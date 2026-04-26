/* ═══════════════════════════════════════════
   ChessCall — Client JS
   WebRTC + Socket.io + Chess.js integration
═══════════════════════════════════════════ */

'use strict';

// ── STATE ─────────────────────────────────────────────────────────────
let socket = null;
let localStream = null;
let peerConnection = null;
let currentRoomId = null;
let isConnected = false;
let micEnabled = true;
let camEnabled = true;

// Chess state
let chessGame = null;
let board = null;
let myColor = null;
let moveCount = 0;
let isChessActive = false;
let highlightedSquares = [];

// ── WEBRTC CONFIG ──────────────────────────────────────────────────────
const ICE_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:openrelay.metered.ca:80' },
    {
      urls: 'turn:openrelay.metered.ca:80',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    }
  ],
  iceCandidatePoolSize: 10
};

// ── DOM REFS ───────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

// ═══════════════════════════════════════════════════════════════════════
//   ENTRY POINT
// ═══════════════════════════════════════════════════════════════════════
async function startApp() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
      audio: { echoCancellation: true, noiseSuppression: true }
    });

    $('local-video').srcObject = localStream;

    // Switch screens
    $('screen-landing').classList.remove('active');
    $('screen-landing').style.display = 'none';
    $('screen-call').classList.add('active');
    $('screen-call').style.display = 'flex';

    initSocket();
    findMatch();
  } catch (err) {
    console.error('Media error:', err);
    $('perm-warning').style.display = 'flex';
    showToast('⚠ Camera/mic access denied. Please allow and try again.');
  }
}

// ═══════════════════════════════════════════════════════════════════════
//   SOCKET.IO SETUP
// ═══════════════════════════════════════════════════════════════════════
function initSocket() {
  socket = io({ transports: ['websocket', 'polling'] });

  // ── Connection lifecycle
  socket.on('connect', () => {
    console.log('[Socket] Connected:', socket.id);
  });

  socket.on('disconnect', () => {
    console.log('[Socket] Disconnected');
    setStatus('disconnected', 'Disconnected');
    if (isConnected) {
      handlePartnerLeft();
    }
  });

  // ── Matchmaking
  socket.on('waiting', () => {
    setStatus('waiting', 'Searching...');
    showWaiting('Looking for a stranger...');
    $('btn-chess').disabled = true;
    isConnected = false;
  });

  socket.on('matched', async ({ roomId, isInitiator }) => {
    console.log('[Match] Room:', roomId, '| Initiator:', isInitiator);
    currentRoomId = roomId;
    await setupPeerConnection();

    if (isInitiator) {
      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);
      socket.emit('offer', { roomId, offer });
    }

    addChatSystem('Connected to a stranger! Say hello 👋');
    setStatus('connected', 'Connected');
    $('btn-chess').disabled = false;
    isConnected = true;
  });

  socket.on('partner-left', handlePartnerLeft);

  // ── WebRTC Signaling
  socket.on('offer', async ({ offer }) => {
    if (!peerConnection) await setupPeerConnection();
    await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    socket.emit('answer', { roomId: currentRoomId, answer });
  });

  socket.on('answer', async ({ answer }) => {
    if (!peerConnection) return;
    await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
  });

  socket.on('ice-candidate', ({ candidate }) => {
    if (peerConnection && candidate) {
      peerConnection.addIceCandidate(new RTCIceCandidate(candidate)).catch(console.warn);
    }
  });

  // ── Chess events
  socket.on('chess-invite', () => {
    openModal('modal-chess-invite');
  });

  socket.on('chess-start', ({ color }) => {
    myColor = color;
    initChessBoard(color);
    showToast(`Chess started! You are ${color === 'white' ? '⬜ White' : '⬛ Black'}`);
  });

  socket.on('chess-declined', () => {
    showToast('Stranger declined the chess invite 😞');
  });

  socket.on('chess-move', ({ move }) => {
    const result = chessGame.move(move);
    if (result) {
      board.position(chessGame.fen());
      addMoveChip(result.san, result.color === 'w' ? 'white' : 'black');
      updateChessStatus();
      checkGameOver();
    }
  });

  socket.on('chess-opponent-resigned', () => {
    showGameOver('🏆', 'You Win!', 'Your opponent resigned.');
    endChess();
  });

  socket.on('chess-draw-offer', () => {
    openModal('modal-draw');
  });

  socket.on('chess-draw-response', ({ accepted }) => {
    if (accepted) {
      showGameOver('🤝', 'Draw!', 'Both players agreed to a draw.');
      endChess();
    } else {
      showToast('Draw offer declined.');
    }
  });

  // ── Chat
  socket.on('chat-message', ({ message }) => {
    addChatMsg(message, false);
  });

  socket.on('skipped', () => {
    cleanupPeerConnection();
    hideChessPanel();
  });
}

