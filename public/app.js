import { initializeApp } from "https://www.gstatic.com/firebasejs/13.2.0/firebase-app.js";
import {
  getAuth,
  connectAuthEmulator,
  setPersistence,
  browserSessionPersistence,
  signInAnonymously,
} from "https://www.gstatic.com/firebasejs/13.2.0/firebase-auth.js";
import {
  getDatabase,
  connectDatabaseEmulator,
  ref,
  get,
  set,
  update,
  remove,
  onValue,
  onDisconnect,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/13.2.0/firebase-database.js";
import { firebaseConfig, emulators } from "./firebase-config.js";

const { createMatch, applyRound } = window.PenaltyMatch;
const { buildLeaderboard } = window.PenaltyStats;

const SHOT_CLOCK_MS = 10000;
const GRACE_MS = 10500; // must match database.rules.json
const SETTLE_MS = 800; // extra wait before reading a timed-out round
const RESULT_PAUSE_MS = 2000;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const LEADERBOARD_SIZE = 10;

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);
if (emulators) {
  connectAuthEmulator(auth, `http://${emulators.host}:${emulators.authPort}`, { disableWarnings: true });
  connectDatabaseEmulator(db, emulators.host, emulators.databasePort);
}

// ---------- DOM ----------

const views = {
  home: document.getElementById("view-home"),
  lobby: document.getElementById("view-lobby"),
  match: document.getElementById("view-match"),
  over: document.getElementById("view-over"),
};

function showView(name) {
  for (const key of Object.keys(views)) {
    views[key].classList.toggle("is-active", key === name);
  }
}

const el = {
  nickname: document.getElementById("nickname"),
  joinCode: document.getElementById("join-code"),
  btnCreate: document.getElementById("btn-create"),
  btnJoin: document.getElementById("btn-join"),
  homeError: document.getElementById("home-error"),
  lobbyCode: document.getElementById("lobby-code"),
  btnCancel: document.getElementById("btn-cancel"),
  nameA: document.getElementById("name-a"),
  nameB: document.getElementById("name-b"),
  scoreA: document.getElementById("score-a"),
  scoreB: document.getElementById("score-b"),
  roleBanner: document.getElementById("role-banner"),
  clock: document.getElementById("clock"),
  controls: document.getElementById("controls"),
  matchStatus: document.getElementById("match-status"),
  ball: document.getElementById("ball"),
  keeper: document.getElementById("keeper"),
  resultBanner: document.getElementById("result-banner"),
  overTitle: document.getElementById("over-title"),
  overScore: document.getElementById("over-score"),
  overStatus: document.getElementById("over-status"),
  btnRematch: document.getElementById("btn-rematch"),
  btnHome: document.getElementById("btn-home"),
  lbBody: document.getElementById("lb-body"),
  lbEmpty: document.getElementById("lb-empty"),
};

function showHomeError(reason) {
  el.homeError.textContent = reason;
  el.homeError.hidden = false;
}

function setHomeEnabled(on) {
  el.btnCreate.disabled = !on;
  el.btnJoin.disabled = !on;
}

// ---------- server time ----------

let serverOffset = 0;
const serverNow = () => Date.now() + serverOffset;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- shot clock (display only; the rules enforce the deadline) ----------

let clockTimer = null;

function startClock(deadline) {
  stopClock();
  const tick = () => {
    const remaining = deadline - serverNow();
    el.clock.textContent = Math.max(0, Math.ceil(remaining / 1000));
    el.clock.classList.toggle("low", remaining <= 3000);
    if (remaining <= 0) {
      stopClock();
      setControlsEnabled(false);
    }
  };
  tick();
  clockTimer = setInterval(tick, 200);
}

function stopClock() {
  if (clockTimer) { clearInterval(clockTimer); clockTimer = null; }
}

function setControlsEnabled(on) {
  el.controls.classList.toggle("disabled", !on);
}

function renderScores(scores) {
  el.scoreA.textContent = scores.a;
  el.scoreB.textContent = scores.b;
}

// ---------- animation ----------

// Horizontal offset (px) applied to ball/keeper for each zone, relative
// to their centered resting position. Tuned to the goal width.
const ZONE_X = { left: -90, center: 0, right: 90 };
let shotToken = 0;

function resetScene() {
  shotToken += 1;
  el.ball.style.transition = "none";
  el.keeper.style.transition = "none";
  el.ball.style.transform = "translate(0, 0)";
  el.keeper.style.transform = "translate(0, 0) rotate(0deg)";
  el.resultBanner.hidden = true;
  el.resultBanner.textContent = "";
  el.resultBanner.className = "result-banner";
  // force reflow so the next transition starts from this reset state
  void el.ball.offsetWidth;
}

