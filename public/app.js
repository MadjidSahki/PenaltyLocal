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
import { playShot, resetScene } from "./scene.js";

const { createMatch, applyRound } = window.PenaltyMatch;
const { buildLeaderboard } = window.PenaltyStats;

const SHOT_CLOCK_MS = 10000;
const GRACE_MS = 10500; // must match database.rules.json
const SETTLE_MS = 800; // extra wait before reading a timed-out round
const RESULT_PAUSE_MS = 2000; // must match database.rules.json
const START_MARGIN_MS = 250; // covers the error of the server time estimate
const NETWORK_TIMEOUT_MS = 8000;
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
  search: document.getElementById("view-search"),
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
  btnSearch: document.getElementById("btn-search"),
  btnSearchCancel: document.getElementById("btn-search-cancel"),
  searchStatus: document.getElementById("search-status"),
  btnForfeit: document.getElementById("btn-forfeit"),
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
  el.btnSearch.disabled = !on;
  el.btnCreate.disabled = !on;
  el.btnJoin.disabled = !on;
}

// ---------- server time ----------

let serverOffset = 0;
const serverNow = () => Date.now() + serverOffset;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Firebase writes wait silently while offline; give up with a message instead.
function withTimeout(promise) {
  return Promise.race([
    promise,
    sleep(NETWORK_TIMEOUT_MS).then(() => { throw new Error("timeout"); }),
  ]);
}

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
  const s = session;
  // Register the disconnect cleanup before announcing presence, so a tab
  // closed in between never leaves a ghost player behind.
  const presence = ref(db, `rooms/${code}/presence/${slot}`);
  await withTimeout(onDisconnect(presence).remove());
  await withTimeout(set(presence, true));
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
  clearTimeout(s.finishTimer);
  clearTimeout(s.joinTimer);
  stopClock();
  const presence = ref(db, `rooms/${s.code}/presence/${s.slot}`);
  onDisconnect(presence).cancel().catch(() => {});
  remove(presence).catch(() => {});
}

function goHome(notice) {
  stopSearch();
  endSession();
  showView("home");
  if (notice) showHomeError(notice);
  else el.homeError.hidden = true;
  loadLeaderboard();
}

const OFFLINE_MESSAGE = "Pas de connexion au serveur. Vérifie ta connexion et réessaie.";

// Writes a new room with this player as its creator; returns its code.
async function newRoomCode(name) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const code = randomCode();
    try {
      await withTimeout(set(ref(db, `rooms/${code}`), {
        players: { a: auth.currentUser.uid },
        names: { a: name },
        createdAt: serverTimestamp(),
      }));
      return code;
    } catch (err) {
      if (err.message === "timeout") throw err;
      // code already taken: try another one
    }
  }
  throw new Error("no free code");
}

async function createRoom() {
  const name = pseudo();
  if (!name) { showHomeError("Choisis un pseudo."); return; }
  localStorage.setItem("pseudo", name);
  el.homeError.hidden = true;
  setHomeEnabled(false);
  try {
    const code = await newRoomCode(name);
    await startSession(code, "a");
    el.lobbyCode.textContent = code;
    showView("lobby");
  } catch (err) {
    endSession();
    showHomeError(err.message === "no free code" ? "Impossible de créer un salon, réessaie." : OFFLINE_MESSAGE);
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
    const problem = await joinRoomCode(code, name);
    if (problem) showHomeError(problem);
  } finally {
    setHomeEnabled(true);
  }
}

// Joins a room as its second player and starts match 1. Returns an error
// message for the player, or null once the match is starting.
async function joinRoomCode(code, name) {
  try {
    const uid = auth.currentUser.uid;
    const room = (await withTimeout(get(ref(db, `rooms/${code}`)))).val();
    if (!room) return "Salon introuvable.";
    if (room.players.a === uid) return "C'est ton propre salon : donne le code à ton adversaire.";
    if (room.players.b) return "Ce salon est déjà complet.";
    if (!room.presence || !room.presence.a) return "Le créateur a quitté ce salon.";
    try {
      await withTimeout(update(ref(db, `rooms/${code}`), { "players/b": uid, "names/b": name }));
    } catch (err) {
      return err.message === "timeout" ? OFFLINE_MESSAGE : "Impossible de rejoindre ce salon.";
    }
    await startSession(code, "b");
    await set(ref(db, `rooms/${code}/matches/1`), {
      n: 1,
      rounds: { 1: { n: 1, startedAt: serverTimestamp() } },
    }).catch(() => {});
    return null;
  } catch {
    endSession();
    return OFFLINE_MESSAGE;
  }
}