// ═══════════════════════════════════════════════════════════════════════
//   WEBRTC
// ═══════════════════════════════════════════════════════════════════════
async function setupPeerConnection() {
  cleanupPeerConnection();

  peerConnection = new RTCPeerConnection(ICE_CONFIG);

  // Add local tracks
  localStream.getTracks().forEach(track => {
    peerConnection.addTrack(track, localStream);
  });

  // Remote stream
  peerConnection.ontrack = ({ streams }) => {
    if (streams && streams[0]) {
      $('remote-video').srcObject = streams[0];
      hideWaiting();
    }
  };

  // ICE candidates
  peerConnection.onicecandidate = ({ candidate }) => {
    if (candidate && socket && currentRoomId) {
      socket.emit('ice-candidate', { roomId: currentRoomId, candidate });
    }
  };

  peerConnection.oniceconnectionstatechange = () => {
    const state = peerConnection.iceConnectionState;
    console.log('[ICE]', state);
    if (state === 'disconnected' || state === 'failed' || state === 'closed') {
      handlePartnerLeft();
    }
  };

  peerConnection.onconnectionstatechange = () => {
    const state = peerConnection.connectionState;
    console.log('[Peer]', state);
    if (state === 'connected') {
      hideWaiting();
    }
  };
}

function cleanupPeerConnection() {
  if (peerConnection) {
    peerConnection.ontrack = null;
    peerConnection.onicecandidate = null;
    peerConnection.oniceconnectionstatechange = null;
    peerConnection.onconnectionstatechange = null;
    peerConnection.close();
    peerConnection = null;
  }
  $('remote-video').srcObject = null;
  currentRoomId = null;
  isConnected = false;
}

// ═══════════════════════════════════════════════════════════════════════
//   MATCHMAKING ACTIONS
// ═══════════════════════════════════════════════════════════════════════
function findMatch() {
  if (!socket) return;
  showWaiting('Looking for a stranger...');
  setStatus('waiting', 'Searching...');
  $('btn-chess').disabled = true;
  clearChat();
  socket.emit('find-match');
}

function skipStranger() {
  if (!socket) return;
  hideChessPanel();
  endChess();
  addChatSystem('You skipped.');
  socket.emit('skip');
  setTimeout(() => findMatch(), 300);
}

function stopAndGoHome() {
  if (socket) socket.disconnect();
  if (localStream) localStream.getTracks().forEach(t => t.stop());
  cleanupPeerConnection();
  hideChessPanel();
  endChess();
  $('screen-call').classList.remove('active');
  $('screen-call').style.display = 'none';
  $('screen-landing').classList.add('active');
  $('screen-landing').style.display = 'flex';
  socket = null;
  localStream = null;
}

function handlePartnerLeft() {
  if (!isConnected) return;
  isConnected = false;
  setStatus('disconnected', 'Stranger left');
  showWaiting('Stranger disconnected...');
  addChatSystem('Stranger has left the chat.');
  $('btn-chess').disabled = true;
  cleanupPeerConnection();
  if (isChessActive) {
    endChess();
    showToast('Chess ended — stranger left');
  }
  // Auto find next after 2s
  setTimeout(() => {
    if (socket && socket.connected) findMatch();
  }, 2000);
}

// ═══════════════════════════════════════════════════════════════════════
//   CHESS
// ═══════════════════════════════════════════════════════════════════════
function inviteToChess() {
  if (!isConnected || isChessActive) return;
  socket.emit('chess-invite');
  showToast('Chess invite sent... ♟');
}

