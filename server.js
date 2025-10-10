const express = require('express');
const fetch = require('node-fetch');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

let activeBots = {}; // store running bots by targetId

// React on a post
async function reactPost(token, postId, reaction) {
  const url = `https://graph.facebook.com/v18.0/${postId}/reactions?type=${reaction}&access_token=${token}`;
  const res = await fetch(url, { method: 'POST' });
  return res.json();
}

// Comment on a post
async function commentPost(token, postId, message) {
  const url = `https://graph.facebook.com/v18.0/${postId}/comments?message=${encodeURIComponent(message)}&access_token=${token}`;
  const res = await fetch(url, { method: 'POST' });
  return res.json();
}

// Share a post
async function sharePost(token, postId) {
  const url = `https://graph.facebook.com/v18.0/me/feed?link=https://www.facebook.com/${postId}&access_token=${token}`;
  const res = await fetch(url, { method: 'POST' });
  return res.json();
}

// Get latest posts from target ID
async function getLatestPosts(targetId, token) {
  const url = `https://graph.facebook.com/v18.0/${encodeURIComponent(targetId)}/posts?fields=id,created_time&limit=5&access_token=${token}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.data) return data.data.map(post => post.id);
  return [];
}

// Start live bot
app.post('/api/start-bot', async (req, res) => {
  const { token, targetId, reactions, comment } = req.body;

  if (!token || !targetId || !reactions || !Array.isArray(reactions)) {
    return res.status(400).json({ success: false, error: 'Missing or invalid fields' });
  }

  if (activeBots[targetId]) {
    return res.json({ success: false, message: 'Bot already running for this target ID' });
  }

  let processedPosts = new Set();

  const pollPosts = async () => {
    try {
      const posts = await getLatestPosts(targetId, token);
      for (let postId of posts) {
        if (!processedPosts.has(postId)) {
          processedPosts.add(postId);
          console.log(`New post detected: ${postId}`);

          // React on post
          for (let i = 0; i < reactions.length; i++) {
            const reaction = reactions[i % reactions.length];
            const result = await reactPost(token, postId, reaction);
            console.log(`Reacted ${reaction} on ${postId}`, result);
          }

          // Comment
          const commentResult = await commentPost(token, postId, comment || 'hi master');
          console.log(`Commented "${comment || 'hi master'}" on ${postId}`, commentResult);

          // Share
          const shareResult = await sharePost(token, postId);
          console.log(`Shared post ${postId}`, shareResult);
        }
      }
    } catch (err) {
      console.error('Bot error:', err.message);
    }
  };

  // Immediately check posts and then every 10s
  await pollPosts();
  const intervalId = setInterval(pollPosts, 10000);

  activeBots[targetId] = intervalId;

  res.json({ success: true, message: `Live bot activated for target ID ${targetId}. It will react, comment, and share automatically.` });
});

// Stop bot
app.post('/api/stop-bot', (req, res) => {
  const { targetId } = req.body;
  if (activeBots[targetId]) {
    clearInterval(activeBots[targetId]);
    delete activeBots[targetId];
    return res.json({ success: true, message: `Bot stopped for target ID ${targetId}` });
  }
  res.json({ success: false, message: 'No active bot found for this target ID' });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));