const BOARD_SIZE = 15;
const ROOM_COUNT = 3;

// ---- Types ----
type Color = "black" | "white";

interface Player {
  socket: WebSocket;
  id: string;
  name: string;
  color: Color | "spectator";
}

interface Move {
  row: number;
  col: number;
  player: Color;
}

interface Room {
  id: number;
  players: Map<string, Player>;
  board: (Color | null)[][];
  currentTurn: Color;
  moveHistory: Move[];
  chats: { from: string; message: string; timestamp: number }[];
  undoRequest: { fromId: string; fromName: string } | null;
  gameStarted: boolean;
  gameOver: boolean;
  winner: Color | null;
  winLine: { row: number; col: number }[];
  wantRestart: Set<string>;
  blackId: string | null;
  whiteId: string | null;
}

function emptyBoard(): (Color | null)[][] {
  return Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(null));
}

function createRoom(id: number): Room {
  return {
    id,
    players: new Map(),
    board: emptyBoard(),
    currentTurn: "black",
    moveHistory: [],
    chats: [],
    undoRequest: null,
    gameStarted: false,
    gameOver: false,
    winner: null,
    winLine: [],
    wantRestart: new Set(),
    blackId: null,
    whiteId: null,
  };
}

const rooms: Room[] = Array.from({ length: ROOM_COUNT }, (_, i) => createRoom(i + 1));

let nextPlayerId = 1;

// ---- Helpers ----
function send(ws: WebSocket, msg: Record<string, unknown>) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function broadcast(room: Room, msg: Record<string, unknown>, excludeId?: string) {
  for (const [id, p] of room.players) {
    if (id !== excludeId) send(p.socket, msg);
  }
}

function broadcastAll(room: Room, msg: Record<string, unknown>) {
  for (const p of room.players.values()) {
    send(p.socket, msg);
  }
}

function getRoomState(room: Room, playerId: string) {
  const p = room.players.get(playerId);
  return {
    type: "room_state",
    board: room.board,
    currentTurn: room.currentTurn,
    yourColor: p?.color ?? "spectator",
    players: {
      black: room.blackId ? room.players.get(room.blackId)?.name ?? null : null,
      white: room.whiteId ? room.players.get(room.whiteId)?.name ?? null : null,
    },
    moveHistory: room.moveHistory,
    gameStarted: room.gameStarted,
    gameOver: room.gameOver,
    winner: room.winner,
    winLine: room.winLine,
    chats: room.chats.slice(-50),
  };
}

function checkWin(board: (Color | null)[][], row: number, col: number, color: Color) {
  const dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];
  for (const [dr, dc] of dirs) {
    const cells: { row: number; col: number }[] = [{ row, col }];
    for (let i = 1; i < 5; i++) {
      const r = row + dr * i, c = col + dc * i;
      if (r >= 0 && r < BOARD_SIZE && c >= 0 && c < BOARD_SIZE && board[r][c] === color) {
        cells.push({ row: r, col: c });
      } else break;
    }
    for (let i = 1; i < 5; i++) {
      const r = row - dr * i, c = col - dc * i;
      if (r >= 0 && r < BOARD_SIZE && c >= 0 && c < BOARD_SIZE && board[r][c] === color) {
        cells.unshift({ row: r, col: c });
      } else break;
    }
    if (cells.length >= 5) {
      cells.sort((a, b) => a.row - b.row || a.col - b.col);
      return cells;
    }
  }
  return null;
}

function startGame(room: Room) {
  room.board = emptyBoard();
  room.currentTurn = "black";
  room.moveHistory = [];
  room.gameStarted = true;
  room.gameOver = false;
  room.winner = null;
  room.winLine = [];
  room.undoRequest = null;
  room.wantRestart.clear();

  for (const [id, p] of room.players) {
    send(p.socket, {
      type: "room_state",
      board: room.board,
      currentTurn: room.currentTurn,
      yourColor: p.color,
      players: {
        black: room.blackId ? room.players.get(room.blackId)?.name ?? null : null,
        white: room.whiteId ? room.players.get(room.whiteId)?.name ?? null : null,
      },
      moveHistory: room.moveHistory,
      gameStarted: true,
      gameOver: false,
      winner: null,
      winLine: [],
      chats: room.chats.slice(-50),
    });
  }
}

