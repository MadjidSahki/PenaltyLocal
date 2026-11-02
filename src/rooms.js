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
    return { code, room };
  }

  function joinRoom(code, player) {
    const room = rooms.get(code);
    if (!room) {
      return { ok: false, reason: "Room not found" };
    }
    if (room.players.b !== null) {
      return { ok: false, reason: "Room is full" };
    }
    room.players.b = player;
    room.status = "ready";
    return { ok: true, room, slot: "b" };
  }

  function getRoom(code) {
    return rooms.get(code);
  }

  function removeRoom(code) {
    rooms.delete(code);
  }

  function roomOfPlayer(playerId) {
    for (const room of rooms.values()) {
      if (
        (room.players.a && room.players.a.id === playerId) ||
        (room.players.b && room.players.b.id === playerId)
      ) {
        return room;
      }
    }
    return undefined;
  }

  return { createRoom, joinRoom, getRoom, removeRoom, roomOfPlayer };
}

module.exports = { createRoomManager };
