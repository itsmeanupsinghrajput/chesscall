'use strict';
/* ═══════════════════════════════════════════════
   ChessCall v2 — Client
   - Robust WebRTC with retry logic
   - Custom chess board (Unicode pieces, no images)
   - Full chess rules via chess.js
   - Clean socket.io events
═══════════════════════════════════════════════ */

// ── GLOBALS ──────────────────────────────────────────────────
let socket, localStream, pc, roomId;
let micOn = true, camOn = true, connected = false;

// Chess
let game = null;       // chess.js instance
let myColor = null;    // 'white' | 'black'
let selected = null;   // selected square e.g. 'e2'
let legalMoves = [];   // legal moves from selected
let lastMove = null;   // {from, to} for highlight
let chessActive = false;

// ── UNICODE PIECES ────────────────────────────────────────────
const PIECES = {
  wK:'♔', wQ:'♕', wR:'♖', wB:'♗', wN:'♘', wP:'♙',
  bK:'♚', bQ:'♛', bR:'♜', bB:'♝', bN:'♞', bP:'♟'
};
const FILES = ['a','b','c','d','e','f','g','h'];

// ── ICE SERVERS ───────────────────────────────────────────────
const ICE = {
  iceServers:[
    {urls:'stun:stun.l.google.com:19302'},
    {urls:'stun:stun1.l.google.com:19302'},
    {urls:'stun:stun2.l.google.com:19302'},
    {urls:'stun:stun.cloudflare.com:3478'},
    {urls:'turn:openrelay.metered.ca:80',
     username:'openrelayproject',credential:'openrelayproject'},
    {urls:'turn:openrelay.metered.ca:443',
     username:'openrelayproject',credential:'openrelayproject'},
  ],
  iceCandidatePoolSize:10
};

// ── HELPERS ───────────────────────────────────────────────────
const $  = id => document.getElementById(id);
let toastTimer;
function toast(msg, dur=3000) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), dur);
}
function setStatus(state, txt) {
  const d = $('status-dot');
  d.className = 'status-dot ' + state;
  $('status-txt').textContent = txt;
}
function addSys(msg) {
  const el = document.createElement('div');
  el.className = 'sys-msg';
  el.textContent = msg;
  const b = $('chat-body');
  b.appendChild(el);
  b.scrollTop = b.scrollHeight;
}
function addMsg(msg, mine) {
  const el = document.createElement('div');
  el.className = 'chat-msg ' + (mine ? 'mine' : 'theirs');
  el.textContent = msg;
  const b = $('chat-body');
  b.appendChild(el);
  b.scrollTop = b.scrollHeight;
}
function openModal(id)  { $(id).classList.add('show'); }
function closeModal(id) { $(id).classList.remove('show'); }

// ══════════════════════════════════════════════════════════════
//   START APP
// ══════════════════════════════════════════════════════════════
async function startApp() {
  $('btn-start').textContent = 'Getting camera...';
  $('btn-start').disabled = true;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video:{ width:{ideal:1280}, height:{ideal:720}, facingMode:'user' },
      audio:{ echoCancellation:true, noiseSuppression:true, sampleRate:44100 }
    });
    $('local-video').srcObject = localStream;

    // Switch screens
    $('screen-landing').style.display = 'none';
    $('screen-call').style.display = 'flex';
    $('screen-call').classList.add('active');

    initSocket();
    findMatch();
  } catch(e) {
    console.error('Media error:', e);
    $('perm-warn').style.display = 'flex';
    $('btn-start').textContent = 'Try Again';
    $('btn-start').disabled = false;
    toast('⚠ Camera/mic access denied!');
  }
}

