'use strict';
/* ═══════════════════════════════════════════
   ChessCall v3 — Fixed Video + Chess
═══════════════════════════════════════════ */

let socket, localStream, pc, roomId;
let micOn = true, camOn = true, connected = false;
let videoHideTimer = null;

// Chess state
let game = null, myColor = null;
let selected = null, legalMoves = [], lastMove = null;
let chessActive = false;

// Unicode chess pieces
const PIECES = {
  wK:'♔', wQ:'♕', wR:'♖', wB:'♗', wN:'♘', wP:'♙',
  bK:'♚', bQ:'♛', bR:'♜', bB:'♝', bN:'♞', bP:'♟'
};
const FILES = ['a','b','c','d','e','f','g','h'];

// ── TURN/STUN servers ──────────────────────────────────────
const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
    { urls: 'stun:stun.relay.metered.ca:80' },
    {
      urls: 'turn:a.relay.metered.ca:80',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    },
    {
      urls: 'turn:a.relay.metered.ca:80?transport=tcp',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    },
    {
      urls: 'turn:openrelay.metered.ca:443',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    },
    {
      urls: 'turns:openrelay.metered.ca:443?transport=tcp',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    }
  ],
  iceCandidatePoolSize: 10
};

// ── Helpers ────────────────────────────────────────────────
const $  = id => document.getElementById(id);
let _toastT;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(_toastT);
  _toastT = setTimeout(() => t.classList.remove('show'), 3200);
}
function setStatus(cls, txt) {
  $('status-dot').className = 'status-dot ' + cls;
  $('status-txt').textContent = txt;
}
function sysMsg(msg) {
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

function showSearching(msg) {
  const ov = $('searching-ov');
  ov.classList.remove('gone');
  $('search-msg').textContent = msg;
  clearTimeout(videoHideTimer);
}
function hideSearching() {
  $('searching-ov').classList.add('gone');
  clearTimeout(videoHideTimer);
}

// ══════════════════════════════════════════════════════════
//   START APP — get camera then connect
// ══════════════════════════════════════════════════════════
async function startApp() {
  const btn = $('btn-start');
  btn.innerHTML = '<span class="btn-label">Getting camera...</span>';
  btn.disabled = true;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: { width:{ideal:1280}, height:{ideal:720} },
      audio: { echoCancellation:true, noiseSuppression:true }
    });
    $('local-video').srcObject = localStream;

    $('screen-landing').style.display = 'none';
    $('screen-call').style.display = 'flex';
    $('screen-call').classList.add('active');

    initSocket();
    findMatch();
  } catch(err) {
    console.error('Camera error:', err);
    $('perm-warn').style.display = 'flex';
    btn.innerHTML = '<span class="btn-label">Try Again</span>';
    btn.disabled = false;
    toast('⚠ Allow camera & microphone access!');
  }
}

// ══════════════════════════════════════════════════════════
//   SOCKET SETUP
// ══════════════════════════════════════════════════════════
function initSocket() {
  socket = io({ transports: ['websocket','polling'], reconnectionAttempts: 10 });

  socket.on('connect', () => console.log('[socket] connected:', socket.id));

  socket.on('disconnect', () => {
    setStatus('off', 'Disconnected');
    if (connected) partnerLeft();
  });

  socket.on('waiting', () => {
    setStatus('searching', 'Searching...');
    showSearching('Finding a stranger...');
    $('btn-chess').disabled = true;
    connected = false;
  });

  socket.on('matched', async ({ roomId: rid, isInitiator }) => {
    roomId = rid;
    connected = true;
    setStatus('connected', 'Connected');
    $('btn-chess').disabled = false;
    $('chat-body').innerHTML = '';
    sysMsg('Connected to a stranger! 👋');

    // Hide searching overlay after 3s even if video doesn't come (NAT issues)
    videoHideTimer = setTimeout(() => {
      hideSearching();
      const rv = $('remote-video');
      if (!rv.srcObject || rv.srcObject.getTracks().length === 0) {
        // No video — show placeholder text
        const box = document.querySelector('.remote-wrap');
        if (!box.querySelector('.no-vid')) {
          const p = document.createElement('div');
          p.className = 'no-vid';
          p.textContent = '📹 Waiting for video...';
          box.appendChild(p);
        }
      }
    }, 6000);

    await setupPeerConn();
    if (isInitiator) {
      try {
        const offer = await pc.createOffer({ offerToReceiveAudio:true, offerToReceiveVideo:true });
        await pc.setLocalDescription(offer);
        socket.emit('offer', { roomId, offer });
      } catch(e) { console.error('Offer error:', e); }
    }
  });

  socket.on('partner-left', partnerLeft);

  // WebRTC signaling
  socket.on('offer', async ({ offer }) => {
    if (!pc) await setupPeerConn();
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('answer', { roomId, answer });
    } catch(e) { console.error('Answer error:', e); }
  });

  socket.on('answer', async ({ answer }) => {
    if (!pc) return;
    try {
      if (pc.signalingState === 'have-local-offer')
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
    } catch(e) { console.error('Set answer error:', e); }
  });

  socket.on('ice-candidate', async ({ candidate }) => {
    if (!pc || !candidate) return;
    try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); }
    catch(e) {}
  });

  // Chess events
  socket.on('chess-invite',  () => openModal('m-chess-invite'));
  socket.on('chess-declined', () => toast('Stranger declined chess :('));

  socket.on('chess-start', ({ color }) => {
    myColor = color;
    initChess(color);
    toast(`Chess started! You play as ${color === 'white' ? '⬜ White' : '⬛ Black'}`);
  });

  socket.on('chess-move', ({ from, to, promotion }) => {
    if (!game) return;
    const mv = game.move({ from, to, promotion: promotion || 'q' });
    if (mv) {
      lastMove = { from, to };
      renderBoard();
      addMoveChip(mv.san, mv.color);
      updateTurnBadge();
      checkEnd();
    }
  });

  socket.on('chess-opponent-resigned', () => {
    gameOver('🏆', 'You Win!', 'Opponent resigned.');
    endChess();
  });

  socket.on('chess-draw-offer', () => openModal('m-draw'));

  socket.on('chess-draw-response', ({ accepted }) => {
    if (accepted) { gameOver('🤝','Draw!','Both agreed to draw.'); endChess(); }
    else toast('Draw declined.');
  });

  socket.on('chat-message', ({ message }) => addMsg(message, false));
  socket.on('skipped', () => { closeChess(); cleanPeer(); });
}

