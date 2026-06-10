const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

//const PORT = 3001;
const PORT = 80;
const DIST = path.join(__dirname, 'dist');

const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

// ---- 匹配队列 ----
const queue = [];

// ---- HTTP: 生产模式托管 dist/ ----
const server = http.createServer((req, res) => {
  let file = req.url === '/' ? '/index.html' : req.url;
  let filePath = path.join(DIST, file);

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not Found');
    } else {
      res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'text/plain' });
      res.end(data);
    }
  });
});

// ---- WebSocket ----
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    switch (msg.type) {
      case 'join': {
        if (queue.length > 0) {
          const opponent = queue.shift();
          opponent.color = 'black';
          ws.color = 'white';

          opponent.opp = ws;
          ws.opp = opponent;

          opponent.send(JSON.stringify({ type: 'start', color: 'black', turn: 'black' }));
          ws.send(JSON.stringify({ type: 'start', color: 'white', turn: 'black' }));
        } else {
          queue.push(ws);
          ws.send(JSON.stringify({ type: 'waiting' }));
        }
        break;
      }

      case 'move': {
        if (ws.opp && ws.opp.readyState === 1) {
          ws.opp.send(JSON.stringify({ type: 'move', row: msg.row, col: msg.col }));
        }
        break;
      }

      case 'restart': {
        ws.wantRestart = true;
        if (ws.opp && ws.opp.readyState === 1) {
          ws.opp.send(JSON.stringify({ type: 'restart_request' }));

          if (ws.opp.wantRestart) {
            ws.wantRestart = false;
            ws.opp.wantRestart = false;
            [ws, ws.opp].forEach((p) => {
              if (p.readyState === 1) {
                p.send(JSON.stringify({ type: 'restart', color: p.color, turn: 'black' }));
              }
            });
          }
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    // 从队列中移除
    const qi = queue.indexOf(ws);
    if (qi !== -1) queue.splice(qi, 1);

    // 通知对手
    if (ws.opp && ws.opp.readyState === 1) {
      ws.opp.send(JSON.stringify({ type: 'opponent_left' }));
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server: http://localhost:${PORT}`);
  console.log(`WebSocket: ws://localhost:${PORT}`);
});
