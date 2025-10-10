// server.js
const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

/**
 * CONFIG
 * Provide TOKEN_ENCRYPTION_KEY as 32-byte base64 string in env for best security.
 * If not present, server will create a secret.key file on first run (less secure).
 */
const TOKENS_FILE = path.join(__dirname, 'tokens.json');
const SECRET_FILE = path.join(__dirname, 'secret.key');

function getEncryptionKey() {
  const envKey = process.env.TOKEN_ENCRYPTION_KEY;
  if (envKey && envKey.length > 0) {
    // expect base64 string
    return Buffer.from(envKey, 'base64');
  }
  // fallback: create/read secret.key (32 bytes base64)
  if (fs.existsSync(SECRET_FILE)) {
    const b64 = fs.readFileSync(SECRET_FILE, 'utf8').trim();
    return Buffer.from(b64, 'base64');
  } else {
    const key = crypto.randomBytes(32);
    fs.writeFileSync(SECRET_FILE, key.toString('base64'), { mode: 0o600 });
    console.warn('No TOKEN_ENCRYPTION_KEY in env — generated secret.key (store it safely).');
    return key;
  }
}
const ENC_KEY = getEncryptionKey();
if (!ENC_KEY || ENC_KEY.length !== 32) {
  console.error('Encryption key must be 32 bytes. Set TOKEN_ENCRYPTION_KEY env var as base64(32bytes).');
  process.exit(1);
}

// encryption helpers (AES-256-GCM)
function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64'); // store as base64
}

