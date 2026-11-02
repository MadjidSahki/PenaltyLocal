const test = require("node:test");
const assert = require("node:assert");
const http = require("http");
const net = require("net");
const WebSocket = require("ws");
const { createServer } = require("../src/server");

function connect(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  ws.queue = [];
  ws.waiters = [];
  ws.on("message", (d) => {
    const msg = JSON.parse(d);
    const w = ws.waiters.shift();
    if (w) w(msg); else ws.queue.push(msg);
  });
  ws.next = () =>
    new Promise((res) => (ws.queue.length ? res(ws.queue.shift()) : ws.waiters.push(res)));
  const rawSend = ws.send.bind(ws);
  ws.rawSend = rawSend;
  ws.send = (obj) => rawSend(JSON.stringify(obj));
  return new Promise((res) => ws.on("open", () => res(ws)));
}

async function until(ws, type, max = 30) {
  for (let i = 0; i < max; i++) {
    const m = await ws.next();
    if (m.type === type) return m;
  }
  throw new Error(`no "${type}" message`);
}

async function untilTurn(ws, round) {
  for (;;) {
    const t = await until(ws, "turn");
    if (t.round === round) return t;
  }
}

async function startPair(opts) {
  const srv = createServer({ port: 0, ...opts });
  const port = srv.httpServer.address().port;
  const a = await connect(port);
  a.send({ type: "create", nickname: "A" });
  const created = await until(a, "created");
  const b = await connect(port);
  b.send({ type: "join", code: created.code, nickname: "B" });
  return { srv, port, a, b, code: created.code };
}

async function playRound(a, b, aZone, bZone) {
  const turn = await until(a, "turn");
  await until(b, "turn");
  a.send({ type: "choice", zone: aZone, round: turn.round });
  b.send({ type: "choice", zone: bZone, round: turn.round });
  const result = await until(a, "result");
  await until(b, "result");
  return { turn, result };
}

// a scores every shot and saves every b shot: 3-0 after 6 rounds ends it.
async function playAWins(a, b) {
  for (let r = 1; r <= 6; r++) await playRound(a, b, "left", r % 2 ? "right" : "left");
}

function httpStatus(port, path) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path }, (res) => {
      res.resume();
      resolve(res.statusCode);
    }).on("error", reject);
  });
}

function sendInvalidFrame(port) {
  return new Promise((resolve) => {
    const sock = net.connect(port, "127.0.0.1", () => {
      sock.write(
        "GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n"
      );
    });
    sock.on("error", () => {});
    sock.once("data", () => {
      sock.write(Buffer.from([0x81, 0x01, 0x41])); // unmasked client frame: protocol error
      setTimeout(() => { sock.destroy(); resolve(); }, 100);
    });
  });
}

test("create + join reaches start, then a round resolves to a goal", async () => {
  const srv = createServer({ port: 0 });
  const port = srv.httpServer.address().port;
  const a = await connect(port);
  a.send({ type: "create", nickname: "A" });
  const created = await a.next();
  assert.equal(created.type, "created");
  const b = await connect(port);
  b.send({ type: "join", code: created.code, nickname: "B" });
  const msgsA = [await a.next(), await a.next()];
  await b.next(); await b.next();
  assert.ok(msgsA.some((m) => m.type === "start"));
  a.send({ type: "choice", zone: "left", round: 1 });
  b.send({ type: "choice", zone: "right", round: 1 });
  let res = null;
  for (let i = 0; i < 4 && !res; i++) { const m = await a.next(); if (m.type === "result") res = m; }
  assert.ok(res, "a got a result");
  assert.equal(res.goal, true);
  srv.close();
});

test("choice from the keeper's opponent reveals nothing until both in", async () => {
  const srv = createServer({ port: 0 });
  const port = srv.httpServer.address().port;
  const a = await connect(port);
  a.send({ type: "create", nickname: "A" });
  const created = await a.next();
  const b = await connect(port);
  b.send({ type: "join", code: created.code, nickname: "B" });
  await a.next(); await a.next(); await b.next(); await b.next();
  a.send({ type: "choice", zone: "left", round: 1 });
  const ack = await a.next();
  assert.equal(ack.type, "waiting");
  srv.close();
});

test("join unknown code => error", async () => {
  const srv = createServer({ port: 0 });
  const port = srv.httpServer.address().port;
  const b = await connect(port);
  b.send({ type: "join", code: "ZZZZ", nickname: "B" });
  const m = await b.next();
  assert.equal(m.type, "error");
  srv.close();
});

test("opponent disconnect notifies the other player", async () => {
  const srv = createServer({ port: 0 });
  const port = srv.httpServer.address().port;
  const a = await connect(port);
  a.send({ type: "create", nickname: "A" });
  const created = await a.next();
  const b = await connect(port);
  b.send({ type: "join", code: created.code, nickname: "B" });
  await a.next(); await a.next(); await b.next(); await b.next();
  b.close();
  let left = null;
  for (let i = 0; i < 4 && !left; i++) { const m = await a.next(); if (m.type === "opponentLeft") left = m; }
  assert.ok(left);
  srv.close();
});

