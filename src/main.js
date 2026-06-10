const SIZE = 15;
const CELL = 40;
const PAD = 30;
const RADIUS = 16;
const W = CELL * (SIZE - 1) + PAD * 2;
const H = W;

// ---- DOM Elements ----
const canvas = document.getElementById("board");
canvas.width = W;
canvas.height = H;
const ctx = canvas.getContext("2d");

const $status = document.getElementById("status");
const $roomInfo = document.getElementById("room-info");
const $undoBtn = document.getElementById("undo-btn");
const $restartBtn = document.getElementById("restart-btn");
const $undoPrompt = document.getElementById("undo-prompt");
const $undoPromptText = document.getElementById("undo-prompt-text");
const $undoAccept = document.getElementById("undo-accept");
const $undoReject = document.getElementById("undo-reject");
const $chatMessages = document.getElementById("chat-messages");
const $chatInput = document.getElementById("chat-input");
const $chatSend = document.getElementById("chat-send");
const $modalOverlay = document.getElementById("modal-overlay");
const $nameInput = document.getElementById("name-input");
const $roomList = document.getElementById("room-list");
const $joinBtn = document.getElementById("join-btn");
const $rightPanel = document.getElementById("right-panel");
const $chatToggle = document.getElementById("chat-toggle");
const $chatCollapse = document.getElementById("chat-collapse");

// ---- Chat Panel Toggle ----
function toggleChat() {
  $rightPanel.classList.toggle("collapsed");
  const collapsed = $rightPanel.classList.contains("collapsed");
  $chatToggle.textContent = collapsed ? "💬" : "✕";
  if (!collapsed) {
    $chatToggle.classList.remove("has-unread");
  }
}

$chatToggle.addEventListener("click", toggleChat);
$chatCollapse.addEventListener("click", toggleChat);

// ---- State ----
let board = Array.from({ length: SIZE }, () => Array(SIZE).fill(null));
let myColor = null;
let currentTurn = null;
let gameOver = false;
let gameStarted = false;
let lastMove = null;
let winLine = [];
let moveHistory = [];
let selectedRoom = 0;
let undoPending = false;
let myName = null;

// ---- WebSocket ----
const protocol = location.protocol === "https:" ? "wss" : "ws";
//const wsUrl = `${protocol}://${location.hostname}:3001`;
const wsUrl = `${protocol}://${location.host}`;
const ws = new WebSocket(wsUrl);
// Build room list immediately, don't wait for WebSocket                                                                                                                                 
fetchRoomList();

ws.onopen = () => {
  $status.textContent = "已连接";
};

ws.onclose = () => {
  $status.textContent = "连接断开，刷新页面重试";
  gameOver = true;
  gameStarted = false;
};

ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  switch (msg.type) {
    case "room_state":
      handleRoomState(msg);
      break;

    case "move_made":
      handleMoveMade(msg);
      break;

    case "game_over":
      gameOver = true;
      winLine = msg.winLine;
      if (msg.winner === myColor) {
        $status.textContent = "你赢了!";
      } else {
        $status.textContent = "你输了";
      }
      $restartBtn.disabled = false;
      $undoBtn.disabled = true;
      draw();
      break;

    case "chat_message":
      addChatMessage(msg.from, msg.message, msg.timestamp);
      break;

    case "undo_requested":
      undoPending = true;
      $undoPrompt.classList.remove("hidden");
      $undoPromptText.textContent = `${msg.from} 请求悔棋`;
      $undoBtn.disabled = true;
      $undoAccept.style.display = "inline-block";
      $undoReject.style.display = "inline-block";
      break;

    case "undo_result":
      undoPending = false;
      $undoPrompt.classList.add("hidden");
      if (msg.accepted) {
        board = msg.board;
        currentTurn = msg.currentTurn;
        moveHistory = msg.moveHistory;
        lastMove = moveHistory.length > 0 ? moveHistory[moveHistory.length - 1] : null;
        winLine = [];
        updateStatus();
        draw();
      }
      $undoBtn.disabled = !canUndo();
      break;

    case "player_left":
      addChatMessage("系统", `${msg.name} 离开了`, Date.now());
      $status.textContent = "对手离开，游戏结束";
      gameOver = true;
      gameStarted = false;
      $undoBtn.disabled = true;
      $restartBtn.disabled = true;
      break;

    case "restart_request":
      addChatMessage("系统", `${msg.from} 想要再来一局`, Date.now());
      break;

    case "player_joined":
      addChatMessage("系统", `${msg.name} 加入了房间`, Date.now());
      break;

    case "error":
      addChatMessage("系统", msg.message, Date.now());
      break;
  }
};

