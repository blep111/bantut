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

// ---- Simple persistent token store (encrypted) ----
const TOKENS_FILE = path.join(__dirname, 'tokens.json');
const SECRET_FILE = path.join(__dirname, 'secret.key');

function getEncryptionKey() {
  const envKey = process.env.TOKEN_ENCRYPTION_KEY;
  if (envKey) return Buffer.from(envKey, 'base64');
  if (fs.existsSync(SECRET_FILE)) {
    return Buffer.from(fs.readFileSync(SECRET_FILE, 'utf8').trim(), 'base64');
  }
  const key = crypto.randomBytes(32);
  fs.writeFileSync(SECRET_FILE, key.toString('base64'), { mode: 0o600 });
  console.warn('No TOKEN_ENCRYPTION_KEY provided — created secret.key locally.');
  return key;
}
const ENC_KEY = getEncryptionKey();
if (!ENC_KEY || ENC_KEY.length !== 32) {
  console.error('Encryption key must be 32 bytes (base64). Provide TOKEN_ENCRYPTION_KEY env or allow server to create secret.key.');
  process.exit(1);
}

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
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
    console.error('decrypt error', err.message);
    return null;
  }
}
function loadStoredTokens() {
  try {
    if (!fs.existsSync(TOKENS_FILE)) return [];
    return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
  } catch (err) {
    console.error('loadStoredTokens error', err.message);
    return [];
  }
}
function saveStoredTokens(arr) {
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(arr, null, 2), { mode: 0o600 });
}
if (!fs.existsSync(TOKENS_FILE)) saveStoredTokens([]);

// in-memory data
let storedTokens = loadStoredTokens(); // objects: { id, name, tokenEnc, createdAt }
let activeBots = {}; // targetId => { intervalId, processedPosts:Set, accounts:[{id,name,token}], meta:{reactions,comment}, activatedAt }
let logs = []; // keep recent logs

function pushLog(obj) {
  obj.time = new Date().toISOString();
  logs.unshift(obj);
  if (logs.length > 500) logs.length = 500;
}

// ---- Graph API helpers ----
async function graphGet(pathUrl) {
  const resp = await fetch(pathUrl);
  const json = await resp.json();
  return json;
}
async function reactPost(token, postId, reaction) {
  const url = `https://graph.facebook.com/v18.0/${postId}/reactions?type=${reaction}&access_token=${token}`;
  return graphGet(url);
}
async function commentPost(token, postId, message) {
  const url = `https://graph.facebook.com/v18.0/${postId}/comments?message=${encodeURIComponent(message)}&access_token=${token}`;
  return graphGet(url);
}
async function sharePost(token, postId) {
  const url = `https://graph.facebook.com/v18.0/me/feed?link=${encodeURIComponent(`https://www.facebook.com/${postId}`)}&access_token=${token}`;
  return graphGet(url);
}
async function getPostsForTarget(targetId, token) {
  const url = `https://graph.facebook.com/v18.0/${encodeURIComponent(targetId)}/posts?fields=id,created_time,message,permalink_url&limit=10&access_token=${token}`;
  return graphGet(url);
}
async function debugToken(inputToken, appId, appSecret) {
  // If no appId/appSecret: return the token /basic info via /me?access_token=
  if (!appId || !appSecret) {
    try {
      const me = await graphGet(`https://graph.facebook.com/v18.0/me?access_token=${encodeURIComponent(inputToken)}`);
      return { raw: me };
    } catch (err) {
      return { error: err.message };
    }
  }
  // use debug_token
  const appAccess = `${appId}|${appSecret}`;
  try {
    return await graphGet(`https://graph.facebook.com/debug_token?input_token=${encodeURIComponent(inputToken)}&access_token=${encodeURIComponent(appAccess)}`);
  } catch (err) {
    return { error: err.message };
  }
}

// ---- Token store endpoints ----
app.post('/api/add-token', (req, res) => {
  const { token, name } = req.body;
  if (!token || token.length < 10) return res.status(400).json({ success: false, error: 'token required' });
  const id = crypto.randomBytes(6).toString('hex');
  const entry = { id, name: name || `acc-${id}`, tokenEnc: encrypt(token), createdAt: new Date().toISOString() };
  storedTokens.push(entry);
  saveStoredTokens(storedTokens);
  pushLog({ type: 'token:add', id: entry.id, name: entry.name });
  return res.json({ success: true, id: entry.id, name: entry.name });
});

app.get('/api/tokens', (req, res) => {
  const list = storedTokens.map(t => ({ id: t.id, name: t.name, createdAt: t.createdAt }));
  res.json({ success: true, tokens: list });
});

app.delete('/api/tokens/:id', (req, res) => {
  const id = req.params.id;
  const idx = storedTokens.findIndex(t => t.id === id);
  if (idx === -1) return res.status(404).json({ success: false, error: 'not found' });
  const removed = storedTokens.splice(idx, 1)[0];
  saveStoredTokens(storedTokens);
  pushLog({ type: 'token:remove', id: removed.id, name: removed.name });
  res.json({ success: true });
});

