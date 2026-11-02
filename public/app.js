(() => {
  "use strict";

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
    btnRematch: document.getElementById("btn-rematch"),
    btnHome: document.getElementById("btn-home"),
  };

  const state = { you: null, names: { a: "A", b: "B" }, role: null };
  let clockTimer = null;

  const ws = new WebSocket(`ws://${location.host}`);

  function send(obj) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  function showHomeError(reason) {
    el.homeError.textContent = reason;
    el.homeError.hidden = false;
  }

  // ----- Shot clock (cosmetic; server is authoritative) -----
  function startClock(ms) {
    stopClock();
    let remaining = Math.ceil(ms / 1000);
    el.clock.textContent = remaining;
    el.clock.classList.remove("low");
    clockTimer = setInterval(() => {
      remaining -= 1;
      el.clock.textContent = Math.max(0, remaining);
      if (remaining <= 3) el.clock.classList.add("low");
      if (remaining <= 0) {
        stopClock();
        setControlsEnabled(false);
      }
    }, 1000);
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

  // Horizontal offset (px) applied to ball/keeper for each zone, relative
  // to their centered resting position. Tuned to the goal width.
  const ZONE_X = { left: -90, center: 0, right: 90 };

  function resetScene() {
    el.ball.style.transition = "none";
    el.keeper.style.transition = "none";
    el.ball.style.transform = "translate(0, 0)";
    el.keeper.style.transform = "translate(0, 0) rotate(0deg)";
    el.resultBanner.hidden = true;
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

  // ----- Message handling -----
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    switch (msg.type) {
      case "created":
        el.lobbyCode.textContent = msg.code;
        showView("lobby");
        break;

      case "joined":
        state.you = msg.you;
        break;

      case "start":
        state.you = msg.you;
        state.names = msg.names;
        el.nameA.textContent = msg.names.a;
        el.nameB.textContent = msg.names.b;
        renderScores({ a: 0, b: 0 });
        el.matchStatus.textContent = "";
        showView("match");
        break;

      case "turn": {
        state.role = msg.role;
        const mine = msg.you === msg.shooter;
        el.roleBanner.textContent = mine
          ? "À toi de tirer — choisis une zone"
          : "Tu es gardien — choisis où plonger";
        el.resultBanner.hidden = true;
        setControlsEnabled(true);
        el.matchStatus.textContent = `Tir n°${msg.round}`;
        startClock(msg.deadlineMs);
        break;
      }

      case "waiting":
        stopClock();
        setControlsEnabled(false);
        el.matchStatus.textContent = "En attente de l'adversaire…";
        break;

      case "result": {
        stopClock();
        setControlsEnabled(false);
        renderScores(msg.scores);
        if (msg.timedOut && msg.timedOut === state.you) {
          el.matchStatus.textContent = "Trop lent !";
        }
        playShot(msg);
        break;
      }

      case "matchOver": {
        const winnerName = state.names[msg.winner];
        const iWon = msg.winner === state.you;
        el.overTitle.textContent = iWon ? "Victoire !" : `${winnerName} gagne`;
        el.overScore.textContent = `${msg.scores.a} — ${msg.scores.b}`;
        showView("over");
        break;
      }

      case "error":
        showHomeError(msg.reason);
        break;

      case "opponentLeft":
        stopClock();
        showHomeError("L'adversaire a quitté la partie.");
        showView("home");
        break;
    }
  });

  ws.addEventListener("close", () => {
    stopClock();
  });

  // ----- UI events -----
  el.btnCreate.addEventListener("click", () => {
    el.homeError.hidden = true;
    send({ type: "create", nickname: el.nickname.value.trim() || "Joueur" });
  });

  el.btnJoin.addEventListener("click", () => {
    el.homeError.hidden = true;
    const code = el.joinCode.value.trim().toUpperCase();
    if (code.length !== 4) { showHomeError("Entre un code à 4 caractères."); return; }
    send({ type: "join", code, nickname: el.nickname.value.trim() || "Joueur" });
  });

  for (const btn of el.controls.querySelectorAll(".btn-zone")) {
    btn.addEventListener("click", () => {
      if (el.controls.classList.contains("disabled")) return;
      send({ type: "choice", zone: btn.dataset.zone });
      setControlsEnabled(false);
    });
  }

  el.btnRematch.addEventListener("click", () => send({ type: "rematch" }));
  el.btnHome.addEventListener("click", () => {
    showView("home");
    el.homeError.hidden = true;
  });
})();
