const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 4;

function defaultGenerateCode() {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return code;
}

function createRoomManager({ generateCode } = {}) {
  const gen = generateCode || defaultGenerateCode;
  const rooms = new Map();
  const playerRooms = new Map(); // playerId -> room code

  function uniqueCode() {
    let code = gen();
    while (rooms.has(code)) {
      code = gen();
    }
    return code;
  }

  function createRoom(player) {
    const code = uniqueCode();
    const room = {
      code,
      players: { a: player, b: null },
      status: "waiting",
      match: null,
    };
    rooms.set(code, room);
    playerRooms.set(player.id, code);
    return { code, room };
  }

  function joinRoom(code, player) {
    const room = rooms.get(code);
    if (!room) {
      return { ok: false, reason: "Room not found" };
    }
    if (room.players.a.id === player.id) {
      return { ok: false, reason: "You are already in this room" };
    }
    if (room.players.b !== null) {
      return { ok: false, reason: "Room is full" };
    }
    room.players.b = player;
    room.status = "ready";
    playerRooms.set(player.id, code);
    return { ok: true, room, slot: "b" };
  }

  function getRoom(code) {
    return rooms.get(code);
  }

  function removeRoom(code) {
    const room = rooms.get(code);
    if (!room) return;
    for (const player of [room.players.a, room.players.b]) {
      if (player && playerRooms.get(player.id) === code) playerRooms.delete(player.id);
    }
    rooms.delete(code);
  }

  function roomOfPlayer(playerId) {
    const code = playerRooms.get(playerId);
    return code === undefined ? undefined : rooms.get(code);
  }

  // Removes the player's room; returns it with the other player (or null).
  function leave(playerId) {
    const room = roomOfPlayer(playerId);
    if (!room) return undefined;
    const { a, b } = room.players;
    const opponent = a && a.id === playerId ? b : a;
    removeRoom(room.code);
    return { room, opponent };
  }

  return { createRoom, joinRoom, getRoom, removeRoom, roomOfPlayer, leave };
}

module.exports = { createRoomManager };
