// Decides what the nightly cleanup removes. Pure: data in, paths out.
// Profiles, pseudos and results are never touched.

const HOUR = 3600 * 1000;
const ROOM_MAX_AGE_MS = 24 * HOUR;
const ACTIVE_GRACE_MS = HOUR; // keep an old room that was used in the last hour
const QUEUE_MAX_IDLE_MS = 10 * 60 * 1000;

const isTime = (v) => typeof v === "number" && Number.isFinite(v);

// Latest server time found in a room (creation, round starts, locks).
function lastActivity(room) {
  let last = room.createdAt;
  for (const match of Object.values(room.matches || {})) {
    for (const round of Object.values((match && match.rounds) || {})) {
      if (round && isTime(round.startedAt)) last = Math.max(last, round.startedAt);
    }
  }
  for (const rounds of Object.values(room.locks || {})) {
    for (const slots of Object.values(rounds || {})) {
      for (const t of Object.values(slots || {})) if (isTime(t)) last = Math.max(last, t);
    }
  }
  return last;
}

function planCleanup({ rooms, queue, limits } = {}, now) {
  const updates = {};
  for (const [code, room] of Object.entries(rooms || {})) {
    if (!room || !isTime(room.createdAt)) continue;
    if (room.createdAt >= now - ROOM_MAX_AGE_MS) continue;
    if (lastActivity(room) >= now - ACTIVE_GRACE_MS) continue;
    updates[`rooms/${code}`] = null;
    updates[`choices/${code}`] = null;
  }
  for (const [uid, entry] of Object.entries(queue || {})) {
    if (!entry || !isTime(entry.at)) continue;
    const seen = isTime(entry.seen) ? Math.max(entry.at, entry.seen) : entry.at;
    if (seen < now - QUEUE_MAX_IDLE_MS) updates[`queue/${uid}`] = null;
  }
  for (const [uid, stamps] of Object.entries(limits || {})) {
    if (stamps && isTime(stamps.room) && stamps.room < now - ROOM_MAX_AGE_MS) updates[`limits/${uid}`] = null;
  }
  return updates;
}

module.exports = { planCleanup, ROOM_MAX_AGE_MS, ACTIVE_GRACE_MS, QUEUE_MAX_IDLE_MS };
