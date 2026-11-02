# Penalty League — Firebase version (design)

Supersedes the networking part of `2026-11-02-penalty-1v1-design.md`. Game rules,
screens and animation stay as described there.

## Why

Playing over the LAN failed in practice: colleagues could not reach the host Mac
(wrong address, corporate network). The user chose to put the game online with
Firebase (free Spark plan), adding persistence and a scoreboard, and to deploy
from GitHub Actions.

## Goals

- Public URL: https://penaltyleague.web.app (Firebase project `penaltyleague`,
  owned by the user's personal Google account; Realtime Database in
  `europe-west1`).
- Matchmaking: "Chercher un adversaire" pairs two waiting players
  automatically, reusing the room engine.
- Same game: rooms with 4-char codes, 1v1, UEFA shootout, secret choices,
  10 s shot clock (shooter timeout = miss, keeper timeout = goal), result pause,
  mutual rematch, "opponent left" handling, animated original visuals.
- Persistence: every finished match is stored once. Leaving an unfinished
  match (button "Abandonner", closing the tab, losing the connection) is a
  forfeit: a loss for the one who left, a win for the one who stayed.
- Scoreboard on the home screen, computed from stored matches.
- Deploy on every push to `main` via GitHub Actions; tests run on PRs and pushes.

## Non-goals

- No custom server or Cloud Functions (Spark plan has none; no billing).
- No accounts, passwords or reconnection.
- Tamper-proof scoreboard (see Constraints).

## Constraints / decided

- Static client on Firebase Hosting; Firebase JS SDK 13.2.0 as ES modules, copied
  into public/vendor/firebase (imports made relative); no build step.
- Firebase Anonymous Auth with **local persistence**: the browser keeps the same
  player between visits (two tabs of one browser are the same player).
- Pseudos are reserved: `names/{lowercase}` maps a pseudo to one player and
  `profiles/{uid}` holds the player's pseudo. Renaming releases the old one.
  The scoreboard groups results by player id and shows the current pseudo.
- Realtime Database; security rules are the referee:
  - a choice is write-once, only by its player, only while
    `now <= round.startedAt + 10500` (10 s + 0.5 s network grace);
  - a player can read the opponent's choice only once both choices exist or the
    deadline (+grace) has passed, so choices stay secret and are final when read;
  - rounds are write-once, `startedAt` must be the server time, and round `n`
    can only be created 2 s (the result pause) after round `n-1` became final:
    2 s after both locks (locks hold the server time), or 12.5 s after its
    start. This prevents starting the opponent's clock early;
  - a new match (rematch) requires both players' rematch flags, and cannot be
    created with rematch flags inside it;
  - a result must match the room's players and pseudos; a forfeit result is
    only accepted once the loser's presence is gone;
  - a matchmaking entry can only be written by its owner; another player can
    only set its `room`, once, to a waiting room that player created.
- The score is never stored as authority: both clients replay the immutable,
  rule-checked choices with the pure `match.js` and get the same result.
- Accepted trade-off (agreed): a player who edits the page can still write a fake
  result record or set rematch flags early; this only affects the scoreboard.
- The scoreboard reads only the latest 500 results (rules: ordered by `at`,
  limited), and a normal result needs a match of at least 6 shots.
- A player can create at most one room every 3 s: the room write must come
  with `limits/{uid}/room` (server time) and `limits/{uid}/code` (that room's
  code), so one stamp allows exactly one room. Profiles cannot be deleted.
  Results can only be read as the latest 500, without start/end bounds.
- html/js/css are served with `Cache-Control: no-cache`, so players get a
  new version right after a deploy (vendor files are cached a day).
- Nightly cleanup (`.github/workflows/cleanup.yml`, `scripts/cleanup.js`, run
  with the deploy service account): removes rooms created more than 24 h ago
  (unless used in the last hour) with their choices, queue entries idle for
  10 min and room stamps older than 24 h. Profiles, pseudos and results are
  kept. Result keys include the room's creation time so that a reused code
  never collides with an old result. A player still in a removed room goes
  home with "Ce salon a expiré."
- App Check (reCAPTCHA Enterprise, score key restricted to the two site
  domains, min score 0.5) is enforced on the Realtime Database: requests
  without a valid App Check token are refused. The client skips it on the
  local emulators. The reCAPTCHA badge is hidden and replaced by the required
  notice under the scoreboard. The browser API key allows Identity Toolkit,
  Secure Token and App Check only, from the site's referrers.
- Security headers (CSP, frame-ancestors, nosniff, referrer policy) are set in
  `firebase.json`; the Firebase SDK is served from `public/vendor/firebase`.
- First shooter alternates between matches in the same room (odd match: creator,
  even match: joiner).
- Deploy uses a Google service-account key stored as the GitHub secret
  `FIREBASE_SERVICE_ACCOUNT` (deploys hosting, database rules and the Anonymous
  Auth setting).

## Cameras and kits

- You are always blue, the opponent red. The role ("TU TIRES" / "TU ES
  GARDIEN") is shown big and pops on every turn.
- When you shoot, the camera is behind the shooter; when you keep, it is
  behind the keeper, facing the shooter. Buttons follow each player's own
  screen: zones are stored as the shooter sees them, so the keeper's choice
  is mirrored (`mirrorZone` in match.js) and the keeper's animation mirrors
  the result back to screen sides.

## Data model

```
rooms/{code}
  players/{a|b}: uid          a = creator, b = joiner (write-once)
  names/{a|b}: pseudo (1–16 chars)
  createdAt: server time
  presence/{a|b}: true        removed on disconnect / leave
  matches/{m}                 m = "1", "2", ... (n: number, n+'' === key)
    n
    rounds/{r}: { n, startedAt }
    rematch/{a|b}: true
  locks/{m}/{r}/{a|b}: server time   public "I have chosen" flag
choices/{code}/{m}/{r}/{a|b}: "left" | "center" | "right"
queue/{uid}: { name, at, room? }   matchmaking: room is set by the matcher
results/{code}_{room createdAt}_{m}: { code, m, uids:{a,b}, a:{name,goals}, b:{name,goals}, winner, at, forfeit? }
profiles/{uid}: { name, key }          names/{key}: uid
limits/{uid}/room: server time of the player's last new room
rooms/{code}/for: uid                  matchmaking: seat b reserved for that player
```

## Flow

1. Create: random code, write room (retry on collision), set presence with
   onDisconnect removal, show lobby.
2. Join: refuse if room missing, creator not present, or full. Write
   `players/b` + `names/b`, presence, then create match 1 with round 1.
3. Round: both clients listen to the room. Clock shown from
   `startedAt + 10 s` using the server time offset. Choosing writes the choice,
   then the lock. The round resolves when both locks exist or the deadline
   (+grace +margin) passes; clients then read both choices (a permission error
   means "not final yet", retry). Missing choice = timeout.
4. After the 2 s result pause, if the replayed match is not finished, a client
   creates the next round (write-once: the first wins). Otherwise both show the
   end screen and try to write the result record (write-once).
5. Rematch: both flags → a client creates the next match. Leave/close: presence
   removed, opponent goes home with a notice, and stores a forfeit result if
   the match was not finished.
6. Matchmaking: a searching player writes `queue/{uid}` (removed on
   disconnect). The newer player of a pair creates a room, becomes present in
   it, then writes the room code into the older player's entry (write-once:
   if it fails, someone else matched them first). The older player joins that
   room. A creator whose matched opponent does not join within 15 s goes back
   to the queue.

## Left to the builder

Exact rule expressions, client module layout, UI layout of the scoreboard.
