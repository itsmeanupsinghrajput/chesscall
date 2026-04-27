'use strict';
/* ═══════════════════════════════════════════════════════
   ChessCall v5 — Complete Fix
   Bug fixes:
   - buildBoard now correctly renders file labels
   - rank-labels height matches board height
   - partnerLeft timeout is cancellable (no duplicate findMatch)
   - chess panel uses tab instead of broken drawer
   - ICE restart on failure
   - Mobile autoplay fix
   - socketStats guarded before access
═══════════════════════════════════════════════════════ */

// ── State ──────────────────────────────────────────────
let socket, localStream, pc, roomId;
let micOn = true, camOn = true, connected = false;
let videoTimer = null;
let partnerLeftTimer = null; // BUG FIX: track so we can cancel it

// Chess
let game = null, myColor = null;
let selected = null, legalMoves = [], lastMove = null;
let chessActive = false;

const PIECES = {
  wK:'♔', wQ:'♕', wR:'♖', wB:'♗', wN:'♘', wP:'♙',
  bK:'♚', bQ:'♛', bR:'♜', bB:'♝', bN:'♞', bP:'♟'
};
const FILES = ['a','b','c','d','e','f','g','h'];

// ── ICE/TURN configuration ─────────────────────────────
const ICE_CFG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'turn:freeturn.net:3478',  username: 'free', credential: 'free' },
    { urls: 'turns:freeturn.net:5349', username: 'free', credential: 'free' },
    { urls: 'turn:openrelay.metered.ca:80',
      username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443',
      username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turns:openrelay.metered.ca:443',
      username: 'openrelayproject', credential: 'openrelayproject' },
  ],
  iceTransportPolicy: 'all',
  iceCandidatePoolSize: 10,
  bundlePolicy: 'max-bundle',
  rtcpMuxPolicy: 'require'
};

// ── Helpers ────────────────────────────────────────────
const $ = id => document.getElementById(id);
let _tt;
function toast(m) {
  const t = $('toast');
  t.textContent = m;
  t.classList.add('show');
  clearTimeout(_tt);
  _tt = setTimeout(() => t.classList.remove('show'), 3000);
}
function setStatus(cls, txt) {
  $('status-dot').className = 'status-dot ' + cls;
  $('status-txt').textContent = txt;
}
function sysMsg(m) {
  const e = document.createElement('div');
  e.className = 'sys-msg';
  e.textContent = m;
  const b = $('chat-body');
  b.appendChild(e);
  b.scrollTop = b.scrollHeight;
}
function addMsg(m, mine) {
  const e = document.createElement('div');
  e.className = 'chat-msg ' + (mine ? 'mine' : 'theirs');
  e.textContent = m;
  const b = $('chat-body');
  b.appendChild(e);
  b.scrollTop = b.scrollHeight;
}
function openModal(id)  { $(id).classList.add('show'); }
function closeModal(id) { $(id).classList.remove('show'); }

function showOv(msg) {
  $('searching-ov').classList.remove('gone');
  $('search-msg').textContent = msg;
  $('tap-video-btn').style.display = 'none';
  clearTimeout(videoTimer);
}
function hideOv() {
  $('searching-ov').classList.add('gone');
  clearTimeout(videoTimer);
}

// ── Tab switching ──────────────────────────────────────
function switchTab(tab) {
  ['chat', 'chess'].forEach(t => {
    $('tab-' + t).classList.toggle('active', t === tab);
    $('panel-' + t).classList.toggle('hidden', t !== tab);
  });
}

// ══════════════════════════════════════════════════════
//   START APP
// ══════════════════════════════════════════════════════
async function startApp() {
  const btn = $('btn-start');
  btn.querySelector('.btn-label').textContent = 'Getting camera...';
  btn.disabled = true;

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
      audio: { echoCancellation: true, noiseSuppression: true }
    });

    const lv = $('local-video');
    lv.srcObject = localStream;
    lv.play().catch(() => {});

    $('screen-landing').style.display = 'none';
    $('screen-call').style.display = 'flex';
    $('screen-call').classList.add('active');

    initSocket();
    findMatch();
  } catch(e) {
    console.error('getUserMedia error:', e);
    $('perm-warn').style.display = 'flex';
    btn.querySelector('.btn-label').textContent = 'Try Again';
    btn.disabled = false;
    toast('⚠ Allow camera & mic access!');
  }
}