function respondChess(accepted) {
  closeModal('modal-chess-invite');
  socket.emit('chess-response', { accepted });
}

function initChessBoard(color) {
  isChessActive = true;
  moveCount = 0;
  chessGame = new Chess();
  $('moves-content').innerHTML = '';
  $('chess-color-label').textContent = color === 'white' ? '⬜ White' : '⬛ Black';
  $('chess-status').textContent = 'Active';

  const cfg = {
    position: 'start',
    orientation: color,
    draggable: true,
    pieceTheme: 'https://unpkg.com/@chrisoakman/chessboardjs@1.0.0/img/chesspieces/wikipedia/{piece}.png',
    onDragStart: onDragStart,
    onDrop: onDrop,
    onSnapEnd: onSnapEnd
  };

  if (board) board.destroy();
  board = Chessboard('chess-board', cfg);
  openChessPanel();
  updateChessStatus();
}

function onDragStart(source, piece) {
  if (!chessGame || chessGame.game_over()) return false;
  if (myColor === 'white' && piece.search(/^b/) !== -1) return false;
  if (myColor === 'black' && piece.search(/^w/) !== -1) return false;
  if (chessGame.turn() === 'w' && myColor !== 'white') return false;
  if (chessGame.turn() === 'b' && myColor !== 'black') return false;
  return true;
}

function onDrop(source, target) {
  removeHighlights();
  const move = chessGame.move({ from: source, to: target, promotion: 'q' });
  if (move === null) return 'snapback';

  addMoveChip(move.san, move.color === 'w' ? 'white' : 'black');
  socket.emit('chess-move', { move: { from: source, to: target, promotion: 'q' } });
  updateChessStatus();
  highlightSquare(source);
  highlightSquare(target);
  checkGameOver();
}

function onSnapEnd() {
  if (board && chessGame) board.position(chessGame.fen());
}

function updateChessStatus() {
  if (!chessGame) return;
  const turn = chessGame.turn() === 'w' ? 'White' : 'Black';
  let status = '';

  if (chessGame.in_checkmate()) {
    status = `${turn} in checkmate`;
  } else if (chessGame.in_check()) {
    status = `${turn} in check!`;
    $('chess-status').style.color = 'var(--red)';
  } else if (chessGame.in_draw()) {
    status = 'Draw';
  } else {
    status = 'Active';
    $('chess-status').style.color = '';
  }

  const myTurn = (chessGame.turn() === 'w' && myColor === 'white') ||
                 (chessGame.turn() === 'b' && myColor === 'black');

  $('chess-turn').textContent = myTurn ? '🟢 Your turn' : `${turn}'s turn`;
  $('chess-status').textContent = status;
}

function checkGameOver() {
  if (!chessGame || !chessGame.game_over()) return;
  if (chessGame.in_checkmate()) {
    const winner = chessGame.turn() === 'w' ? 'Black' : 'White';
    const iWon = (winner === 'White' && myColor === 'white') ||
                 (winner === 'Black' && myColor === 'black');
    showGameOver(iWon ? '🏆' : '😔', iWon ? 'You Win!' : 'You Lost!', `${winner} wins by checkmate.`);
  } else if (chessGame.in_draw()) {
    showGameOver('🤝', 'Draw!', 'The game ended in a draw.');
  } else if (chessGame.in_stalemate()) {
    showGameOver('🤝', 'Stalemate!', 'The game ended in stalemate.');
  }
  endChess();
}

function resignChess() {
  if (!isChessActive) return;
  socket.emit('chess-resign');
  showGameOver('🏳️', 'You Resigned', 'Better luck next time!');
  endChess();
}

function offerDraw() {
  if (!isChessActive) return;
  socket.emit('chess-draw-offer');
  showToast('Draw offered to opponent');
}

function respondDraw(accepted) {
  closeModal('modal-draw');
  socket.emit('chess-draw-response', { accepted });
  if (accepted) {
    showGameOver('🤝', 'Draw!', 'Both players agreed to a draw.');
    endChess();
  }
}

function endChess() {
  isChessActive = false;
  myColor = null;
  chessGame = null;
  moveCount = 0;
}

