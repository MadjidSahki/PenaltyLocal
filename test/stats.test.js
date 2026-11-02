const test = require("node:test");
const assert = require("node:assert");
const { buildLeaderboard } = require("../public/stats");

const result = (aName, aGoals, bName, bGoals, winner, at = 1) => ({
  a: { name: aName, goals: aGoals },
  b: { name: bName, goals: bGoals },
  winner,
  at,
});

test("empty results give an empty leaderboard", () => {
  assert.deepEqual(buildLeaderboard([]), []);
});

test("wins, losses, played and goals are counted per player", () => {
  const rows = buildLeaderboard([result("Alice", 3, "Bob", 1, "a"), result("Bob", 4, "Alice", 2, "a")]);
  const alice = rows.find((r) => r.name === "Alice");
  const bob = rows.find((r) => r.name === "Bob");
  assert.deepEqual(
    { played: alice.played, wins: alice.wins, losses: alice.losses, goals: alice.goals },
    { played: 2, wins: 1, losses: 1, goals: 5 }
  );
  assert.deepEqual(
    { played: bob.played, wins: bob.wins, losses: bob.losses, goals: bob.goals },
    { played: 2, wins: 1, losses: 1, goals: 5 }
  );
});

test("pseudos are grouped case- and space-insensitively, keeping the latest spelling", () => {
  const rows = buildLeaderboard([result("zizou", 3, "Bob", 0, "a", 1), result(" Zizou ", 3, "Bob", 0, "a", 2)]);
  assert.equal(rows.length, 2);
  const z = rows.find((r) => r.wins === 2);
  assert.equal(z.name, "Zizou");
});

test("sorted by wins, then win rate, then goals, then name", () => {
  const rows = buildLeaderboard([
    result("A", 3, "B", 0, "a"),
    result("C", 3, "D", 0, "a"),
    result("C", 0, "E", 3, "b"),
    result("A", 5, "F", 0, "a"),
  ]);
  assert.deepEqual(rows.slice(0, 3).map((r) => r.name), ["A", "E", "C"]);
});

test("malformed records are skipped", () => {
  const rows = buildLeaderboard([null, { a: { name: "X" } }, result("Alice", 3, "Bob", 1, "a")]);
  assert.equal(rows.length, 2);
});

test("a forfeit counts as a win for the one who stayed and a loss for the one who left", () => {
  const rows = buildLeaderboard([{ ...result("Alice", 1, "Bob", 0, "b"), forfeit: true }]);
  const alice = rows.find((r) => r.name === "Alice");
  const bob = rows.find((r) => r.name === "Bob");
  assert.deepEqual([alice.wins, alice.losses, bob.wins, bob.losses], [0, 1, 1, 0]);
});

test("results are grouped by player and shown with their current pseudo", () => {
  const withUids = (r, a, b) => ({ ...r, uids: { a, b } });
  const rows = buildLeaderboard(
    [
      withUids(result("Zizou", 3, "Bob", 0, "a", 1), "u1", "u2"),
      withUids(result("Zinedine", 3, "Bob", 1, "a", 2), "u1", "u2"),
      withUids(result("Zizou", 3, "Karim", 0, "a", 3), "u3", "u4"),
    ],
    { u1: "Zidane", u2: "Bob" }
  );
  const zidane = rows.find((r) => r.name === "Zidane");
  assert.deepEqual([zidane.played, zidane.wins, zidane.goals], [2, 2, 6]);
  assert.ok(rows.find((r) => r.name === "Zizou" && r.wins === 1), "u3 keeps its own row");
});
