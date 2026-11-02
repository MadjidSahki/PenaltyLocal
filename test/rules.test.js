// Security rules tests. Run against the Realtime Database emulator:
//   npm run test:rules
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} = require("@firebase/rules-unit-testing");
const { ref, set, update, get, remove, serverTimestamp, query, orderByChild, limitToLast } = require("firebase/database");

const CODE = "AB23";
const PEOPLE = { alice: "Alice", bob: "Bob", carol: "Carol", dave: "Dave" };
const CREATED = Date.now() - 60000; // creation time of the seeded room
// Result keys carry the room's creation time, so a code reused after the
// nightly cleanup never collides with an old result.
const RES1 = `${CODE}_${CREATED}_1`;
const GRACE_MS = 10500;
let env;

const db = (uid) => env.authenticatedContext(uid).database();
// Creates a room together with the creator's rate-limit stamp, as the client does.
const mkRoom = (uid, room, code = CODE) =>
  update(ref(db(uid)), { [`rooms/${code}`]: room, [`limits/${uid}/room`]: serverTimestamp(), [`limits/${uid}/code`]: code });
const anon = () => env.unauthenticatedContext().database();
const seed = (fn) => env.withSecurityRulesDisabled((ctx) => fn(ctx.database()));

const newRoom = (uid, name = PEOPLE[uid] || "Alice") => ({
  players: { a: uid },
  names: { a: name },
  createdAt: serverTimestamp(),
  presence: { a: true },
});

// A full room (alice = a, bob = b) with match 1 round 1 started `ago` ms ago.
async function seedRoom({ ago = 0, extra = {}, played = false } = {}) {
  const rounds = { 1: { n: 1, startedAt: Date.now() - ago } };
  if (played) for (let r = 2; r <= 6; r++) rounds[r] = { n: r, startedAt: Date.now() - ago };
  await seed((d) =>
    set(ref(d, `rooms/${CODE}`), {
      players: { a: "alice", b: "bob" },
      names: { a: "Alice", b: "Bob" },
      createdAt: CREATED,
      presence: { a: true, b: true },
      matches: { 1: { n: 1, rounds } },
      ...extra,
    })
  );
}

const choice = (uid, slot, zone, m = 1, r = 1) => set(ref(db(uid), `choices/${CODE}/${m}/${r}/${slot}`), zone);
const lock = (uid, slot, m = 1, r = 1) => set(ref(db(uid), `rooms/${CODE}/locks/${m}/${r}/${slot}`), serverTimestamp());
const PAUSE_MS = 2000;
const startRound = (uid, r, m = 1, startedAt = serverTimestamp(), n = r) =>
  set(ref(db(uid), `rooms/${CODE}/matches/${m}/rounds/${r}`), { n, startedAt });

test.before(async () => {
  env = await initializeTestEnvironment({
    projectId: "demo-penalty",
    database: {
      host: "127.0.0.1",
      port: 9400,
      rules: fs.readFileSync(path.join(__dirname, "..", "database.rules.json"), "utf8"),
    },
  });
});
test.beforeEach(async () => {
  await env.clearDatabase();
  // Every test player already owns their pseudo.
  await seed((d) => {
    const data = {};
    for (const [uid, name] of Object.entries(PEOPLE)) {
      data[`profiles/${uid}`] = { name, key: name.toLowerCase() };
      data[`names/${name.toLowerCase()}`] = uid;
    }
    return update(ref(d), data);
  });
});
test.after(async () => env.cleanup());

// ---------- rooms ----------

test("a signed-in player can create a room as player a", async () => {
  await assertSucceeds(mkRoom("alice", newRoom("alice")));
});

test("signed-out visitors cannot create or read rooms", async () => {
  await assertFails(set(ref(anon(), `rooms/${CODE}`), newRoom("alice")));
  await seedRoom();
  await assertFails(get(ref(anon(), `rooms/${CODE}`)));
});

test("cannot create a room in someone else's name", async () => {
  await assertFails(mkRoom("alice", newRoom("bob")));
});

test("cannot overwrite an existing room", async () => {
  await assertSucceeds(mkRoom("alice", newRoom("alice")));
  await assertFails(mkRoom("carol", newRoom("carol")));
});

test("room codes must be 4 characters from the safe alphabet", async () => {
  await assertFails(mkRoom("alice", newRoom("alice"), "AB01"));
});

test("rooms cannot be listed", async () => {
  await seedRoom();
  await assertFails(get(ref(db("carol"), "rooms")));
});