// ══════════════════════════════════════════════════════
//   SOCKET
// ══════════════════════════════════════════════════════
function initSocket() {
  socket = io({ transports: ['websocket', 'polling'], reconnectionAttempts: 10 });

  socket.on('connect', () => console.log('[socket] connected:', socket.id));
  socket.on('disconnect', () => {
    setStatus('off', 'Disconnected');
    if (connected) partnerLeft();
  });

  socket.on('waiting', () => {
    setStatus('searching', 'Searching...');
    showOv('Finding a stranger...');
    $('btn-chess').disabled = true;
    connected = false;
  });

  socket.on('matched', async ({ roomId: rid, isInitiator }) => {
    roomId = rid;
    connected = true;
    setStatus('connected', 'Connected');
    $('btn-chess').disabled = false;
    $('chess-invite-btn2').disabled = false;
    $('chat-body').innerHTML = '';
    sysMsg('Connected to a stranger! 👋');
    console.log('[matched] isInitiator=', isInitiator);

    await makePeer();

    if (isInitiator) {
      try {
        const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
        await pc.setLocalDescription(offer);
        socket.emit('offer', { roomId, offer });
        console.log('[offer] sent');
      } catch(e) { console.error('offer error', e); }
    }

    // Fallback: hide overlay after 8s even if video doesn't arrive
    videoTimer = setTimeout(() => {
      hideOv();
      const rv = $('remote-video');
      if (!rv.srcObject || !rv.srcObject.getVideoTracks().length) {
        $('tap-video-btn').style.display = 'flex';
      }
    }, 8000);
  });

  socket.on('partner-left', partnerLeft);

  socket.on('offer', async ({ offer }) => {
    console.log('[offer] received');
    if (!pc) await makePeer();
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('answer', { roomId, answer });
      console.log('[answer] sent');
    } catch(e) { console.error('answer error', e); }
  });

  socket.on('answer', async ({ answer }) => {
    console.log('[answer] received');
    if (!pc) return;
    try {
      if (pc.signalingState === 'have-local-offer') {
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
      }
    } catch(e) { console.error('setAnswer error', e); }
  });

  socket.on('ice-candidate', async ({ candidate }) => {
    if (!pc || !candidate) return;
    try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); }
    catch(e) { console.warn('ICE candidate error', e); }
  });

  // Chess events
  socket.on('chess-invite', () => openModal('m-chess-invite'));
  socket.on('chess-declined', () => toast('Chess declined 😞'));
  socket.on('chess-start', ({ color }) => {
    myColor = color;
    initChess(color);
    toast(`You play ${color === 'white' ? '⬜ White' : '⬛ Black'}`);
  });
  socket.on('chess-move', ({ from, to, promotion }) => {
    if (!game) return;
    const mv = game.move({ from, to, promotion: promotion || 'q' });
    if (mv) {
      lastMove = { from, to };
      renderBoard();
      addChip(mv.san, mv.color);
      updateBadge();
      checkEnd();
    }
  });
  socket.on('chess-opponent-resigned', () => {
    gameOver('🏆', 'You Win!', 'Opponent resigned.');
    endChess();
  });
  socket.on('chess-draw-offer', () => openModal('m-draw'));
  socket.on('chess-draw-response', ({ accepted }) => {
    if (accepted) {
      gameOver('🤝', 'Draw!', 'Both agreed to a draw.');
      endChess();
    } else {
      toast('Draw declined.');
    }
  });
  socket.on('chat-message', ({ message }) => addMsg(message, false));

  // BUG FIX: 'skipped' event — cleanPeer so we can find new match
  socket.on('skipped', () => {
    cleanPeer();
  });
}