// ══════════════════════════════════════════════════════════════
//   SOCKET.IO
// ══════════════════════════════════════════════════════════════
function initSocket() {
  socket = io({ transports:['websocket','polling'], reconnectionAttempts:5 });

  socket.on('connect', () => console.log('[socket] connected', socket.id));
  socket.on('disconnect', () => {
    setStatus('off','Disconnected');
    if(connected) handleLeft();
  });

  // Matchmaking
  socket.on('waiting', () => {
    setStatus('searching','Searching...');
    showSearching('Finding a stranger...');
    $('btn-chess').disabled = true;
    connected = false;
  });

  socket.on('matched', async ({ roomId:rid, isInitiator }) => {
    roomId = rid;
    connected = true;
    await createPC();
    if(isInitiator) {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('offer', { roomId, offer });
    }
    setStatus('connected','Connected');
    $('btn-chess').disabled = false;
    $('chat-body').innerHTML = '';
    addSys('Connected! Say hello 👋');
  });

  socket.on('partner-left', handleLeft);

  // WebRTC signaling
  socket.on('offer', async ({ offer }) => {
    if(!pc) await createPC();
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('answer', { roomId, answer });
  });

  socket.on('answer', async ({ answer }) => {
    if(pc && pc.signalingState !== 'stable')
      await pc.setRemoteDescription(new RTCSessionDescription(answer));
  });

  socket.on('ice-candidate', ({ candidate }) => {
    if(pc && candidate)
      pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(()=>{});
  });

  // Chess
  socket.on('chess-invite', () => openModal('m-chess-invite'));

  socket.on('chess-start', ({ color }) => {
    myColor = color;
    startChessBoard(color);
    toast(`Chess started! You are ${color === 'white' ? '⬜ White' : '⬛ Black'}`);
  });

  socket.on('chess-declined', () => toast('Chess invite declined 😞'));

  socket.on('chess-move', ({ from, to, promotion }) => {
    const move = game.move({ from, to, promotion: promotion || 'q' });
    if(move) {
      lastMove = { from, to };
      renderBoard();
      addMoveChip(move.san, move.color);
      updateTurnBadge();
      checkGameEnd();
    }
  });

  socket.on('chess-opponent-resigned', () => {
    showGameOver('🏆','You Win!','Your opponent resigned.');
    endChess(false);
  });

  socket.on('chess-draw-offer', () => openModal('m-draw'));

  socket.on('chess-draw-response', ({ accepted }) => {
    if(accepted) {
      showGameOver('🤝','Draw!','Both players agreed to a draw.');
      endChess(false);
    } else {
      toast('Draw offer declined.');
    }
  });

  // Chat
  socket.on('chat-message', ({ message }) => addMsg(message, false));

  socket.on('skipped', () => {
    closeChess();
    cleanPC();
  });
}

// ══════════════════════════════════════════════════════════════
//   WEBRTC
// ══════════════════════════════════════════════════════════════
async function createPC() {
  cleanPC();
  pc = new RTCPeerConnection(ICE);

  // Add local tracks
  localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

  // Receive remote stream
  const remoteStream = new MediaStream();
  $('remote-video').srcObject = remoteStream;

  pc.ontrack = e => {
    e.streams[0].getTracks().forEach(t => remoteStream.addTrack(t));
    hideSearching();
  };

  pc.onicecandidate = e => {
    if(e.candidate && socket && roomId)
      socket.emit('ice-candidate', { roomId, candidate:e.candidate });
  };

  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    console.log('[PC]', s);
    if(s === 'connected') hideSearching();
    if(s === 'disconnected' || s === 'failed' || s === 'closed') handleLeft();
  };

  pc.oniceconnectionstatechange = () => {
    if(pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed')
      hideSearching();
  };
}

function cleanPC() {
  if(pc) { pc.close(); pc = null; }
  const rv = $('remote-video');
  if(rv.srcObject) { rv.srcObject.getTracks().forEach(t=>t.stop()); rv.srcObject = null; }
  roomId = null;
  connected = false;
}

// ══════════════════════════════════════════════════════════════
//   MATCHMAKING CONTROLS
// ══════════════════════════════════════════════════════════════
function findMatch() {
  showSearching('Finding a stranger...');
  setStatus('searching','Searching...');
  $('btn-chess').disabled = true;
  if(socket) socket.emit('find-match');
}

