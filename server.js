const express = require("express");
const fetch = require("node-fetch");
const cors = require("cors");
const bodyParser = require("body-parser");
const path = require("path");

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

let activeBots = {}; // store active target monitors

// --- Facebook Graph API Actions ---
async function reactPost(token, postId, reaction) {
  try {
    const url = `https://graph.facebook.com/v18.0/${postId}/reactions?type=${reaction}&access_token=${token}`;
    const res = await fetch(url, { method: "POST" });
    return await res.json();
  } catch (err) {
    return { error: err.message };
  }
}

async function commentPost(token, postId, message) {
  try {
    const url = `https://graph.facebook.com/v18.0/${postId}/comments?message=${encodeURIComponent(message)}&access_token=${token}`;
    const res = await fetch(url, { method: "POST" });
    return await res.json();
  } catch (err) {
    return { error: err.message };
  }
}

async function sharePost(token, postId) {
  try {
    const url = `https://graph.facebook.com/v18.0/me/feed?link=https://www.facebook.com/${postId}&access_token=${token}`;
    const res = await fetch(url, { method: "POST" });
    return await res.json();
  } catch (err) {
    return { error: err.message };
  }
}

async function getLatestPosts(targetId, token) {
  try {
    const url = `https://graph.facebook.com/v18.0/${encodeURIComponent(targetId)}/posts?fields=id,created_time&limit=5&access_token=${token}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.data) return data.data.map((post) => post.id);
    return [];
  } catch (err) {
    console.error("Fetch error:", err.message);
    return [];
  }
}

// --- API: Start Multi-Bot ---
app.post("/api/start-bot", async (req, res) => {
  const { tokens, targetId, reactions, comment } = req.body;

  if (!tokens || !Array.isArray(tokens) || tokens.length === 0)
    return res.status(400).json({ success: false, message: "Tokens required" });

  if (!targetId) return res.status(400).json({ success: false, message: "Target ID required" });

  if (!reactions || !Array.isArray(reactions))
    return res.status(400).json({ success: false, message: "Reactions must be an array" });

  if (activeBots[targetId]) {
    return res.json({ success: false, message: `Bot already running for target ${targetId}` });
  }

  let processedPosts = new Set();

  async function pollPosts() {
    try {
      const posts = await getLatestPosts(targetId, tokens[0]);
      for (let postId of posts) {
        if (!processedPosts.has(postId)) {
          processedPosts.add(postId);
          console.log(`🔔 New post detected: ${postId}`);

          for (let token of tokens) {
            const reaction = reactions[Math.floor(Math.random() * reactions.length)];
            await reactPost(token, postId, reaction);
            await commentPost(token, postId, comment || "Awesome post!");
            await sharePost(token, postId);
            console.log(`✅ Bot reacted (${reaction}), commented & shared using token`);
          }
        }
      }
    } catch (err) {
      console.error("Bot error:", err.message);
    }
  }

  // Run immediately and every 10 seconds
  await pollPosts();
  const interval = setInterval(pollPosts, 10000);
  activeBots[targetId] = interval;

  res.json({
    success: true,
    message: `Live multi-bot started for ${targetId} with ${tokens.length} accounts.`,
  });
});

// --- API: Stop Bot ---
app.post("/api/stop-bot", (req, res) => {
  const { targetId } = req.body;
  if (activeBots[targetId]) {
    clearInterval(activeBots[targetId]);
    delete activeBots[targetId];
    res.json({ success: true, message: `Bot stopped for ${targetId}` });
  } else {
    res.json({ success: false, message: "No active bot for this ID" });
  }
});

// --- Serve Frontend ---
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🔥 Multi Facebook Bot running on port ${PORT}`));