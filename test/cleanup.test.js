const test = require("node:test");
const assert = require("node:assert");
const { planCleanup, ROOM_MAX_AGE_MS, ACTIVE_GRACE_MS, QUEUE_MAX_IDLE_MS } = require("../scripts/cleanup-plan");

const NOW = Date.UTC(2026, 10, 3, 3, 0, 0);
const HOUR = 3600 * 1000;
const room = (createdAt, extra = {}) => ({ players: { a: "u1" }, names: { a: "A" }, createdAt, ...extra });

test("constants: rooms kept 24 h, recent activity protects them for 1 h, queue entries idle 10 min", () => {
  assert.equal(ROOM_MAX_AGE_MS, 24 * HOUR);
  assert.equal(ACTIVE_GRACE_MS, HOUR);
  assert.equal(QUEUE_MAX_IDLE_MS, 10 * 60 * 1000);
});

test("rooms older than 24 h are removed with their choices", () => {
  const plan = planCleanup({ rooms: { OLD2: room(NOW - 25 * HOUR), NEW2: room(NOW - 2 * HOUR) } }, NOW);
  assert.deepEqual(plan, { "rooms/OLD2": null, "choices/OLD2": null });
});

test("an old room with a round started in the last hour is kept", () => {
  const busy = room(NOW - 30 * HOUR, {
    matches: { 9: { n: 9, rounds: { 1: { n: 1, startedAt: NOW - 20 * 60 * 1000 } } } },
  });
  assert.deepEqual(planCleanup({ rooms: { BUSY: busy } }, NOW), {});
});

test("an old room whose last activity is older than an hour is removed", () => {
  const idle = room(NOW - 30 * HOUR, {
    matches: { 1: { n: 1, rounds: { 1: { n: 1, startedAt: NOW - 2 * HOUR } } } },
    locks: { 1: { 1: { a: NOW - 2 * HOUR } } },
  });
  assert.deepEqual(planCleanup({ rooms: { IDLE: idle } }, NOW), { "rooms/IDLE": null, "choices/IDLE": null });
});

test("queue entries idle for more than 10 minutes are removed, recent heartbeats keep them", () => {
  const plan = planCleanup({
    queue: {
      ghost: { name: "G", at: NOW - 3 * HOUR },
      waiting: { name: "W", at: NOW - 3 * HOUR, seen: NOW - 60 * 1000 },
      fresh: { name: "F", at: NOW - 30 * 1000 },
    },
  }, NOW);
  assert.deepEqual(plan, { "queue/ghost": null });
});

test("room-creation stamps older than 24 h are removed", () => {
  const plan = planCleanup({ limits: { u1: { room: NOW - 25 * HOUR }, u2: { room: NOW - HOUR } } }, NOW);
  assert.deepEqual(plan, { "limits/u1": null });
});

test("malformed or missing data never causes a deletion it should not", () => {
  const plan = planCleanup({ rooms: { BAD1: null, BAD2: { createdAt: "yesterday" } }, queue: { x: null }, limits: null }, NOW);
  assert.deepEqual(plan, {});
});

test("profiles, pseudos and results are never touched", () => {
  const plan = planCleanup({ profiles: { u1: {} }, names: { a: "u1" }, results: { x: {} } }, NOW);
  assert.deepEqual(plan, {});
});
