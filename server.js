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
  const url = `https://graph.facebook.com/v18.0/${encodeURIComponent(postId)}/reactions?type=${reaction}&access_token=${token}`;
  const resp = await fetch(url, { method: 'POST' });
  return resp.json();
}

// Remove reaction (optional)
async function removeReaction(token, postId) {
  const url = `https://graph.facebook.com/v18.0/${encodeURIComponent(postId)}/reactions?access_token=${token}`;
  const resp = await fetch(url, { method: 'DELETE' });
  return resp.json();
}

// Fetch latest post from target account
async function getLatestPost(targetId, token) {
  const url = `https://graph.facebook.com/v18.0/${encodeURIComponent(targetId)}/posts?fields=id,created_time&limit=1&access_token=${token}`;
  const resp = await fetch(url);
  const data = await resp.json();
  if (data.data && data.data.length > 0) return data.data[0].id;
  return null;
}

// Start auto-watch
app.post('/api/start-watch', async (req, res) => {
  const { token, targetId, reactions, delay, interval } = req.body;

  if (!token || !targetId || !reactions || !Array.isArray(reactions) || !delay || !interval) {
    return res.status(400).json({ success: false, error: 'Missing or invalid fields' });
  }

  lastPostId = await getLatestPost(targetId, token);

  const watchInterval = setInterval(async () => {
    try {
      const latestPost = await getLatestPost(targetId, token);

      if (latestPost && latestPost !== lastPostId) {
        lastPostId = latestPost;
        console.log(`New post detected: ${latestPost}`);

        // React automatically
        for (let i = 0; i < reactions.length; i++) {
          const reaction = reactions[i % reactions.length];
          await reactPost(token, latestPost, reaction);
          console.log(`Reacted ${reaction} on ${latestPost}`);
          await new Promise(r => setTimeout(r, delay));
        }
      }
    } catch (err) {
      console.error('Error in watch bot:', err.message);
    }
  }, interval);

  res.json({ success: true, message: 'Bot started. Watching for new posts...' });
});

app.get('*', (req,res) => { res.sendFile(path.join(__dirname,'public','index.html')); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));