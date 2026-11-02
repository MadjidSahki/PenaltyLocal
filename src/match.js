const ZONES = ["left", "center", "right"];

const REGULATION_SHOTS = 5;

function createMatch() {
  return {
    scores: { a: 0, b: 0 },
    shotsTaken: { a: 0, b: 0 },
    shooter: "a",
    round: 1,
    phase: "regulation",
    status: "playing",
    winner: null,
    pending: { shooter: null, keeper: null },
    lastResult: null,
  };
}

function clone(state) {
  return {
    scores: { ...state.scores },
    shotsTaken: { ...state.shotsTaken },
    shooter: state.shooter,
    round: state.round,
    phase: state.phase,
    status: state.status,
    winner: state.winner,
    pending: { ...state.pending },
    lastResult: state.lastResult ? { ...state.lastResult } : null,
  };
}

function keeperOf(shooter) {
  return shooter === "a" ? "b" : "a";
}

function applyEndRules(state) {
  const { scores, shotsTaken, phase } = state;
  const shotsA = shotsTaken.a;
  const shotsB = shotsTaken.b;

  if (phase === "regulation") {
    const remainingA = Math.max(0, REGULATION_SHOTS - shotsA);
    const remainingB = Math.max(0, REGULATION_SHOTS - shotsB);
    if (scores.a > scores.b + remainingB) {
      state.status = "finished";
      state.winner = "a";
      return;
    }
    if (scores.b > scores.a + remainingA) {
      state.status = "finished";
      state.winner = "b";
      return;
    }
    if (shotsA >= REGULATION_SHOTS && shotsB >= REGULATION_SHOTS) {
      if (scores.a !== scores.b) {
        state.status = "finished";
        state.winner = scores.a > scores.b ? "a" : "b";
      } else {
        state.phase = "suddenDeath";
      }
    }
    return;
  }

  // sudden death: decide only when both have taken an equal number of shots
  if (shotsA === shotsB && scores.a !== scores.b) {
    state.status = "finished";
    state.winner = scores.a > scores.b ? "a" : "b";
  }
}

function resolveRound(state, shooterZone, keeperZone, timedOut) {
  const next = clone(state);
  const shooter = next.shooter;
  const keeper = keeperOf(shooter);

  // Outcome rules:
  //  - shooter timed out  -> miss (no goal)
  //  - keeper timed out   -> goal conceded
  //  - both chose a zone  -> goal unless the keeper matched the shooter
  let goal;
  if (timedOut === shooter) {
    goal = false;
  } else if (timedOut === keeper) {
    goal = true;
  } else {
    goal = shooterZone !== keeperZone;
  }

  if (goal) next.scores[shooter] += 1;
  next.shotsTaken[shooter] += 1;

  next.lastResult = {
    shooter,
    keeper,
    shooterZone,
    keeperZone,
    goal,
    timedOut: timedOut || null,
    scores: { ...next.scores },
  };

  next.pending = { shooter: null, keeper: null };
  next.shooter = keeper;
  next.round += 1;

  applyEndRules(next);

  next.lastResult.status = next.status;
  next.lastResult.winner = next.winner;
  return next;
}

function roleOf(state, player) {
  return player === state.shooter ? "shooter" : "keeper";
}

function submitChoice(state, player, zone) {
  if (state.status === "finished") {
    return { ok: false, reason: "Match is finished" };
  }
  if (!ZONES.includes(zone)) {
    return { ok: false, reason: "Invalid zone" };
  }
  const role = roleOf(state, player);
  if (state.pending[role] !== null) {
    return { ok: false, reason: "Already chose this round" };
  }

  const next = clone(state);
  next.pending[role] = zone;

  if (next.pending.shooter !== null && next.pending.keeper !== null) {
    return {
      ok: true,
      state: resolveRound(next, next.pending.shooter, next.pending.keeper, null),
    };
  }
  return { ok: true, state: next };
}

function submitTimeout(state, player) {
  if (state.status === "finished") {
    return { ok: false, reason: "Match is finished" };
  }
  const role = roleOf(state, player);
  if (state.pending[role] !== null) {
    return { ok: false, reason: "Player already chose this round" };
  }

  // The timed-out player's zone is null; the other player's zone is
  // whatever they already submitted (or null if they haven't either).
  const shooterZone = role === "shooter" ? null : state.pending.shooter;
  const keeperZone = role === "keeper" ? null : state.pending.keeper;

  return { ok: true, state: resolveRound(state, shooterZone, keeperZone, player) };
}

function roundResult(state) {
  return state.lastResult;
}

module.exports = {
  ZONES,
  createMatch,
  submitChoice,
  submitTimeout,
  roundResult,
};
