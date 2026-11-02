const test = require("node:test");
const assert = require("node:assert");
const { createMatch, submitChoice, ZONES } = require("../src/match");

test("fresh match: a shoots first, scores zero, playing", () => {
  const m = createMatch();
  assert.deepEqual(m.scores, { a: 0, b: 0 });
  assert.equal(m.shooter, "a");
  assert.equal(m.status, "playing");
});

test("different zones => goal; roles this round: a shoots, b keeps", () => {
  let m = createMatch();
  m = submitChoice(m, "a", "left").state;   // shooter a
  const r = submitChoice(m, "b", "right");  // keeper b
  assert.equal(r.ok, true);
  assert.equal(r.state.scores.a, 1);
  assert.equal(r.state.shooter, "b"); // roles alternate
});

test("same zone => save, no goal", () => {
  let m = createMatch();
  m = submitChoice(m, "a", "center").state;
  const r = submitChoice(m, "b", "center");
  assert.equal(r.state.scores.a, 0);
});

test("invalid zone rejected, state unchanged", () => {
  const m = createMatch();
  const r = submitChoice(m, "a", "up");
  assert.equal(r.ok, false);
  assert.ok(r.reason);
});

test("double submit by same player rejected", () => {
  let m = createMatch();
  m = submitChoice(m, "a", "left").state;
  const r = submitChoice(m, "a", "right");
  assert.equal(r.ok, false);
});

test("match finishes once the lead is unassailable, further choice rejected", () => {
  // a scores every shot, b misses every shot. Roles alternate each round.
  let m = createMatch();
  const aGoal = (st) => submitChoice(submitChoice(st, "a", "left").state, "b", "right").state; // a shoots, b keeps wrong -> goal
  const bMiss = (st) => submitChoice(submitChoice(st, "b", "left").state, "a", "left").state;   // b shoots, a saves -> no goal
  m = aGoal(m); // 1-0  (a shots:1, b shots:0)
  m = bMiss(m); // 1-0  (b shots:1)
  m = aGoal(m); // 2-0  (a shots:2)
  m = bMiss(m); // 2-0  (b shots:2)
  m = aGoal(m); // 3-0  (a shots:3) — b has 3 left, still catchable
  m = bMiss(m); // 3-0  (b shots:3) — now b has 2 left, 3 > 0+2 => a wins
  assert.equal(m.status, "finished");
  assert.equal(m.winner, "a");
  const r = submitChoice(m, "b", "left");
  assert.equal(r.ok, false);
});

test("tie after 5 each => sudden death phase", () => {
  let m = createMatch();
  // all saves: a shoots left, b keeps left; then b shoots left, a keeps left; x5 each
  for (let i = 0; i < 10; i++) {
    const shooter = m.shooter;
    const keeper = shooter === "a" ? "b" : "a";
    m = submitChoice(m, shooter, "left").state;
    m = submitChoice(m, keeper, "left").state;
  }
  assert.equal(m.scores.a, 0);
  assert.equal(m.scores.b, 0);
  assert.equal(m.phase, "suddenDeath");
  assert.equal(m.status, "playing");
});

test("shooter timeout => missed shot, no goal, round advances", () => {
  const { submitTimeout } = require("../src/match");
  let m = createMatch(); // a is shooter
  const r = submitTimeout(m, "a");
  assert.equal(r.ok, true);
  assert.equal(r.state.scores.a, 0);
  assert.equal(r.state.shooter, "b"); // round advanced, roles alternate
});

test("keeper timeout => goal conceded", () => {
  const { submitTimeout } = require("../src/match");
  let m = createMatch(); // a shooter, b keeper
  const r = submitTimeout(m, "b");
  assert.equal(r.ok, true);
  assert.equal(r.state.scores.a, 1); // shooter a scores
});

test("timeout after that player already chose is rejected", () => {
  const { submitTimeout } = require("../src/match");
  let m = submitChoice(createMatch(), "a", "left").state; // shooter a locked in
  const r = submitTimeout(m, "a");
  assert.equal(r.ok, false);
});

test("ZONES are the three expected zones", () => {
  assert.deepEqual([...ZONES].sort(), ["center", "left", "right"]);
});
