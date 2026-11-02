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
const { ref, set, update, get, remove, serverTimestamp } = require("firebase/database");

const CODE = "AB23";
const GRACE_MS = 10500;
let env;

const db = (uid) => env.authenticatedContext(uid).database();
const anon = () => env.unauthenticatedContext().database();
const seed = (fn) => env.withSecurityRulesDisabled((ctx) => fn(ctx.database()));

const newRoom = (uid, name = "Alice") => ({
  players: { a: uid },
  names: { a: name },
  createdAt: serverTimestamp(),
  presence: { a: true },
});

// A full room (alice = a, bob = b) with match 1 round 1 started `ago` ms ago.
async function seedRoom({ ago = 0, extra = {} } = {}) {
  await seed((d) =>
    set(ref(d, `rooms/${CODE}`), {
      players: { a: "alice", b: "bob" },
      names: { a: "Alice", b: "Bob" },
      createdAt: Date.now() - 60000,
      presence: { a: true, b: true },
      matches: { 1: { n: 1, rounds: { 1: { n: 1, startedAt: Date.now() - ago } } } },
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
test.beforeEach(async () => env.clearDatabase());
test.after(async () => env.cleanup());

// ---------- rooms ----------

test("a signed-in player can create a room as player a", async () => {
  await assertSucceeds(set(ref(db("alice"), `rooms/${CODE}`), newRoom("alice")));
});

test("signed-out visitors cannot create or read rooms", async () => {
  await assertFails(set(ref(anon(), `rooms/${CODE}`), newRoom("alice")));
  await seedRoom();
  await assertFails(get(ref(anon(), `rooms/${CODE}`)));
});

test("cannot create a room in someone else's name", async () => {
  await assertFails(set(ref(db("alice"), `rooms/${CODE}`), newRoom("bob")));
});

test("cannot overwrite an existing room", async () => {
  await assertSucceeds(set(ref(db("alice"), `rooms/${CODE}`), newRoom("alice")));
  await assertFails(set(ref(db("carol"), `rooms/${CODE}`), newRoom("carol")));
});

test("room codes must be 4 characters from the safe alphabet", async () => {
  await assertFails(set(ref(db("alice"), `rooms/AB01`), newRoom("alice")));
});

test("rooms cannot be listed", async () => {
  await seedRoom();
  await assertFails(get(ref(db("carol"), "rooms")));
});

test("pseudo must be 1 to 16 characters", async () => {
  await assertFails(set(ref(db("alice"), `rooms/${CODE}`), newRoom("alice", "x".repeat(17))));
  await assertFails(set(ref(db("alice"), `rooms/${CODE}`), newRoom("alice", "")));
});

const join = (uid, name = "Bob") =>
  update(ref(db(uid), `rooms/${CODE}`), { "players/b": uid, "names/b": name, "presence/b": true });

test("another player can join a waiting room", async () => {
  await set(ref(db("alice"), `rooms/${CODE}`), newRoom("alice"));
  await assertSucceeds(join("bob"));
});

test("the creator cannot join their own room", async () => {
  await set(ref(db("alice"), `rooms/${CODE}`), newRoom("alice"));
  await assertFails(join("alice"));
});

test("a full room cannot be joined", async () => {
  await set(ref(db("alice"), `rooms/${CODE}`), newRoom("alice"));
  await join("bob");
  await assertFails(join("carol", "Carol"));
});

test("a room whose creator left cannot be joined", async () => {
  await set(ref(db("alice"), `rooms/${CODE}`), newRoom("alice"));
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
  await set(ref(db("alice"), `rooms/${CODE}`), newRoom("alice"));
  await join("bob");
  await assertSucceeds(newMatch("bob", 1));
});

test("match 1 cannot start before someone joined", async () => {
  await set(ref(db("alice"), `rooms/${CODE}`), newRoom("alice"));
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
  await set(ref(db("alice"), `rooms/${CODE}`), newRoom("alice"));
  await join("bob");
  await remove(ref(db("alice"), `rooms/${CODE}/presence/a`));
  await assertFails(newMatch("bob", 1));
});

test("a new match cannot come with rematch flags already set", async () => {
  await set(ref(db("alice"), `rooms/${CODE}`), newRoom("alice"));
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
  await assertFails(set(ref(db("alice"), `rooms/${CODE}`), { ...newRoom("alice"), names: { a: "Alice", b: "Bob" } }));
  await assertFails(set(ref(db("alice"), `rooms/${CODE}`), { ...newRoom("alice"), presence: { a: true, b: true } }));
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

test("a player of the match can store its result once, and anyone signed in can read results", async () => {
  await seedRoom();
  await assertSucceeds(set(ref(db("bob"), `results/${CODE}/1`), resultFor()));
  await assertFails(set(ref(db("alice"), `results/${CODE}/1`), resultFor()));
  const all = await assertSucceeds(get(ref(db("carol"), "results")));
  assert.equal(all.child(`${CODE}/1/winner`).val(), "a");
});

test("strangers cannot store results", async () => {
  await seedRoom();
  await assertFails(set(ref(db("carol"), `results/${CODE}/1`), resultFor()));
});

const forfeitFor = (winner) =>
  resultFor({ a: { name: "Alice", goals: 0 }, b: { name: "Bob", goals: 1 }, winner, forfeit: true });
const started = { locks: { 1: { 1: { a: Date.now() - 1000 } } } };

test("a forfeit is stored only once the loser has really left", async () => {
  await seedRoom({ extra: started });
  await assertFails(set(ref(db("bob"), `results/${CODE}/1`), { ...forfeitFor("b"), forfeit: "yes" }));
  await assertFails(set(ref(db("bob"), `results/${CODE}/1`), forfeitFor("b"))); // alice is still there
  await remove(ref(db("alice"), `rooms/${CODE}/presence/a`));
  await assertSucceeds(set(ref(db("bob"), `results/${CODE}/1`), forfeitFor("b")));
});

test("a forfeit for player a needs player b gone", async () => {
  await seedRoom({ extra: started });
  await assertFails(set(ref(db("alice"), `results/${CODE}/1`), forfeitFor("a")));
  await remove(ref(db("bob"), `rooms/${CODE}/presence/b`));
  await assertSucceeds(set(ref(db("alice"), `results/${CODE}/1`), forfeitFor("a")));
});

test("a forfeit needs the winner still present", async () => {
  await seedRoom({ extra: started });
  await remove(ref(db("alice"), `rooms/${CODE}/presence/a`));
  await remove(ref(db("bob"), `rooms/${CODE}/presence/b`));
  await assertFails(set(ref(db("bob"), `results/${CODE}/1`), forfeitFor("b")));
});

test("no forfeit before anyone has played a shot of the match", async () => {
  await seedRoom();
  await remove(ref(db("alice"), `rooms/${CODE}/presence/a`));
  await assertFails(set(ref(db("bob"), `results/${CODE}/1`), forfeitFor("b")));
});

test("results must match the room and be well-formed", async () => {
  await seedRoom();
  await assertFails(set(ref(db("alice"), `results/${CODE}/1`), resultFor({ uids: { a: "alice", b: "carol" } })));
  await assertFails(set(ref(db("alice"), `results/${CODE}/1`), resultFor({ winner: "c" })));
  await assertFails(set(ref(db("alice"), `results/${CODE}/1`), resultFor({ at: 123 })));
  await assertFails(set(ref(db("alice"), `results/${CODE}/2`), resultFor({ m: 2 })));
  await assertFails(set(ref(db("alice"), `results/${CODE}/1`), resultFor({ a: { name: "Zidane", goals: 3 } })));
});

test("unknown top-level paths are refused", async () => {
  await assertFails(set(ref(db("alice"), "hack"), true));
  await assertFails(get(ref(db("alice"), "/")));
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
  await set(ref(db("bob"), `rooms/${CODE}`), roomFor("bob", "Bob", "alice"));
  await assertSucceeds(set(ref(db("bob"), "queue/alice/room"), CODE));
  await assertFails(set(ref(db("carol"), "queue/alice/room"), "ZZ99"));
});

test("a player cannot be matched into a room that is not the matcher's", async () => {
  await enqueue("alice");
  await set(ref(db("dave"), `rooms/${CODE}`), roomFor("dave", "Dave", "alice"));
  await assertFails(set(ref(db("bob"), "queue/alice/room"), CODE));
});

test("a player cannot be matched into a room made for someone else, or for nobody", async () => {
  await enqueue("alice");
  await set(ref(db("bob"), `rooms/${CODE}`), roomFor("bob", "Bob", "carol"));
  await assertFails(set(ref(db("bob"), "queue/alice/room"), CODE));
  await set(ref(db("bob"), "rooms/CD45"), newRoom("bob", "Bob"));
  await assertFails(set(ref(db("bob"), "queue/alice/room"), "CD45"));
});

test("a player cannot be matched into a room whose creator is not present", async () => {
  await enqueue("alice");
  await set(ref(db("bob"), `rooms/${CODE}`), { ...roomFor("bob", "Bob", "alice"), presence: null });
  await assertFails(set(ref(db("bob"), "queue/alice/room"), CODE));
});

test("only the matched player can take the second seat of a matchmaking room", async () => {
  await set(ref(db("bob"), `rooms/${CODE}`), roomFor("bob", "Bob", "alice"));
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
  await set(ref(db("bob"), `rooms/${CODE}`), roomFor("bob", "Bob", "alice"));
  await assertFails(set(ref(db("bob"), "queue/alice/room"), CODE));
});