// ---------- matchmaking ----------
// Waiting players sit in queue/{uid}. The newer player of a pair does the
// matching: it creates a room with the room engine, writes its code into the
// older player's entry (write-once), and the older player joins that room.

const MATCH_JOIN_TIMEOUT_MS = 15000;
let search = null;

async function startSearch(notice) {
  const name = pseudo();
  if (!name) { showHomeError("Choisis un pseudo."); return; }
  localStorage.setItem("pseudo", name);
  el.homeError.hidden = true;
  setHomeEnabled(false);
  const uid = auth.currentUser.uid;
  const entry = ref(db, `queue/${uid}`);
  try {
    await withTimeout(onDisconnect(entry).remove());
    await withTimeout(set(entry, { name, at: serverTimestamp() }));
  } catch {
    showHomeError(OFFLINE_MESSAGE);
    return;
  } finally {
    setHomeEnabled(true);
  }
  const s = { name, uid, entry, busy: false, tried: new Set() };
  search = s;
  el.searchStatus.textContent = notice || "En attente d'un autre joueur…";
  showView("search");
  s.unsubscribe = onValue(ref(db, "queue"), (snap) => {
    if (search === s) onQueue(s, snap.val() || {});
  });
}

function stopSearch() {
  const s = search;
  if (!s) return;
  search = null;
  if (s.unsubscribe) s.unsubscribe();
  onDisconnect(s.entry).cancel().catch(() => {});
  remove(s.entry).catch(() => {});
}

async function onQueue(s, queue) {
  const mine = queue[s.uid];
  if (!mine || s.busy) return;

  if (mine.room) {
    // Someone matched us: join their room.
    s.busy = true;
    stopSearch();
    el.searchStatus.textContent = "Adversaire trouvé, connexion…";
    const problem = await joinRoomCode(mine.room, s.name);
    if (problem && !session) startSearch("Nouvelle recherche…");
    return;
  }

  const candidates = Object.entries(queue)
    .filter(([uid, e]) => uid !== s.uid && e && !e.room && typeof e.at === "number" && !s.tried.has(uid))
    .filter(([uid, e]) => e.at < mine.at || (e.at === mine.at && uid < s.uid))
    .sort((x, y) => x[1].at - y[1].at);
  if (!candidates.length) return;

  const [otherUid, other] = candidates[0];
  s.busy = true;
  s.tried.add(otherUid);
  el.searchStatus.textContent = `Adversaire trouvé : ${other.name}…`;
  try {
    // Be present in the room before telling the other player where it is.
    const code = await newRoomCode(s.name);
    await startSession(code, "a");
    await withTimeout(set(ref(db, `queue/${otherUid}/room`), code));
  } catch {
    // Someone else matched them first (or the network failed): keep looking.
    endSession();
    if (search === s) {
      s.busy = false;
      el.searchStatus.textContent = "En attente d'un autre joueur…";
    }
    return;
  }
  if (search !== s) { endSession(); return; } // cancelled meanwhile
  stopSearch();
  // If they never show up, go back to the queue.
  const room = session;
  room.joinTimer = setTimeout(() => {
    if (session === room && !room.m) {
      endSession();
      startSearch("L'adversaire ne s'est pas connecté, nouvelle recherche…");
    }
  }, MATCH_JOIN_TIMEOUT_MS);
}

// ---------- match flow ----------
// Both players replay the same rule-checked choices with match.js, so they
// always agree on the score. Rounds are created by whichever client gets
// there first; the database rules make every write happen at most once.

function onRoom(s, room) {
  if (!room) return;
  s.room = room;
  const opp = otherSlot(s.slot);
  const oppPresent = !!(room.presence && room.presence[opp]);
  if (oppPresent) s.opponentSeen = true;
  if (s.opponentSeen && !oppPresent) {
    if (s.m && !s.over && s.match && s.match.status !== "finished") {
      const saving = saveResult(s, { winner: s.slot, forfeit: true });
      goHome(`${room.names[opp]} a quitté le match : victoire par forfait !`);
      saving.then(loadLeaderboard);
    } else {
      goHome("L'adversaire a quitté la partie.");
    }
    return;
  }
  const m = Math.max(0, ...Object.keys(room.matches || {}).map(Number));
  if (!m) return; // still waiting for an opponent
  if (m !== s.m) beginMatch(s, m);
  step(s);
}