// ══════════════════════════════════════════════════════════
//   PEER CONNECTION
// ══════════════════════════════════════════════════════════
async function setupPeerConn() {
  cleanPeer();
  pc = new RTCPeerConnection(ICE_SERVERS);

  // Add all local tracks
  localStream.getTracks().forEach(track => {
    pc.addTrack(track, localStream);
  });

  // Remote stream setup
  const remoteStream = new MediaStream();
  const remoteVid = $('remote-video');
  remoteVid.srcObject = remoteStream;

  pc.ontrack = (event) => {
    console.log('[track]', event.track.kind);
    event.streams[0].getTracks().forEach(track => remoteStream.addTrack(track));
    // Hide searching when we receive video
    if (event.track.kind === 'video') {
      remoteVid.play().catch(() => {});
      hideSearching();
      // Remove "waiting for video" placeholder if exists
      const p = document.querySelector('.no-vid');
      if (p) p.remove();
    }
  };

  pc.onicecandidate = ({ candidate }) => {
    if (candidate && socket && roomId)
      socket.emit('ice-candidate', { roomId, candidate });
  };

  pc.oniceconnectionstatechange = () => {
    const s = pc.iceConnectionState;
    console.log('[ICE]', s);
    if (s === 'connected' || s === 'completed') {
      hideSearching();
    }
    if (s === 'failed') {
      pc.restartIce();
      toast('Connection issue — retrying...');
    }
    if (s === 'disconnected') {
      setTimeout(() => {
        if (pc && pc.iceConnectionState === 'disconnected') partnerLeft();
      }, 4000);
    }
  };

  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    console.log('[CONN]', s);
    if (s === 'connected') hideSearching();
    if (s === 'failed') partnerLeft();
  };
}

function cleanPeer() {
  clearTimeout(videoHideTimer);
  if (pc) { pc.close(); pc = null; }
  const rv = $('remote-video');
  if (rv.srcObject) { rv.srcObject = null; }
  roomId = null;
  connected = false;
}

// ══════════════════════════════════════════════════════════
//   MATCHMAKING
// ══════════════════════════════════════════════════════════
function findMatch() {
  if (!socket) return;
  showSearching('Finding a stranger...');
  setStatus('searching', 'Searching...');
  $('btn-chess').disabled = true;
  socket.emit('find-match');
}

function skipStranger() {
  if (!socket) return;
  closeChess();
  sysMsg('You skipped.');
  socket.emit('skip');
  setTimeout(findMatch, 400);
}

function stopCall() {
  closeChess();
  if (socket) { socket.disconnect(); socket = null; }
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  cleanPeer();
  $('screen-call').style.display = 'none';
  $('screen-call').classList.remove('active');
  $('screen-landing').style.display = 'flex';
  $('screen-landing').classList.add('active');
}

