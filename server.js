const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const { Resend } = require('resend');
const resend = new Resend('re_cfhokFpy_N8GCrGEdzPeGGHW9m5dNtpgR');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// In-memory storage
const users = {};       // email -> { email, password, nickname, gameHistory }
const sessions = {};    // sessionToken -> email
const rooms = {};       // roomCode -> { white, black, fen, moves, chat, status }
const pendingVerifications = {}; // email -> code

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  do {
    code = '';
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms[code]);
  return code;
}

function generateToken() {
  return uuidv4().replace(/-/g, '');
}

// ─── Auth Routes ────────────────────────────────────────────────────────────

app.post('/api/signup', (req, res) => {
  const { email, password, nickname } = req.body;
  if (!email || !password) return res.json({ ok: false, error: 'Email and password required' });
  if (password.length < 8) return res.json({ ok: false, error: 'Password must be at least 8 characters' });
  if (users[email]) return res.json({ ok: false, error: 'Email already registered' });
  if (nickname) {
    const taken = Object.values(users).some(u => u.nickname && u.nickname.toLowerCase() === nickname.toLowerCase());
    if (taken) return res.json({ ok: false, error: 'Nickname already taken' });
  }
  users[email] = { email, password, nickname: nickname || '', gameHistory: [] };
  res.json({ ok: true });
});