// ══════════════════════════════════════════════════════
//   PEER CONNECTION
// ══════════════════════════════════════════════════════
async function makePeer() {
  cleanPeer();
  pc = new RTCPeerConnection(ICE_CFG);
  console.log('[PC] created');

  // Add local tracks
  localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

  // Receive remote stream
  const remoteStream = new MediaStream();
  const rv = $('remote-video');
  rv.srcObject = remoteStream;

  pc.ontrack = (e) => {
    console.log('[track]', e.track.kind, e.track.readyState);
    e.streams[0].getTracks().forEach(t => remoteStream.addTrack(t));
    if (e.track.kind === 'video') {
      rv.play().then(() => {
        hideOv();
        $('tap-video-btn').style.display = 'none';
        console.log('[remote video] playing');
      }).catch(err => {
        console.warn('[autoplay blocked]', err);
        // Mobile fallback
        hideOv();
        $('tap-video-btn').style.display = 'flex';
      });
    }
  };

  pc.onicecandidate = ({ candidate }) => {
    if (candidate && socket && roomId) {
      socket.emit('ice-candidate', { roomId, candidate });
    }
  };

  pc.oniceconnectionstatechange = () => {
    const s = pc.iceConnectionState;
    console.log('[ICE]', s);
    if (s === 'failed') {
      console.log('[ICE] failed → restarting');
      toast('Connection issue, retrying...');
      pc.restartIce();
    }
    if (s === 'disconnected') {
      setTimeout(() => {
        if (pc && pc.iceConnectionState === 'disconnected') partnerLeft();
      }, 5000);
    }
  };

  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    console.log('[conn]', s);
    if (s === 'failed') partnerLeft();
  };

  pc.onsignalingstatechange = () => {
    console.log('[signal]', pc.signalingState);
  };
}

function cleanPeer() {
  clearTimeout(videoTimer);
  if (pc) { pc.close(); pc = null; }
  const rv = $('remote-video');
  rv.srcObject = null;
  roomId = null;
  connected = false;
  $('tap-video-btn').style.display = 'none';
}

// Mobile: tap to play video
function tapToPlay() {
  const rv = $('remote-video');
  if (rv.srcObject) {
    rv.play().then(() => {
      $('tap-video-btn').style.display = 'none';
    }).catch(e => console.warn(e));
  }
}

// ══════════════════════════════════════════════════════
//   MATCHMAKING
// ══════════════════════════════════════════════════════
function findMatch() {
  if (!socket || !socket.connected) return;
  clearTimeout(partnerLeftTimer); // BUG FIX: cancel any pending auto-rematch
  showOv('Finding a stranger...');
  setStatus('searching', 'Searching...');
  $('btn-chess').disabled = true;
  $('chess-invite-btn2').disabled = true;
  socket.emit('find-match');
}

function skipStranger() {
  clearTimeout(partnerLeftTimer); // BUG FIX: cancel partnerLeft auto-rematch
  closeChess();
  sysMsg('You skipped.');
  socket.emit('skip');
  // Clean up peer immediately, then find new match
  cleanPeer();
  setTimeout(findMatch, 300);
}

function stopCall() {
  clearTimeout(partnerLeftTimer); // BUG FIX
  closeChess();
  if (socket) { socket.disconnect(); socket = null; }
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  cleanPeer();
  $('screen-call').style.display = 'none';
  $('screen-call').classList.remove('active');
  $('screen-landing').style.display = 'flex';
  $('screen-landing').classList.add('active');
  // Reset start button
  const btn = $('btn-start');
  btn.querySelector('.btn-label').textContent = 'Start Talking';
  btn.disabled = false;
}

function partnerLeft() {
  // BUG FIX: guard against multiple calls
  if (!connected && !chessActive) return;
  connected = false;

  setStatus('off', 'Stranger left');
  showOv('Stranger left...');
  sysMsg('Stranger left the chat.');
  $('btn-chess').disabled = true;
  $('chess-invite-btn2').disabled = true;

  if (chessActive) {
    endChess();
    toast('Chess ended');
  }

  cleanPeer();

  // BUG FIX: save timer ID so we can cancel it
  partnerLeftTimer = setTimeout(() => {
    if (socket && socket.connected) findMatch();
  }, 2000);
}

