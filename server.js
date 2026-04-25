const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  transports: ['websocket', 'polling']
});

app.use(express.static(path.join(__dirname, 'public')));

//app.use(express.static(path.join(__dirname, 'public')));

// ADD THIS ↓
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- State ---
let waitingQueue = [];         // array of socket ids
let rooms = {};                // roomId -> { players: [id1, id2], chess: { active: false } }
let socketToRoom = {};         // socketId -> roomId
let socketStats = {};          // socketId -> { peersSkipped, gamesPlayed }

function generateRoomId() {
  return Math.random().toString(36).substr(2, 9);
}

function leaveCurrentRoom(socket) {
  const roomId = socketToRoom[socket.id];
  if (!roomId || !rooms[roomId]) return;

  const room = rooms[roomId];

  // Notify partner
  socket.to(roomId).emit('partner-left');
  socket.leave(roomId);
  delete socketToRoom[socket.id];

  // Clean up partner references
  room.players = room.players.filter(id => id !== socket.id);
  if (room.players.length > 0) {
    const otherId = room.players[0];
    if (otherId) {
      delete socketToRoom[otherId];
      const otherSocket = io.sockets.sockets.get(otherId);
      if (otherSocket) otherSocket.leave(roomId);
    }
  }
  delete rooms[roomId];
}

io.on('connection', (socket) => {
  console.log(`[+] Connected: ${socket.id}`);
  socketStats[socket.id] = { peersSkipped: 0, gamesPlayed: 0 };

  // ── MATCHMAKING ──────────────────────────────────────────
  socket.on('find-match', () => {
    leaveCurrentRoom(socket);

    // Remove self from queue if already in it
    waitingQueue = waitingQueue.filter(id => id !== socket.id);

    // Check for a valid waiting partner
    while (waitingQueue.length > 0) {
      const partnerId = waitingQueue.shift();
      const partnerSocket = io.sockets.sockets.get(partnerId);
      if (partnerSocket && partnerSocket.connected) {
        // Match found!
        const roomId = generateRoomId();
        rooms[roomId] = {
          players: [socket.id, partnerId],
          chess: { active: false }
        };
        socketToRoom[socket.id] = roomId;
        socketToRoom[partnerId] = roomId;

        socket.join(roomId);
        partnerSocket.join(roomId);

        // partnerSocket is the initiator (creates WebRTC offer)
        socket.emit('matched', { roomId, isInitiator: false });
        partnerSocket.emit('matched', { roomId, isInitiator: true });

        console.log(`[Room] ${roomId}: ${socket.id} <-> ${partnerId}`);
        return;
      }
    }

    // No partner found — add to queue
    waitingQueue.push(socket.id);
    socket.emit('waiting');
    console.log(`[Queue] ${socket.id} waiting. Queue size: ${waitingQueue.length}`);
  });

  socket.on('skip', () => {
    if (socketStats[socket.id]) socketStats[socket.id].peersSkipped++;
    leaveCurrentRoom(socket);
    socket.emit('skipped');
  });

  // ── WEBRTC SIGNALING ─────────────────────────────────────
  socket.on('offer', ({ roomId, offer }) => {
    socket.to(roomId).emit('offer', { offer });
  });

  socket.on('answer', ({ roomId, answer }) => {
    socket.to(roomId).emit('answer', { answer });
  });

  socket.on('ice-candidate', ({ roomId, candidate }) => {
    socket.to(roomId).emit('ice-candidate', { candidate });
  });

  // ── CHESS ────────────────────────────────────────────────
  socket.on('chess-invite', () => {
    const roomId = socketToRoom[socket.id];
    if (!roomId) return;
    socket.to(roomId).emit('chess-invite');
  });

  socket.on('chess-response', ({ accepted }) => {
    const roomId = socketToRoom[socket.id];
    if (!roomId || !rooms[roomId]) return;

    if (accepted) {
      rooms[roomId].chess.active = true;
      const players = rooms[roomId].players;
      // Randomly assign colors
      const shuffle = Math.random() < 0.5;
      const whiteId = shuffle ? players[0] : players[1];
      const blackId = shuffle ? players[1] : players[0];

      io.to(whiteId).emit('chess-start', { color: 'white' });
      io.to(blackId).emit('chess-start', { color: 'black' });

      if (socketStats[whiteId]) socketStats[whiteId].gamesPlayed++;
      if (socketStats[blackId]) socketStats[blackId].gamesPlayed++;
    } else {
      socket.to(roomId).emit('chess-declined');
    }
  });

  socket.on('chess-move', (moveData) => {
    const roomId = socketToRoom[socket.id];
    if (!roomId) return;
    socket.to(roomId).emit('chess-move', moveData);
  });

  socket.on('chess-resign', () => {
    const roomId = socketToRoom[socket.id];
    if (!roomId) return;
    if (rooms[roomId]) rooms[roomId].chess.active = false;
    socket.to(roomId).emit('chess-opponent-resigned');
  });

  socket.on('chess-draw-offer', () => {
    const roomId = socketToRoom[socket.id];
    if (!roomId) return;
    socket.to(roomId).emit('chess-draw-offer');
  });

  socket.on('chess-draw-response', ({ accepted }) => {
    const roomId = socketToRoom[socket.id];
    if (!roomId) return;
    socket.to(roomId).emit('chess-draw-response', { accepted });
  });

  // ── CHAT ─────────────────────────────────────────────────
  socket.on('chat-message', ({ message }) => {
    const roomId = socketToRoom[socket.id];
    if (!roomId || !message || message.length > 300) return;
    // Sanitize basic
    const safe = message.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    socket.to(roomId).emit('chat-message', { message: safe });
  });

  // ── DISCONNECT ───────────────────────────────────────────
  socket.on('disconnect', () => {
    console.log(`[-] Disconnected: ${socket.id}`);
    waitingQueue = waitingQueue.filter(id => id !== socket.id);
    leaveCurrentRoom(socket);
    delete socketStats[socket.id];
  });

  // ── STATS (optional endpoint) ─────────────────────────────
  app.get('/stats', (_, res) => {
    res.json({
      online: io.sockets.sockets.size,
      waiting: waitingQueue.length,
      activeRooms: Object.keys(rooms).length
    });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n✅ ChessCall server running → http://localhost:${PORT}\n`);
});
