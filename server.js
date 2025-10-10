// server.js
const express = require("express");
const fetch = require("node-fetch");
const cors = require("cors");
const bodyParser = require("body-parser");
const path = require("path");

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

/**
 * activeBots structure:
 * {
 *   targetId: {
 *     intervalId,
 *     processedPosts: Set(),
 *     activatedAt: timestampMs,
 *     tokens: [ ... ], // current tokens (may be refreshed)
 *     meta: { reactions, comment, appId, appSecret }
 *   }
 * }
 */
const activeBots = {};

// --- Helpers ---
async function reactPost(token, postId, reaction) {
  try {
    const url = `https://graph.facebook.com/v18.0/${postId}/reactions?type=${reaction}&access_token=${token}`;
    const r = await fetch(url, { method: "POST" });
    return await r.json();
  } catch (err) {
    return { error: err.message };
  }
}

async function commentPost(token, postId, message) {
  try {
    const url = `https://graph.facebook.com/v18.0/${postId}/comments?message=${encodeURIComponent(
      message
    )}&access_token=${token}`;
    const r = await fetch(url, { method: "POST" });
    return await r.json();
  } catch (err) {
    return { error: err.message };
  }
}

async function sharePost(token, postId) {
  try {
    const url = `https://graph.facebook.com/v18.0/me/feed?link=https://www.facebook.com/${postId}&access_token=${token}`;
    const r = await fetch(url, { method: "POST" });
    return await r.json();
  } catch (err) {
    return { error: err.message };
  }
}

// Get latest posts (with created_time)
async function getLatestPosts(targetId, token) {
  try {
    const url = `https://graph.facebook.com/v18.0/${encodeURIComponent(
      targetId
    )}/posts?fields=id,created_time&limit=10&access_token=${token}`;
    const r = await fetch(url);
    const data = await r.json();
    if (data && Array.isArray(data.data)) return data.data; // items with id and created_time
    return [];
  } catch (err) {
    console.error("getLatestPosts error:", err.message);
    return [];
  }
}

/**
 * Exchange short-lived token for long-lived token (if appId/appSecret available)
 * Returns new token string or null on failure.
 */
async function exchangeForLongLivedToken(shortToken, appId, appSecret) {
  if (!appId || !appSecret || !shortToken) return null;
  try {
    const url = `https://graph.facebook.com/v18.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${encodeURIComponent(
      appId
    )}&client_secret=${encodeURIComponent(appSecret)}&fb_exchange_token=${encodeURIComponent(shortToken)}`;
    const r = await fetch(url);
    const data = await r.json();
    if (data && data.access_token) return data.access_token;
    console.warn("exchangeForLongLivedToken failed:", data);
    return null;
  } catch (err) {
    console.error("exchangeForLongLivedToken error:", err.message);
    return null;
  }
}

/**
 * Validate a token using /debug_token (requires an app access token)
 * Returns true if valid (not expired) else false.
 */
async function validateToken(tokenToCheck, appId, appSecret) {
  if (!appId || !appSecret) return true; // cannot validate; assume user-provided token
  try {
    const appAccess = `${appId}|${appSecret}`;
    const url = `https://graph.facebook.com/debug_token?input_token=${encodeURIComponent(
      tokenToCheck
    )}&access_token=${encodeURIComponent(appAccess)}`;
    const r = await fetch(url);
    const data = await r.json();
    if (data && data.data && data.data.is_valid) return true;
    return false;
  } catch (err) {
    console.error("validateToken error:", err.message);
    return false;
  }
}

