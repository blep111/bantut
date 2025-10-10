const express = require('express');
const fetch = require('node-fetch');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// In-memory cooldown and daily limits
let userStatus = {}; // { token: { used: 0, lastUsed: timestamp, resetTime } }
const COOLDOWN_MINUTES = 15;
const DAILY_LIMIT = 10;

app.post('/api/react', async (req, res) => {
  const { token, postId, reaction } = req.body;
  if (!token || !postId || !reaction) return res.status(400).json({ success: false, error: 'Missing token, postId, or reaction' });

  const now = Date.now();
  if (!userStatus[token]) userStatus[token] = { used: 0, lastUsed: 0, resetTime: now + 24 * 60 * 60 * 1000 };

  const status = userStatus[token];

  // Reset daily usage
  if (now > status.resetTime) {
    status.used = 0;
    status.resetTime = now + 24 * 60 * 60 * 1000;
  }

  // Check cooldown
  if (now - status.lastUsed < COOLDOWN_MINUTES * 60 * 1000) {
    const remaining = Math.ceil((COOLDOWN_MINUTES * 60 * 1000 - (now - status.lastUsed)) / 1000);
    return res.json({ success: false, error: 'Cooldown active', remainingSeconds: remaining });
  }

  // Check daily limit
  if (status.used >= DAILY_LIMIT) {
    const resetIn = Math.ceil((status.resetTime - now) / 1000);
    return res.json({ success: false, error: 'Daily limit reached', resetIn });
  }

  // Send reaction via Graph API
  try {
    const url = `https://graph.facebook.com/v18.0/${encodeURIComponent(postId)}/reactions?type=${reaction}&access_token=${token}`;
    const resp = await fetch(url, { method: 'POST' });
    const data = await resp.json();

    if (!resp.ok || data.error) return res.json({ success: false, error: data.error ? data.error.message : 'Graph API error' });

    // Update status
    status.used += 1;
    status.lastUsed = now;

    return res.json({ success: true, data, used: status.used, remaining: DAILY_LIMIT - status.used });
  } catch (err) {
    console.error(err);
    return res.json({ success: false, error: 'Server error', details: err.message });
  }
});

// Serve frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));