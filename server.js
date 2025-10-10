const express = require('express');
const fetch = require('node-fetch');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

let lastPostId = null;

// React to a post
async function reactPost(token, postId, reaction) {
  const url = `https://graph.facebook.com/v18.0/${postId}/reactions?type=${reaction}&access_token=${token}`;
  const resp = await fetch(url, { method: 'POST' });
  return resp.json();
}

// Comment on a post
async function commentPost(token, postId, message) {
  const url = `https://graph.facebook.com/v18.0/${postId}/comments?message=${encodeURIComponent(message)}&access_token=${token}`;
  const resp = await fetch(url, { method: 'POST' });
  return resp.json();
}

// Get latest post from target
async function getLatestPost(targetId, token) {
  const url = `https://graph.facebook.com/v18.0/${encodeURIComponent(targetId)}/posts?fields=id,created_time&limit=1&access_token=${token}`;
  const resp = await fetch(url);
  const data = await resp.json();
  if (data.data && data.data.length > 0) return data.data[0].id;
  return null;
}

// Start watching target
app.post('/api/start-watch', async (req, res) => {
  const { token, targetId, reactions, interval } = req.body;

  if (!token || !targetId || !reactions || !Array.isArray(reactions)) {
    return res.status(400).json({ success: false, error: 'Missing or invalid fields' });
  }

  const pollInterval = interval && !isNaN(interval) ? parseInt(interval) : 10000; // default 10s

  lastPostId = await getLatestPost(targetId, token);

  setInterval(async () => {
    try {
      const latestPost = await getLatestPost(targetId, token);

      if (latestPost && latestPost !== lastPostId) {
        lastPostId = latestPost;
        console.log(`New post detected: ${latestPost}`);

        // React on post
        for (let i = 0; i < reactions.length; i++) {
          const reaction = reactions[i % reactions.length];
          const result = await reactPost(token, latestPost, reaction);
          console.log(`Reacted ${reaction} on ${latestPost}`, result);
        }

        // Comment on post
        const commentResult = await commentPost(token, latestPost, 'hi master');
        console.log('Commented "hi master":', commentResult);
      }
    } catch (err) {
      console.error('Error in bot:', err.message);
    }
  }, pollInterval);

  res.json({ success: true, message: `Bot activated. Polling every ${pollInterval / 1000} seconds.` });
});

app.get('*', (req,res) => { res.sendFile(path.join(__dirname,'public','index.html')); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));