function beginMatch(s, m) {
  clearTimeout(s.timer);
  clearTimeout(s.finishTimer);
  clearTimeout(s.joinTimer);
  Object.assign(s, {
    m,
    match: createMatch({ firstShooter: m % 2 === 1 ? "a" : "b" }),
    resolved: 0,
    shownTurn: 0,
    resolving: false,
    nextAt: 0,
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
  const match = s.room.matches[s.m];
  if (s.over) { renderRematch(s, match); return; }
  // While resolving, or after the deciding shot (finishTimer shows the end
  // screen), there is nothing to schedule; leave the timers alone.
  if (s.resolving || s.match.status === "finished") return;
  clearTimeout(s.timer);

  const wait = s.nextAt - serverNow();
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
  } catch {
    if (session === s && s.resolved < r) el.matchStatus.textContent = "Trop tard !";
    return;
  }
  if (session === s && s.shownTurn === r && s.resolved < r) {
    el.matchStatus.textContent = "En attente de l'adversaire…";
  }
  // The lock only lets the round end early; the choice already counts.
  await set(ref(db, roomPath(s, `/locks/${s.m}/${r}/${s.slot}`)), serverTimestamp()).catch(() => {});
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
  s.nextAt = nextRoundAt(s, r);
  const result = s.match.lastResult;
  renderScores(result.scores);
  el.matchStatus.textContent = result.timedOut === s.slot ? "Trop lent !" : "";
  playShot(result);
  if (s.match.status === "finished") {
    saveResult(s);
    s.finishTimer = setTimeout(() => finishMatch(s), Math.max(RESULT_PAUSE_MS, s.nextAt - serverNow()));
  } else {
    step(s);
  }
}

// When the next round may start, in server time. Both players compute the
// same value, and the database rules refuse an earlier start.
function nextRoundAt(s, r) {
  const round = s.room.matches[s.m].rounds[r];
  const locks = (s.room.locks && s.room.locks[s.m] && s.room.locks[s.m][r]) || {};
  if (typeof locks.a === "number" && typeof locks.b === "number") {
    return Math.max(locks.a, locks.b) + RESULT_PAUSE_MS + START_MARGIN_MS;
  }
  return round.startedAt + GRACE_MS + RESULT_PAUSE_MS + START_MARGIN_MS;
}

// Stores the match once in the scoreboard. Both players try; the first write
// wins. A forfeit is written by the player who stayed.
function saveResult(s, { winner = s.match.winner, forfeit = false } = {}) {
  const { scores } = s.match;
  const record = {
    code: s.code,
    m: s.m,
    uids: { a: s.room.players.a, b: s.room.players.b },
    a: { name: s.room.names.a, goals: scores.a },
    b: { name: s.room.names.b, goals: scores.b },
    winner,
    at: serverTimestamp(),
  };
  if (forfeit) record.forfeit = true;
  return set(ref(db, `results/${s.code}/${s.m}`), record).catch(() => {});
}

function forfeit() {
  const s = session;
  if (!s || !s.m || s.over) return;
  if (!confirm("Abandonner ? Le match comptera comme une défaite.")) return;
  goHome("Tu as abandonné : défaite par forfait.");
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

el.btnSearch.addEventListener("click", () => startSearch());
el.btnSearchCancel.addEventListener("click", () => goHome());
el.btnForfeit.addEventListener("click", forfeit);
el.btnCreate.addEventListener("click", createRoom);
el.btnJoin.addEventListener("click", joinRoom);
el.btnCancel.addEventListener("click", () => goHome());
for (const btn of el.controls.querySelectorAll(".btn-zone")) {
  btn.addEventListener("click", () => choose(btn.dataset.zone));
}
el.btnRematch.addEventListener("click", askRematch);
el.btnHome.addEventListener("click", () => goHome());

// ---------- start ----------

if (!el.nickname.value) el.nickname.value = localStorage.getItem("pseudo") || "";
setHomeEnabled(false);

onValue(ref(db, ".info/serverTimeOffset"), (snap) => { serverOffset = snap.val() || 0; });

let wasConnected = false;
onValue(ref(db, ".info/connected"), (snap) => {
  if (snap.val() === true) {
    wasConnected = true;
  } else if (wasConnected && (session || search)) {
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