app.post('/api/login/request', async (req, res) => {
  const { email, password } = req.body;
  const user = users[email];
  if (!user || user.password !== password) return res.json({ ok: false, error: 'Invalid email or password' });
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  pendingVerifications[email] = { code, expires: Date.now() + 10 * 60 * 1000 };
  try {
    await resend.emails.send({
      from: 'Blobfish Chess <noreply@blobfish.space>',
      to: email,
      subject: 'Your Blobfish Chess Login Code',
      html: `<div style="font-family:sans-serif;max-width:400px;margin:0 auto;padding:24px;background:#1a1a2e;color:#e2e8f0;border-radius:12px"><h2 style="color:#4a9eff">🐟 Blobfish Chess</h2><p style="color:#94a3b8">Your login verification code:</p><div style="font-size:36px;font-weight:800;letter-spacing:10px;color:#4a9eff;background:#0f3460;padding:20px;border-radius:10px;text-align:center">${code}</div><p style="color:#94a3b8;font-size:13px;margin-top:16px">Expires in 10 minutes.</p></div>`
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('Email send error:', err);
    res.json({ ok: true });
  }
});

app.post('/api/login/verify', (req, res) => {
  const { email, code } = req.body;
  const pending = pendingVerifications[email];
  if (!pending) return res.json({ ok: false, error: 'No pending verification' });
  if (Date.now() > pending.expires) { delete pendingVerifications[email]; return res.json({ ok: false, error: 'Code expired' }); }
  if (pending.code !== code) return res.json({ ok: false, error: 'Invalid code' });
  delete pendingVerifications[email];
  const token = generateToken();
  sessions[token] = email;
  const user = users[email];
  res.json({ ok: true, token, nickname: user.nickname, email });
});

app.post('/api/logout', (req, res) => {
  const { token } = req.body;
  delete sessions[token];
  res.json({ ok: true });
});

app.get('/api/history', (req, res) => {
  const token = req.headers.authorization;
  const email = sessions[token];
  if (!email) return res.json({ ok: false, error: 'Not logged in' });
  res.json({ ok: true, history: users[email].gameHistory || [] });
});

app.post('/api/history/add', (req, res) => {
  const token = req.headers.authorization;
  const email = sessions[token];
  if (!email) return res.json({ ok: false, error: 'Not logged in' });
  const { result, opponent, opponentType } = req.body;
  users[email].gameHistory.unshift({ result, opponent, opponentType, date: new Date().toISOString() });
  if (users[email].gameHistory.length > 50) users[email].gameHistory.pop();
  res.json({ ok: true });
});

app.post('/api/nickname', (req, res) => {
  const token = req.headers.authorization;
  const email = sessions[token];
  if (!email) return res.json({ ok: false, error: 'Not logged in' });
  const { nickname } = req.body;
  if (nickname) {
    const taken = Object.values(users).some(u => u.email !== email && u.nickname && u.nickname.toLowerCase() === nickname.toLowerCase());
    if (taken) return res.json({ ok: false, error: 'Nickname already taken' });
  }
  users[email].nickname = nickname || '';
  res.json({ ok: true });
});

// ─── Room Routes ─────────────────────────────────────────────────────────────

app.post('/api/room/create', (req, res) => {
  const token = req.headers.authorization;
  const email = sessions[token];
  const code = generateRoomCode();
  const nick = email ? (users[email]?.nickname || email) : 'Guest';
  rooms[code] = {
    white: { email, nick, socketId: null },
    black: null,
    fen: 'start',
    moves: [],
    chat: [],
    status: 'waiting',
    created: Date.now()
  };
  res.json({ ok: true, code });
});

app.post('/api/room/join', (req, res) => {
  const { code } = req.body;
  const token = req.headers.authorization;
  const email = sessions[token];
  const room = rooms[code];
  if (!room) return res.json({ ok: false, error: 'Room not found' });
  if (room.status !== 'waiting') return res.json({ ok: false, error: 'Room is full or game already started' });
  const nick = email ? (users[email]?.nickname || email) : 'Guest';
  room.black = { email, nick, socketId: null };
  room.status = 'ready';
  res.json({ ok: true, code, whiteNick: room.white.nick, blackNick: nick });
});

// ─── Socket.io ───────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  socket.on('join-room', ({ code, color }) => {
    const room = rooms[code];
    if (!room) return socket.emit('error', 'Room not found');
    socket.join(code);
    if (color === 'white' && room.white) room.white.socketId = socket.id;
    if (color === 'black' && room.black) room.black.socketId = socket.id;
    if (room.white?.socketId && room.black?.socketId) {
      io.to(code).emit('game-start', { whiteNick: room.white.nick, blackNick: room.black.nick });
    }
    socket.emit('room-state', { fen: room.fen, moves: room.moves, chat: room.chat, status: room.status });
  });

  socket.on('move', ({ code, move, fen }) => {
    const room = rooms[code];
    if (!room) return;
    room.fen = fen;
    room.moves.push(move);
    socket.to(code).emit('move', { move, fen });
  });

  socket.on('chat', ({ code, message, nick }) => {
    const room = rooms[code];
    if (!room) return;
    const filtered = filterProfanity(message);
    const entry = { nick, message: filtered, time: Date.now() };
    room.chat.push(entry);
    io.to(code).emit('chat', entry);
  });

  socket.on('game-over', ({ code, result }) => {
    const room = rooms[code];
    if (!room) return;
    room.status = 'finished';
    io.to(code).emit('game-over', { result });
  });

  socket.on('offer-draw', ({ code }) => {
    socket.to(code).emit('draw-offered');
  });

  socket.on('accept-draw', ({ code }) => {
    io.to(code).emit('game-over', { result: 'draw' });
  });

  socket.on('resign', ({ code, color }) => {
    io.to(code).emit('game-over', { result: color === 'white' ? 'black wins' : 'white wins', reason: 'resignation' });
  });

  socket.on('reconnect-room', ({ code, color }) => {
    const room = rooms[code];
    if (!room) return;
    socket.join(code);
    socket.emit('room-state', { fen: room.fen, moves: room.moves, chat: room.chat, status: room.status });
  });

  socket.on('disconnect', () => {
    for (const [code, room] of Object.entries(rooms)) {
      if (room.white?.socketId === socket.id) {
        socket.to(code).emit('opponent-disconnected');
        room.white.socketId = null;
      }
      if (room.black?.socketId === socket.id) {
        socket.to(code).emit('opponent-disconnected');
        room.black.socketId = null;
      }
    }
  });
});

// Clean up old rooms every hour
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of Object.entries(rooms)) {
    if (now - room.created > 24 * 60 * 60 * 1000) delete rooms[code];
  }
}, 60 * 60 * 1000);

// ─── Profanity Filter ─────────────────────────────────────────────────────────

function filterProfanity(text) {
  const badWords = ['fuck','shit','ass','bitch','damn','crap','piss','dick','cock','cunt','bastard','hell','whore','slut'];
  let filtered = text;
  for (const word of badWords) {
    const regex = new RegExp(word, 'gi');
    filtered = filtered.replace(regex, '*'.repeat(word.length));
  }
  return filtered;
}

// ─── Serve frontend for all routes ───────────────────────────────────────────

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Blobfish Chess running on port ${PORT}`));
