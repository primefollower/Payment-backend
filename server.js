const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const dotenv = require('dotenv');
const crypto = require('crypto');
const admin = require('firebase-admin');

dotenv.config();

admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n')
  })
});

const db = admin.firestore();
const app = express();

// Middleware
app.use(cors({ origin: "*" }));

app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf.toString();
  }
}));
app.use(express.urlencoded({ extended: true }));

// === CASHFREE CONFIG ===
const CASHFREE_APP_ID = process.env.CASHFREE_APP_ID;
const CASHFREE_SECRET = process.env.CASHFREE_SECRET;
const CASHFREE_MODE = (process.env.CASHFREE_MODE || 'sandbox').toLowerCase();
const ADMIN_SECRET = process.env.ADMIN_SECRET;

console.log("🚀 Backend Mode:", CASHFREE_MODE);
console.log("App ID Loaded:", CASHFREE_APP_ID ? "✅ YES" : "❌ NO");
console.log("Secret Loaded:", CASHFREE_SECRET ? `✅ YES (length: ${CASHFREE_SECRET.length})` : "❌ NO");
console.log("Admin Secret Loaded:", ADMIN_SECRET ? "✅ YES" : "❌ NO");

// ════════════════════════════════════════════════════
// CASHFREE PAYMENT SYSTEM
// ════════════════════════════════════════════════════