function onTransitionEnd(node) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; node.removeEventListener("transitionend", finish); resolve(); } };
    node.addEventListener("transitionend", finish);
    setTimeout(finish, 700); // fallback if transitionend never fires
  });
}

// Animate the ball to shooterZone and the keeper diving to keeperZone.
// A null zone means that side timed out (ball/keeper stays put).
function playShot(result) {
  resetScene();
  const token = shotToken;
  el.ball.style.transition = "transform 0.4s cubic-bezier(0.25, 0.9, 0.4, 1)";
  el.keeper.style.transition = "transform 0.35s cubic-bezier(0.3, 1.4, 0.5, 1)";

  requestAnimationFrame(() => {
    if (result.keeperZone !== null) {
      const kx = ZONE_X[result.keeperZone];
      const tilt = result.keeperZone === "left" ? -35 : result.keeperZone === "right" ? 35 : 0;
      el.keeper.style.transform = `translate(${kx}px, 10px) rotate(${tilt}deg)`;
    }
    if (result.shooterZone !== null) {
      const bx = ZONE_X[result.shooterZone];
      el.ball.style.transform = `translate(${bx}px, -150px)`;
    }
  });

  return onTransitionEnd(el.ball).then(() => {
    // The next turn may already have reset the scene.
    if (token !== shotToken) return result;
    const banner = el.resultBanner;
    banner.hidden = false;
    if (result.timedOut) {
      banner.textContent = "TEMPS ÉCOULÉ";
      banner.classList.add("is-timeout");
    } else if (result.goal) {
      banner.textContent = "BUT !";
      banner.classList.add("is-goal");
    } else {
      banner.textContent = "ARRÊT !";
      banner.classList.add("is-save");
    }
    return result;
  });
}

// ---------- scoreboard ----------

async function loadLeaderboard() {
  try {
    const snap = await get(ref(db, "results"));
    const results = [];
    snap.forEach((room) => { room.forEach((match) => { results.push(match.val()); }); });
    renderLeaderboard(buildLeaderboard(results).slice(0, LEADERBOARD_SIZE));
  } catch {
    renderLeaderboard([]);
  }
}

function renderLeaderboard(rows) {
  el.lbBody.replaceChildren();
  el.lbEmpty.hidden = rows.length > 0;
  rows.forEach((row, i) => {
    const tr = document.createElement("tr");
    for (const value of [i + 1, row.name, row.wins, row.losses, row.goals]) {
      const td = document.createElement("td");
      td.textContent = value;
      tr.appendChild(td);
    }
    el.lbBody.appendChild(tr);
  });
}

// ---------- rooms ----------

// The current room and match, as seen by this player.
let session = null;

function randomCode() {
  const bytes = new Uint32Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (n) => CODE_ALPHABET[n % CODE_ALPHABET.length]).join("");
}

function pseudo() {
  return el.nickname.value.trim().replace(/\s+/g, " ").slice(0, 16);
}

const roomPath = (s, rest = "") => `rooms/${s.code}${rest}`;
const otherSlot = (slot) => (slot === "a" ? "b" : "a");

async function startSession(code, slot) {
  session = { code, slot, room: null, m: 0, opponentSeen: false, timer: null };
  const presence = ref(db, `rooms/${code}/presence/${slot}`);
  await onDisconnect(presence).remove();
  const s = session;
  s.unsubscribe = onValue(ref(db, `rooms/${code}`), (snap) => {
    if (session === s) onRoom(s, snap.val());
  });
}

function endSession() {
  const s = session;
  if (!s) return;
  session = null;
  if (s.unsubscribe) s.unsubscribe();
  clearTimeout(s.timer);
  stopClock();
  const presence = ref(db, `rooms/${s.code}/presence/${s.slot}`);
  onDisconnect(presence).cancel().catch(() => {});
  remove(presence).catch(() => {});
}

function goHome(notice) {
  endSession();
  showView("home");
  if (notice) showHomeError(notice);
  else el.homeError.hidden = true;
  loadLeaderboard();
}

async function createRoom() {
  const name = pseudo();
  if (!name) { showHomeError("Choisis un pseudo."); return; }
  localStorage.setItem("pseudo", name);
  el.homeError.hidden = true;
  setHomeEnabled(false);
  try {
    for (let attempt = 0; attempt < 6; attempt++) {
      const code = randomCode();
      try {
        await set(ref(db, `rooms/${code}`), {
          players: { a: auth.currentUser.uid },
          names: { a: name },
          createdAt: serverTimestamp(),
          presence: { a: true },
        });
      } catch {
        continue; // code already taken
      }
      await startSession(code, "a");
      el.lobbyCode.textContent = code;
      showView("lobby");
      return;
    }
    showHomeError("Impossible de créer un salon, réessaie.");
  } finally {
    setHomeEnabled(true);
  }
}

