const express = require('express');
const fetch = require('node-fetch');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// React to a post
app.post('/api/react', async (req, res) => {
  try {
    const { access_token, postId, reaction } = req.body;
    if (!access_token || !postId || !reaction) {
      return res.status(400).json({ success: false, error: 'Missing access_token, postId, or reaction' });
    }

    const reactionType = reaction.toUpperCase();
    const url = `https://graph.facebook.com/${encodeURIComponent(postId)}/reactions?type=${reactionType}&access_token=${access_token}`;

    const resp = await fetch(url, { method: 'POST' });
    const data = await resp.json();

    if (!resp.ok) {
      return res.status(resp.status).json({ success: false, error: data.error || 'Graph API error', details: data });
    }

    return res.json({ success: true, data });
  } catch (err) {
    console.error('Server error:', err);
    return res.status(500).json({ success: false, error: 'Server error', details: err.message });
  }
});

// Serve frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));