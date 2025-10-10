import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import fs from 'fs';
import fetch from 'node-fetch';

const app = express();
const PORT = process.env.PORT || 3000;
const TOKEN_FILE = './data/tokens.json';

app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));

// Load tokens from file
let tokens = [];
if (fs.existsSync(TOKEN_FILE)) {
    tokens = JSON.parse(fs.readFileSync(TOKEN_FILE));
}

// Save tokens to file
const saveTokens = () => fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2));

// API: Get all tokens
app.get('/api/tokens', (req, res) => {
    res.json({ success: true, tokens });
});

// API: Add token
app.post('/api/token/add', (req, res) => {
    const { token } = req.body;
    if (!token) return res.json({ success: false, error: 'Token is required' });
    if (!tokens.includes(token)) {
        tokens.push(token);
        saveTokens();
    }
    res.json({ success: true, tokens });
});

// API: Remove token
app.post('/api/token/remove', (req, res) => {
    const { token } = req.body;
    tokens = tokens.filter(t => t !== token);
    saveTokens();
    res.json({ success: true, tokens });
});

// API: Start bot
let botInterval = null;
let lastPostId = null;

app.post('/api/bot/start', (req, res) => {
    const { targetId, commentText } = req.body;
    if (!targetId) return res.json({ success: false, error: 'Target ID is required' });

    if (botInterval) clearInterval(botInterval);

    botInterval = setInterval(async () => {
        try {
            for (const token of tokens) {
                // Get latest posts of target
                const response = await fetch(`https://graph.facebook.com/v17.0/${targetId}/posts?access_token=${token}&fields=id,message,created_time&limit=1`);
                const data = await response.json();

                if (data.data && data.data.length > 0) {
                    const latestPost = data.data[0];

                    // Skip if already reacted
                    if (latestPost.id === lastPostId) continue;
                    lastPostId = latestPost.id;

                    // React
                    await fetch(`https://graph.facebook.com/v17.0/${latestPost.id}/reactions?type=LOVE&access_token=${token}`, { method: 'POST' });

                    // Comment
                    if (commentText) {
                        await fetch(`https://graph.facebook.com/v17.0/${latestPost.id}/comments?message=${encodeURIComponent(commentText)}&access_token=${token}`, { method: 'POST' });
                    }

                    // Share
                    await fetch(`https://graph.facebook.com/v17.0/me/feed?link=https://www.facebook.com/${latestPost.id}&access_token=${token}`, { method: 'POST' });
                    
                    console.log(`Token ${token.substring(0,10)}... reacted, commented, and shared post ${latestPost.id}`);
                }
            }
        } catch (error) {
            console.error('Bot error:', error);
        }
    }, 5000); // Check every 5 seconds

    res.json({ success: true, message: 'Bot started' });
});

// API: Stop bot
app.post('/api/bot/stop', (req, res) => {
    if (botInterval) clearInterval(botInterval);
    botInterval = null;
    lastPostId = null;
    res.json({ success: true, message: 'Bot stopped' });
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));