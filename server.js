const express = require('express');
const fetch = require('node-fetch');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

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

// Get all posts from target ID
async function getAllPosts(targetId, token) {
  const url = `https://graph.facebook.com/v18.0/${encodeURIComponent(targetId)}/posts?fields=id,created_time&limit=100&access_token=${token}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.data) return data.data.map(post => post.id);
  return [];
}

// Start the bot
app.post('/api/start-watch', async (req, res) => {
  const { token, targetId, reactions } = req.body;

  if (!token || !targetId || !reactions || !Array.isArray(reactions)) {
    return res.status(400).json({ success: false, error: 'Missing or invalid fields' });
  }

  try {
    const posts = await getAllPosts(targetId, token);

    if (posts.length === 0) {
      return res.json({ success: false, message: 'No posts found for this target ID.' });
    }

    for (let postId of posts) {
      console.log(`Processing post: ${postId}`);

      // React with all reactions
      for (let i = 0; i < reactions.length; i++) {
        const reaction = reactions[i % reactions.length];
        const reactResult = await reactPost(token, postId, reaction);
        console.log(`Reacted ${reaction} on ${postId}`, reactResult);
      }

      // Comment "hi master"
      const commentResult = await commentPost(token, postId, 'hi master');
      console.log(`Commented "hi master" on ${postId}`, commentResult);
    }

    res.json({ success: true, message: `Bot processed ${posts.length} posts instantly.` });
  } catch (err) {
    console.error('Bot error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));