// Scene animation: crowd, shot, keeper dive, result banner and confetti.
// The scene itself is drawn as SVG in index.html.

const NS = "http://www.w3.org/2000/svg";
const $ = (id) => document.getElementById(id);

const scene = $("scene");
const banner = $("result-banner");

// The two cameras drawn in index.html. Positions are keyed by screen side,
// in the local units of each group.
const SHOOTER_VIEW = {
  ball: $("ball"), keeper: $("keeper"), shooter: $("shooter"), legKick: $("leg-kick"),
  armsDown: $("arms-down"), armsUp: $("arms-up"),
  kick: { shooter: "translate(-22px,-26px)", leg: "rotate(-28deg)" },
  ballGoal: { left: "translate(-72px,-150px) scale(.62)", center: "translate(0px,-160px) scale(.6)", right: "translate(72px,-150px) scale(.62)" },
  ballSaved: { left: "translate(-95px,-115px) scale(.62)", center: "translate(0px,-166px) scale(.6)", right: "translate(95px,-115px) scale(.62)" },
  ballRebound: { left: "translate(-128px,-54px) scale(.7)", center: "translate(0px,-69px) scale(.72)", right: "translate(128px,-54px) scale(.7)" },
  dive: { left: "translate(-46px,4px) rotate(-80deg)", center: "translate(0px,-10px)", right: "translate(46px,4px) rotate(80deg)" },
};
const KEEPER_VIEW = {
  ball: $("k-ball"), keeper: $("k-keeper"), shooter: $("k-shooter"), legKick: $("k-leg-kick"),
  armsDown: $("k-arms-down"), armsUp: $("k-arms-up"),
  kick: { shooter: "translateY(6px)", leg: "rotate(-24deg)" },
  ballGoal: { left: "translate(-112px,104px) scale(1.25)", center: "translate(0px,96px) scale(1.25)", right: "translate(112px,104px) scale(1.25)" },
  ballSaved: { left: "translate(-126px,82px) scale(1.15)", center: "translate(0px,51px) scale(1.1)", right: "translate(126px,82px) scale(1.15)" },
  ballRebound: { left: "translate(-150px,30px) scale(1.2)", center: "translate(30px,-40px) scale(.8)", right: "translate(150px,30px) scale(1.2)" },
  dive: { left: "translate(-62px,2px) rotate(-78deg)", center: "translate(0px,-8px)", right: "translate(62px,2px) rotate(78deg)" },
};

// Zones are named as the shooter sees the goal; the keeper's camera looks
// the other way, so left and right swap on screen.
const MIRROR = { left: "right", center: "center", right: "left" };

// ---------- crowd ----------

function buildCrowd(crowd) {
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  const add = (tag, attrs, parent) => {
    const node = document.createElementNS(NS, tag);
    for (const key in attrs) node.setAttribute(key, attrs[key]);
    parent.appendChild(node);
    return node;
  };
  const animate = (node, min, spread) => {
    node.style.setProperty("--d", (min + rnd() * spread).toFixed(2) + "s");
    node.style.setProperty("--delay", (-rnd()).toFixed(2) + "s");
  };

  const skins = ["#f1c7a1", "#e2a97e", "#c98b5f", "#8d5a3b", "#5d3a24"];
  const shirts = ["#1565c0", "#1565c0", "#ffffff", "#1e88e5", "#e53935", "#ffd54f", "#0d47a1", "#ffffff"];
  for (let row = 0; row < 3; row++) {
    const y = 13 + row * 12;
    for (let x = 5 + (row % 2) * 5; x < 360; x += 10) {
      const fan = add("g", { class: "fan" }, crowd);
      animate(fan, 0.6, 0.7);
      add("rect", { x: x - 4, y: y + 1, width: 8, height: 8, rx: 3, fill: pick(shirts) }, fan);
      add("circle", { cx: x, cy: y - 1.5, r: 3.1, fill: pick(skins) }, fan);
    }
  }

  const flagColors = [["#1565c0", "#fff"], ["#e53935", "#fff"], ["#ffd54f", "#1565c0"], ["#fff", "#1565c0"]];
  for (const x of [26, 74, 118, 196, 246, 300, 340]) {
    const [main, stripe] = pick(flagColors);
    const flag = add("g", { class: "flag" }, crowd);
    animate(flag, 1, 0.8);
    add("rect", { x, y: 2, width: 1.4, height: 24, fill: "#cfd8dc" }, flag);
    add("path", { d: `M${x + 1.4} 2 h17 l-3 5 l3 5 h-17 Z`, fill: main }, flag);
    add("rect", { x: x + 1.4, y: 5.5, width: 15.5, height: 3, fill: stripe }, flag);
  }

  for (const [x, width, text] of [[136, 70, "ALLEZ !"], [262, 64, "ON Y CROIT"]]) {
    const holder = add("g", { class: "banner" }, crowd);
    add("rect", { x, y: 31, width, height: 11, rx: 1.5, fill: "#fff" }, holder);
    add("rect", { x, y: 31, width, height: 2, fill: "#1565c0" }, holder);
    add("rect", { x, y: 40, width, height: 2, fill: "#1565c0" }, holder);
    const label = add("text", {
      x: x + width / 2, y: 39.6, "text-anchor": "middle", "font-size": 6.5,
      "font-weight": 900, "font-family": "system-ui", fill: "#0d47a1",
    }, holder);
    label.textContent = text;
  }
}