function skipStranger() {
  if(!socket) return;
  closeChess();
  addSys('You skipped.');
  socket.emit('skip');
  setTimeout(findMatch, 300);
}

function stopCall() {
  closeChess();
  if(socket) { socket.disconnect(); socket = null; }
  if(localStream) { localStream.getTracks().forEach(t=>t.stop()); localStream = null; }
  cleanPC();
  $('screen-call').classList.remove('active');
  $('screen-call').style.display = 'none';
  $('screen-landing').style.display = 'flex';
  $('screen-landing').classList.add('active');
}

function handleLeft() {
  if(!connected && !chessActive) return;
  connected = false;
  setStatus('off','Stranger left');
  showSearching('Stranger disconnected...');
  addSys('Stranger has left.');
  $('btn-chess').disabled = true;
  if(chessActive) { closeChess(); toast('Chess ended — stranger left'); }
  cleanPC();
  setTimeout(() => { if(socket && socket.connected) findMatch(); }, 2000);
}

// ══════════════════════════════════════════════════════════════
//   VIDEO OVERLAYS
// ══════════════════════════════════════════════════════════════
function showSearching(msg) {
  const ov = $('searching-ov');
  ov.classList.remove('gone');
  $('search-msg').textContent = msg;
}
function hideSearching() {
  $('searching-ov').classList.add('gone');
}

// ══════════════════════════════════════════════════════════════
//   MEDIA CONTROLS
// ══════════════════════════════════════════════════════════════
function toggleMic() {
  if(!localStream) return;
  micOn = !micOn;
  localStream.getAudioTracks().forEach(t => t.enabled = micOn);
  const btn = $('btn-mic');
  btn.classList.toggle('muted', !micOn);
  btn.title = micOn ? 'Mute mic' : 'Unmute mic';
  toast(micOn ? '🎤 Mic on' : '🔇 Mic muted');
}
function toggleCam() {
  if(!localStream) return;
  camOn = !camOn;
  localStream.getVideoTracks().forEach(t => t.enabled = camOn);
  const btn = $('btn-cam');
  btn.classList.toggle('muted', !camOn);
  btn.title = camOn ? 'Turn off camera' : 'Turn on camera';
  toast(camOn ? '📷 Camera on' : '🚫 Camera off');
}

// ══════════════════════════════════════════════════════════════
//   CHAT
// ══════════════════════════════════════════════════════════════
function sendMsg() {
  const inp = $('chat-in');
  const msg = inp.value.trim();
  if(!msg || !connected) return;
  socket.emit('chat-message', { message: msg });
  addMsg(msg, true);
  inp.value = '';
}

// ══════════════════════════════════════════════════════════════
//   CHESS — INVITE FLOW
// ══════════════════════════════════════════════════════════════
function inviteChess() {
  if(!connected || chessActive) return;
  socket.emit('chess-invite');
  toast('Chess invite sent ♟');
}
function respondChess(accepted) {
  closeModal('m-chess-invite');
  socket.emit('chess-response', { accepted });
}

// ══════════════════════════════════════════════════════════════
//   CHESS BOARD — CUSTOM IMPLEMENTATION (Unicode pieces)
// ══════════════════════════════════════════════════════════════
function startChessBoard(color) {
  game = new Chess();
  myColor = color;
  chessActive = true;
  selected = null;
  legalMoves = [];
  lastMove = null;

  // Set color display
  $('my-color-val').textContent = color === 'white' ? '⬜ White' : '⬛ Black';
  $('mh-list').innerHTML = '';

  buildBoard();
  renderBoard();
  updateTurnBadge();

  // Open chess drawer
  $('chess-drawer').classList.add('open');
}