// ---- Static File Serving ----
const ROOT = new URL(".", import.meta.url).pathname;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

async function serveFile(pathname: string): Promise<Response> {
  const filePath = pathname === "/" ? "/index.html" : pathname;
  const fullPath = ROOT + filePath.replace(/^\//, "");

  try {
    const data = await Deno.readFile(fullPath);
    const ext = fullPath.slice(fullPath.lastIndexOf("."));
    return new Response(data, {
      headers: { "Content-Type": MIME[ext] || "application/octet-stream" },
    });
  } catch {
    // Try src/ directory for asset files
    try {
      const srcPath = ROOT + "src/" + filePath.replace(/^\/src\//, "");
      const data = await Deno.readFile(srcPath);
      const ext = srcPath.slice(srcPath.lastIndexOf("."));
      return new Response(data, {
        headers: { "Content-Type": MIME[ext] || "application/octet-stream" },
      });
    } catch {
      return new Response("Not Found", { status: 404 });
    }
  }
}

// ---- WebSocket Handler ----
function handleSocket(socket: WebSocket) {
  const playerId = String(nextPlayerId++);
  let currentRoom: Room | null = null;

  socket.addEventListener("message", (e) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(typeof e.data === "string" ? e.data : new TextDecoder().decode(e.data as ArrayBuffer));
    } catch {
      return;
    }

    switch (msg.type) {
      case "join_room": {
        const roomId = Number(msg.roomId);
        const name = String(msg.name || "玩家").trim().slice(0, 12);

        if (isNaN(roomId) || roomId < 1 || roomId > ROOM_COUNT) {
          send(socket, { type: "error", message: `房间号无效 (1-${ROOM_COUNT})` });
          return;
        }

        const room = rooms[roomId - 1];
        let color: Color | "spectator" = "spectator";

        if (!room.blackId) {
          color = "black";
          room.blackId = playerId;
        } else if (!room.whiteId) {
          color = "white";
          room.whiteId = playerId;
        }

        const player: Player = { socket, id: playerId, name, color };
        room.players.set(playerId, player);
        currentRoom = room;

        send(socket, getRoomState(room, playerId));

        if (color !== "spectator") {
          broadcast(room, {
            type: "chat_message",
            from: "系统",
            message: `${name} 加入了房间 (${color === "black" ? "黑方" : "白方"})`,
            timestamp: Date.now(),
          }, playerId);
        } else {
          send(socket, {
            type: "chat_message",
            from: "系统",
            message: "房间已满，你以观战模式加入",
            timestamp: Date.now(),
          });
        }

        // Start game when 2 players
        if (room.blackId && room.whiteId && !room.gameStarted) {
          startGame(room);
          broadcastAll(room, {
            type: "chat_message",
            from: "系统",
            message: "游戏开始！黑方先行",
            timestamp: Date.now(),
          });
        }

        // Notify others a new player joined
        broadcast(room, {
          type: "player_joined",
          playerId,
          name,
          color,
        }, playerId);
        break;
      }

      case "move": {
        if (!currentRoom) return;
        const room = currentRoom;
        const player = room.players.get(playerId);
        if (!player || player.color === "spectator") {
          send(socket, { type: "error", message: "观战模式不能落子" });
          return;
        }
        if (room.gameOver) {
          send(socket, { type: "error", message: "游戏已结束" });
          return;
        }
        if (!room.gameStarted) {
          send(socket, { type: "error", message: "等待对手加入" });
          return;
        }
        if (room.currentTurn !== player.color) {
          send(socket, { type: "error", message: "还没轮到你" });
          return;
        }
        const row = Number(msg.row);
        const col = Number(msg.col);
        if (isNaN(row) || isNaN(col) || row < 0 || row >= BOARD_SIZE || col < 0 || col >= BOARD_SIZE) {
          send(socket, { type: "error", message: "无效位置" });
          return;
        }
        if (room.board[row][col]) {
          send(socket, { type: "error", message: "此处已有棋子" });
          return;
        }

        // If the requester makes a new move, cancel their undo request
        if (room.undoRequest && room.undoRequest.fromId === playerId) {
          room.undoRequest = null;
        }

        room.board[row][col] = player.color;
        room.moveHistory.push({ row, col, player: player.color });
        room.currentTurn = player.color === "black" ? "white" : "black";

        const winLine = checkWin(room.board, row, col, player.color);

        broadcastAll(room, {
          type: "move_made",
          row,
          col,
          player: player.color,
          board: room.board,
          currentTurn: room.currentTurn,
          moveHistory: room.moveHistory,
        });

        // If opponent moves while an undo request is pending, remind them
        if (room.undoRequest && room.undoRequest.fromId !== playerId) {
          send(socket, { type: "undo_requested", from: room.undoRequest.fromName });
        }

        if (winLine) {
          room.gameOver = true;
          room.winner = player.color;
          room.winLine = winLine;
          broadcastAll(room, {
            type: "game_over",
            winner: player.color,
            winLine,
          });
          broadcastAll(room, {
            type: "chat_message",
            from: "系统",
            message: `${player.name} (${player.color === "black" ? "黑方" : "白方"}) 获胜！`,
            timestamp: Date.now(),
          });
        }
        break;
      }

      case "chat": {
        if (!currentRoom) return;
        const player = currentRoom.players.get(playerId);
        if (!player) return;
        const message = String(msg.message || "").trim().slice(0, 200);
        if (!message) return;

        const chatMsg = { from: player.name, message, timestamp: Date.now() };
        currentRoom.chats.push(chatMsg);
        if (currentRoom.chats.length > 200) currentRoom.chats.shift();

        broadcastAll(currentRoom, {
          type: "chat_message",
          ...chatMsg,
        });
        break;
      }

      case "undo_request": {
        if (!currentRoom) return;
        const room = currentRoom;
        const player = room.players.get(playerId);
        if (!player || player.color === "spectator") {
          send(socket, { type: "error", message: "观战者不能请求悔棋" });
          return;
        }
        if (room.gameOver) {
          send(socket, { type: "error", message: "游戏已结束" });
          return;
        }
        if (room.moveHistory.length < 1) {
          send(socket, { type: "error", message: "至少需要下一步棋才能悔棋" });
          return;
        }
        if (room.undoRequest) {
          send(socket, { type: "error", message: "已有待处理的悔棋请求" });
          return;
        }

        room.undoRequest = { fromId: playerId, fromName: player.name };

        // Notify opponent
        const oppId = player.color === "black" ? room.whiteId : room.blackId;
        if (oppId) {
          const opp = room.players.get(oppId);
          if (opp) {
            send(opp.socket, { type: "undo_requested", from: player.name });
          }
        }

        send(socket, {
          type: "chat_message",
          from: "系统",
          message: `你请求悔棋，等待对方回应...`,
          timestamp: Date.now(),
        });
        break;
      }

      case "undo_response": {
        if (!currentRoom) return;
        const room = currentRoom;
        const player = room.players.get(playerId);
        if (!player || player.color === "spectator") return;

        if (!room.undoRequest) {
          send(socket, { type: "error", message: "没有待处理的悔棋请求" });
          return;
        }

        const accept = Boolean(msg.accept);
        const requester = room.players.get(room.undoRequest.fromId);
        room.undoRequest = null;

        if (accept && room.moveHistory.length >= 1 && requester) {
          const lastMove = room.moveHistory[room.moveHistory.length - 1];

          if (lastMove.player === requester.color) {
            // Opponent hasn't moved yet — undo just the requester's 1 move
            const m = room.moveHistory.pop()!;
            room.board[m.row][m.col] = null;
            room.currentTurn = requester.color;

            broadcastAll(room, {
              type: "undo_result",
              accepted: true,
              board: room.board,
              currentTurn: room.currentTurn,
              moveHistory: room.moveHistory,
            });
            broadcastAll(room, {
              type: "chat_message",
              from: "系统",
              message: `${player.name} 同意了悔棋（撤销 1 步）`,
              timestamp: Date.now(),
            });
          } else if (room.moveHistory.length >= 2) {
            // Opponent already responded — undo both moves (2 steps)
            const m1 = room.moveHistory.pop()!;
            const m2 = room.moveHistory.pop()!;
            room.board[m1.row][m1.col] = null;
            room.board[m2.row][m2.col] = null;
            room.currentTurn = requester.color;

            broadcastAll(room, {
              type: "undo_result",
              accepted: true,
              board: room.board,
              currentTurn: room.currentTurn,
              moveHistory: room.moveHistory,
            });
            broadcastAll(room, {
              type: "chat_message",
              from: "系统",
              message: `${player.name} 同意了悔棋（撤销 2 步）`,
              timestamp: Date.now(),
            });
          }
        } else {
          if (requester) {
            send(requester.socket, {
              type: "undo_result",
              accepted: false,
              board: room.board,
              currentTurn: room.currentTurn,
              moveHistory: room.moveHistory,
            });
          }
          broadcastAll(room, {
            type: "chat_message",
            from: "系统",
            message: `${player.name} 拒绝了悔棋`,
            timestamp: Date.now(),
          });
        }
        break;
      }

      case "restart": {
        if (!currentRoom) return;
        const room = currentRoom;
        const player = room.players.get(playerId);
        if (!player || player.color === "spectator") return;

        room.wantRestart.add(playerId);

        const otherId = player.color === "black" ? room.whiteId : room.blackId;
        if (otherId && !room.wantRestart.has(otherId)) {
          const other = room.players.get(otherId);
          if (other) send(other.socket, { type: "restart_request", from: player.name });
          send(socket, {
            type: "chat_message",
            from: "系统",
            message: "你已准备再来一局，等待对方...",
            timestamp: Date.now(),
          });
        }

        // Both want restart → swap colors and start
        if (otherId && room.wantRestart.has(otherId) && room.wantRestart.has(playerId)) {
          // Swap colors
          if (room.blackId && room.whiteId) {
            const black = room.players.get(room.blackId)!;
            const white = room.players.get(room.whiteId)!;
            black.color = "white";
            white.color = "black";
            room.blackId = white.id;
            room.whiteId = black.id;
          }
          startGame(room);
          broadcastAll(room, {
            type: "chat_message",
            from: "系统",
            message: "新一局开始！双方交换黑白，黑方先行",
            timestamp: Date.now(),
          });
        }
        break;
      }
    }
  });

  socket.addEventListener("close", () => {
    if (!currentRoom) return;
    const room = currentRoom;
    const player = room.players.get(playerId);
    if (!player) return;

    const name = player.name;
    room.players.delete(playerId);
    room.wantRestart.delete(playerId);

    if (room.undoRequest?.fromId === playerId) {
      room.undoRequest = null;
    }

    if (room.blackId === playerId) room.blackId = null;
    if (room.whiteId === playerId) room.whiteId = null;

    if (room.players.size === 0) {
      // Reset room
      Object.assign(room, createRoom(room.id));
    } else {
      broadcastAll(room, {
        type: "chat_message",
        from: "系统",
        message: `${name} 离开了房间`,
        timestamp: Date.now(),
      });

      if (room.gameStarted && !room.gameOver) {
        room.gameOver = true;
        broadcastAll(room, {
          type: "player_left",
          name,
        });
        broadcastAll(room, {
          type: "chat_message",
          from: "系统",
          message: "对手离开，游戏结束",
          timestamp: Date.now(),
        });
      }
    }
  });

  socket.addEventListener("error", () => {
    // close event will handle cleanup
  });
}

// ---- Server ----
Deno.serve({ port: 3001 }, (req) => {
  const upgrade = req.headers.get("upgrade");
  if (upgrade?.toLowerCase() === "websocket") {
    const { socket, response } = Deno.upgradeWebSocket(req);
    handleSocket(socket);
    return response;
  }

  const url = new URL(req.url);
  return serveFile(url.pathname);
});

console.log("五子棋服务器已启动: http://localhost:3001");
console.log(`房间数: ${ROOM_COUNT}`);