// ---------- confetti ----------

const CONFETTI_COLORS = ["#ffd54f", "#e53935", "#1e88e5", "#ffffff", "#43a047", "#ff7043", "#ab47bc"];

function throwConfetti() {
  const fall = scene.clientHeight + 30 + "px";
  for (let i = 0; i < 90; i++) {
    const piece = document.createElement("div");
    piece.className = Math.random() < 0.4 ? "confetti round" : "confetti";
    piece.style.left = (Math.random() * 100).toFixed(1) + "%";
    piece.style.background = CONFETTI_COLORS[i % CONFETTI_COLORS.length];
    piece.style.setProperty("--t", (1.6 + Math.random() * 1.2).toFixed(2) + "s");
    piece.style.setProperty("--delay", (Math.random() * 0.35).toFixed(2) + "s");
    piece.style.setProperty("--dx", ((Math.random() - 0.5) * 160).toFixed(0) + "px");
    piece.style.setProperty("--rot", ((Math.random() - 0.5) * 1440).toFixed(0) + "deg");
    piece.style.setProperty("--fall", fall);
    piece.addEventListener("animationend", () => piece.remove());
    scene.appendChild(piece);
  }
}

// ---------- shot ----------

let token = 0;
let timers = [];

export function resetScene() {
  token += 1;
  timers.forEach(clearTimeout);
  timers = [];
  scene.classList.add("no-anim");
  for (const v of [SHOOTER_VIEW, KEEPER_VIEW]) {
    for (const node of [v.ball, v.keeper, v.shooter, v.legKick]) node.style.transform = "";
    v.ball.style.transition = "";
    v.armsDown.removeAttribute("hidden");
    v.armsUp.setAttribute("hidden", "");
  }
  banner.hidden = true;
  banner.textContent = "";
  banner.className = "result-banner";
  scene.classList.remove("cheer");
  scene.querySelectorAll(".confetti").forEach((piece) => piece.remove());
  void scene.offsetWidth; // apply the reset before animations come back
  scene.classList.remove("no-anim");
}

// Plays one shot. A null zone means that player did not choose in time.
// Timers only (no requestAnimationFrame): a background tab must still reach
// the result, since browsers pause animation frames in hidden tabs.
export function playShot(result) {
  resetScene();
  const current = token;
  const later = (ms, fn) => timers.push(setTimeout(() => { if (current === token) fn(); }, ms));
  const { goal } = result;
  const keeperCam = scene.classList.contains("me-keeps");
  const v = keeperCam ? KEEPER_VIEW : SHOOTER_VIEW;
  const onScreen = (zone) => (zone === null ? null : keeperCam ? MIRROR[zone] : zone);
  const shooterZone = onScreen(result.shooterZone);
  const keeperZone = onScreen(result.keeperZone);

  return new Promise((resolve) => {
    later(30, () => {
      if (shooterZone !== null) {
        v.shooter.style.transform = v.kick.shooter;
        v.legKick.style.transform = v.kick.leg;
      }
    });
    later(150, () => {
      if (shooterZone !== null) v.ball.style.transform = goal ? v.ballGoal[shooterZone] : v.ballSaved[shooterZone];
      if (keeperZone !== null) {
        v.armsDown.setAttribute("hidden", "");
        v.armsUp.removeAttribute("hidden");
        v.keeper.style.transform = v.dive[keeperZone];
      }
      if (!goal && shooterZone !== null) {
        // the keeper pushes the ball away once it reaches the gloves
        later(470, () => {
          v.ball.style.transition = "transform 0.5s cubic-bezier(0.2, 0.7, 0.3, 1)";
          v.ball.style.transform = v.ballRebound[shooterZone];
        });
      }
    });
    later(650, () => {
      banner.hidden = false;
      if (result.timedOut) {
        banner.textContent = "TEMPS ÉCOULÉ";
        banner.classList.add("is-timeout");
      } else if (goal) {
        banner.textContent = "BUT !";
        banner.classList.add("is-goal");
      } else {
        banner.textContent = "ARRÊT !";
        banner.classList.add("is-save");
      }
      if (goal) {
        scene.classList.add("cheer");
        throwConfetti();
        later(2600, () => scene.classList.remove("cheer"));
      }
      resolve(result);
    });
  });
}

buildCrowd($("crowd"));
buildCrowd($("k-crowd"));
