const http = require("http");
const fs = require("fs");
const os = require("os");
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
  let urlPath;
  try {
    urlPath = decodeURIComponent(req.url.split("?")[0]);
  } catch {
    urlPath = null;
  }
  if (urlPath === null || urlPath.includes("\0")) {
    res.writeHead(400);
    res.end("Bad request");
    return;
  }
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

function createServer({ port = 3000, shotClockMs = 10000, resultPauseMs = 2000 } = {}) {
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

  function slotOf(room, playerId) {
    return room.players.a.id === playerId ? "a" : "b";
  }

  // A room has one timer at a time: the shot clock during a turn, or the
  // pause that lets both players watch the result.
  function clearTimer(room) {
    if (room.timer) {
      clearTimeout(room.timer);
      room.timer = null;
    }
  }

  function leaveRoom(playerId) {
    const left = rooms.leave(playerId);
    if (!left) return;
    clearTimer(left.room);
    if (left.opponent) send(sockets.get(left.opponent.id), { type: "opponentLeft" });
  }

  function startRound(room) {
    const match = room.match;
    const shooter = match.shooter;
    const keeper = shooter === "a" ? "b" : "a";
    room.stage = "turn";
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
    clearTimer(room);
    room.timer = setTimeout(() => {
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
    clearTimer(room);
    room.stage = "result";
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
    room.timer = setTimeout(() => {
      room.timer = null;
      if (room.match.status === "finished") {
        room.stage = "over";
        room.rematch = { a: false, b: false };
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
    }, resultPauseMs);
  }

  function startMatch(room) {
    clearTimer(room);
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
    sockets.set(playerId, ws);

    // Without a listener, a protocol error on one socket would crash the process.
    ws.on("error", () => {});

    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (!msg || typeof msg !== "object" || typeof msg.type !== "string") return;
      try {
        handle(ws, playerId, msg);
      } catch (err) {
        console.error("Message handling failed:", err);
      }
    });

    ws.on("close", () => {
      sockets.delete(playerId);
      leaveRoom(playerId);
    });
  });

  function handle(ws, playerId, msg) {
    switch (msg.type) {
      case "create": {
        leaveRoom(playerId);
        const { code } = rooms.createRoom({ id: playerId, nickname: msg.nickname || "Joueur" });
        send(ws, { type: "created", code });
        break;
      }
      case "join": {
        const current = rooms.roomOfPlayer(playerId);
        if (current && current.code === msg.code) {
          send(ws, { type: "error", reason: "You are already in this room" });
          return;
        }
        leaveRoom(playerId);
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
        // Only accept a choice for the round being played: a click that
        // arrives after the shot clock must not count for the next round.
        if (!room || room.stage !== "turn" || msg.round !== room.match.round) return;
        const slot = slotOf(room, playerId);
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
        if (!room || room.stage !== "over") return;
        const slot = slotOf(room, playerId);
        const other = slot === "a" ? "b" : "a";
        room.rematch[slot] = true;
        if (room.rematch[other]) {
          startMatch(room);
        } else {
          send(ws, { type: "rematchWaiting" });
          send(playerSocket(room, other), { type: "rematchRequested" });
        }
        break;
      }
      case "leave":
        leaveRoom(playerId);
        break;
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

function lanAddresses() {
  const addresses = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal) addresses.push(entry.address);
    }
  }
  return addresses;
}

if (require.main === module) {
  const port = process.env.PORT || 3000;
  const srv = createServer({ port: Number(port) });
  srv.httpServer.on("listening", () => {
    const actualPort = srv.httpServer.address().port;
    console.log(`Penalty 1v1 en écoute sur le port ${actualPort}`);
    console.log(`Sur ce PC : http://localhost:${actualPort}`);
    for (const address of lanAddresses()) {
      console.log(`Réseau local : http://${address}:${actualPort}`);
    }
  });
}

module.exports = { createServer };