function partnerLeft() {
  if (!connected && !chessActive) return;
  connected = false;
  setStatus('off', 'Stranger left');
  showSearching('Stranger has left...');
  sysMsg('Stranger has left the chat.');
  $('btn-chess').disabled = true;
  if (chessActive) { endChess(); toast('Chess ended — stranger left'); }
  cleanPeer();
  setTimeout(() => { if (socket && socket.connected) findMatch(); }, 2000);
}

// ══════════════════════════════════════════════════════════
//   MEDIA CONTROLS
// ══════════════════════════════════════════════════════════
function toggleMic() {
  if (!localStream) return;
  micOn = !micOn;
  localStream.getAudioTracks().forEach(t => t.enabled = micOn);
  $('btn-mic').classList.toggle('muted', !micOn);
  toast(micOn ? '🎤 Mic on' : '🔇 Mic off');
}
function toggleCam() {
  if (!localStream) return;
  camOn = !camOn;
  localStream.getVideoTracks().forEach(t => t.enabled = camOn);
  $('btn-cam').classList.toggle('muted', !camOn);
  toast(camOn ? '📷 Camera on' : '🚫 Camera off');
}

// ══════════════════════════════════════════════════════════
//   CHAT
// ══════════════════════════════════════════════════════════
function sendMsg() {
  const inp = $('chat-in');
  const msg = inp.value.trim();
  if (!msg || !connected) return;
  socket.emit('chat-message', { message: msg });
  addMsg(msg, true);
  inp.value = '';
}

// ══════════════════════════════════════════════════════════
//   CHESS — INVITE FLOW
// ══════════════════════════════════════════════════════════
function inviteChess() {
  if (!connected) { toast('Not connected to anyone!'); return; }
  if (chessActive) { toast('Chess already active!'); return; }
  socket.emit('chess-invite');
  toast('Chess invite sent ♟');
}

function respondChess(accepted) {
  closeModal('m-chess-invite');
  socket.emit('chess-response', { accepted });
}

// ══════════════════════════════════════════════════════════
//   CHESS BOARD — Unicode pieces, no images needed
// ══════════════════════════════════════════════════════════
function initChess(color) {
  game = new Chess();
  myColor = color;
  chessActive = true;
  selected = null;
  legalMoves = [];
  lastMove = null;

  $('my-color-val').textContent = color === 'white' ? '⬜ White' : '⬛ Black';
  $('mh-list').innerHTML = '';

  buildBoard();
  renderBoard();
  updateTurnBadge();
  $('chess-drawer').classList.add('open');
}

function buildBoard() {
  const boardEl = $('chess-board');
  boardEl.innerHTML = '';

  const rl = $('rank-labels');
  rl.innerHTML = '';

  // Orientation based on color
  const ranks = myColor === 'white' ? [8,7,6,5,4,3,2,1] : [1,2,3,4,5,6,7,8];
  const fileIdxs = myColor === 'white' ? [0,1,2,3,4,5,6,7] : [7,6,5,4,3,2,1,0];

  for (let ri = 0; ri < 8; ri++) {
    const rankNum = ranks[ri];

    // Rank label
    const lbl = document.createElement('div');
    lbl.className = 'rank-lbl';
    lbl.textContent = rankNum;
    rl.appendChild(lbl);

    for (let fi = 0; fi < 8; fi++) {
      const fileIdx = fileIdxs[fi];
      const sqName = FILES[fileIdx] + rankNum;
      const isLight = (rankNum + fileIdx) % 2 === 0;

      const sq = document.createElement('div');
      sq.className = 'sq ' + (isLight ? 'light' : 'dark');
      sq.dataset.sq = sqName;
      sq.addEventListener('click', () => handleClick(sqName));
      boardEl.appendChild(sq);
    }
  }
}

function renderBoard() {
  document.querySelectorAll('#chess-board .sq').forEach(cell => {
    const sqName = cell.dataset.sq;
    const fileIdx = FILES.indexOf(sqName[0]);
    const rankNum = parseInt(sqName[1]);
    const isLight = (rankNum + fileIdx) % 2 === 0;

    // Reset class
    cell.className = 'sq ' + (isLight ? 'light' : 'dark');

    // Last move highlight
    if (lastMove && (sqName === lastMove.from || sqName === lastMove.to))
      cell.classList.add('last-move');

    // Selected
    if (sqName === selected) cell.classList.add('selected');

    // Legal move hints
    if (legalMoves.includes(sqName)) {
      cell.classList.add('move-hint');
      if (game.get(sqName)) cell.classList.add('has-piece');
    }

    // King in check
    if (game && game.in_check()) {
      const kingPos = findKing(game.turn());
      if (sqName === kingPos) cell.classList.add('in-check');
    }

    // Render piece
    cell.innerHTML = '';
    const piece = game ? game.get(sqName) : null;
    if (piece) {
      const key = (piece.color === 'w' ? 'w' : 'b') + piece.type.toUpperCase();
      const span = document.createElement('span');
      span.className = 'piece ' + (piece.color === 'w' ? 'white-piece' : 'black-piece');
      span.textContent = PIECES[key] || '';
      cell.appendChild(span);
    }
  });
}

