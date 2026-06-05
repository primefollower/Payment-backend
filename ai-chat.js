const express = require('express');
const fetch = require('node-fetch');
const router = express.Router();

router.post('/chat', async (req, res) => {
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
          model: 'google/gemini-2.0-flash-exp',
      messages,
      temperature: 0.7,
      max_tokens: 200
    })
  }
);

const data = await response.json();

res.json({
  reply:
    data.choices?.[0]?.message?.content ||
    "⚠️ I couldn't generate a reply."
});

} catch (err) {
console.error(err);

res.status(500).json({
  error: 'Failed to generate response'
});

}
});

module.exports = router;