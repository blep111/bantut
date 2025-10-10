// server.js
// Safe personal-account automation: encrypted token store, persistent bots, retries/backoff, token refresh optional.

const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

/* ---------- Config & Files ---------- */
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const TOKENS_FILE = path.join(DATA_DIR, 'tokens.json');        // encrypted tokens storage
const STATE_FILE = path.join(DATA_DIR, 'activeBots.json');    // persist active bots state
const SECRET_FILE = path.join(DATA_DIR, 'secret.key');        // encryption key (if not provided via env)

/* ---------- Encryption helpers (AES-256-GCM) ---------- */
function getKey() {
  const env = process.env.TOKEN_ENCRYPTION_KEY;
  if (env) return Buffer.from(env, 'base64');
  if (fs.existsSync(SECRET_FILE)) {
    return Buffer.from(fs.readFileSync(SECRET_FILE, 'utf8').trim(), 'base64');
  }
  const key = crypto.randomBytes(32);
  fs.writeFileSync(SECRET_FILE, key.toString('base64'), { mode: 0o600 });
  console.warn('Generated local secret.key; provide TOKEN_ENCRYPTION_KEY env for production.');
  return key;
}
const ENC_KEY = getKey();
if (!ENC_KEY || ENC_KEY.length !== 32) {
  console.error('Encryption key must be 32 bytes. Provide TOKEN_ENCRYPTION_KEY (base64).');
  process.exit(1);
}

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv);
  const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}
function decrypt(b64) {
  try {
    const buf = Buffer.from(b64, 'base64');
    const iv = buf.slice(0,12);
    const tag = buf.slice(12,28);
    const enc = buf.slice(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', ENC_KEY, iv);
    decipher.setAuthTag(tag);
    const out = Buffer.concat([decipher.update(enc), decipher.final()]);
    return out.toString('utf8');
  } catch (err) {
    console.error('decrypt failed', err.message);
    return null;
  }
}

/* ---------- Persistent storage helpers ---------- */
function loadJSON(filepath, fallback) {
  try {
    if (!fs.existsSync(filepath)) return fallback;
    return JSON.parse(fs.readFileSync(filepath,'utf8'));
  } catch (e) {
    console.error('loadJSON error', filepath, e.message);
    return fallback;
  }
}
function saveJSON(filepath, obj) {
  fs.writeFileSync(filepath, JSON.stringify(obj, null, 2), { mode: 0o600 });
}

/* ---------- Token store ---------- */
let storedTokens = loadJSON(TOKENS_FILE, []); // [{id,name,tokenEnc,createdAt}]
function persistTokens(){ saveJSON(TOKENS_FILE, storedTokens); }

/* ---------- Active bots (in-memory + persistence) ---------- */
/*
 activeBots structure:
 { targetId: {
     intervalId,
     processedPosts: Set,
     activatedAt,
     accounts: [{id,name,token}],
     meta: { reactions, comment, perAccountDelayMs },
     running: true
   }
 }
*/
let activeBots = {};
// restore if state exists
(function restoreState(){
  const saved = loadJSON(STATE_FILE, null);
  if (!saved) return;
  for (const s of saved) {
    // cannot restore decrypted tokens here; require user to re-start bots via UI to load tokens from storedTokens
    // we save minimal state so UI can show prior bots
    activeBots[s.targetId] = {
      restored: true,
      activatedAt: s.activatedAt,
      meta: s.meta
    };
  }
})();

function persistBotsState() {
  const arr = Object.keys(activeBots).map(targetId => {
    const b = activeBots[targetId];
    return { targetId, activatedAt: b.activatedAt, meta: b.meta };
  });
  saveJSON(STATE_FILE, arr);
}

/* ---------- Graph helpers + safe retries/backoff ---------- */
async function fetchJson(url, opts = {}) {
  try {
    const r = await fetch(url, opts);
    const j = await r.json().catch(()=>({}));
    return j;
  } catch (err) {
    return { error: err.message };
  }
}

async function graphReact(token, postId, reaction) {
  const url = `https://graph.facebook.com/v18.0/${postId}/reactions?type=${reaction}&access_token=${encodeURIComponent(token)}`;
  return await fetchJson(url, { method: 'POST' });
}
async function graphComment(token, postId, text) {
  const url = `https://graph.facebook.com/v18.0/${postId}/comments?message=${encodeURIComponent(text)}&access_token=${encodeURIComponent(token)}`;
  return await fetchJson(url, { method: 'POST' });
}
async function graphShare(token, postId) {
  const url = `https://graph.facebook.com/v18.0/me/feed?link=${encodeURIComponent(`https://www.facebook.com/${postId}`)}&access_token=${encodeURIComponent(token)}`;
  return await fetchJson(url, { method: 'POST' });
}
async function graphGetPosts(targetId, token, limit=10) {
  const url = `https://graph.facebook.com/v18.0/${encodeURIComponent(targetId)}/posts?fields=id,created_time,permalink_url,message&limit=${limit}&access_token=${encodeURIComponent(token)}`;
  return await fetchJson(url);
}

/* Exponential backoff retry helper */
async function retry(fn, attempts=3, baseDelayMs=700) {
  let lastErr = null;
  for (let i=0;i<attempts;i++) {
    const res = await fn();
    if (!res || res.error || res.error_description || res.error_message || res.error_code) {
      lastErr = res;
      await new Promise(r => setTimeout(r, baseDelayMs * Math.pow(2,i)));
      continue;
    }
    return res;
  }
  return lastErr;
}

/* ---------- API: Token management ---------- */

// Add token (encrypt and store) — only for accounts you own
app.post('/api/add-token', (req, res) => {
  const { token, name } = req.body;
  if (!token || token.length < 10) return res.status(400).json({ success:false, error:'token required' });
  const id = crypto.randomBytes(6).toString('hex');
  const entry = { id, name: name || `acc-${id}`, tokenEnc: encrypt(token), createdAt: new Date().toISOString() };
  storedTokens.push(entry);
  persistTokens();
  res.json({ success:true, id, name: entry.name });
});

app.get('/api/tokens', (req, res) => {
  const list = storedTokens.map(t => ({ id: t.id, name: t.name, createdAt: t.createdAt }));
  res.json({ success:true, tokens: list });
});

app.delete('/api/tokens/:id', (req, res) => {
  const id = req.params.id;
  const idx = storedTokens.findIndex(t => t.id === id);
  if (idx === -1) return res.status(404).json({ success:false, error:'not found' });
  storedTokens.splice(idx,1);
  persistTokens();
  res.json({ success:true });
});

/* ---------- Diagnostics endpoints ---------- */
// Test token: returns /me or debug info
app.post('/api/test-token', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ success:false, error:'token required' });
  const r = await fetchJson(`https://graph.facebook.com/v18.0/me?access_token=${encodeURIComponent(token)}`);
  res.json({ success: true, result: r });
});