async function joinRoom() {
  const name = pseudo();
  const code = el.joinCode.value.trim().toUpperCase();
  if (!name) { showHomeError("Choisis un pseudo."); return; }
  if (!/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/.test(code)) {
    showHomeError("Entre un code à 4 caractères.");
    return;
  }
  localStorage.setItem("pseudo", name);
  el.homeError.hidden = true;
  setHomeEnabled(false);
  try {
    const uid = auth.currentUser.uid;
    const room = (await get(ref(db, `rooms/${code}`))).val();
    if (!room) return showHomeError("Salon introuvable.");
    if (room.players.a === uid) return showHomeError("C'est ton propre salon : donne le code à ton adversaire.");
    if (room.players.b) return showHomeError("Ce salon est déjà complet.");
    if (!room.presence || !room.presence.a) return showHomeError("Le créateur a quitté ce salon.");
    try {
      await update(ref(db, `rooms/${code}`), { "players/b": uid, "names/b": name, "presence/b": true });
    } catch {
      return showHomeError("Impossible de rejoindre ce salon.");
    }
    await startSession(code, "b");
    await set(ref(db, `rooms/${code}/matches/1`), {
      n: 1,
      rounds: { 1: { n: 1, startedAt: serverTimestamp() } },
    }).catch(() => {});
  } finally {
    setHomeEnabled(true);
  }
}

// ---------- match flow ----------
// Both players replay the same rule-checked choices with match.js, so they
// always agree on the score. Rounds are created by whichever client gets
// there first; the database rules make every write happen at most once.

function onRoom(s, room) {
  if (!room) return;
  s.room = room;
  const opp = otherSlot(s.slot);
  if (room.players && room.players[opp]) s.opponentSeen = true;
  if (s.opponentSeen && !(room.presence && room.presence[opp])) {
    goHome("L'adversaire a quitté la partie.");
    return;
  }
  const m = Math.max(0, ...Object.keys(room.matches || {}).map(Number));
  if (!m) return; // still waiting for an opponent
  if (m !== s.m) beginMatch(s, m);
  step(s);
}

function beginMatch(s, m) {
  clearTimeout(s.timer);
  Object.assign(s, {
    m,
    match: createMatch({ firstShooter: m % 2 === 1 ? "a" : "b" }),
    resolved: 0,
    shownTurn: 0,
    resolving: false,
    pauseUntil: 0,
    over: false,
    requestedRound: 0,
    requestedMatch: 0,
  });
  el.nameA.textContent = s.room.names.a;
  el.nameB.textContent = s.room.names.b;
  renderScores({ a: 0, b: 0 });
  resetScene();
  el.matchStatus.textContent = "";
  el.overStatus.textContent = "";
  el.btnRematch.disabled = false;
  showView("match");
}

function step(s) {
  if (session !== s || !s.m) return;
  clearTimeout(s.timer);
  const match = s.room.matches[s.m];
  if (s.over) { renderRematch(s, match); return; }
  if (s.resolving || s.match.status === "finished") return;

  const wait = s.pauseUntil - Date.now();
  if (wait > 0) { s.timer = setTimeout(() => step(s), wait); return; }

  const r = s.resolved + 1;
  const round = match.rounds && match.rounds[r];
  if (!round) {
    // Round 1 comes with the match; later rounds are started after a result.
    if (s.resolved > 0 && s.requestedRound !== r) {
      s.requestedRound = r;
      set(ref(db, roomPath(s, `/matches/${s.m}/rounds/${r}`)), { n: r, startedAt: serverTimestamp() })
        .catch(() => { s.requestedRound = 0; });
    }
    s.timer = setTimeout(() => step(s), 1500);
    return;
  }

  const locks = (s.room.locks && s.room.locks[s.m] && s.room.locks[s.m][r]) || {};
  if (s.shownTurn !== r) showTurn(s, r, round, locks);
  const settleAt = round.startedAt + GRACE_MS + SETTLE_MS;
  if ((locks.a && locks.b) || serverNow() >= settleAt) resolveRound(s, r);
  else s.timer = setTimeout(() => step(s), settleAt - serverNow());
}

function showTurn(s, r, round, locks) {
  s.shownTurn = r;
  const iShoot = s.match.shooter === s.slot;
  el.roleBanner.textContent = iShoot
    ? "À toi de tirer — choisis une zone"
    : "Tu es gardien — choisis où plonger";
  resetScene();
  el.matchStatus.textContent = `Tir n°${r}`;
  const open = !locks[s.slot] && serverNow() < round.startedAt + SHOT_CLOCK_MS;
  setControlsEnabled(open);
  startClock(round.startedAt + SHOT_CLOCK_MS);
}

