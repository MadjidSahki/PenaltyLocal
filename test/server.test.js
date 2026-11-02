const test = require("node:test");
const assert = require("node:assert");
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
  ws.send = ((orig) => (obj) => orig.call(ws, JSON.stringify(obj)))(ws.send);
  return new Promise((res) => ws.on("open", () => res(ws)));
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
  a.send({ type: "choice", zone: "left" });
  b.send({ type: "choice", zone: "right" });
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
  a.send({ type: "choice", zone: "left" });
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