test("pseudo must be 1 to 16 characters", async () => {
  await assertFails(mkRoom("alice", newRoom("alice", "x".repeat(17))));
  await assertFails(mkRoom("alice", newRoom("alice", "")));
});

const join = (uid, name = "Bob") =>
  update(ref(db(uid), `rooms/${CODE}`), { "players/b": uid, "names/b": name, "presence/b": true });

test("another player can join a waiting room", async () => {
  await mkRoom("alice", newRoom("alice"));
  await assertSucceeds(join("bob"));
});

test("the creator cannot join their own room", async () => {
  await mkRoom("alice", newRoom("alice"));
  await assertFails(join("alice"));
});

test("a full room cannot be joined", async () => {
  await mkRoom("alice", newRoom("alice"));
  await join("bob");
  await assertFails(join("carol", "Carol"));
});

test("a room whose creator left cannot be joined", async () => {
  await mkRoom("alice", newRoom("alice"));
  await remove(ref(db("alice"), `rooms/${CODE}/presence/a`));
  await assertFails(join("bob"));
});

test("a player can only change their own presence", async () => {
  await seedRoom();
  await assertSucceeds(remove(ref(db("bob"), `rooms/${CODE}/presence/b`)));
  await assertFails(remove(ref(db("bob"), `rooms/${CODE}/presence/a`)));
});

test("players and names cannot be changed after the fact", async () => {
  await seedRoom();
  await assertFails(set(ref(db("alice"), `rooms/${CODE}/players/a`), "mallory"));
  await assertFails(set(ref(db("bob"), `rooms/${CODE}/names/a`), "Loser"));
});

// ---------- choices ----------

test("a player can choose for their own slot during the round", async () => {
  await seedRoom();
  await assertSucceeds(choice("alice", "a", "left"));
});

test("a player cannot choose for the opponent", async () => {
  await seedRoom();
  await assertFails(choice("alice", "b", "left"));
});

test("a choice cannot be changed", async () => {
  await seedRoom();
  await choice("alice", "a", "left");
  await assertFails(choice("alice", "a", "right"));
});

test("only left, center or right are valid choices", async () => {
  await seedRoom();
  await assertFails(choice("alice", "a", "up"));
});

test("a choice after the shot clock is refused", async () => {
  await seedRoom({ ago: GRACE_MS + 1000 });
  await assertFails(choice("alice", "a", "left"));
});

test("a choice for a round that has not started is refused", async () => {
  await seedRoom();
  await assertFails(choice("alice", "a", "left", 1, 2));
});

test("strangers cannot choose", async () => {
  await seedRoom();
  await assertFails(choice("carol", "a", "left"));
});

test("the opponent's choice stays secret until both have chosen", async () => {
  await seedRoom();
  await choice("alice", "a", "left");
  await assertSucceeds(get(ref(db("alice"), `choices/${CODE}/1/1/a`)));
  await assertFails(get(ref(db("bob"), `choices/${CODE}/1/1/a`)));
  await choice("bob", "b", "right");
  const seen = await assertSucceeds(get(ref(db("bob"), `choices/${CODE}/1/1/a`)));
  assert.equal(seen.val(), "left");
});

test("choices become readable once the shot clock has expired", async () => {
  await seedRoom({ ago: GRACE_MS + 1000 });
  await seed((d) => set(ref(d, `choices/${CODE}/1/1/a`), "center"));
  const seen = await assertSucceeds(get(ref(db("bob"), `choices/${CODE}/1/1/a`)));
  assert.equal(seen.val(), "center");
});

test("a lock needs the player's choice first and belongs to the player", async () => {
  await seedRoom();
  await assertFails(lock("alice", "a"));
  await choice("alice", "a", "left");
  await assertFails(lock("bob", "a"));
  await assertSucceeds(lock("alice", "a"));
});

test("a lock must carry the server time", async () => {
  await seedRoom();
  await choice("alice", "a", "left");
  await assertFails(set(ref(db("alice"), `rooms/${CODE}/locks/1/1/a`), true));
  await assertFails(set(ref(db("alice"), `rooms/${CODE}/locks/1/1/a`), Date.now() - 60000));
});

// ---------- rounds ----------

test("the next round cannot start while the current one is open", async () => {
  await seedRoom();
  await assertFails(startRound("alice", 2));
});

test("the next round cannot start right after both players have locked", async () => {
  await seedRoom();
  await choice("alice", "a", "left");
  await lock("alice", "a");
  await choice("bob", "b", "right");
  await lock("bob", "b");
  await assertFails(startRound("bob", 2));
});