async function choose(zone) {
  const s = session;
  if (!s || !s.m || el.controls.classList.contains("disabled")) return;
  setControlsEnabled(false);
  const r = s.shownTurn;
  try {
    await set(ref(db, `choices/${s.code}/${s.m}/${r}/${s.slot}`), zone);
    await set(ref(db, roomPath(s, `/locks/${s.m}/${r}/${s.slot}`)), true);
    if (session === s && s.shownTurn === r && s.resolved < r) {
      el.matchStatus.textContent = "En attente de l'adversaire…";
    }
  } catch {
    if (session === s && s.resolved < r) el.matchStatus.textContent = "Trop tard !";
  }
}

// Reads both final choices. A read is refused until the round is final, so a
// refusal just means "try again in a moment".
async function readChoices(s, r) {
  const base = `choices/${s.code}/${s.m}/${r}`;
  for (let attempt = 0; attempt < 25; attempt++) {
    try {
      const [a, b] = await Promise.all([get(ref(db, `${base}/a`)), get(ref(db, `${base}/b`))]);
      return { a: a.val(), b: b.val() };
    } catch {
      await sleep(400);
    }
  }
  return null;
}

async function resolveRound(s, r) {
  s.resolving = true;
  stopClock();
  setControlsEnabled(false);
  const choices = await readChoices(s, r);
  if (session !== s) return;
  if (!choices) {
    goHome("Connexion perdue avec le serveur.");
    return;
  }
  s.match = applyRound(s.match, choices).state;
  s.resolved = r;
  s.resolving = false;
  const result = s.match.lastResult;
  renderScores(result.scores);
  el.matchStatus.textContent = result.timedOut === s.slot ? "Trop lent !" : "";
  playShot(result);
  s.pauseUntil = Date.now() + RESULT_PAUSE_MS;
  if (s.match.status === "finished") s.timer = setTimeout(() => finishMatch(s), RESULT_PAUSE_MS);
  else step(s);
}

function finishMatch(s) {
  if (session !== s) return;
  s.over = true;
  stopClock();
  const { winner, scores } = s.match;
  el.overTitle.textContent = winner === s.slot ? "Victoire !" : `${s.room.names[winner]} gagne`;
  el.overScore.textContent = `${scores.a} — ${scores.b}`;
  el.overStatus.textContent = "";
  el.btnRematch.disabled = false;
  showView("over");
  set(ref(db, `results/${s.code}/${s.m}`), {
    code: s.code,
    m: s.m,
    uids: { a: s.room.players.a, b: s.room.players.b },
    a: { name: s.room.names.a, goals: scores.a },
    b: { name: s.room.names.b, goals: scores.b },
    winner,
    at: serverTimestamp(),
  }).catch(() => {}); // both players try; the first write wins
  step(s);
}

function renderRematch(s, match) {
  const flags = match.rematch || {};
  const mine = flags[s.slot];
  const theirs = flags[otherSlot(s.slot)];
  if (mine && theirs) {
    const next = s.m + 1;
    if (s.requestedMatch !== next) {
      s.requestedMatch = next;
      set(ref(db, roomPath(s, `/matches/${next}`)), {
        n: next,
        rounds: { 1: { n: 1, startedAt: serverTimestamp() } },
      }).catch(() => {});
    }
  } else if (mine) {
    el.overStatus.textContent = "En attente de l'adversaire…";
    el.btnRematch.disabled = true;
  } else if (theirs) {
    el.overStatus.textContent = `${s.room.names[otherSlot(s.slot)]} veut rejouer !`;
  }
}

function askRematch() {
  const s = session;
  if (!s || !s.over) return;
  el.btnRematch.disabled = true;
  set(ref(db, roomPath(s, `/matches/${s.m}/rematch/${s.slot}`)), true).catch(() => {});
}

// ---------- UI events ----------

el.btnCreate.addEventListener("click", createRoom);
el.btnJoin.addEventListener("click", joinRoom);
el.btnCancel.addEventListener("click", () => goHome());
for (const btn of el.controls.querySelectorAll(".btn-zone")) {
  btn.addEventListener("click", () => choose(btn.dataset.zone));
}
el.btnRematch.addEventListener("click", askRematch);
el.btnHome.addEventListener("click", () => goHome());

// ---------- start ----------

el.nickname.value = localStorage.getItem("pseudo") || "";
setHomeEnabled(false);

onValue(ref(db, ".info/serverTimeOffset"), (snap) => { serverOffset = snap.val() || 0; });

let wasConnected = false;
onValue(ref(db, ".info/connected"), (snap) => {
  if (snap.val() === true) {
    wasConnected = true;
  } else if (wasConnected && session) {
    goHome("Connexion perdue avec le serveur.");
  }
});

setPersistence(auth, browserSessionPersistence)
  .then(() => signInAnonymously(auth))
  .then(() => {
    setHomeEnabled(true);
    loadLeaderboard();
  })
  .catch(() => showHomeError("Connexion à Firebase impossible. Recharge la page."));