// ══════════════════════════════════════════════════════
//   MEDIA CONTROLS
// ══════════════════════════════════════════════════════
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

// ══════════════════════════════════════════════════════
//   CHAT
// ══════════════════════════════════════════════════════
function sendMsg() {
  const inp = $('chat-in'), msg = inp.value.trim();
  if (!msg || !connected) return;
  socket.emit('chat-message', { message: msg });
  addMsg(msg, true);
  inp.value = '';
}

// ══════════════════════════════════════════════════════
//   CHESS
// ══════════════════════════════════════════════════════
function inviteChess() {
  if (!connected) { toast('Not connected!'); return; }
  if (chessActive) {
    toast('Chess already active!');
    switchTab('chess');
    return;
  }
  socket.emit('chess-invite');
  toast('Chess invite sent ♟');
  switchTab('chess'); // Switch to chess tab so they can see the idle state
}

function respondChess(accepted) {
  closeModal('m-chess-invite');
  socket.emit('chess-response', { accepted });
}

// ── Board init ─────────────────────────────────────────
function initChess(color) {
  game = new Chess();
  myColor = color;
  chessActive = true;
  selected = null;
  legalMoves = [];
  lastMove = null;

  $('my-color-val').textContent = color === 'white' ? '⬜ White' : '⬛ Black';
  $('mh-list').innerHTML = '';

  // Show game, hide idle
  $('chess-idle').classList.add('hidden');
  $('chess-game').classList.remove('hidden');

  buildBoard();
  renderBoard();
  updateBadge();
  switchTab('chess');
}

// ── BUG FIX: buildBoard now also builds file labels ────
function buildBoard() {
  const bd = $('chess-board'); bd.innerHTML = '';
  const rl = $('rank-labels'); rl.innerHTML = '';
  const fl = $('file-labels'); fl.innerHTML = ''; // BUG FIX: was never populated

  const ranks = myColor === 'white' ? [8,7,6,5,4,3,2,1] : [1,2,3,4,5,6,7,8];
  const fidxs = myColor === 'white' ? [0,1,2,3,4,5,6,7] : [7,6,5,4,3,2,1,0];

  // Rank labels (left side)
  for (const rn of ranks) {
    const lbl = document.createElement('div');
    lbl.className = 'rank-lbl';
    lbl.textContent = rn;
    rl.appendChild(lbl);
  }

  // Board squares
  for (let ri = 0; ri < 8; ri++) {
    const rn = ranks[ri];
    for (let fi = 0; fi < 8; fi++) {
      const fidx = fidxs[fi];
      const sq = FILES[fidx] + rn;
      const light = (rn + fidx) % 2 === 0;
      const cell = document.createElement('div');
      cell.className = 'sq ' + (light ? 'light' : 'dark');
      cell.dataset.sq = sq;
      cell.addEventListener('click', () => clickSq(sq));
      bd.appendChild(cell);
    }
  }

  // BUG FIX: File labels (bottom) — previously never built
  for (let fi = 0; fi < 8; fi++) {
    const lbl = document.createElement('div');
    lbl.className = 'file-lbl';
    lbl.textContent = FILES[fidxs[fi]];
    fl.appendChild(lbl);
  }
}

