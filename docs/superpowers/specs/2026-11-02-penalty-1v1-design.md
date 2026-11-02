# Penalty 1v1 — Design

## Intent & why

A local-network penalty shootout game played 1v1 in the browser. Each player
is on their own device. One player hosts a Node server on their PC and
port-forwards it so an outside opponent can connect by opening a URL. Nothing
to install on the opponent's side. The goal is a fun, satisfying,
back-and-forth penalty duel between two people, with an animated visual, in
the spirit of games like Penalty Mentality but with an entirely original look
(no assets or layout copied from any existing game).

## Goals

- Two players, each on their own device, connected to one Node server over the
  local network (or via port forwarding).
- Room system: a player creates a room and gets a short code to share; the
  other enters the code (plus a nickname) to join. Multiple rooms can coexist,
  each room is one 1v1 match.
- Penalty mechanics: on each turn one player is the **shooter**, the other is
  the **goalkeeper**. Both choose secretly among **left / center / right**.
  Same zone chosen → **save**. Different zones → **goal**.
- Roles alternate every shot (turn 1: A shoots, B keeps; turn 2: B shoots,
  A keeps; etc.).
- Official UEFA shootout rules: 5 shots each in alternation, early finish as
  soon as the result is mathematically decided, sudden death on a tie after 5.
- Animated visual rendering: a pitch, a goal, the ball travelling to the
  chosen zone, the keeper diving, and a clear GOAL / SAVE result.

## Non-goals

- No single-screen / hot-seat mode (each player has their own device).
- No accounts, persistence, matchmaking service, or leaderboards.
- No AI opponent.
- No spectators.
- No mobile-app packaging; it's a web page.

## Anti-goals (would make it a failure even if it "works")

- Copying the visual design, assets, or character art of any existing penalty
  game. The look must be original.
- Letting a player see the opponent's choice before locking in their own
  (choices are secret and simultaneous per turn).
- A match that can desync between the two clients (the server is the single
  source of truth for match state and results).

## Constraints

- Server: Node.js with the `ws` library for WebSockets. Node's built-in `http`
  module serves the static client files; no web framework.
- Client: vanilla HTML/CSS/JS, no front-end framework. Canvas or DOM/CSS for
  the animation (implementer's choice; CSS-transform animation is fine).
- The server is authoritative: it validates turns, decides goal/save, tracks
  the score, and tells both clients what to animate. Clients never decide the
  outcome.
- Room codes are short, human-readable (e.g. 4 uppercase letters/digits),
  unique among active rooms.
- A room holds exactly two players. A third attempt to join a full room is
  rejected with a clear message.

## Match rules (UEFA shootout)

- A "round" is one shot by one shooter against the other player as keeper.
  Rounds alternate the shooter.
- Best-of-5 per player: each player takes up to 5 shots.
- **Early finish:** after any shot, if one player's score cannot be caught by
  the other given the remaining shots, the match ends immediately.
- **Tie after 5 each:** sudden death. Each sudden-death pair is one shot per
  player (same alternation). After both have shot in a sudden-death pair, if
  the scores differ the match ends; otherwise another pair.
- Shooter picks one of {left, center, right}. Keeper picks one of
  {left, center, right}. Equal → save (no goal). Unequal → goal.
- **Shot clock:** each player has 10 seconds per round to choose a zone.
  If the shooter runs out of time, it counts as a missed shot (no goal).
  If the keeper runs out of time, it counts as a goal conceded. The
  server owns the clock and decides the timeout; the client shows a
  countdown but never decides the outcome. A player's timeout resolves
  as if they had chosen the zone that gives the opponent the result:
  shooter timeout = no goal, keeper timeout = goal.

## Flow

1. Player opens the URL, sees a home screen: "Create room" or "Join room",
   plus a nickname field.
2. Create → server makes a room, returns the code; the creator waits on a
   lobby screen showing the code to share.
3. The second player enters code + nickname → joins. When two players are
   present, the server starts the match and both clients switch to the match
   screen.
4. Each round: the server tells both clients whose turn it is and each
   player's role. The shooter chooses a zone; the keeper chooses a zone;
   choices are hidden from the opponent until both are locked. The server
   resolves the outcome and sends it to both clients, which play the same
   animation and update the shared scoreboard.
5. When the match ends (per the rules above), both clients show the final
   result and offer a rematch / return to home.
6. Disconnect handling: if a player leaves mid-match, the other is told and
   returned to home; the room is cleaned up.

## Decided "how" (my calls unless overridden)

- Tech: Node + `ws` + built-in `http`; vanilla client. (Agreed with user.)
- Each player enters a **nickname** when joining; shown during the match.
  (My call.)
- Room code format: 4 characters, uppercase A–Z and 2–9 (avoiding ambiguous
  0/O/1/I). (My call.)
- Simultaneous secret choice per turn: both shooter and keeper submit; server
  reveals only after both are in. (My call, follows the anti-goal.)
- Shot clock of 10 seconds per round, server-owned. Timeout resolves as a
  non-choice: shooter timeout = missed shot, keeper timeout = goal conceded.
  The client shows a countdown only. (My call, agreed with user.)
- Animation via CSS transforms on DOM elements (ball + keeper), which keeps
  the client simple and dependency-free. (My call; implementer may use canvas
  if cleaner.)
- Visual: original pitch/goal/ball/keeper drawn with CSS/SVG shapes, no
  external art. (My call.)

## Left to the builder

- Exact pixel layout, colors, and easing of the animation.
- Internal message-shape details of the WebSocket protocol, as long as the
  server stays authoritative and choices stay secret until both are in.
- How reconnection within a short grace window is handled, if at all (a clean
  "opponent left → return home" is sufficient).
