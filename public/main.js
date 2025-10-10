const tokenList = document.getElementById('token-list');
const newTokenInput = document.getElementById('new-token');
const addTokenBtn = document.getElementById('addTokenBtn');
const startBotBtn = document.getElementById('startBotBtn');
const stopBotBtn = document.getElementById('stopBotBtn');
const targetIdInput = document.getElementById('targetId');
const commentInput = document.getElementById('commentText');
const statusEl = document.getElementById('status');

const loadTokens = async () => {
  const res = await fetch('/api/tokens');
  const data = await res.json();
  tokenList.innerHTML = data.tokens.map(t => `<div>${t.substring(0, 10)}...</div>`).join('');
};

addTokenBtn.addEventListener('click', async () => {
  const token = newTokenInput.value.trim();
  if (!token) return alert('Enter token');
  await fetch('/api/token/add', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token })
  });
  newTokenInput.value = '';
  loadTokens();
});

startBotBtn.addEventListener('click', async () => {
  const targetId = targetIdInput.value.trim();
  const commentText = commentInput.value.trim();
  if (!targetId) return alert('Enter target ID');
  await fetch('/api/bot/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ targetId, commentText })
  });
  statusEl.textContent = 'Bot running...';
});

stopBotBtn.addEventListener('click', async () => {
  await fetch('/api/bot/stop', { method: 'POST' });
  statusEl.textContent = 'Bot stopped';
});

loadTokens();