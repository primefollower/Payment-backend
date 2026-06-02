const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors({
  origin: "*"  // Change to your domain later for production
}));

const CASHFREE_APP_ID = process.env.CASHFREE_APP_ID;
const CASHFREE_SECRET = process.env.CASHFREE_SECRET_KEY;

app.post('/create-order', async (req, res) => {
  try {
    const { amount, userId, username, email, followers } = req.body;

    if (!amount || !userId) {
      return res.status(400).json({ success: false, message: "Missing data" });
    }

    const orderId = `PF_${Date.now()}`;

    const response = await fetch("https://sandbox.cashfree.com/pg/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-client-id": CASHFREE_APP_ID,
        "x-client-secret": CASHFREE_SECRET,
        "x-api-version": "2023-08-01"
      },
      body: JSON.stringify({
        order_id: orderId,
        order_amount: amount,
        order_currency: "INR",
        customer_details: {
          customer_id: userId,
          customer_name: username || "User",
          customer_email: email || "user@example.com",
          customer_phone: "9999999999"
        }
      })
    });

    const data = await response.json();

    if (data.payment_session_id) {
      res.json({
        success: true,
        payment_session_id: data.payment_session_id,
        order_id: orderId
      });
    } else {
      res.status(400).json({ success: false, message: data.message || "Failed" });
    }

  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Cashfree Backend running on port ${PORT}`));