function addMoveChip(san, color) {
  moveCount++;
  const chip = document.createElement('div');
  chip.className = `move-chip ${color}`;
  chip.textContent = san;
  $('moves-content').appendChild(chip);
  $('moves-content').scrollTop = $('moves-content').scrollHeight;
}

// Square highlighting
function highlightSquare(sq) {
  const el = document.querySelector(`.square-${sq}`);
  if (el) {
    el.classList.add('highlight-' + (el.classList.contains('white-1e1d7') ? 'white' : 'black'));
    highlightedSquares.push(el);
  }
}
function removeHighlights() {
  highlightedSquares.forEach(el => {
    el.classList.remove('highlight-white', 'highlight-black');
  });
  highlightedSquares = [];
}

// ═══════════════════════════════════════════════════════════════════════
//   MEDIA CONTROLS
// ═══════════════════════════════════════════════════════════════════════
function toggleMic() {
  if (!localStream) return;
  micEnabled = !micEnabled;
  localStream.getAudioTracks().forEach(t => t.enabled = micEnabled);
  const btn = $('btn-mic');
  btn.textContent = micEnabled ? '🎤' : '🔇';
  btn.classList.toggle('muted', !micEnabled);
  showToast(micEnabled ? 'Microphone on' : 'Microphone muted');
}

function toggleCam() {
  if (!localStream) return;
  camEnabled = !camEnabled;
  localStream.getVideoTracks().forEach(t => t.enabled = camEnabled);
  const btn = $('btn-cam');
  btn.textContent = camEnabled ? '📷' : '🚫';
  btn.classList.toggle('muted', !camEnabled);
  showToast(camEnabled ? 'Camera on' : 'Camera off');
}

// ═══════════════════════════════════════════════════════════════════════
//   CHAT
// ═══════════════════════════════════════════════════════════════════════
function sendChatMessage() {
  const input = $('chat-input');
  const msg = input.value.trim();
  if (!msg || !isConnected) return;
  socket.emit('chat-message', { message: msg });
  addChatMsg(msg, true);
  input.value = '';
}

function addChatMsg(msg, mine) {
  const el = document.createElement('div');
  el.className = `chat-msg ${mine ? 'mine' : 'theirs'}`;
  el.textContent = msg;
  const container = $('chat-messages');
  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
}

function addChatSystem(msg) {
  const el = document.createElement('div');
  el.className = 'chat-system';
  el.textContent = msg;
  const container = $('chat-messages');
  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
}

function clearChat() {
  $('chat-messages').innerHTML = '<div class="chat-system">Waiting for connection...</div>';
}

// ═══════════════════════════════════════════════════════════════════════
//   UI HELPERS
// ═══════════════════════════════════════════════════════════════════════
function setStatus(state, text) {
  const dot = $('status-dot');
  dot.className = 'status-dot ' + state;
  $('status-text').textContent = text;
}

function showWaiting(msg) {
  const overlay = $('waiting-overlay');
  overlay.classList.remove('hidden');
  $('waiting-msg').textContent = msg;
}

function hideWaiting() {
  $('waiting-overlay').classList.add('hidden');
}

function openChessPanel() {
  $('chess-panel').classList.add('open');
}

function hideChessPanel() {
  $('chess-panel').classList.remove('open');
}

// Modals
function openModal(id) {
  $(id).classList.add('open');
}
function closeModal(id) {
  $(id).classList.remove('open');
}
function closeGameOver() {
  closeModal('modal-gameover');
}

function showGameOver(icon, title, body) {
  $('gameover-icon').textContent = icon;
  $('gameover-title').textContent = title;
  $('gameover-body').textContent = body;
  openModal('modal-gameover');
}

// Toast
let toastTimer;
function showToast(msg) {
  const toast = $('toast');
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 3000);
}

// ── Close modals on backdrop click ────────────────────────────────────
document.addEventListener('click', e => {
  if (e.target.classList.contains('modal-backdrop')) {
    e.target.classList.remove('open');
  }
});

// ── Keyboard shortcuts ────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-backdrop.open').forEach(m => m.classList.remove('open'));
  }
});
