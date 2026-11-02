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