function decrypt(b64) {
  try {
    const data = Buffer.from(b64, 'base64');
    const iv = data.slice(0, 12);
    const tag = data.slice(12, 28);
    const encrypted = data.slice(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', ENC_KEY, iv);
    decipher.setAuthTag(tag);
    const out = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return out.toString('utf8');
  } catch (err) {
    console.error('Decrypt error', err.message);
    return null;
  }
}

// tokens persistence
function loadTokens() {
  try {
    if (!fs.existsSync(TOKENS_FILE)) return [];
    const raw = fs.readFileSync(TOKENS_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('Failed loading tokens.json', err.message);
    return [];
  }
}

function saveTokens(arr) {
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(arr, null, 2), { mode: 0o600 });
}

// ensure file exists
if (!fs.existsSync(TOKENS_FILE)) saveTokens([]);

// helpers for token store
function maskTok(token) {
  if (!token) return '';
  return token.slice(0, 6) + '...' + token.slice(-6);
}

// load into memory
let storedTokens = loadTokens(); // array of { id, name, tokenEnc, createdAt }

// utility to generate id
function genId() {
  return crypto.randomBytes(8).toString('hex');
}

/* ====================================================================
   Facebook actions (same as previous bot)
   ==================================================================== */
async function reactPost(token, postId, reaction) {
  try {
    const url = `https://graph.facebook.com/v18.0/${postId}/reactions?type=${reaction}&access_token=${token}`;
    const r = await fetch(url, { method: 'POST' });
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
    const r = await fetch(url, { method: 'POST' });
    return await r.json();
  } catch (err) {
    return { error: err.message };
  }
}

async function sharePost(token, postId) {
  try {
    const url = `https://graph.facebook.com/v18.0/me/feed?link=https://www.facebook.com/${postId}&access_token=${token}`;
    const r = await fetch(url, { method: 'POST' });
    return await r.json();
  } catch (err) {
    return { error: err.message };
  }
}

async function getLatestPosts(targetId, token) {
  try {
    const url = `https://graph.facebook.com/v18.0/${encodeURIComponent(targetId)}/posts?fields=id,created_time&limit=10&access_token=${token}`;
    const r = await fetch(url);
    return (await r.json()).data || [];
  } catch (err) {
    console.error('getLatestPosts error', err.message);
    return [];
  }
}

/* ====================================================================
   Active bots management (uses tokens from store or direct tokens)
   activeBots[targetId] = { intervalId, processedPosts:Set, activatedAt, accounts: [{id, token}], meta:{reactions,comment} }
   ==================================================================== */
const activeBots = {};

async function pollForTarget(targetId) {
  const bot = activeBots[targetId];
  if (!bot) return;
  const { accounts, processedPosts, activatedAt, meta } = bot;
  if (!accounts || accounts.length === 0) return;

  // use first account to list posts (visibility assumption)
  const listToken = accounts[0].token;
  const posts = await getLatestPosts(targetId, listToken);

  for (const p of posts) {
    const postId = p.id;
    const createdTime = p.created_time ? Date.parse(p.created_time) : null;

    if (createdTime && createdTime <= activatedAt) continue; // ignore old posts
    if (processedPosts.has(postId)) continue;

    processedPosts.add(postId);
    console.log(`New post detected for ${targetId}: ${postId}`);

    for (let i = 0; i < accounts.length; i++) {
      const acc = accounts[i];
      const token = acc.token; // raw token string
      const reaction = meta.reactions[Math.floor(Math.random() * meta.reactions.length)];

      const r1 = await reactPost(token, postId, reaction);
      console.log(`Account ${acc.id} reacted:`, r1);

      const c1 = await commentPost(token, postId, meta.comment || 'hi master');
      console.log(`Account ${acc.id} commented:`, c1);

      const s1 = await sharePost(token, postId);
      console.log(`Account ${acc.id} shared:`, s1);
    }
  }
}

/* ====================================================================
   REST API: token management, start/stop bots, status
   ==================================================================== */

// Add a token to local store (encrypted)
// Body: { token: string, name?: string }
app.post('/api/add-token', (req, res) => {
  try {
    const { token, name } = req.body;
    if (!token || token.length < 10) return res.status(400).json({ success: false, error: 'token required' });

    const id = genId();
    const entry = {
      id,
      name: name || `acc-${id}`,
      tokenEnc: encrypt(token),
      createdAt: new Date().toISOString(),
    };
    storedTokens.push(entry);
    saveTokens(storedTokens);
    return res.json({ success: true, id, name: entry.name });
  } catch (err) {
    console.error('add-token error', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// List stored tokens (masked)
app.get('/api/tokens', (req, res) => {
  try {
    const result = storedTokens.map((t) => ({
      id: t.id,
      name: t.name,
      createdAt: t.createdAt,
      tokenMask: '*****' + t.id.slice(0, 4),
    }));
    return res.json({ success: true, tokens: result });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Remove token by id
app.delete('/api/tokens/:id', (req, res) => {
  try {
    const id = req.params.id;
    const idx = storedTokens.findIndex((t) => t.id === id);
    if (idx === -1) return res.status(404).json({ success: false, error: 'not found' });
    storedTokens.splice(idx, 1);
    saveTokens(storedTokens);
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Start multi-bot for a target using stored tokens (selectedIds) or direct tokens
// Body: { tokenIds?: [id,...], targetId, reactions: [...], comment }
// If tokenIds provided, will use stored tokens by id. Otherwise tokens param (raw) can be used.
app.post('/api/start-bot', async (req, res) => {
  try {
    const { tokenIds, tokens, targetId, reactions, comment } = req.body;
    if (!targetId) return res.status(400).json({ success: false, error: 'targetId required' });
    if (!reactions || !Array.isArray(reactions) || reactions.length === 0)
      return res.status(400).json({ success: false, error: 'reactions array required' });

    if (activeBots[targetId]) return res.json({ success: false, message: 'Bot already running for this targetId' });

    // build accounts array {id, token}
    let accounts = [];
    if (Array.isArray(tokenIds) && tokenIds.length > 0) {
      for (const id of tokenIds) {
        const entry = storedTokens.find((t) => t.id === id);
        if (!entry) continue;
        const tok = decrypt(entry.tokenEnc);
        if (!tok) {
          console.warn('Failed to decrypt token for id', id);
          continue;
        }
        accounts.push({ id: entry.id, name: entry.name, token: tok });
      }
    } else if (Array.isArray(tokens) && tokens.length > 0) {
      // raw tokens included in request (not recommended)
      accounts = tokens.map((t, idx) => ({ id: `tmp-${idx}`, name: `tmp-${idx}`, token: t }));
    } else {
      return res.status(400).json({ success: false, error: 'tokenIds or tokens required' });
    }

    if (accounts.length === 0) return res.status(400).json({ success: false, error: 'no valid accounts available' });

    const bot = {
      intervalId: null,
      processedPosts: new Set(),
      activatedAt: Date.now(),
      accounts,
      meta: { reactions, comment },
    };
    activeBots[targetId] = bot;

    // run immediately and then interval
    await pollForTarget(targetId);
    bot.intervalId = setInterval(() => pollForTarget(targetId), 10000);

    return res.json({ success: true, message: `Bot started for ${targetId} using ${accounts.length} accounts.` });
  } catch (err) {
    console.error('start-bot error', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Stop bot
app.post('/api/stop-bot', (req, res) => {
  try {
    const { targetId } = req.body;
    if (!targetId) return res.status(400).json({ success: false, error: 'targetId required' });
    const b = activeBots[targetId];
    if (!b) return res.json({ success: false, message: 'No active bot for this targetId' });
    clearInterval(b.intervalId);
    delete activeBots[targetId];
    return res.json({ success: true, message: `Bot stopped for ${targetId}` });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// status
app.get('/api/status', (req, res) => {
  const keys = Object.keys(activeBots);
  const status = keys.map((k) => ({
    targetId: k,
    activatedAt: new Date(activeBots[k].activatedAt).toISOString(),
    accounts: activeBots[k].accounts.map((a) => ({ id: a.id, name: a.name })),
    reactions: activeBots[k].meta.reactions,
  }));
  res.json({ success: true, bots: status });
});

/* Serve frontend */
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/* Start server */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));