// === CREATE ORDER ===
app.post('/create-order', async (req, res) => {
  try {
    const { amount, userId, username, email, followers } = req.body;

    console.log("📥 Create Order Request:", {
      amount, userId, username, followers,
      email: email ? email.substring(0, 5) + "..." : null
    });

    if (!amount || !userId || Number(amount) <= 0) {
      return res.status(400).json({ success: false, message: "Missing amount or userId" });
    }

    if (!CASHFREE_APP_ID || !CASHFREE_SECRET) {
      return res.status(500).json({
        success: false,
        message: "Cashfree keys not configured",
        debug: { appId: !!CASHFREE_APP_ID, secret: !!CASHFREE_SECRET }
      });
    }

    const orderId = `PF_${Date.now()}`;

    const apiUrl = CASHFREE_MODE === 'production'
      ? "https://api.cashfree.com/pg/orders"
      : "https://sandbox.cashfree.com/pg/orders";

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-version': '2023-08-01',
        'x-client-id': CASHFREE_APP_ID,
        'x-client-secret': CASHFREE_SECRET,
      },
      body: JSON.stringify({
        order_amount: Number(amount),
        order_currency: "INR",
        order_id: orderId,
        customer_details: {
          customer_id: userId,
          customer_name: username || "Prime User",
          customer_email: email || "user@example.com",
          customer_phone: "9999999999"
        }
      })
    });

    const data = await response.json();

    console.log("💰 Cashfree Status:", response.status);
    console.log("Cashfree Response:", JSON.stringify(data, null, 2));

    if (response.ok && data.payment_session_id) {
      await db.collection('pending_payments').doc(orderId).set({
        orderId,
        userId,
        amount: Number(amount),
        followers: Number(followers) || 0,
        status: 'pending',
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });

      res.json({
        success: true,
        payment_session_id: data.payment_session_id,
        orderId: orderId
      });
    } else {
      res.status(response.status || 400).json({
        success: false,
        message: data.message || "Cashfree failed",
        error: data
      });
    }

  } catch (error) {
    console.error("Backend Error:", error);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// === VERIFY PAYMENT (Polling Fallback) ===
app.post('/verify-payment', async (req, res) => {
  try {
    const { orderId } = req.body;
    if (!orderId) return res.status(400).json({ success: false, message: "Missing orderId" });

    const apiUrl = CASHFREE_MODE === 'production'
      ? `https://api.cashfree.com/pg/orders/${orderId}`
      : `https://sandbox.cashfree.com/pg/orders/${orderId}`;

    const response = await fetch(apiUrl, {
      method: 'GET',
      headers: {
        'x-api-version': '2023-08-01',
        'x-client-id': CASHFREE_APP_ID,
        'x-client-secret': CASHFREE_SECRET
      }
    });

    const data = await response.json();

    if (data.order_status === "PAID") {
      const paymentRef = db.collection("payment_events").doc(orderId);
      const paymentSnap = await paymentRef.get();

      if (!paymentSnap.exists) {
        let followers = 0;
        try {
          const pendingSnap = await db.collection('pending_payments').doc(orderId).get();
          if (pendingSnap.exists) {
            followers = pendingSnap.data().followers || 0;
          }
        } catch (e) {
          console.warn("Could not fetch pending_payments:", e);
        }

        await paymentRef.set({
          orderId,
          status: "paid",
          processed: false,
          amount: data.order_amount,
          followers: followers,
          userId: data.customer_details?.customer_id || "",
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }
      return res.json({ success: true, orderId });
    }

    res.json({ success: false, message: `Payment ${data.order_status}` });

  } catch (err) {
    console.error("Verify Error:", err);
    res.status(500).json({ success: false, message: "Verification failed" });
  }
});

// === CASHFREE WEBHOOK ===
app.post('/cashfree-webhook', async (req, res) => {
  try {
    const signature = req.headers['x-webhook-signature'];
    const timestamp = req.headers['x-webhook-timestamp'];
    const rawBody = req.rawBody;

    if (!signature || !timestamp || !rawBody) {
      return res.status(400).json({ success: false });
    }

    const expectedSig = crypto
      .createHmac('sha256', CASHFREE_SECRET)
      .update(`${timestamp}.${rawBody}`)
      .digest('base64');

    if (signature !== expectedSig) {
      console.error("❌ Invalid webhook signature");
      return res.status(401).json({ success: false });
    }

    const payload = JSON.parse(rawBody);
    const orderData = payload.data?.order || payload.data || payload;
    const { order_id, order_status, order_amount } = orderData;
    const customerId = payload.data?.customer_details?.customer_id
      || payload.data?.order?.customer_details?.customer_id
      || "";

    console.log(`🔔 Webhook: ${order_id} → ${order_status}`);

    if (order_status === "PAID") {
      const paymentRef = db.collection("payment_events").doc(order_id);
      if (!(await paymentRef.get()).exists) {
        let followers = 0;
        try {
          const pendingSnap = await db.collection('pending_payments').doc(order_id).get();
          if (pendingSnap.exists) {
            followers = pendingSnap.data().followers || 0;
          }
        } catch (e) {
          console.warn("Webhook: Could not fetch pending_payments:", e);
        }

        await paymentRef.set({
          orderId: order_id,
          status: "paid",
          processed: false,
          amount: order_amount,
          followers: followers,
          userId: customerId,
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        console.log(`✅ Webhook recorded payment: ${order_id} (${followers} followers)`);
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error("Webhook Error:", err);
    res.status(500).json({ success: false });
  }
});

// ════════════════════════════════════════════════════
// PRIME AI CHAT
// ════════════════════════════════════════════════════

app.post('/chat', async (req, res) => {
  try {
    const { messages } = req.body;

    const response = await fetch(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'google/gemini-2.0-flash-001',
          messages,
          temperature: 0.7,
          max_tokens: 200
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error("OpenRouter error:", JSON.stringify(data));
      return res.status(response.status).json({
        error: data.error?.message || "AI request failed"
      });
    }

    res.json({
      reply: data.choices?.[0]?.message?.content || "⚠️ I couldn't generate a reply."
    });

  } catch (err) {
    console.error("Chat error:", err);
    res.status(500).json({ error: 'Failed to generate response' });
  }
});

// ════════════════════════════════════════════════════
// COUPON SYSTEM
// ════════════════════════════════════════════════════

// Helper: admin auth check
function isAdmin(req) {
  const secret = req.headers['x-admin-secret'] || req.body.adminSecret;
  return ADMIN_SECRET && secret === ADMIN_SECRET;
}

// Helper: generate random coupon code
function generateCouponCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 8; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return "PRIME" + code;
}

// Helper: evaluate coupon status
function getCouponStatus(c) {
  if (!c.active) return "Disabled";
  if (c.expiry && new Date(c.expiry) < new Date()) return "Expired";
  if (c.maxUses > 0 && (c.usedCount || 0) >= c.maxUses) return "Usage Limit Reached";
  return "Active";
}

// ── CREATE COUPON (admin) ──
app.post('/create-coupon', async (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ success: false, message: "Unauthorized" });

    let { code, discount, validFor, expiry, maxUses, maxDiscount, level } = req.body;

    code = (code && code.trim()) ? code.trim().toUpperCase() : generateCouponCode();
    discount = Number(discount);
    maxUses = Number(maxUses) || 0;
    maxDiscount = Number(maxDiscount) || 0;
    validFor = validFor || "both";
    // level: 0 = any level, or 1-5 for a specific level requirement
    level = Number(level) || 0;

    if (!discount || discount <= 0 || discount > 100) {
      return res.status(400).json({ success: false, message: "Discount must be 1-100" });
    }

    // Check duplicate
    const existing = await db.collection('coupons').where('code', '==', code).get();
    if (!existing.empty) {
      return res.status(400).json({ success: false, message: "Coupon code already exists" });
    }

    const couponDoc = {
      code,
      discount,
      validFor,
      expiry: expiry || null,
      maxUses,
      maxDiscount,
      level,
      usedCount: 0,
      active: true,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };

    const ref = await db.collection('coupons').add(couponDoc);
    res.json({ success: true, id: ref.id, code, message: "Coupon created" });

  } catch (err) {
    console.error("create-coupon error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ── LIST COUPONS (admin) ──
app.post('/list-coupons', async (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ success: false, message: "Unauthorized" });

    const snap = await db.collection('coupons').orderBy('createdAt', 'desc').get();
    const coupons = snap.docs.map(d => {
      const data = d.data();
      return {
        id: d.id,
        ...data,
        maxDiscount: data.maxDiscount || 0,
        level: data.level || 0,
        createdAt: data.createdAt?.toDate?.()?.toISOString() || null,
        status: getCouponStatus(data)
      };
    });

    res.json({ success: true, coupons });
  } catch (err) {
    console.error("list-coupons error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ── UPDATE COUPON (admin) ──
app.post('/update-coupon', async (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ success: false, message: "Unauthorized" });

    const { id, updates } = req.body;
    if (!id || !updates) return res.status(400).json({ success: false, message: "Missing id/updates" });

    const allowed = {};
    if (updates.discount !== undefined) allowed.discount = Number(updates.discount);
    if (updates.validFor !== undefined) allowed.validFor = updates.validFor;
    if (updates.expiry !== undefined) allowed.expiry = updates.expiry;
    if (updates.maxUses !== undefined) allowed.maxUses = Number(updates.maxUses);
    if (updates.maxDiscount !== undefined) allowed.maxDiscount = Number(updates.maxDiscount);
    if (updates.level !== undefined) allowed.level = Number(updates.level) || 0;
    if (updates.active !== undefined) allowed.active = !!updates.active;

    await db.collection('coupons').doc(id).update(allowed);
    res.json({ success: true, message: "Coupon updated" });
  } catch (err) {
    console.error("update-coupon error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ── DELETE COUPON (admin) ──
app.post('/delete-coupon', async (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ success: false, message: "Unauthorized" });

    const { id } = req.body;
    if (!id) return res.status(400).json({ success: false, message: "Missing id" });

    await db.collection('coupons').doc(id).delete();
    res.json({ success: true, message: "Coupon deleted" });
  } catch (err) {
    console.error("delete-coupon error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ── VALIDATE COUPON (public — during checkout) ──
app.post('/validate-coupon', async (req, res) => {
  try {
    let { code, orderType, amount, userId } = req.body;
    // orderType: "credits" or "paidOrders"
    // amount: original price (credits number OR rupees)

    if (!code || !orderType || amount === undefined) {
      return res.json({ valid: false, message: "Missing fields" });
    }

    code = code.trim().toUpperCase();
    amount = Number(amount);

    const snap = await db.collection('coupons').where('code', '==', code).limit(1).get();
    if (snap.empty) {
      return res.json({ valid: false, message: "Invalid coupon code" });
    }

    const docSnap = snap.docs[0];
    const c = docSnap.data();

    // Status checks
    if (!c.active) return res.json({ valid: false, message: "Coupon is disabled" });
    if (c.expiry && new Date(c.expiry) < new Date()) {
      return res.json({ valid: false, message: "Coupon has expired" });
    }
    if (c.maxUses > 0 && (c.usedCount || 0) >= c.maxUses) {
      return res.json({ valid: false, message: "Coupon usage limit reached" });
    }

    // validFor check
    if (c.validFor !== "both" && c.validFor !== orderType) {
      const typeLabel = orderType === "credits" ? "credit orders" : "paid orders";
      return res.json({ valid: false, message: `This coupon is not valid for ${typeLabel}` });
    }

    // Level restriction check
    const requiredLevel = c.level || 0;
    if (requiredLevel > 0) {
      const LEVEL_NAMES = { 1: "Prime Starter", 2: "Prime Lion", 3: "Prime Shark", 4: "Prime Elite", 5: "Prime Member" };
      if (!userId) {
        return res.json({ valid: false, message: `This coupon is only for ${LEVEL_NAMES[requiredLevel]}` });
      }
      try {
        const uSnap = await db.collection('users').doc(userId).get();
        const uLevel = uSnap.exists ? (uSnap.data().level || 1) : 1;
        if (uLevel !== requiredLevel) {
          return res.json({ valid: false, message: `Only for ${LEVEL_NAMES[requiredLevel]}` });
        }
      } catch (e) {
        return res.json({ valid: false, message: "Could not verify your level" });
      }
    }

    // Check if user already used this coupon (optional - per user limit)
    if (userId) {
      const userRedemption = await db.collection('coupon_redemptions')
        .where('couponId', '==', docSnap.id)
        .where('userId', '==', userId)
        .limit(1)
        .get();

      if (!userRedemption.empty) {
        return res.json({ valid: false, message: "You have already used this coupon" });
      }
    }

    // Calculate discount with maxDiscount cap
    let discountAmount = Math.round((amount * c.discount) / 100);

    // Apply maxDiscount cap if set
    const maxDiscountCap = c.maxDiscount || 0;
    if (maxDiscountCap > 0) {
      discountAmount = Math.min(discountAmount, maxDiscountCap);
    }

    const finalPrice = Math.max(Math.round(amount - discountAmount), orderType === "paidOrders" ? 1 : 0);

    // Build message
    let message = `${c.discount}% OFF applied!`;
    if (maxDiscountCap > 0) {
      const unit = orderType === "paidOrders" ? "₹" : "";
      const unitAfter = orderType === "credits" ? " Credits" : "";
      message = `${c.discount}% OFF (upto ${unit}${maxDiscountCap}${unitAfter}) applied!`;
    }

    res.json({
      valid: true,
      couponId: docSnap.id,
      code: c.code,
      discount: c.discount,
      maxDiscount: maxDiscountCap,
      discountAmount,
      finalPrice,
      originalPrice: amount,
      message
    });

  } catch (err) {
    console.error("validate-coupon error:", err);
    res.status(500).json({ valid: false, message: "Server error" });
  }
});

// ── REDEEM COUPON (after successful payment/order) ──
app.post('/redeem-coupon', async (req, res) => {
  try {
    const { couponId, userId, orderId } = req.body;
    if (!couponId) return res.status(400).json({ success: false, message: "Missing couponId" });

    const ref = db.collection('coupons').doc(couponId);

    await db.runTransaction(async (t) => {
      const doc = await t.get(ref);
      if (!doc.exists) throw new Error("Coupon not found");
      const c = doc.data();

      // Re-validate at redemption
      if (!c.active) throw new Error("Coupon disabled");
      if (c.maxUses > 0 && (c.usedCount || 0) >= c.maxUses) throw new Error("Limit reached");

      t.update(ref, { usedCount: admin.firestore.FieldValue.increment(1) });
    });

    // Log redemption
    await db.collection('coupon_redemptions').add({
      couponId,
      userId: userId || "",
      orderId: orderId || "",
      redeemedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({ success: true, message: "Coupon redeemed" });
  } catch (err) {
    console.error("redeem-coupon error:", err);
    res.status(500).json({ success: false, message: err.message || "Server error" });
  }
});



// ════════════════════════════════════════════════════
// INSTAGRAM CONNECT (Username Lookup)
// ════════════════════════════════════════════════════

app.post('/instagram-lookup', async (req, res) => {
  try {
    const { username } = req.body;
    if (!username) {
      return res.json({ success: false, message: "Username required" });
    }

    const cleanUsername = username.replace(/^@/, '').trim().toLowerCase();
    if (!cleanUsername || cleanUsername.length < 1) {
      return res.json({ success: false, message: "Invalid username" });
    }

    // Try multiple data sources for Instagram profile
    let profileData = null;

    // Method 1: Try i.instagram.com endpoint
    try {
      const resp = await fetch(`https://i.instagram.com/api/v1/users/web_profile_info/?username=${cleanUsername}`, {
        headers: {
          'User-Agent': 'Instagram 275.0.0.27.98 Android (33/13; 420dpi; 1080x2400; samsung; SM-G991B; o1s; exynos2100; en_US; 458229237)',
          'X-IG-App-ID': '936619743392459'
        }
      });
      if (resp.ok) {
        const data = await resp.json();
        const user = data?.data?.user;
        if (user) {
          profileData = {
            username: user.username,
            fullName: user.full_name || user.username,
            profilePic: user.profile_pic_url || user.profile_pic_url_hd || "",
            isPrivate: user.is_private || false,
            profileLink: `https://www.instagram.com/${user.username}/`
          };
        }
      }
    } catch (e) {
      console.warn("Method 1 failed:", e.message);
    }

    // Method 2: Fallback - scrape public page
    if (!profileData) {
      try {
        const resp = await fetch(`https://www.instagram.com/${cleanUsername}/?__a=1&__d=dis`, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
            'Accept': 'application/json',
            'X-IG-App-ID': '936619743392459'
          }
        });
        if (resp.ok) {
          const text = await resp.text();
          try {
            const data = JSON.parse(text);
            const user = data?.graphql?.user || data?.user;
            if (user) {
              profileData = {
                username: user.username,
                fullName: user.full_name || user.username,
                profilePic: user.profile_pic_url_hd || user.profile_pic_url || "",
                isPrivate: user.is_private || false,
                profileLink: `https://www.instagram.com/${user.username}/`
              };
            }
          } catch (parseErr) {
            console.warn("JSON parse failed for method 2");
          }
        }
      } catch (e) {
        console.warn("Method 2 failed:", e.message);
      }
    }

    // Method 3: Basic fallback - just validate username exists
    if (!profileData) {
      try {
        const resp = await fetch(`https://www.instagram.com/${cleanUsername}/`, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          },
          redirect: 'follow'
        });
        if (resp.ok) {
          const html = await resp.text();
          if (html.includes(`"username":"${cleanUsername}"`) || html.includes(`@${cleanUsername}`)) {
            // Extract what we can from meta tags
            const ogImageMatch = html.match(/property="og:image"\s+content="([^"]+)"/);
            const titleMatch = html.match(/property="og:title"\s+content="([^"]+)"/);
            const isPrivate = html.includes('"is_private":true');

            let fullName = cleanUsername;
            if (titleMatch) {
              const parts = titleMatch[1].split('(');
              if (parts[0]) fullName = parts[0].trim();
            }

            profileData = {
              username: cleanUsername,
              fullName: fullName,
              profilePic: ogImageMatch ? ogImageMatch[1] : "",
              isPrivate: isPrivate,
              profileLink: `https://www.instagram.com/${cleanUsername}/`
            };
          }
        }
      } catch (e) {
        console.warn("Method 3 failed:", e.message);
      }
    }

    if (!profileData) {
      return res.json({ success: false, message: "Instagram account not found" });
    }

    // Proxy the profile picture to base64 (Instagram CDN blocks direct hotlinking with 403)
    profileData.profilePicBase64 = "";
    if (profileData.profilePic) {
      try {
        const imgResp = await fetch(profileData.profilePic, {
          headers: {
            'User-Agent': 'Instagram 275.0.0.27.98 Android (33/13; 420dpi; 1080x2400; samsung; SM-G991B; o1s; exynos2100; en_US; 458229237)',
            'Accept': 'image/webp,image/jpeg,image/png,*/*',
            'Referer': 'https://www.instagram.com/'
          }
        });
        if (imgResp.ok) {
          const buffer = await imgResp.buffer();
          const base64 = buffer.toString('base64');
          const contentType = imgResp.headers.get('content-type') || 'image/jpeg';
          profileData.profilePicBase64 = `data:${contentType};base64,${base64}`;
        }
      } catch (imgErr) {
        console.warn("Profile pic proxy failed:", imgErr.message);
      }
    }
    // Never send the raw CDN url to the client (it will 403). Only base64.
    profileData.profilePic = "";

    res.json({ success: true, profile: profileData });

  } catch (err) {
    console.error("instagram-lookup error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});



// ════════════════════════════════════════════════════
// ADMIN — ORDERS (Credit / Paid / Bonus)
// ════════════════════════════════════════════════════

// Helper: enrich an order with user details
async function enrichOrderWithUser(order) {
  let userEmail = "", userName = "";
  try {
    if (order.user_id) {
      const uSnap = await db.collection('users').doc(order.user_id).get();
      if (uSnap.exists) {
        const u = uSnap.data();
        userEmail = u.email || "";
        userName = u.username || "";
      }
    }
  } catch (e) { /* ignore */ }
  return { ...order, userEmail, userName };
}

// ── LIST CREDIT ORDERS (admin) ──
app.post('/admin-credit-orders', async (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ success: false, message: "Unauthorized" });

    const snap = await db.collection('orders')
      .orderBy('order_time', 'desc')
      .limit(200)
      .get();

    const orders = [];
    for (const d of snap.docs) {
      const o = d.data();
      // Credit orders: NOT paid, NOT bonus, AND credits_spent > 0 (skip free 3-follower first order)
      const isPaid = o.isPaidOrder === true;
      const isBonus = o.isViralBonus || o.isDay3Bonus || o.isLevelReward;
      const isDiamond = o.isDiamondOrder === true;
      const spent = Number(o.credits_spent || 0);
      if (isPaid || isBonus) continue;
      // Include credit orders (spent>0) and diamond orders
      if (spent <= 0 && !isDiamond) continue;

      const enriched = await enrichOrderWithUser({
        id: d.id,
        user_id: o.user_id,
        instagram_username: o.instagram_username || "",
        instagram_link: o.instagram_link || "",
        followers: o.followers || 0,
        credits_spent: spent,
        isDiamondOrder: isDiamond,
        diamondCost: o.diamondCost || 0,
        status: o.status || "processing",
        order_time: o.order_time?.toDate?.()?.toISOString() || null
      });
      orders.push(enriched);
    }

    res.json({ success: true, orders });
  } catch (err) {
    console.error("admin-credit-orders error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ── LIST PAID ORDERS (admin) ──
app.post('/admin-paid-orders', async (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ success: false, message: "Unauthorized" });

    const snap = await db.collection('orders')
      .where('isPaidOrder', '==', true)
      .orderBy('order_time', 'desc')
      .limit(200)
      .get();

    const orders = [];
    for (const d of snap.docs) {
      const o = d.data();
      const enriched = await enrichOrderWithUser({
        id: d.id,
        user_id: o.user_id,
        instagram_username: o.instagram_username || "",
        instagram_link: o.instagram_link || "",
        followers: o.followers || 0,
        paidAmount: o.paidAmount || 0,
        status: o.status || "processing",
        order_time: o.order_time?.toDate?.()?.toISOString() || null
      });
      orders.push(enriched);
    }

    res.json({ success: true, orders });
  } catch (err) {
    console.error("admin-paid-orders error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ── LIST BONUS ORDERS (admin) — all free / bonus orders ──
app.post('/admin-bonus-orders', async (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ success: false, message: "Unauthorized" });

    const snap = await db.collection('orders')
      .orderBy('order_time', 'desc')
      .limit(300)
      .get();

    const orders = [];
    for (const d of snap.docs) {
      const o = d.data();
      const isPaid = o.isPaidOrder === true;
      const spent = Number(o.credits_spent || 0);
      const isViral = o.isViralBonus === true;
      const isDay3 = o.isDay3Bonus === true;
      const isLevelReward = o.isLevelReward === true;
      const isFreeFirst = (o.followers === 3 && spent === 0 && !isViral && !isDay3 && !isLevelReward && o.isDiamondOrder !== true);

      // Bonus = free (0 credit) orders that are NOT paid and NOT diamond
      const isBonus = (isViral || isDay3 || isLevelReward || isFreeFirst);
      if (isPaid || !isBonus) continue;

      let bonusType = "Free";
      if (isViral) bonusType = "Prime Viral Bonus";
      else if (isDay3) bonusType = "Day 3 (50 Free)";
      else if (isLevelReward) bonusType = "Level Free Followers";
      else if (isFreeFirst) bonusType = "First Order Free (3)";

      const enriched = await enrichOrderWithUser({
        id: d.id,
        user_id: o.user_id,
        bonusType,
        instagram_username: o.instagram_username || "",
        instagram_link: o.instagram_link || "",
        followers: o.followers || 0,
        status: o.status || "processing",
        order_time: o.order_time?.toDate?.()?.toISOString() || null
      });
      orders.push(enriched);
    }

    res.json({ success: true, orders });
  } catch (err) {
    console.error("admin-bonus-orders error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ════════════════════════════════════════════════════
// DIAMOND UNLOCK (secure — for level-locked orders)
// ════════════════════════════════════════════════════

app.post('/diamond-unlock', async (req, res) => {
  try {
    const { userId, unlockKey } = req.body;
    if (!userId || !unlockKey) {
      return res.json({ success: false, message: "Missing fields" });
    }

    const userRef = db.collection('users').doc(userId);
    const result = await db.runTransaction(async (t) => {
      const snap = await t.get(userRef);
      if (!snap.exists) throw new Error("User not found");
      const diamonds = snap.data().diamonds || 0;
      if (diamonds < 1) throw new Error("Not enough diamonds");

      const unlockUntil = Date.now() + 60 * 60 * 1000; // 1 hour
      t.update(userRef, {
        diamonds: admin.firestore.FieldValue.increment(-1),
        [`diamondUnlocks.${unlockKey}`]: unlockUntil
      });
      return { unlockUntil, newDiamonds: diamonds - 1 };
    });

    res.json({ success: true, ...result });
  } catch (err) {
    console.error("diamond-unlock error:", err);
    res.json({ success: false, message: err.message || "Server error" });
  }
});

// ════════════════════════════════════════════════════
// HEALTH CHECK
// ════════════════════════════════════════════════════

app.get('/', (req, res) => {
  res.json({
    status: "ok",
    service: "Prime Follower Backend",
    mode: CASHFREE_MODE,
    timestamp: new Date().toISOString()
  });
});

app.get('/health', (req, res) => {
  res.json({ status: "healthy", uptime: process.uptime() });
});

// ════════════════════════════════════════════════════
// START SERVER
// ════════════════════════════════════════════════════

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT} | Mode: ${CASHFREE_MODE}`);
});