// ---- Room Join Modal ----
function fetchRoomList() {
  $roomList.innerHTML = "";
  for (let i = 1; i <= 3; i++) {
    const div = document.createElement("div");
    div.className = "room-card";
    div.dataset.room = String(i);
    div.innerHTML = `<div class="room-num">房间 ${i}</div><div class="room-players">-</div>`;
    div.addEventListener("click", () => selectRoom(i, div));
    $roomList.appendChild(div);
  }

  const saved = localStorage.getItem("gomoku_name");
  if (saved) $nameInput.value = saved;

  $nameInput.addEventListener("input", updateJoinBtn);
  updateJoinBtn();
}

function selectRoom(roomId, el) {
  selectedRoom = roomId;
  document.querySelectorAll(".room-card").forEach((c) => c.classList.remove("selected"));
  el.classList.add("selected");
  updateJoinBtn();
}

function updateJoinBtn() {
  $joinBtn.disabled = !($nameInput.value.trim() && selectedRoom > 0);
}

$joinBtn.addEventListener("click", () => {
  const name = $nameInput.value.trim();
  if (!name || selectedRoom === 0) return;
  localStorage.setItem("gomoku_name", name);
  myName = name;
  $modalOverlay.style.display = "none";
  ws.send(JSON.stringify({ type: "join_room", roomId: selectedRoom, name }));
  $roomInfo.textContent = `房间 ${selectedRoom}`;
});

function handleRoomState(msg) {
  board = msg.board;
  currentTurn = msg.currentTurn;
  myColor = msg.yourColor;
  gameStarted = msg.gameStarted;
  gameOver = msg.gameOver;
  winLine = msg.winLine || [];
  moveHistory = msg.moveHistory || [];
  lastMove = moveHistory.length > 0 ? moveHistory[moveHistory.length - 1] : null;

  const b = msg.players.black || "等待中";
  const w = msg.players.white || "等待中";
  $roomInfo.textContent = `房间 ${selectedRoom} | 黑方: ${b} | 白方: ${w}`;

  // Restore chat history
  $chatMessages.innerHTML = "";
  if (msg.chats) {
    for (const c of msg.chats) {
      addChatMessage(c.from, c.message, c.timestamp);
    }
  }

  updateStatus();
  updateButtons();
  draw();
}

function handleMoveMade(msg) {
  board = msg.board;
  currentTurn = msg.currentTurn;
  moveHistory = msg.moveHistory;
  lastMove = { row: msg.row, col: msg.col };
  winLine = [];
  updateStatus();
  updateButtons();
  draw();
}

