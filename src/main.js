const SIZE = 15;
const CELL = 40;
const PAD = 30;
const RADIUS = 16;
const W = CELL * (SIZE - 1) + PAD * 2;
const H = W;

const canvas = document.getElementById('board');
canvas.width = W;
canvas.height = H;
const ctx = canvas.getContext('2d');

const $status = document.getElementById('status');
const $restart = document.getElementById('restart');
const $last = document.getElementById('last-move');

let board = Array.from({ length: SIZE }, () => Array(SIZE).fill(null));
let myColor = null;
let currentTurn = null;
let gameOver = false;
let lastMove = null;
let winLine = null;

// ---- WebSocket ----
const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
const wsUrl = import.meta.env.DEV
  ? `ws://${location.hostname}:3001`
  : `${protocol}://${location.host}`;
const ws = new WebSocket(wsUrl);

ws.onopen = () => ws.send(JSON.stringify({ type: 'join' }));

ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  switch (msg.type) {
    case 'waiting':
      $status.textContent = '等待对手加入...';
      break;

    case 'start':
      myColor = msg.color;
      currentTurn = msg.turn;
      board = Array.from({ length: SIZE }, () => Array(SIZE).fill(null));
      gameOver = false;
      lastMove = null;
      winLine = null;
      $restart.disabled = true;
      updateStatus();
      draw();
      break;

    case 'move':
      board[msg.row][msg.col] = currentTurn;
      lastMove = { row: msg.row, col: msg.col };
      currentTurn = myColor;
      draw();
      if (checkWin(msg.row, msg.col, board[msg.row][msg.col])) {
        endGame(msg.row, msg.col, board[msg.row][msg.col]);
      } else {
        updateStatus();
      }
      break;

    case 'restart_request':
      $status.textContent = '对手想要再来一局，点击按钮同意';
      $restart.disabled = false;
      break;

    case 'restart':
      myColor = msg.color;
      currentTurn = msg.turn;
      board = Array.from({ length: SIZE }, () => Array(SIZE).fill(null));
      gameOver = false;
      lastMove = null;
      winLine = null;
      $restart.disabled = true;
      updateStatus();
      draw();
      break;

    case 'opponent_left':
      $status.textContent = '对手已离开';
      gameOver = true;
      $restart.disabled = true;
      break;
  }
};

ws.onclose = () => {
  $status.textContent = '连接断开，刷新页面重试';
  gameOver = true;
};

// ---- 绘制 ----
function draw() {
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#dcb35c';
  ctx.fillRect(0, 0, W, H);

  // 网格
  ctx.strokeStyle = '#333';
  ctx.lineWidth = 1;
  for (let i = 0; i < SIZE; i++) {
    const pos = PAD + i * CELL;
    ctx.beginPath(); ctx.moveTo(PAD, pos); ctx.lineTo(PAD + (SIZE - 1) * CELL, pos); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(pos, PAD); ctx.lineTo(pos, PAD + (SIZE - 1) * CELL); ctx.stroke();
  }

  // 星位
  const stars = [3, 7, 11];
  ctx.fillStyle = '#333';
  for (const r of stars) for (const c of stars) {
    ctx.beginPath();
    ctx.arc(PAD + c * CELL, PAD + r * CELL, 3.5, 0, Math.PI * 2);
    ctx.fill();
  }

  // 坐标标签
  ctx.font = '11px sans-serif';
  ctx.fillStyle = '#555';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let i = 0; i < SIZE; i++) {
    ctx.fillText(i, PAD + i * CELL, PAD - 16);
    ctx.fillText(i, PAD - 16, PAD + i * CELL);
  }

  // 棋子
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (!board[r][c]) continue;
      drawStone(PAD + c * CELL, PAD + r * CELL, board[r][c]);
    }
  }

  // 最后一手标记
  if (lastMove) {
    const lx = PAD + lastMove.col * CELL, ly = PAD + lastMove.row * CELL;
    ctx.strokeStyle = '#f44336';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(lx, ly, 6, 0, Math.PI * 2);
    ctx.stroke();
  }

  // 胜利线
  if (gameOver && winLine) {
    ctx.strokeStyle = '#f44336';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(PAD + winLine[0].col * CELL, PAD + winLine[0].row * CELL);
    ctx.lineTo(PAD + winLine[4].col * CELL, PAD + winLine[4].row * CELL);
    ctx.stroke();
  }
}

function drawStone(x, y, color) {
  ctx.fillStyle = 'rgba(0,0,0,.25)';
  ctx.beginPath();
  ctx.arc(x + 2, y + 2, RADIUS, 0, Math.PI * 2);
  ctx.fill();

  const grad = ctx.createRadialGradient(x - 4, y - 4, 2, x, y, RADIUS);
  if (color === 'black') {
    grad.addColorStop(0, '#555');
    grad.addColorStop(1, '#000');
  } else {
    grad.addColorStop(0, '#fff');
    grad.addColorStop(1, '#bbb');
  }
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(x, y, RADIUS, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = color === 'black' ? '#000' : '#999';
  ctx.lineWidth = 1;
  ctx.stroke();
}

// ---- 点击落子 ----
canvas.addEventListener('click', (e) => {
  if (gameOver || currentTurn !== myColor) return;

  const rect = canvas.getBoundingClientRect();
  const scaleX = W / rect.width;
  const scaleY = H / rect.height;
  const mx = (e.clientX - rect.left) * scaleX;
  const my = (e.clientY - rect.top) * scaleY;

  const col = Math.round((mx - PAD) / CELL);
  const row = Math.round((my - PAD) / CELL);

  if (row < 0 || row >= SIZE || col < 0 || col >= SIZE) return;
  if (board[row][col]) return;

  board[row][col] = myColor;
  lastMove = { row, col };
  currentTurn = myColor === 'black' ? 'white' : 'black';

  ws.send(JSON.stringify({ type: 'move', row, col }));

  if (checkWin(row, col, myColor)) {
    endGame(row, col, myColor);
  } else {
    updateStatus();
  }
  draw();
});

// ---- 胜负判定 ----
function checkWin(row, col, color) {
  const dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];
  for (const [dr, dc] of dirs) {
    const cells = [{ row, col }];
    for (let i = 1; i < 5; i++) {
      const r = row + dr * i, c = col + dc * i;
      if (r >= 0 && r < SIZE && c >= 0 && c < SIZE && board[r][c] === color) cells.push({ row: r, col: c });
      else break;
    }
    for (let i = 1; i < 5; i++) {
      const r = row - dr * i, c = col - dc * i;
      if (r >= 0 && r < SIZE && c >= 0 && c < SIZE && board[r][c] === color) cells.unshift({ row: r, col: c });
      else break;
    }
    if (cells.length >= 5) {
      cells.sort((a, b) => a.row - b.row || a.col - b.col);
      winLine = cells;
      return true;
    }
  }
  return false;
}

function endGame(row, col, color) {
  gameOver = true;
  $status.textContent = color === myColor ? '你赢了!' : '你输了';
  $restart.disabled = false;
}

function updateStatus() {
  if (gameOver) return;
  const colorName = myColor === 'black' ? '黑' : '白';
  const turnText = currentTurn === myColor ? ' — 轮到你下' : ' — 对手思考中';
  $status.textContent = `你执${colorName}${turnText}`;
}

// ---- 再来一局 ----
$restart.addEventListener('click', () => {
  ws.send(JSON.stringify({ type: 'restart' }));
  $restart.disabled = true;
  $status.textContent = '等待对手回应...';
});

draw();