function renderBoard() {
  document.querySelectorAll('#chess-board .sq').forEach(cell => {
    const sq = cell.dataset.sq;
    const fidx = FILES.indexOf(sq[0]);
    const rn = parseInt(sq[1]);
    const light = (rn + fidx) % 2 === 0;

    cell.className = 'sq ' + (light ? 'light' : 'dark');

    if (lastMove && (sq === lastMove.from || sq === lastMove.to))
      cell.classList.add('last-move');
    if (sq === selected)
      cell.classList.add('selected');
    if (legalMoves.includes(sq)) {
      cell.classList.add('move-hint');
      if (game.get(sq)) cell.classList.add('has-piece');
    }
    if (game && game.in_check()) {
      const kp = findKing(game.turn());
      if (sq === kp) cell.classList.add('in-check');
    }

    cell.innerHTML = '';
    const p = game ? game.get(sq) : null;
    if (p) {
      const key = (p.color === 'w' ? 'w' : 'b') + p.type.toUpperCase();
      const span = document.createElement('span');
      span.className = 'piece ' + (p.color === 'w' ? 'white-piece' : 'black-piece');
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

function clickSq(sq) {
  if (!chessActive || !game) return;
  const myTurn = (game.turn() === 'w' && myColor === 'white') ||
                 (game.turn() === 'b' && myColor === 'black');
  if (!myTurn) { toast("Not your turn!"); return; }

  const p = game.get(sq);
  const mc = myColor === 'white' ? 'w' : 'b';

  if (selected) {
    if (legalMoves.includes(sq)) { doMove(selected, sq); return; }
    if (p && p.color === mc) { selSq(sq); return; }
    selected = null; legalMoves = []; renderBoard(); return;
  }
  if (p && p.color === mc) selSq(sq);
}

function selSq(sq) {
  selected = sq;
  legalMoves = game.moves({ square: sq, verbose: true }).map(m => m.to);
  renderBoard();
}

function doMove(from, to) {
  // Check for pawn promotion
  const piece = game.get(from);
  let promotion = 'q'; // auto-promote to queen
  if (piece && piece.type === 'p') {
    const toRank = parseInt(to[1]);
    if ((myColor === 'white' && toRank === 8) || (myColor === 'black' && toRank === 1)) {
      promotion = 'q'; // Could show UI for this, defaulting to queen
    }
  }

  const mv = game.move({ from, to, promotion });
  if (!mv) return;

  lastMove = { from, to };
  selected = null;
  legalMoves = [];
  renderBoard();
  addChip(mv.san, mv.color);
  updateBadge();
  socket.emit('chess-move', { from, to, promotion });
  checkEnd();
}

function updateBadge() {
  if (!game) return;
  const myTurn = (game.turn() === 'w' && myColor === 'white') ||
                 (game.turn() === 'b' && myColor === 'black');
  const badge = $('chess-turn-badge');
  if (game.in_check())
    badge.textContent = myTurn ? '🔴 YOU in check!' : '⚠ Opponent in check';
  else
    badge.textContent = myTurn ? '🟢 Your Turn' : "⏳ Opponent's Turn";
}

function addChip(san, color) {
  const c = document.createElement('span');
  c.className = 'mv ' + (color === 'w' ? 'w' : 'b');
  c.textContent = san;
  const l = $('mh-list');
  l.appendChild(c);
  l.scrollTop = l.scrollHeight;
}

function checkEnd() {
  if (!game) return;
  if (game.in_checkmate()) {
    const loser = game.turn();
    const iLose = (loser === 'w' && myColor === 'white') ||
                  (loser === 'b' && myColor === 'black');
    gameOver(iLose ? '😔' : '🏆', iLose ? 'You Lost!' : 'You Win!', 'Checkmate!');
    endChess();
  } else if (game.in_stalemate()) {
    gameOver('🤝', 'Stalemate!', 'No legal moves remaining.');
    endChess();
  } else if (game.in_draw()) {
    gameOver('🤝', 'Draw!', 'Game ended in a draw.');
    endChess();
  }
}

function gameOver(ico, title, body) {
  $('go-icon').textContent = ico;
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
  toast('Draw offered ½');
}

function respondDraw(accepted) {
  closeModal('m-draw');
  socket.emit('chess-draw-response', { accepted });
  if (accepted) {
    gameOver('🤝', 'Draw!', 'Both agreed to a draw.');
    endChess();
  } else {
    toast('Draw declined.');
  }
}

function closeChess() {
  endChess();
  switchTab('chat');
}

function endChess() {
  chessActive = false;
  myColor = null;
  game = null;
  selected = null;
  legalMoves = [];
  lastMove = null;
  // Show idle, hide game
  $('chess-idle').classList.remove('hidden');
  $('chess-game').classList.add('hidden');
}

// ── Keyboard shortcuts ─────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-bg.show').forEach(m => m.classList.remove('show'));
  }
});

// Click outside modal to close
document.addEventListener('click', e => {
  if (e.target.classList.contains('modal-bg')) {
    e.target.classList.remove('show');
  }
});