test("shot clock: shooter not choosing in time => missed shot result", async () => {
  const srv = createServer({ port: 0, shotClockMs: 80 });
  const port = srv.httpServer.address().port;
  const a = await connect(port);
  a.send({ type: "create", nickname: "A" });
  const created = await a.next();
  const b = await connect(port);
  b.send({ type: "join", code: created.code, nickname: "B" });
  await a.next(); await a.next(); await b.next(); await b.next();
  let res = null;
  for (let i = 0; i < 6 && !res; i++) { const m = await a.next(); if (m.type === "result") res = m; }
  assert.ok(res, "a got a timeout result");
  assert.equal(res.goal, false);
  assert.equal(res.timedOut, "a");
  srv.close();
});

test("malformed or null-byte URLs get 400 and the server keeps serving", async () => {
  const srv = createServer({ port: 0 });
  const port = srv.httpServer.address().port;
  assert.equal(await httpStatus(port, "/%"), 400);
  assert.equal(await httpStatus(port, "/%00"), 400);
  assert.equal(await httpStatus(port, "/"), 200);
  srv.close();
});

test("non-object websocket messages are ignored and the connection keeps working", async () => {
  const srv = createServer({ port: 0 });
  const port = srv.httpServer.address().port;
  const a = await connect(port);
  for (const raw of ["null", "42", '"hi"', "[]", "{bad json"]) a.rawSend(raw);
  a.send({ type: "create", nickname: "A" });
  const m = await a.next();
  assert.equal(m.type, "created");
  srv.close();
});

test("an invalid websocket frame does not crash the server", async () => {
  const srv = createServer({ port: 0 });
  const port = srv.httpServer.address().port;
  await sendInvalidFrame(port);
  assert.equal(await httpStatus(port, "/"), 200);
  srv.close();
});

test("a late choice for a round that already ended is ignored", async () => {
  const { srv, a, b } = await startPair({ shotClockMs: 300, resultPauseMs: 100 });
  const res = await until(a, "result"); // round 1: shooter a timed out
  assert.equal(res.timedOut, "a");
  a.send({ type: "choice", zone: "left", round: 1 }); // late click, after the clock
  const t2 = await untilTurn(a, 2);
  assert.equal(t2.shooter, "b");
  await untilTurn(b, 2);
  b.send({ type: "choice", zone: "left", round: 2 }); // b shoots round 2
  const m = await b.next();
  assert.equal(m.type, "waiting"); // a's late click was not taken as a's round-2 dive
  srv.close();
});

test("the next turn starts only after the result pause", async () => {
  const { srv, a, b } = await startPair({ resultPauseMs: 200 });
  await playRound(a, b, "left", "right");
  const t0 = Date.now();
  const t2 = await until(a, "turn");
  assert.equal(t2.round, 2);
  assert.ok(Date.now() - t0 >= 150, "the next turn came before the pause");
  srv.close();
});

test("the end of the match is announced after the result pause", async () => {
  const { srv, a, b } = await startPair({ resultPauseMs: 120 });
  await playAWins(a, b);
  const t0 = Date.now();
  const over = await until(a, "matchOver");
  assert.equal(over.winner, "a");
  assert.ok(Date.now() - t0 >= 80, "matchOver came before the pause");
  srv.close();
});

test("rematch in the middle of a match is ignored", async () => {
  const { srv, a, b } = await startPair({ resultPauseMs: 10 });
  const t = await until(a, "turn");
  await until(b, "turn");
  a.send({ type: "rematch" });
  a.send({ type: "choice", zone: "left", round: t.round });
  const m = await a.next();
  assert.equal(m.type, "waiting"); // no new "start": the match was not restarted
  srv.close();
});

test("rematch starts only when both players ask, after the match", async () => {
  const { srv, a, b } = await startPair({ resultPauseMs: 10 });
  await playAWins(a, b);
  await until(a, "matchOver");
  await until(b, "matchOver");
  a.send({ type: "rematch" });
  assert.equal((await a.next()).type, "rematchWaiting");
  assert.equal((await b.next()).type, "rematchRequested");
  b.send({ type: "rematch" });
  await until(a, "start");
  await until(b, "start");
  const t = await until(a, "turn");
  assert.equal(t.round, 1);
  srv.close();
});

test("leaving notifies the opponent and the next room plays normally", async () => {
  const { srv, a, b } = await startPair({ resultPauseMs: 10 });
  await playAWins(a, b);
  await until(a, "matchOver");
  await until(b, "matchOver");
  a.send({ type: "leave" });
  await until(b, "opponentLeft");
  a.send({ type: "create", nickname: "A" });
  const created = await until(a, "created");
  b.send({ type: "join", code: created.code, nickname: "B" });
  const { result } = await playRound(a, b, "left", "right");
  assert.equal(result.goal, true);
  assert.equal(result.timedOut, null);
  srv.close();
});

test("creating a second room replaces the first one", async () => {
  const srv = createServer({ port: 0, resultPauseMs: 10 });
  const port = srv.httpServer.address().port;
  const a = await connect(port);
  a.send({ type: "create", nickname: "A" });
  a.send({ type: "create", nickname: "A" });
  await until(a, "created");
  const second = await until(a, "created");
  const b = await connect(port);
  b.send({ type: "join", code: second.code, nickname: "B" });
  const { result } = await playRound(a, b, "left", "right");
  assert.equal(result.goal, true);
  srv.close();
});