test("the next round can start once the result pause after both locks has passed", async () => {
  await seedRoom({
    ago: 5000,
    extra: { locks: { 1: { 1: { a: Date.now() - 4000, b: Date.now() - PAUSE_MS - 500 } } } },
  });
  await assertSucceeds(startRound("bob", 2));
});

test("the next round cannot start just after the shot clock expired", async () => {
  await seedRoom({ ago: GRACE_MS + 500 });
  await assertFails(startRound("alice", 2));
});

test("the next round can start once the shot clock and the result pause have expired", async () => {
  await seedRoom({ ago: GRACE_MS + PAUSE_MS + 1000 });
  await assertSucceeds(startRound("alice", 2));
});

test("a round can only be started once", async () => {
  await seedRoom({ ago: GRACE_MS + PAUSE_MS + 1000 });
  await startRound("alice", 2);
  await assertFails(startRound("bob", 2));
});

test("a round's start time must be the server time", async () => {
  await seedRoom({ ago: GRACE_MS + PAUSE_MS + 1000 });
  await assertFails(startRound("alice", 2, 1, Date.now() - 60000));
});

test("rounds cannot be skipped", async () => {
  await seedRoom({ ago: GRACE_MS + PAUSE_MS + 1000 });
  await assertFails(startRound("alice", 3));
  await assertFails(startRound("alice", 2, 1, serverTimestamp(), 3));
});

test("strangers cannot start rounds", async () => {
  await seedRoom({ ago: GRACE_MS + PAUSE_MS + 1000 });
  await assertFails(startRound("carol", 2));
});

// ---------- matches ----------

const newMatch = (uid, m) =>
  set(ref(db(uid), `rooms/${CODE}/matches/${m}`), {
    n: m,
    rounds: { 1: { n: 1, startedAt: serverTimestamp() } },
  });

test("the joiner can start match 1 with round 1", async () => {
  await mkRoom("alice", newRoom("alice"));
  await join("bob");
  await assertSucceeds(newMatch("bob", 1));
});

test("match 1 cannot start before someone joined", async () => {
  await mkRoom("alice", newRoom("alice"));
  await assertFails(newMatch("alice", 1));
});

test("a rematch needs both players to ask", async () => {
  await seedRoom();
  await assertFails(newMatch("alice", 2));
  await assertSucceeds(set(ref(db("alice"), `rooms/${CODE}/matches/1/rematch/a`), true));
  await assertFails(newMatch("alice", 2));
  await assertFails(set(ref(db("alice"), `rooms/${CODE}/matches/1/rematch/b`), true));
  await assertSucceeds(set(ref(db("bob"), `rooms/${CODE}/matches/1/rematch/b`), true));
  await assertSucceeds(newMatch("bob", 2));
});

test("matches cannot be skipped or created twice", async () => {
  await seedRoom({ extra: {} });
  await assertFails(newMatch("alice", 1));
  await assertFails(newMatch("alice", 3));
});

test("a match cannot start while a player is not present", async () => {
  await mkRoom("alice", newRoom("alice"));
  await join("bob");
  await remove(ref(db("alice"), `rooms/${CODE}/presence/a`));
  await assertFails(newMatch("bob", 1));
});

test("a new match cannot come with rematch flags already set", async () => {
  await mkRoom("alice", newRoom("alice"));
  await join("bob");
  await assertFails(
    set(ref(db("bob"), `rooms/${CODE}/matches/1`), {
      n: 1,
      rounds: { 1: { n: 1, startedAt: serverTimestamp() } },
      rematch: { a: true, b: true },
    })
  );
});

test("a new room cannot pre-fill the joiner's name or presence", async () => {
  await assertFails(mkRoom("alice", { ...newRoom("alice"), names: { a: "Alice", b: "Bob" } }));
  await assertFails(mkRoom("alice", { ...newRoom("alice"), presence: { a: true, b: true } }));
});

// ---------- results ----------

const resultFor = (overrides = {}) => ({
  code: CODE,
  m: 1,
  uids: { a: "alice", b: "bob" },
  a: { name: "Alice", goals: 3 },
  b: { name: "Bob", goals: 1 },
  winner: "a",
  at: serverTimestamp(),
  ...overrides,
});

const latest = (uid, n) => get(query(ref(db(uid), "results"), orderByChild("at"), limitToLast(n)));

