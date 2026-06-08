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

// Important: For webhook signature verification
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

console.log("🚀 Backend Mode:", CASHFREE_MODE);
console.log("App ID Loaded:", CASHFREE_APP_ID ? "✅ YES" : "❌ NO");
console.log("Secret Loaded:", CASHFREE_SECRET ? `✅ YES (length: ${CASHFREE_SECRET.length})` : "❌ NO");

// === CREATE ORDER ENDPOINT ===
// === CREATE ORDER ENDPOINT ===
app.post('/create-order', async (req, res) => {
  try {
    const { amount, userId, username, email, followers } = req.body;

    console.log("📥 Create Order Request:", { 
      amount, 
      userId, 
      username,
      followers,
      email: email ? email.substring(0,5)+"..." : null 
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
      // Save order metadata to Firestore for recovery
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
        // Get followers count from pending_payments
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

// === CASHFREE WEBHOOK (Main Success Handler) ===
app.post('/cashfree-webhook', async (req, res) => {
  try {
    const signature = req.headers['x-webhook-signature'];
    const timestamp = req.headers['x-webhook-timestamp'];
    const rawBody = req.rawBody;

    if (!signature || !timestamp || !rawBody) {
      return res.status(400).json({ success: false });
    }

    // Verify signature
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
        // Get followers count from pending_payments
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

// === PRIME AI CHAT ENDPOINT ===
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
      reply:
        data.choices?.[0]?.message?.content ||
        "⚠️ I couldn't generate a reply."
    });

  } catch (err) {
    console.error("Chat error:", err);
    res.status(500).json({ error: 'Failed to generate response' });
  }
});

// ════════════════════════════════════════════════════
// COUPON SYSTEM
// ════════════════════════════════════════════════════

const ADMIN_SECRET = process.env.ADMIN_SECRET;

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

    let { code, discount, validFor, expiry, maxUses } = req.body;

    code = (code && code.trim()) ? code.trim().toUpperCase() : generateCouponCode();
    discount = Number(discount);
    maxUses = Number(maxUses) || 0;
    validFor = validFor || "both"; // credits | paidOrders | both

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

// ── UPDATE / ENABLE / DISABLE COUPON (admin) ──
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
    let { code, orderType, amount } = req.body;
    // orderType: "credits" or "paidOrders"
    // amount: original price (credits number OR rupees)

    if (!code || !orderType || amount === undefined) {
      return res.status(400).json({ valid: false, message: "Missing fields" });
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
      return res.json({ valid: false, message: "Coupon not valid for this order type" });
    }

    const discountAmount = Math.round((amount * c.discount) / 100);
    const finalPrice = Math.max(amount - discountAmount, 0);

    res.json({
      valid: true,
      couponId: docSnap.id,
      code: c.code,
      discount: c.discount,
      discountAmount,
      finalPrice,
      message: `Coupon applied! ${c.discount}% off`
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT} | Mode: ${CASHFREE_MODE}`);
});