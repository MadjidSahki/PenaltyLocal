const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");
const { createMatch, submitChoice, submitTimeout, roundResult } = require("./match");
const { createRoomManager } = require("./rooms");

const PUBLIC_DIR = path.join(__dirname, "..", "public");

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split("?")[0]);
  if (urlPath === "/") urlPath = "/index.html";
  const filePath = path.join(PUBLIC_DIR, path.normalize(urlPath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const type = CONTENT_TYPES[path.extname(filePath)] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type });
    res.end(data);
  });
}

function createServer({ port = 3000, shotClockMs = 10000 } = {}) {
  const rooms = createRoomManager({});
  const httpServer = http.createServer(serveStatic);
  const wss = new WebSocketServer({ server: httpServer });

  const sockets = new Map(); // playerId -> ws

  function send(ws, msg) {
    if (ws && ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  function playerSocket(room, slot) {
    const player = room.players[slot];
    return player ? sockets.get(player.id) : null;
  }

  function clearClock(room) {
    if (room.clock) {
      clearTimeout(room.clock);
      room.clock = null;
    }
  }

  function startRound(room) {
    const match = room.match;
    const shooter = match.shooter;
    const keeper = shooter === "a" ? "b" : "a";
    for (const slot of ["a", "b"]) {
      const role = slot === shooter ? "shooter" : "keeper";
      send(playerSocket(room, slot), {
        type: "turn",
        round: match.round,
        shooter,
        you: slot,
        role,
        deadlineMs: shotClockMs,
      });
    }
    clearClock(room);
    room.clock = setTimeout(() => {
      // A player who hasn't chosen times out; the shooter is resolved first
      // so that if both failed to choose it counts as a missed shot.
      const pending = room.match.pending;
      const timeoutPlayer = pending.shooter === null ? shooter : keeper;
      const r = submitTimeout(room.match, timeoutPlayer);
      if (r.ok) {
        room.match = r.state;
        broadcastResult(room);
      }
    }, shotClockMs);
  }

  function broadcastResult(room) {
    clearClock(room);
    const result = roundResult(room.match);
    for (const slot of ["a", "b"]) {
      send(playerSocket(room, slot), {
        type: "result",
        shooterZone: result.shooterZone,
        keeperZone: result.keeperZone,
        goal: result.goal,
        scores: result.scores,
        shooter: result.shooter,
        timedOut: result.timedOut,
      });
    }
    if (room.match.status === "finished") {
      for (const slot of ["a", "b"]) {
        send(playerSocket(room, slot), {
          type: "matchOver",
          winner: room.match.winner,
          scores: room.match.scores,
        });
      }
    } else {
      startRound(room);
    }
  }

  function startMatch(room) {
    room.match = createMatch();
    const names = {
      a: room.players.a.nickname,
      b: room.players.b.nickname,
    };
    for (const slot of ["a", "b"]) {
      send(playerSocket(room, slot), { type: "start", you: slot, names });
    }
    startRound(room);
  }

  wss.on("connection", (ws) => {
    const playerId = crypto.randomUUID();
    ws.playerId = playerId;
    sockets.set(playerId, ws);

    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      handle(ws, playerId, msg);
    });

    ws.on("close", () => {
      sockets.delete(playerId);
      const room = rooms.roomOfPlayer(playerId);
      if (!room) return;
      clearClock(room);
      const otherSlot = room.players.a && room.players.a.id === playerId ? "b" : "a";
      send(playerSocket(room, otherSlot), { type: "opponentLeft" });
      rooms.removeRoom(room.code);
    });
  });

  function handle(ws, playerId, msg) {
    switch (msg.type) {
      case "create": {
        const { code, room } = rooms.createRoom({ id: playerId, nickname: msg.nickname || "Joueur" });
        send(ws, { type: "created", code });
        break;
      }
      case "join": {
        const result = rooms.joinRoom(msg.code, { id: playerId, nickname: msg.nickname || "Joueur" });
        if (!result.ok) {
          send(ws, { type: "error", reason: result.reason });
          return;
        }
        const room = result.room;
        send(ws, {
          type: "joined",
          code: room.code,
          you: "b",
          opponent: room.players.a.nickname,
        });
        startMatch(room);
        break;
      }
      case "choice": {
        const room = rooms.roomOfPlayer(playerId);
        if (!room || !room.match) return;
        const slot = room.players.a.id === playerId ? "a" : "b";
        const r = submitChoice(room.match, slot, msg.zone);
        if (!r.ok) {
          send(ws, { type: "error", reason: r.reason });
          return;
        }
        room.match = r.state;
        // The round resolves when submitChoice clears both pending slots.
        if (room.match.pending.shooter === null && room.match.pending.keeper === null) {
          broadcastResult(room);
        } else {
          send(ws, { type: "waiting" });
        }
        break;
      }
      case "rematch": {
        const room = rooms.roomOfPlayer(playerId);
        if (!room || !room.players.b) return;
        startMatch(room);
        break;
      }
      default:
        break;
    }
  }

  httpServer.listen(port);

  return {
    httpServer,
    wss,
    close() {
      for (const client of wss.clients) {
        client.terminate();
      }
      wss.close();
      httpServer.close();
    },
  };
}

if (require.main === module) {
  const port = process.env.PORT || 3000;
  const srv = createServer({ port: Number(port) });
  const addr = srv.httpServer.address();
  console.log(`Penalty 1v1 en écoute sur le port ${addr.port}`);
  console.log(`Local : http://localhost:${addr.port}`);
}

module.exports = { createServer };
