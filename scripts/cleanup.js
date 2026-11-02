// Nightly cleanup of the Realtime Database (run by .github/workflows/cleanup.yml).
//   node scripts/cleanup.js [--dry-run]
// Auth: the service account in GOOGLE_APPLICATION_CREDENTIALS, or ACCESS_TOKEN
// (the emulator accepts "owner"). DATABASE_URL / DATABASE_NS select the target.
const { GoogleAuth } = require("google-auth-library");
const { planCleanup, ROOM_MAX_AGE_MS } = require("./cleanup-plan");

const DATABASE_URL = process.env.DATABASE_URL || "https://penaltyleague-default-rtdb.europe-west1.firebasedatabase.app";
const DATABASE_NS = process.env.DATABASE_NS || "";
const BATCH = 300;
const dryRun = process.argv.includes("--dry-run");

async function accessToken() {
  if (process.env.ACCESS_TOKEN) return process.env.ACCESS_TOKEN;
  const auth = new GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/firebase.database", "https://www.googleapis.com/auth/userinfo.email"],
  });
  return auth.getAccessToken();
}

function url(path, params = {}) {
  const u = new URL(`${DATABASE_URL}/${path}.json`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  if (DATABASE_NS) u.searchParams.set("ns", DATABASE_NS);
  return u;
}

async function request(token, method, path, { params, body } = {}) {
  const res = await fetch(url(path, params), {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} /${path}: ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

(async () => {
  const token = await accessToken();
  const now = Date.now();
  const totals = { rooms: 0, queue: 0, limits: 0 };

  // Old rooms, oldest first, a page at a time (rooms are indexed on
  // createdAt). The cursor moves past each page, so rooms that are kept
  // (still in use, or everything in a dry run) are read only once.
  let cursor = null;
  let seenAtCursor = new Set();
  for (;;) {
    const params = { orderBy: '"createdAt"', endAt: String(now - ROOM_MAX_AGE_MS), limitToFirst: String(BATCH) };
    if (cursor !== null) params.startAt = String(cursor);
    const rooms = await request(token, "GET", "rooms", { params }) || {};
    const returned = Object.keys(rooms).length;
    for (const code of seenAtCursor) delete rooms[code];
    const plan = planCleanup({ rooms }, now);
    const removed = Object.keys(plan).filter((p) => p.startsWith("rooms/")).length;
    if (removed && !dryRun) await request(token, "PATCH", "", { body: plan });
    totals.rooms += removed;
    if (returned < BATCH) break;
    const times = Object.values(rooms).map((r) => r && r.createdAt).filter((t) => typeof t === "number");
    if (!times.length) break;
    const last = Math.max(...times);
    const atLast = Object.entries(rooms).filter(([, r]) => r && r.createdAt === last).map(([code]) => code);
    seenAtCursor = new Set(last === cursor ? [...seenAtCursor, ...atLast] : atLast);
    cursor = last;
  }

  const queue = await request(token, "GET", "queue") || {};
  const limits = await request(token, "GET", "limits") || {};
  const plan = planCleanup({ queue, limits }, now);
  totals.queue = Object.keys(plan).filter((p) => p.startsWith("queue/")).length;
  totals.limits = Object.keys(plan).filter((p) => p.startsWith("limits/")).length;
  if (Object.keys(plan).length && !dryRun) await request(token, "PATCH", "", { body: plan });

  const verb = dryRun ? "Dry run: would remove" : "Removed";
  console.log(`${verb} ${totals.rooms} room(s) older than 24 h with their choices, ${totals.queue} idle queue entr(y/ies), ${totals.limits} old room stamp(s).`);
})().catch((err) => {
  console.error("Cleanup failed:", err.message);
  process.exit(1);
});
