// Runs scripts/cleanup.js against the Realtime Database emulator (admin token)
// and checks what it removed. Part of `npm run test:rules`.
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const { execFile } = require("child_process");

const NS = "demo-penalty-default-rtdb";
const BASE = "http://127.0.0.1:9400";
const HOUR = 3600 * 1000;
const url = (p) => `${BASE}/${p}.json?ns=${NS}`;
const admin = { Authorization: "Bearer owner" };

async function put(p, value) {
  const r = await fetch(url(p), { method: "PUT", headers: admin, body: JSON.stringify(value) });
  assert.equal(r.status, 200, `PUT ${p}`);
}
async function read(p) {
  return (await fetch(url(p), { headers: admin })).json();
}
function runCleanup(args = []) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [path.join(__dirname, "..", "scripts", "cleanup.js"), ...args], {
      env: { ...process.env, DATABASE_URL: BASE, DATABASE_NS: NS, ACCESS_TOKEN: "owner" },
    }, (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout)));
  });
}

test("cleanup removes old rooms, their choices, idle queue entries and old stamps, and nothing else", async () => {
  const now = Date.now();
  await put("", {
    rooms: {
      OLD2: { players: { a: "u1" }, names: { a: "A" }, createdAt: now - 30 * HOUR },
      NEW2: { players: { a: "u2" }, names: { a: "B" }, createdAt: now - HOUR },
    },
    choices: { OLD2: { 1: { 1: { a: "left" } } }, NEW2: { 1: { 1: { a: "right" } } } },
    queue: { ghost: { name: "G", at: now - 2 * HOUR }, live: { name: "L", at: now - 60 * 1000 } },
    limits: { u1: { room: now - 30 * HOUR }, u2: { room: now - HOUR } },
    profiles: { u1: { name: "A", key: "a" } },
    names: { a: "u1" },
    results: { OLD2_1_1: { winner: "a", at: now - 30 * HOUR } },
  });

  const dry = await runCleanup(["--dry-run"]);
  assert.match(dry, /dry run/i);
  assert.ok(await read("rooms/OLD2"), "dry run deletes nothing");

  const out = await runCleanup();
  assert.match(out, /removed 1 room/i);
  assert.equal(await read("rooms/OLD2"), null);
  assert.equal(await read("choices/OLD2"), null);
  assert.equal(await read("queue/ghost"), null);
  assert.equal(await read("limits/u1"), null);
  assert.ok(await read("rooms/NEW2"));
  assert.ok(await read("choices/NEW2"));
  assert.ok(await read("queue/live"));
  assert.ok(await read("limits/u2"));
  assert.ok(await read("profiles/u1"));
  assert.ok(await read("names/a"));
  assert.ok(await read("results/OLD2_1_1"));
});

test("cleanup goes through many old rooms in batches", async () => {
  const now = Date.now();
  const rooms = {};
  for (let i = 0; i < 650; i++) rooms[`R${String(i).padStart(3, "0")}`] = { players: { a: "u" }, names: { a: "A" }, createdAt: now - 48 * HOUR + i };
  await put("", { rooms });
  const dry = await runCleanup(["--dry-run"]);
  assert.match(dry, /would remove 650 room/i);
  await runCleanup();
  assert.equal(await read("rooms"), null);
});