// Check target visibility via token
app.post('/api/check-target', async (req, res) => {
  const { token, targetId } = req.body;
  if (!token || !targetId) return res.status(400).json({ success:false, error:'token and targetId required' });
  const r = await graphGetPosts(targetId, token);
  res.json({ success:true, result: r });
});

/* ---------- Bot control (start / stop / status) ---------- */

function buildAccountsFromIds(tokenIds) {
  const accounts = [];
  for (const id of tokenIds) {
    const e = storedTokens.find(t => t.id === id);
    if (!e) continue;
    const tok = decrypt(e.tokenEnc);
    if (!tok) continue;
    accounts.push({ id: e.id, name: e.name, token: tok });
  }
  return accounts;
}

// Start bot: tokenIds (stored), targetId, reactions[], comment, perAccountDelayMs (optional), appId/appSecret (optional for token exchange)
// NOTE: bot will only process posts created AFTER activationTime
app.post('/api/start-bot', async (req, res) => {
  try {
    const { tokenIds, targetId, reactions, comment, perAccountDelayMs = 1000, appId, appSecret } = req.body;
    if (!tokenIds || !Array.isArray(tokenIds) || tokenIds.length === 0) return res.status(400).json({ success:false, error:'tokenIds required' });
    if (!targetId) return res.status(400).json({ success:false, error:'targetId required' });
    if (!reactions || !Array.isArray(reactions) || reactions.length === 0) return res.status(400).json({ success:false, error:'reactions array required' });

    if (activeBots[targetId] && activeBots[targetId].running) return res.json({ success:false, message:'Bot already running for this target' });

    // build accounts
    const accounts = buildAccountsFromIds(tokenIds);
    if (!accounts || accounts.length === 0) return res.status(400).json({ success:false, error:'no valid stored tokens found' });

    // optional: exchange tokens for long-lived using appId/appSecret (best-effort)
    if (appId && appSecret) {
      for (let i=0;i<accounts.length;i++) {
        try {
          const shortToken = accounts[i].token;
          const exchUrl = `https://graph.facebook.com/v18.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${encodeURIComponent(appId)}&client_secret=${encodeURIComponent(appSecret)}&fb_exchange_token=${encodeURIComponent(shortToken)}`;
          const exch = await fetchJson(exchUrl);
          if (exch && exch.access_token) {
            accounts[i].token = exch.access_token;
          }
        } catch(e){ /* ignore */ }
      }
    }

    // create bot entry
    const bot = {
      intervalId: null,
      processedPosts: new Set(),
      activatedAt: Date.now(),
      accounts,
      meta: { reactions, comment, perAccountDelayMs },
      running: true
    };
    activeBots[targetId] = bot;
    persistBotsState();

    // immediate poll then periodic
    await pollForTarget(targetId).catch(e=>console.error(e));
    bot.intervalId = setInterval(() => pollForTarget(targetId).catch(e=>console.error(e)), 8000);

    return res.json({ success:true, message:`Bot started for ${targetId} with ${accounts.length} accounts` });
  } catch (err) {
    console.error('start-bot err', err);
    return res.status(500).json({ success:false, error: err.message });
  }
});