function buildBoard() {
  const board = $('chess-board');
  board.innerHTML = '';

  // Rank labels (8 down to 1 for white, 1 to 8 for black)
  const rl = $('rank-labels');
  rl.innerHTML = '';

  const ranks = myColor === 'white'
    ? [8,7,6,5,4,3,2,1]
    : [1,2,3,4,5,6,7,8];

  const files = myColor === 'white'
    ? [0,1,2,3,4,5,6,7]
    : [7,6,5,4,3,2,1,0];

  // Build 64 squares
  for(let ri=0; ri<8; ri++) {
    const rankNum = ranks[ri];

    // Rank label
    const lbl = document.createElement('div');
    lbl.className = 'rank-lbl';
    lbl.textContent = rankNum;
    rl.appendChild(lbl);

    for(let fi=0; fi<8; fi++) {
      const fileIdx = files[fi];
      const sq = FILES[fileIdx] + rankNum;
      const isLight = (rankNum + fileIdx) % 2 === 0;

      const cell = document.createElement('div');
      cell.className = 'sq ' + (isLight ? 'light' : 'dark');
      cell.dataset.sq = sq;
      cell.onclick = () => handleSquareClick(sq);
      board.appendChild(cell);
    }
  }
}

function renderBoard() {
  const board = $('chess-board');
  const squares = board.querySelectorAll('.sq');

  squares.forEach(cell => {
    const sq = cell.dataset.sq;
    // Reset classes
    cell.className = 'sq ' + getSquareColor(sq);

    // Highlight last move
    if(lastMove && (sq === lastMove.from || sq === lastMove.to)) {
      cell.classList.add('last-move');
    }

    // Highlight selection
    if(sq === selected) cell.classList.add('selected');

    // Highlight legal moves
    if(legalMoves.includes(sq)) {
      cell.classList.add('move-hint');
      const piece = game.get(sq);
      if(piece) cell.classList.add('has-piece');
    }

    // King in check highlight
    if(game.in_check()) {
      const turn = game.turn();
      const kingPiece = { type:'k', color:turn };
      // Find king square
      const fen = game.fen().split(' ')[0];
      if(sq === findKing(turn)) cell.classList.add('in-check');
    }

    // Render piece
    cell.innerHTML = '';
    const piece = game.get(sq);
    if(piece) {
      const span = document.createElement('span');
      const key = (piece.color === 'w' ? 'w' : 'b') + piece.type.toUpperCase();
      span.className = 'piece ' + (piece.color === 'w' ? 'white-piece' : 'black-piece');
      span.textContent = PIECES[key] || '?';
      cell.appendChild(span);
    }
  });
}

function findKing(color) {
  // Find king position from game board
  for(const file of FILES) {
    for(let rank=1; rank<=8; rank++) {
      const sq = file + rank;
      const p = game.get(sq);
      if(p && p.type === 'k' && p.color === color) return sq;
    }
  }
  return null;
}

function getSquareColor(sq) {
  const file = FILES.indexOf(sq[0]);
  const rank = parseInt(sq[1]);
  return (rank + file) % 2 === 0 ? 'light' : 'dark';
}

function handleSquareClick(sq) {
  if(!chessActive || !game) return;

  // Check if it's my turn
  const myTurn = (game.turn() === 'w' && myColor === 'white') ||
                 (game.turn() === 'b' && myColor === 'black');
  if(!myTurn) { toast('Not your turn!'); return; }

  const piece = game.get(sq);

  // If a square is already selected
  if(selected) {
    // Clicking a legal move target
    if(legalMoves.includes(sq)) {
      makeMove(selected, sq);
      return;
    }
    // Clicking own piece — switch selection
    if(piece && piece.color === (myColor === 'white' ? 'w' : 'b')) {
      selectSquare(sq);
      return;
    }
    // Clicking elsewhere — deselect
    selected = null;
    legalMoves = [];
    renderBoard();
    return;
  }

  // Select piece if it's mine
  if(piece && piece.color === (myColor === 'white' ? 'w' : 'b')) {
    selectSquare(sq);
  }
}