// ---- Diagnostic endpoints ----
// Test token (optionally appId/appSecret) -> returns debug_token result or /me
app.post('/api/test-token', async (req, res) => {
  const { token, appId, appSecret } = req.body;
  if (!token) return res.status(400).json({ success: false, error: 'token required' });
  try {
    const debug = await debugToken(token, appId, appSecret);
    res.json({ success: true, result: debug });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Check target: returns posts visible to the token
app.post('/api/check-target', async (req, res) => {
  const { token, targetId } = req.body;
  if (!token || !targetId) return res.status(400).json({ success: false, error: 'token and targetId required' });
  try {
    const posts = await getPostsForTarget(targetId, token);
    res.json({ success: true, result: posts });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// logs
app.get('/api/logs', (req, res) => {
  res.json({ success: true, logs });
});

// ---- Bot core ----
async function pollForTarget(targetId) {
  const bot = activeBots[targetId];
  if (!bot) return;
  const { accounts, processedPosts, activatedAt, meta } = bot;
  if (!accounts || accounts.length === 0) return;

  const listToken = accounts[0].token;
  let postsResp;
  try {
    postsResp = await getPostsForTarget(targetId, listToken);
  } catch (err) {
    pushLog({ type: 'error', targetId, message: 'Failed fetch posts', error: err.message });
    return;
  }
  if (!postsResp || !Array.isArray(postsResp.data)) {
    pushLog({ type: 'error', targetId, message: 'No posts data returned', raw: postsResp });
    return;
  }

  for (const p of postsResp.data) {
    const postId = p.id;
    const createdTime = p.created_time ? Date.parse(p.created_time) : null;
    // only process posts created after activation
    if (createdTime && createdTime <= activatedAt) continue;
    if (processedPosts.has(postId)) continue;
    processedPosts.add(postId);

    pushLog({ type: 'post:detected', targetId, postId, created_time: p.created_time, message: p.message || '' });

    // perform actions with each account
    for (let i = 0; i < accounts.length; i++) {
      const acc = accounts[i];
      const token = acc.token;
      // React
      try {
        const reaction = meta.reactions[Math.floor(Math.random()*meta.reactions.length)];
        const r = await reactPost(token, postId, reaction);
        pushLog({ type: 'action', action: 'react', account: acc.name, accountId: acc.id, postId, reaction, result: r });
      } catch (err) {
        pushLog({ type: 'action-error', action: 'react', account: acc.name, postId, error: err.message });
      }
      // Comment
      try {
        const c = await commentPost(token, postId, meta.comment || 'hi master');
        pushLog({ type: 'action', action: 'comment', account: acc.name, accountId: acc.id, postId, result: c });
      } catch (err) {
        pushLog({ type: 'action-error', action: 'comment', account: acc.name, postId, error: err.message });
      }
      // Share
      try {
        const s = await sharePost(token, postId);
        pushLog({ type: 'action', action: 'share', account: acc.name, accountId: acc.id, postId, result: s });
      } catch (err) {
        pushLog({ type: 'action-error', action: 'share', account: acc.name, postId, error: err.message });
      }
    } // accounts loop
  } // posts loop
}

// Start bot: choose tokens by tokenIds (stored) or raw tokens
app.post('/api/start-bot', async (req, res) => {
  try {
    const { tokenIds, tokens, targetId, reactions, comment } = req.body;
    if (!targetId) return res.status(400).json({ success: false, error: 'targetId required' });
    if (!reactions || !Array.isArray(reactions) || reactions.length === 0) return res.status(400).json({ success: false, error: 'reactions array required' });

    if (activeBots[targetId]) return res.json({ success: false, message: 'Bot already running for this targetId' });

    let accounts = [];
    if (Array.isArray(tokenIds) && tokenIds.length > 0) {
      for (const id of tokenIds) {
        const e = storedTokens.find(t => t.id === id);
        if (!e) continue;
        const tok = decrypt(e.tokenEnc);
        if (!tok) {
          pushLog({ type:'error', message:'cannot decrypt token', id: e.id });
          continue;
        }
        accounts.push({ id: e.id, name: e.name, token: tok });
      }
    } else if (Array.isArray(tokens) && tokens.length > 0) {
      accounts = tokens.map((t,i)=>({ id: `tmp-${i}`, name: `tmp-${i}`, token: t }));
    } else {
      return res.status(400).json({ success: false, error: 'tokenIds or tokens required' });
    }

    if (accounts.length === 0) return res.status(400).json({ success: false, error: 'no accounts available' });

    activeBots[targetId] = {
      intervalId: null,
      processedPosts: new Set(),
      activatedAt: Date.now(),
      accounts,
      meta: { reactions, comment }
    };

    // immediately poll once and then set interval
    await pollForTarget(targetId);
    activeBots[targetId].intervalId = setInterval(() => pollForTarget(targetId), 10000);

    pushLog({ type: 'bot:start', targetId, accounts: accounts.map(a=>a.name) });

    return res.json({ success: true, message: `Bot started for ${targetId} using ${accounts.length} accounts.` });
  } catch (err) {
    console.error('start-bot error', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// stop
app.post('/api/stop-bot', (req, res) => {
  const { targetId } = req.body;
  if (!targetId) return res.status(400).json({ success: false, error: 'targetId required' });
  const b = activeBots[targetId];
  if (!b) return res.json({ success: false, message: 'No active bot for this targetId' });
  clearInterval(b.intervalId);
  delete activeBots[targetId];
  pushLog({ type: 'bot:stop', targetId });
  res.json({ success: true, message: `Bot stopped for ${targetId}` });
});

app.get('/api/status', (req, res) => {
  const bots = Object.keys(activeBots).map(k => ({
    targetId: k,
    activatedAt: new Date(activeBots[k].activatedAt).toISOString(),
    accounts: activeBots[k].accounts.map(a => ({ id: a.id, name: a.name })),
    reactions: activeBots[k].meta.reactions
  }));
  res.json({ success: true, bots });
});

// serve UI
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on ${PORT}`));