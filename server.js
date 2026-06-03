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
app.post('/create-order', async (req, res) => {
  try {
    const { amount, userId, username, email } = req.body;

    console.log("📥 Create Order Request:", { 
      amount, 
      userId, 
      username, 
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
      if (!(await paymentRef.get()).exists) {
    await paymentRef.set({
          orderId,
          status: "paid",
          processed: false,
          amount: data.order_amount,
          followers: 0,
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
     await paymentRef.set({
          orderId: order_id,
          status: "paid",
          processed: false,
          amount: order_amount,
          followers: 0,
          userId: customerId,
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        console.log(`✅ Webhook recorded payment: ${order_id}`);
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error("Webhook Error:", err);
    res.status(500).json({ success: false });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT} | Mode: ${CASHFREE_MODE}`);
});