test("a player of the match can store its result once, and anyone signed in can read the latest results", async () => {
  await seedRoom({ played: true });
  await assertSucceeds(set(ref(db("bob"), `results/${RES1}`), resultFor()));
  await assertFails(set(ref(db("alice"), `results/${RES1}`), resultFor()));
  const recent = await assertSucceeds(latest("carol", 500));
  assert.equal(recent.child(`${RES1}/winner`).val(), "a");
});

test("results cannot be paged through with start or end bounds", async () => {
  const { endAt, startAt } = require("firebase/database");
  await assertFails(get(query(ref(db("carol"), "results"), orderByChild("at"), endAt(Date.now()), limitToLast(500))));
  await assertFails(get(query(ref(db("carol"), "results"), orderByChild("at"), startAt(0), limitToLast(500))));
});

test("results can only be read as the latest 500 at most", async () => {
  await assertFails(get(ref(db("carol"), "results")));
  await assertFails(latest("carol", 100000));
  await assertFails(get(ref(anon(), "results")));
});

test("a normal result needs a match of at least six shots", async () => {
  await seedRoom();
  await assertFails(set(ref(db("bob"), `results/${RES1}`), resultFor()));
});

test("goals must be whole numbers", async () => {
  await seedRoom({ played: true });
  await assertFails(set(ref(db("bob"), `results/${RES1}`), resultFor({ a: { name: "Alice", goals: 1.5 } })));
});

test("a result's key must match its room, its creation time and match number", async () => {
  await seedRoom({ played: true });
  await assertFails(set(ref(db("bob"), `results/ZZ99_${CREATED}_1`), resultFor()));
  await assertFails(set(ref(db("bob"), `results/${CODE}_1`), resultFor())); // old key format
  await assertFails(set(ref(db("bob"), `results/${CODE}_${CREATED + 1}_1`), resultFor()));
});

test("a room code reused after cleanup can store its own result", async () => {
  await seed((d) => set(ref(d, `results/${RES1}`), { winner: "a", at: CREATED }));
  const reborn = CREATED + 86400000;
  await seedRoom({ played: true, extra: { createdAt: reborn } });
  await assertSucceeds(set(ref(db("bob"), `results/${CODE}_${reborn}_1`), resultFor()));
});

test("strangers cannot store results", async () => {
  await seedRoom({ played: true });
  await assertFails(set(ref(db("carol"), `results/${RES1}`), resultFor()));
});

const forfeitFor = (winner) =>
  resultFor({ a: { name: "Alice", goals: 0 }, b: { name: "Bob", goals: 1 }, winner, forfeit: true });
const started = { locks: { 1: { 1: { a: Date.now() - 1000 } } } };

test("a forfeit is stored only once the loser has really left", async () => {
  await seedRoom({ extra: started });
  await assertFails(set(ref(db("bob"), `results/${RES1}`), { ...forfeitFor("b"), forfeit: "yes" }));
  await assertFails(set(ref(db("bob"), `results/${RES1}`), forfeitFor("b"))); // alice is still there
  await remove(ref(db("alice"), `rooms/${CODE}/presence/a`));
  await assertSucceeds(set(ref(db("bob"), `results/${RES1}`), forfeitFor("b")));
});

test("a forfeit for player a needs player b gone", async () => {
  await seedRoom({ extra: started });
  await assertFails(set(ref(db("alice"), `results/${RES1}`), forfeitFor("a")));
  await remove(ref(db("bob"), `rooms/${CODE}/presence/b`));
  await assertSucceeds(set(ref(db("alice"), `results/${RES1}`), forfeitFor("a")));
});

test("a forfeit needs the winner still present", async () => {
  await seedRoom({ extra: started });
  await remove(ref(db("alice"), `rooms/${CODE}/presence/a`));
  await remove(ref(db("bob"), `rooms/${CODE}/presence/b`));
  await assertFails(set(ref(db("bob"), `results/${RES1}`), forfeitFor("b")));
});

test("no forfeit before anyone has played a shot of the match", async () => {
  await seedRoom();
  await remove(ref(db("alice"), `rooms/${CODE}/presence/a`));
  await assertFails(set(ref(db("bob"), `results/${RES1}`), forfeitFor("b")));
});

test("results must match the room and be well-formed", async () => {
  await seedRoom({ played: true });
  await assertFails(set(ref(db("alice"), `results/${RES1}`), resultFor({ uids: { a: "alice", b: "carol" } })));
  await assertFails(set(ref(db("alice"), `results/${RES1}`), resultFor({ winner: "c" })));
  await assertFails(set(ref(db("alice"), `results/${RES1}`), resultFor({ at: 123 })));
  await assertFails(set(ref(db("alice"), `results/${CODE}_${CREATED}_2`), resultFor({ m: 2 })));
  await assertFails(set(ref(db("alice"), `results/${RES1}`), resultFor({ a: { name: "Zidane", goals: 3 } })));
});