app.post('/api/stop-bot', (req, res) => {
  const { targetId } = req.body;
  if (!targetId) return res.status(400).json({ success:false, error:'targetId required' });
  const bot = activeBots[targetId];
  if (!bot) return res.json({ success:false, message:'No active bot for this target' });
  if (bot.intervalId) clearInterval(bot.intervalId);
  bot.running = false;
  delete activeBots[targetId];
  persistBotsState();
  return res.json({ success:true, message:`Bot stopped for ${targetId}` });
});

app.get('/api/status', (req, res) => {
  const status = Object.keys(activeBots).map(tid => {
    const b = activeBots[tid];
    return { targetId: tid, activatedAt: new Date(b.activatedAt).toISOString(), accounts: b.accounts.map(a=>({id:a.id,name:a.name})), reactions: b.meta.reactions };
  });
  res.json({ success:true, bots: status });
});

/* ---------- Polling logic (process only posts created after activation) ---------- */

async function pollForTarget(targetId) {
  const bot = activeBots[targetId];
  if (!bot || !bot.running) return;
  const listToken = bot.accounts[0].token;
  const postsResp = await graphGetPosts(targetId, listToken);
  if (!postsResp || !Array.isArray(postsResp.data)) return;

  for (const p of postsResp.data) {
    const postId = p.id;
    const created = p.created_time ? Date.parse(p.created_time) : null;
    if (created && created <= bot.activatedAt) continue; // only new posts
    if (bot.processedPosts.has(postId)) continue;
    bot.processedPosts.add(postId);

    // perform actions per account with small delay between accounts to reduce rate pressure
    for (let i=0;i<bot.accounts.length;i++) {
      const acc = bot.accounts[i];
      // Choose a reaction (round-robin or random)
      const reaction = bot.meta.reactions[i % bot.meta.reactions.length];
      // React (with retries)
      const reactRes = await retry(()=>graphReact(acc.token, postId, reaction), 3);
      // Comment
      const commentRes = await retry(()=>graphComment(acc.token, postId, bot.meta.comment || 'hi master'), 3);
      // Share
      const shareRes = await retry(()=>graphShare(acc.token, postId), 3);

      // log to filesystem for auditing
      const entry = {
        time: new Date().toISOString(),
        targetId,
        postId,
        accountId: acc.id,
        accountName: acc.name,
        reactionResult: reactRes,
        commentResult: commentRes,
        shareResult: shareRes
      };
      // append to per-target log file
      const logfile = path.join(DATA_DIR, `actions_${targetId}.log`);
      fs.appendFileSync(logfile, JSON.stringify(entry) + '\n');

      // delay between accounts
      await new Promise(r=>setTimeout(r, bot.meta.perAccountDelayMs || 1000));
    }
  }
}

/* ---------- Serve frontend ---------- */
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

/* ---------- Start server ---------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> console.log(`Server running on ${PORT}`));