function findKing(color) {
  for (const f of FILES) {
    for (let r = 1; r <= 8; r++) {
      const sq = f + r;
      const p = game.get(sq);
      if (p && p.type === 'k' && p.color === color) return sq;
    }
  }
  return null;
}

function handleClick(sqName) {
  if (!chessActive || !game) return;

  // Is it my turn?
  const myTurn = (game.turn() === 'w' && myColor === 'white') ||
                 (game.turn() === 'b' && myColor === 'black');
  if (!myTurn) { toast("It's not your turn!"); return; }

  const piece = game.get(sqName);
  const myColorCode = myColor === 'white' ? 'w' : 'b';

  if (selected) {
    // Try to make the move
    if (legalMoves.includes(sqName)) {
      doMove(selected, sqName);
      return;
    }
    // Reselect own piece
    if (piece && piece.color === myColorCode) {
      selectSq(sqName);
      return;
    }
    // Deselect
    selected = null; legalMoves = [];
    renderBoard();
    return;
  }

  // Select own piece
  if (piece && piece.color === myColorCode) selectSq(sqName);
}

function selectSq(sqName) {
  selected = sqName;
  const moves = game.moves({ square: sqName, verbose: true });
  legalMoves = moves.map(m => m.to);
  renderBoard();
}

function doMove(from, to) {
  const piece = game.get(from);
  const isPromo = piece && piece.type === 'p' && (to[1] === '8' || to[1] === '1');
  const mv = game.move({ from, to, promotion: 'q' });
  if (!mv) return;

  lastMove = { from, to };
  selected = null; legalMoves = [];
  renderBoard();
  addMoveChip(mv.san, mv.color);
  updateTurnBadge();
  socket.emit('chess-move', { from, to, promotion: 'q' });
  checkEnd();
}

function updateTurnBadge() {
  if (!game) return;
  const myTurn = (game.turn() === 'w' && myColor === 'white') ||
                 (game.turn() === 'b' && myColor === 'black');
  const badge = $('chess-turn-badge');
  if (game.in_check()) {
    badge.textContent = myTurn ? '🔴 YOU are in check!' : '⚠ Opponent in check';
  } else {
    badge.textContent = myTurn ? '🟢 Your Turn' : "⏳ Opponent's Turn";
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

function checkEnd() {
  if (!game) return;
  if (game.in_checkmate()) {
    const loser = game.turn(); // current turn loses
    const iLose = (loser === 'w' && myColor === 'white') || (loser === 'b' && myColor === 'black');
    gameOver(iLose ? '😔' : '🏆', iLose ? 'You Lost!' : 'You Win!', 'Checkmate!');
    endChess();
  } else if (game.in_stalemate()) {
    gameOver('🤝', 'Stalemate!', "No legal moves — it's a draw.");
    endChess();
  } else if (game.in_draw()) {
    gameOver('🤝', 'Draw!', 'Game ended in a draw.');
    endChess();
  }
}

function gameOver(icon, title, body) {
  $('go-icon').textContent = icon;
  $('go-title').textContent = title;
  $('go-text').textContent = body;
  openModal('m-gameover');
}

function resignGame() {
  if (!chessActive) return;
  socket.emit('chess-resign');
  gameOver('🏳️', 'You Resigned', 'Better luck next time!');
  endChess();
}

function offerDraw() {
  if (!chessActive) return;
  socket.emit('chess-draw-offer');
  toast('Draw offered to opponent');
}

function respondDraw(accepted) {
  closeModal('m-draw');
  socket.emit('chess-draw-response', { accepted });
  if (accepted) { gameOver('🤝','Draw!','Both players agreed.'); endChess(); }
}

function closeChess() {
  $('chess-drawer').classList.remove('open');
  endChess();
}

function endChess() {
  chessActive = false;
  myColor = null;
  game = null;
  selected = null;
  legalMoves = [];
  lastMove = null;
  setTimeout(() => $('chess-drawer').classList.remove('open'), 300);
}

// ── Global event listeners ──────────────────────────────
document.addEventListener('keydown', e => {
  if (e.key === 'Escape')
    document.querySelectorAll('.modal-bg.show').forEach(m => m.classList.remove('show'));
});
document.addEventListener('click', e => {
  if (e.target.classList.contains('modal-bg')) e.target.classList.remove('show');
});