function selectSquare(sq) {
  selected = sq;
  const moves = game.moves({ square:sq, verbose:true });
  legalMoves = moves.map(m => m.to);
  renderBoard();
}

function makeMove(from, to) {
  // Handle pawn promotion (auto-queen for now)
  const piece = game.get(from);
  const promotion = piece && piece.type === 'p' &&
    (to[1] === '8' || to[1] === '1') ? 'q' : undefined;

  const move = game.move({ from, to, promotion: promotion || 'q' });
  if(!move) return;

  lastMove = { from, to };
  selected = null;
  legalMoves = [];
  renderBoard();
  addMoveChip(move.san, move.color);
  updateTurnBadge();

  // Send to opponent
  socket.emit('chess-move', { from, to, promotion: promotion || 'q' });

  checkGameEnd();
}

function updateTurnBadge() {
  if(!game) return;
  const myTurn = (game.turn() === 'w' && myColor === 'white') ||
                 (game.turn() === 'b' && myColor === 'black');

  if(game.in_check()) {
    $('chess-turn-badge').textContent = myTurn ? '🔴 Your King in Check!' : '⚠ Opponent in Check';
  } else {
    $('chess-turn-badge').textContent = myTurn ? '🟢 Your Turn' : '⏳ Opponent\'s Turn';
  }
}

function addMoveChip(san, color) {
  const chip = document.createElement('span');
  chip.className = 'mv ' + (color === 'w' ? 'w' : 'b');
  chip.textContent = san;
  const list = $('mh-list');
  list.appendChild(chip);
  list.scrollTop = list.scrollHeight;
}

function checkGameEnd() {
  if(!game) return;
  if(game.in_checkmate()) {
    const winner = game.turn() === 'w' ? 'Black' : 'White';
    const iWon = (winner === 'White' && myColor === 'white') ||
                 (winner === 'Black' && myColor === 'black');
    showGameOver(iWon ? '🏆' : '😔', iWon ? 'You Win!' : 'You Lost!',
      `${winner} wins by checkmate!`);
    endChess(false);
  } else if(game.in_stalemate()) {
    showGameOver('🤝','Stalemate!','No legal moves — it\'s a draw.');
    endChess(false);
  } else if(game.in_draw()) {
    showGameOver('🤝','Draw!','The game ended in a draw.');
    endChess(false);
  }
}

function showGameOver(icon, title, body) {
  $('go-icon').textContent = icon;
  $('go-title').textContent = title;
  $('go-text').textContent = body;
  openModal('m-gameover');
}

// ── CHESS ACTIONS ─────────────────────────────────────────────
function resignGame() {
  if(!chessActive) return;
  socket.emit('chess-resign');
  showGameOver('🏳️','You Resigned','Better luck next time!');
  endChess(false);
}

function offerDraw() {
  if(!chessActive) return;
  socket.emit('chess-draw-offer');
  toast('Draw offered to opponent');
}

function respondDraw(accepted) {
  closeModal('m-draw');
  socket.emit('chess-draw-response', { accepted });
  if(accepted) {
    showGameOver('🤝','Draw!','Both players agreed.');
    endChess(false);
  }
}

function closeChess() {
  $('chess-drawer').classList.remove('open');
  endChess(true);
}

function endChess(silent) {
  chessActive = false;
  myColor = null;
  game = null;
  selected = null;
  legalMoves = [];
  lastMove = null;
  if(!silent) {
    // Keep chess panel closed, continue call
    setTimeout(() => $('chess-drawer').classList.remove('open'), 400);
  }
}

// ══════════════════════════════════════════════════════════════
//   KEYBOARD & GLOBAL EVENTS
// ══════════════════════════════════════════════════════════════
document.addEventListener('keydown', e => {
  if(e.key === 'Escape') {
    document.querySelectorAll('.modal-bg.show').forEach(m => m.classList.remove('show'));
  }
});

document.addEventListener('click', e => {
  if(e.target.classList.contains('modal-bg')) {
    e.target.classList.remove('show');
  }
});