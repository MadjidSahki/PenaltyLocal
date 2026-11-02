(function (root) {
"use strict";

function cleanName(name) {
  return typeof name === "string" ? name.trim().replace(/\s+/g, " ") : "";
}

function isValid(r) {
  return (
    r && typeof r === "object" && r.a && r.b &&
    cleanName(r.a.name) && cleanName(r.b.name) &&
    Number.isFinite(r.a.goals) && Number.isFinite(r.b.goals) &&
    (r.winner === "a" || r.winner === "b")
  );
}

// Aggregates stored match results into scoreboard rows, one per player.
// Players are identified by their account id when the result has one, and
// shown with their current pseudo (`currentNames`: uid -> pseudo), so a
// rename carries the player's record. Older results without ids are
// grouped by pseudo, case-insensitively, with the most recent spelling.
function buildLeaderboard(results, currentNames = {}) {
  const rows = new Map();
  const sorted = results.filter(isValid).sort((x, y) => (x.at || 0) - (y.at || 0));
  for (const r of sorted) {
    for (const slot of ["a", "b"]) {
      const uid = r.uids && typeof r.uids[slot] === "string" ? r.uids[slot] : null;
      const storedName = cleanName(r[slot].name);
      const name = (uid && cleanName(currentNames[uid])) || storedName;
      const key = uid ? "id:" + uid : "name:" + storedName.toLowerCase();
      const row = rows.get(key) || { name, played: 0, wins: 0, losses: 0, goals: 0 };
      row.name = name;
      row.played += 1;
      row.goals += r[slot].goals;
      if (r.winner === slot) row.wins += 1;
      else row.losses += 1;
      rows.set(key, row);
    }
  }
  const rate = (row) => (row.played ? row.wins / row.played : 0);
  return [...rows.values()].sort(
    (x, y) =>
      y.wins - x.wins ||
      rate(y) - rate(x) ||
      y.goals - x.goals ||
      x.name.localeCompare(y.name)
  );
}

const api = { buildLeaderboard };

if (typeof module !== "undefined" && module.exports) module.exports = api;
else root.PenaltyStats = api;
})(typeof self !== "undefined" ? self : this);
