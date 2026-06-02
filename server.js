const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const aiChatRoutes = require('./ai-chat');

dotenv.config();

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());

app.use('/', aiChatRoutes);

// === CASHFREE CONFIG ===
const CASHFREE_APP_ID = process.env.CASHFREE_APP_ID;
const CASHFREE_SECRET = process.env.CASHFREE_SECRET;
const CASHFREE_MODE = (process.env.CASHFREE_MODE || 'sandbox').toLowerCase();

console.log("🚀 Backend Mode:", CASHFREE_MODE);
console.log("App ID Loaded:", CASHFREE_APP_ID ? "✅ YES" : "❌ NO");
console.log("Secret Loaded:", CASHFREE_SECRET ? `✅ YES (length: ${CASHFREE_SECRET.length})` : "❌ NO");
console.log("Mode Loaded:", CASHFREE_MODE);

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

    if (!amount || !userId) {
      return res.status(400).json({ success: false, message: "Missing amount or userId" });
    }

    if (!CASHFREE_APP_ID || !CASHFREE_SECRET) {
      return res.status(500).json({ 
        success: false, 
        message: "Cashfree keys not configured on Railway",
        debug: { 
          appId: !!CASHFREE_APP_ID, 
          secret: !!CASHFREE_SECRET,
          mode: CASHFREE_MODE 
        }
      });
    }

    const orderId = `PF_${Date.now()}`;

    const apiUrl = CASHFREE_MODE === 'production' 
      ? "https://api.cashfree.com/pg/orders" 
      : "https://sandbox.cashfree.com/pg/orders";

    console.log(`🔄 Calling Cashfree ${CASHFREE_MODE.toUpperCase()} API... URL: ${apiUrl}`);

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
    console.log("💰 Cashfree Response:", JSON.stringify(data, null, 2));

    if (response.ok && data.payment_session_id) {
      res.json({
        success: true,
        payment_session_id: data.payment_session_id,
        order_id: orderId
      });
    } else {
      res.status(response.status || 400).json({ 
        success: false, 
        message: data.message || "Cashfree authentication failed",
        cashfree_error: data,
        status_code: response.status
      });
    }

  } catch (error) {
    console.error("Backend Error:", error);
    res.status(500).json({ 
      success: false, 
      message: "Internal server error",
      error: error.message 
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT} | Mode: ${CASHFREE_MODE}`);
});