// ---- Drawing ----
function draw() {
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = "#dcb35c";
  ctx.fillRect(0, 0, W, H);

  // Grid lines
  ctx.strokeStyle = "#333";
  ctx.lineWidth = 1;
  for (let i = 0; i < SIZE; i++) {
    const pos = PAD + i * CELL;
    ctx.beginPath();
    ctx.moveTo(PAD, pos);
    ctx.lineTo(PAD + (SIZE - 1) * CELL, pos);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(pos, PAD);
    ctx.lineTo(pos, PAD + (SIZE - 1) * CELL);
    ctx.stroke();
  }

  // Star points (天元 + 四星)
  const stars = [3, 7, 11];
  ctx.fillStyle = "#333";
  for (const r of stars) {
    for (const c of stars) {
      ctx.beginPath();
      ctx.arc(PAD + c * CELL, PAD + r * CELL, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Coordinate labels
  ctx.font = "11px sans-serif";
  ctx.fillStyle = "#555";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (let i = 0; i < SIZE; i++) {
    ctx.fillText(String(i), PAD + i * CELL, PAD - 16);
    ctx.fillText(String(i), PAD - 16, PAD + i * CELL);
  }

  // Stones
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (!board[r][c]) continue;
      drawStone(PAD + c * CELL, PAD + r * CELL, board[r][c]);
    }
  }

  // Last move marker
  if (lastMove && !gameOver) {
    const lx = PAD + lastMove.col * CELL;
    const ly = PAD + lastMove.row * CELL;
    ctx.strokeStyle = "#f44336";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(lx, ly, 6, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Win line
  if (gameOver && winLine.length >= 5) {
    ctx.strokeStyle = "#f44336";
    ctx.lineWidth = 3;
    ctx.beginPath();
    const first = winLine[0];
    const last = winLine[winLine.length - 1];
    ctx.moveTo(PAD + first.col * CELL, PAD + first.row * CELL);
    ctx.lineTo(PAD + last.col * CELL, PAD + last.row * CELL);
    ctx.stroke();
  }
}

function drawStone(x, y, color) {
  // Shadow
  ctx.fillStyle = "rgba(0,0,0,.25)";
  ctx.beginPath();
  ctx.arc(x + 2, y + 2, RADIUS, 0, Math.PI * 2);
  ctx.fill();

  // Stone gradient
  const grad = ctx.createRadialGradient(x - 4, y - 4, 2, x, y, RADIUS);
  if (color === "black") {
    grad.addColorStop(0, "#555");
    grad.addColorStop(1, "#000");
  } else {
    grad.addColorStop(0, "#fff");
    grad.addColorStop(1, "#bbb");
  }
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(x, y, RADIUS, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = color === "black" ? "#000" : "#999";
  ctx.lineWidth = 1;
  ctx.stroke();
}

// ---- Click to Place Stone ----
canvas.addEventListener("click", (e) => {
  if (gameOver || currentTurn !== myColor || !gameStarted || myColor === "spectator") return;

  const rect = canvas.getBoundingClientRect();
  const scaleX = W / rect.width;
  const scaleY = H / rect.height;
  const mx = (e.clientX - rect.left) * scaleX;
  const my = (e.clientY - rect.top) * scaleY;

  const col = Math.round((mx - PAD) / CELL);
  const row = Math.round((my - PAD) / CELL);

  if (row < 0 || row >= SIZE || col < 0 || col >= SIZE) return;
  if (board[row][col]) return;

  // Optimistic local update
  board[row][col] = myColor;
  lastMove = { row, col };
  currentTurn = myColor === "black" ? "white" : "black";

  ws.send(JSON.stringify({ type: "move", row, col }));
  updateStatus();
  updateButtons();
  draw();
});

// ---- Buttons ----
function canUndo() {
  if (gameOver || !gameStarted || myColor === "spectator") return false;
  if (undoPending) return false;
  if (moveHistory.length < 1) return false;
  if (currentTurn === myColor) return false;
  return true;
}

function updateButtons() {
  $undoBtn.disabled = !canUndo();
  $restartBtn.disabled = !gameOver || myColor === "spectator";
}

$undoBtn.addEventListener("click", () => {
  if (!canUndo()) return;
  undoPending = true;
  $undoBtn.disabled = true;
  $undoPrompt.classList.remove("hidden");
  $undoPromptText.textContent = "等待对方同意悔棋...";
  $undoAccept.style.display = "none";
  $undoReject.style.display = "none";
  ws.send(JSON.stringify({ type: "undo_request" }));
});

$undoAccept.addEventListener("click", () => {
  ws.send(JSON.stringify({ type: "undo_response", accept: true }));
  undoPending = false;
  $undoPrompt.classList.add("hidden");
});

$undoReject.addEventListener("click", () => {
  ws.send(JSON.stringify({ type: "undo_response", accept: false }));
  undoPending = false;
  $undoPrompt.classList.add("hidden");
});

$restartBtn.addEventListener("click", () => {
  ws.send(JSON.stringify({ type: "restart" }));
  $restartBtn.disabled = true;
  $status.textContent = "等待对手回应...";
});

// ---- Chat ----
function addChatMessage(from, message) {
  const div = document.createElement("div");
  const isSystem = from === "系统";
  const isMe = from === myName;

  div.className = "msg";
  if (isSystem) div.classList.add("system");
  else if (isMe) div.classList.add("me");
  else div.classList.add("other");

  if (isSystem) {
    div.textContent = message;
  } else {
    if (!isMe) {
      const author = document.createElement("div");
      author.className = "author";
      author.textContent = from;
      div.appendChild(author);
    }
    div.appendChild(document.createTextNode(message));
  }
  $chatMessages.appendChild(div);
  $chatMessages.scrollTop = $chatMessages.scrollHeight;

  // Pulse toggle button if panel is collapsed
  if ($rightPanel.classList.contains("collapsed") && !isSystem) {
    $chatToggle.classList.add("has-unread");
    setTimeout(() => $chatToggle.classList.remove("has-unread"), 2000);
  }
}

function sendChat() {
  const text = $chatInput.value.trim();
  if (!text) return;
  $chatInput.value = "";
  ws.send(JSON.stringify({ type: "chat", message: text }));
}

$chatSend.addEventListener("click", sendChat);
$chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendChat();
});

// ---- Status ----
function updateStatus() {
  if (gameOver) return;
  if (!gameStarted) {
    $status.textContent = "等待对手加入...";
    return;
  }
  if (myColor === "spectator") {
    $status.textContent = `观战中 — 当前${currentTurn === "black" ? "黑方" : "白方"}行动`;
    return;
  }
  const colorName = myColor === "black" ? "黑" : "白";
  const turnText = currentTurn === myColor ? " — 轮到你下" : " — 对手思考中";
  $status.textContent = `你执${colorName}${turnText}`;
}

// Initial draw
draw();