test("unknown top-level paths are refused", async () => {
  await assertFails(set(ref(db("alice"), "hack"), true));
  await assertFails(get(ref(db("alice"), "/")));
});

// ---------- pseudos ----------

const claim = (uid, name, old = null) => {
  const key = name.toLowerCase();
  const data = { [`profiles/${uid}`]: { name, key }, [`names/${key}`]: uid };
  if (old) data[`names/${old}`] = null;
  return update(ref(db(uid)), data);
};

test("a new player can claim a free pseudo", async () => {
  await assertSucceeds(claim("erin", "Erin"));
  const owner = await get(ref(db("dave"), "names/erin"));
  assert.equal(owner.val(), "erin");
});

test("a pseudo already taken cannot be claimed, whatever the case", async () => {
  await assertFails(claim("erin", "ALICE"));
  await assertFails(claim("erin", "Alice"));
});

test("a player can rename and the old pseudo is released", async () => {
  await assertSucceeds(claim("alice", "Alicia", "alice"));
  await assertSucceeds(claim("erin", "Alice"));
});

test("a profile cannot be deleted, so an old pseudo cannot be kept while taking a new one", async () => {
  await assertFails(remove(ref(db("alice"), "profiles/alice")));
});

test("a player cannot keep two pseudos or release someone else's", async () => {
  await assertFails(claim("alice", "Alicia")); // old one not released
  await assertFails(update(ref(db("erin")), { "names/bob": null }));
});

test("a profile must point to the reservation of its own pseudo", async () => {
  await assertFails(set(ref(db("erin"), "profiles/erin"), { name: "Erin", key: "erin" }));
  await claim("erin", "Erin");
  await assertFails(set(ref(db("erin"), "profiles/erin"), { name: "Eve", key: "erin" }));
});

test("pseudos use letters, digits, spaces, dashes and apostrophes only", async () => {
  await assertFails(claim("erin", "\u202Eniamda"));
  await assertFails(claim("erin", " Erin"));
  await assertFails(claim("erin", "Er  in"));
  await assertFails(claim("erin", "Erin<script>"));
  await assertSucceeds(claim("erin", "Zoé d'Arc-2"));
});

test("the name shown in a room must be the player's pseudo", async () => {
  await assertFails(mkRoom("alice", newRoom("alice", "Zizou")));
  await mkRoom("alice", newRoom("alice"));
  await assertFails(update(ref(db("bob"), `rooms/${CODE}`), { "players/b": "bob", "names/b": "Zizou" }));
});

test("one stamp creates exactly one room, even in a single multi-path update", async () => {
  await assertFails(update(ref(db("alice")), {
    "limits/alice/room": serverTimestamp(), "limits/alice/code": CODE,
    [`rooms/${CODE}`]: newRoom("alice"), "rooms/CD45": newRoom("alice"),
  }));
  await assertFails(update(ref(db("alice")), {
    "limits/alice/room": serverTimestamp(), [`rooms/${CODE}`]: newRoom("alice"),
  })); // stamp without the room code
});

test("rooms can be created at most once every 3 seconds per player", async () => {
  await assertSucceeds(mkRoom("alice", newRoom("alice")));
  await assertFails(mkRoom("alice", newRoom("alice"), "CD45"));
  await assertFails(set(ref(db("alice"), "rooms/EF67"), newRoom("alice"))); // without the stamp
  await assertFails(set(ref(db("bob"), "limits/alice/room"), serverTimestamp()));
});

// ---------- matchmaking queue ----------

const enqueue = (uid, name = "Alice", at = serverTimestamp()) => set(ref(db(uid), `queue/${uid}`), { name, at });

test("a player can join and leave the matchmaking queue", async () => {
  await assertSucceeds(enqueue("alice"));
  await assertSucceeds(remove(ref(db("alice"), "queue/alice")));
});

test("a player cannot queue someone else or remove their entry", async () => {
  await assertFails(set(ref(db("alice"), "queue/bob"), { name: "Bob", at: serverTimestamp() }));
  await enqueue("bob", "Bob");
  await assertFails(set(ref(db("alice"), "queue/bob"), { name: "Bob", at: serverTimestamp() }));
  await assertFails(remove(ref(db("alice"), "queue/bob")));
});