// --- Polling logic per target ---
async function pollForTarget(targetId) {
  const bot = activeBots[targetId];
  if (!bot) return;

  const { tokens, meta, processedPosts, activatedAt } = bot;
  // Use first token to list posts (we assume tokens have similar visibility)
  const listToken = tokens[0];

  const posts = await getLatestPosts(targetId, listToken);
  if (!posts || posts.length === 0) return;

  for (const p of posts) {
    const postId = p.id;
    const createdTime = p.created_time ? Date.parse(p.created_time) : null;

    // Only react if created_time exists and is after activation, otherwise skip
    if (createdTime && createdTime <= activatedAt) {
      // skip older posts
      continue;
    }

    if (processedPosts.has(postId)) continue; // already processed

    // mark processed
    processedPosts.add(postId);

    console.log(`New post (after activation) detected: ${postId} for target ${targetId}`);

    // For each token, attempt actions
    for (let idx = 0; idx < tokens.length; idx++) {
      let token = tokens[idx];

      // Try to validate token; if invalid and app credentials provided, attempt exchange once
      const ok = await validateToken(token, meta.appId, meta.appSecret);
      if (!ok && meta.appId && meta.appSecret) {
        console.log("Token invalid/expired — attempting exchange for long-lived token using app credentials");
        const exchanged = await exchangeForLongLivedToken(token, meta.appId, meta.appSecret);
        if (exchanged) {
          tokens[idx] = exchanged;
          token = exchanged;
          console.log("Token exchanged successfully for account index", idx);
        } else {
          console.warn("Token exchange failed for account index", idx);
        }
      }

      // React with random reaction from list (you can change to deterministic)
      try {
        const reaction = meta.reactions[Math.floor(Math.random() * meta.reactions.length)];
        const r1 = await reactPost(token, postId, reaction);
        console.log(`React result for token[${idx}]:`, r1);
      } catch (err) {
        console.error("React error", err.message);
      }

      // Comment
      try {
        const c = await commentPost(token, postId, meta.comment || "hi master");
        console.log(`Comment result for token[${idx}]:`, c);
      } catch (err) {
        console.error("Comment error", err.message);
      }

      // Share
      try {
        const s = await sharePost(token, postId);
        console.log(`Share result for token[${idx}]:`, s);
      } catch (err) {
        console.error("Share error", err.message);
      }
    } // end tokens loop
  } // end posts loop
}

// --- API endpoints ---

/**
 * Start multi-bot for a target.
 * Body: { tokens: [..], targetId, reactions: [..], comment, appId (optional), appSecret (optional) }
 * The bot will only act on posts whose created_time is AFTER activation time.
 */
app.post("/api/start-bot", async (req, res) => {
  try {
    const { tokens, targetId, reactions, comment, appId, appSecret } = req.body;
    if (!tokens || !Array.isArray(tokens) || tokens.length === 0) {
      return res.status(400).json({ success: false, error: "tokens (array) required" });
    }
    if (!targetId) return res.status(400).json({ success: false, error: "targetId required" });
    if (!reactions || !Array.isArray(reactions) || reactions.length === 0) {
      return res.status(400).json({ success: false, error: "reactions (array) required" });
    }
    if (activeBots[targetId]) {
      return res.json({ success: false, message: "Bot already running for this targetId" });
    }

    // activatedAt ensures we only react to posts after activation
    const activatedAt = Date.now();

    // create bot entry
    activeBots[targetId] = {
      intervalId: null,
      processedPosts: new Set(),
      activatedAt,
      tokens: tokens.slice(), // copy (may be refreshed)
      meta: { reactions, comment, appId, appSecret },
    };

    // Immediately poll once, then set interval (10s)
    await pollForTarget(targetId);
    activeBots[targetId].intervalId = setInterval(() => pollForTarget(targetId), 10000);

    return res.json({
      success: true,
      message: `Bot started for ${targetId}. Only new posts after activation (${new Date(activatedAt).toISOString()}) will be processed.`,
    });
  } catch (err) {
    console.error("start-bot error:", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Stop bot
 * Body: { targetId }
 */
app.post("/api/stop-bot", (req, res) => {
  const { targetId } = req.body;
  if (!targetId) return res.status(400).json({ success: false, error: "targetId required" });
  const bot = activeBots[targetId];
  if (!bot) return res.json({ success: false, message: "No active bot for this targetId" });
  clearInterval(bot.intervalId);
  delete activeBots[targetId];
  return res.json({ success: true, message: `Bot stopped for ${targetId}` });
});

/**
 * Status endpoint to list active bots
 */
app.get("/api/status", (req, res) => {
  const keys = Object.keys(activeBots);
  const status = keys.map((k) => ({
    targetId: k,
    activatedAt: new Date(activeBots[k].activatedAt).toISOString(),
    accounts: activeBots[k].tokens.length,
    reactions: activeBots[k].meta.reactions,
  }));
  res.json({ success: true, bots: status });
});

// Serve frontend
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Multi-bot server running on port ${PORT}`));