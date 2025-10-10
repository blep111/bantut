const express = require('express');
const fetch = require('node-fetch');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// In-memory cooldown and daily limits
let userStatus = {}; // { token: { used: 0, lastUsed: timestamp, resetTime } }
const COOLDOWN_MINUTES = 15;
const DAILY_LIMIT = 10;

// API to react manually
app.post('/api/react', async (req, res) => {
  const { token, postId, reaction } = req.body;
  if (!token || !postId || !reaction) return res.status(400).json({ success: false, error: 'Missing token, postId, or reaction' });
  const now = Date.now();
  if (!userStatus[token]) userStatus[token] = { used: 0, lastUsed: 0, resetTime: now + 24*60*60*1000 };
  const status = userStatus[token];

  if (now > status.resetTime) { status.used=0; status.resetTime=now+24*60*60*1000; }
  if (now - status.lastUsed < COOLDOWN_MINUTES*60*1000) {
    return res.json({ success:false,error:'Cooldown active' });
  }
  if (status.used>=DAILY_LIMIT) {
    return res.json({ success:false,error:'Daily limit reached' });
  }

  try{
    const url = `https://graph.facebook.com/v18.0/${encodeURIComponent(postId)}/reactions?type=${reaction}&access_token=${token}`;
    const resp = await fetch(url, { method:'POST' });
    const data = await resp.json();
    if(!resp.ok || data.error) return res.json({ success:false, error:data.error ? data.error.message:'Graph API error' });

    status.used+=1; status.lastUsed=now;
    return res.json({ success:true, data, used: status.used, remaining: DAILY_LIMIT - status.used });
  }catch(err){ return res.json({ success:false, error:'Server error', details:err.message }); }
});

// API to run bot automatically on multiple posts
app.post('/api/bot-react', async (req, res) => {
  const { token, posts, reaction } = req.body;
  if(!token || !posts || !Array.isArray(posts) || !reaction) return res.status(400).json({ success:false, error:'Missing fields' });

  const results = [];
  for(const post of posts){
    try{
      const url = `https://graph.facebook.com/v18.0/${encodeURIComponent(post)}/reactions?type=${reaction}&access_token=${token}`;
      const resp = await fetch(url,{ method:'POST' });
      const data = await resp.json();
      results.push({ post, success: !data.error, response:data });
    }catch(err){
      results.push({ post, success:false, error: err.message });
    }
  }
  return res.json({ success:true, results });
});

app.get('*', (req,res) => { res.sendFile(path.join(__dirname,'public','index.html')); });

const PORT = process.env.PORT || 3000;
app.listen(PORT,()=>console.log(`Server running on port ${PORT}`));