test("a queue entry needs a 1–16 character pseudo and the server time", async () => {
  await assertFails(enqueue("alice", "x".repeat(17)));
  await assertFails(enqueue("alice", "Alice", Date.now() - 60000));
});

test("signed-in players can read the queue, visitors cannot", async () => {
  await enqueue("alice");
  await assertSucceeds(get(ref(db("bob"), "queue")));
  await assertFails(get(ref(anon(), "queue")));
});

const roomFor = (creator, name, target) => ({ ...newRoom(creator, name), for: target });

test("a waiting player can be matched once, into a room the matcher created for them", async () => {
  await enqueue("alice");
  await enqueue("bob", "Bob");
  await mkRoom("bob", roomFor("bob", "Bob", "alice"));
  await assertSucceeds(set(ref(db("bob"), "queue/alice/room"), CODE));
  await assertFails(set(ref(db("carol"), "queue/alice/room"), "ZZ99"));
});

test("only a queued player who came later can match someone", async () => {
  await enqueue("alice");
  await mkRoom("bob", roomFor("bob", "Bob", "alice"));
  await assertFails(set(ref(db("bob"), "queue/alice/room"), CODE)); // bob is not searching
  await seed((d) => set(ref(d, "queue/bob"), { name: "Bob", at: Date.now() - 600000 }));
  await assertFails(set(ref(db("bob"), "queue/alice/room"), CODE)); // bob has waited longer
});

test("a waiting player can refresh their last-seen time, only to the server time", async () => {
  await enqueue("alice");
  await assertSucceeds(update(ref(db("alice"), "queue/alice"), { seen: serverTimestamp() }));
  await assertFails(update(ref(db("alice"), "queue/alice"), { seen: Date.now() + 600000 }));
});

test("the matchmaking name must be the player's pseudo", async () => {
  await assertFails(enqueue("alice", "Bob"));
});

test("a player cannot be matched into a room that is not the matcher's", async () => {
  await enqueue("alice");
  await mkRoom("dave", roomFor("dave", "Dave", "alice"));
  await assertFails(set(ref(db("bob"), "queue/alice/room"), CODE));
});

test("a player cannot be matched into a room made for someone else, or for nobody", async () => {
  await enqueue("alice");
  await enqueue("bob", "Bob");
  await mkRoom("bob", roomFor("bob", "Bob", "carol"));
  await assertFails(set(ref(db("bob"), "queue/alice/room"), CODE));
  await seed((d) => set(ref(d, "rooms/CD45"), { players: { a: "bob" }, names: { a: "Bob" }, createdAt: Date.now(), presence: { a: true } }));
  await assertFails(set(ref(db("bob"), "queue/alice/room"), "CD45"));
});

test("a player cannot be matched into a room whose creator is not present", async () => {
  await enqueue("alice");
  await enqueue("bob", "Bob");
  await mkRoom("bob", { ...roomFor("bob", "Bob", "alice"), presence: null });
  await assertFails(set(ref(db("bob"), "queue/alice/room"), CODE));
});

test("only the matched player can take the second seat of a matchmaking room", async () => {
  await mkRoom("bob", roomFor("bob", "Bob", "alice"));
  await assertFails(join("carol", "Carol"));
  await assertSucceeds(join("alice", "Alice"));
});

test("a queue entry cannot keep an old waiting time", async () => {
  await seed((d) => set(ref(d, "queue/alice"), { name: "Alice", at: Date.now() - 60000 }));
  const old = (await get(ref(db("alice"), "queue/alice/at"))).val();
  await assertFails(set(ref(db("alice"), "queue/alice"), { name: "Alice", at: old }));
  await assertSucceeds(set(ref(db("alice"), "queue/alice"), { name: "Alice", at: serverTimestamp() }));
});

test("a player cannot be matched into a room that is already full", async () => {
  await enqueue("alice");
  await seedRoom({ extra: { for: "carol" } }); // alice and bob already play there
  await assertFails(set(ref(db("alice"), "queue/carol/room"), CODE));
  await set(ref(db("carol"), "queue/carol"), { name: "Carol", at: serverTimestamp() });
  await assertFails(set(ref(db("bob"), "queue/carol/room"), CODE));
});

test("nobody can be matched while not waiting", async () => {
  await mkRoom("bob", roomFor("bob", "Bob", "alice"));
  await assertFails(set(ref(db("bob"), "queue/alice/room"), CODE));
});
