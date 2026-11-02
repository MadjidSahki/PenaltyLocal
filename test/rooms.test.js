const test = require("node:test");
const assert = require("node:assert");
const { createRoomManager } = require("../src/rooms");

const codes = () => { let i = 0; const arr = ["AAAA", "BBBB"]; return () => arr[i++]; };

test("create then join fills both slots", () => {
  const rm = createRoomManager({ generateCode: codes() });
  const { code, room } = rm.createRoom({ id: "1", nickname: "P1" });
  assert.equal(code, "AAAA");
  assert.equal(room.status, "waiting");
  const j = rm.joinRoom("AAAA", { id: "2", nickname: "P2" });
  assert.equal(j.ok, true);
  assert.equal(j.slot, "b");
  assert.equal(rm.getRoom("AAAA").status, "ready");
});

test("join unknown code rejected", () => {
  const rm = createRoomManager({ generateCode: codes() });
  const j = rm.joinRoom("ZZZZ", { id: "2", nickname: "P2" });
  assert.equal(j.ok, false);
  assert.match(j.reason, /not found/i);
});

test("join full room rejected", () => {
  const rm = createRoomManager({ generateCode: codes() });
  rm.createRoom({ id: "1", nickname: "P1" });
  rm.joinRoom("AAAA", { id: "2", nickname: "P2" });
  const j = rm.joinRoom("AAAA", { id: "3", nickname: "P3" });
  assert.equal(j.ok, false);
  assert.match(j.reason, /full/i);
});

test("default code is 4 chars from safe alphabet", () => {
  const rm = createRoomManager({});
  const { code } = rm.createRoom({ id: "1", nickname: "P1" });
  assert.match(code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/);
});

test("roomOfPlayer and removeRoom", () => {
  const rm = createRoomManager({ generateCode: codes() });
  rm.createRoom({ id: "1", nickname: "P1" });
  assert.equal(rm.roomOfPlayer("1").code, "AAAA");
  rm.removeRoom("AAAA");
  assert.equal(rm.getRoom("AAAA"), undefined);
});

test("leave removes the player's room and reports the opponent", () => {
  const rm = createRoomManager({ generateCode: codes() });
  rm.createRoom({ id: "1", nickname: "P1" });
  rm.joinRoom("AAAA", { id: "2", nickname: "P2" });
  const left = rm.leave("1");
  assert.equal(left.room.code, "AAAA");
  assert.equal(left.opponent.id, "2");
  assert.equal(rm.getRoom("AAAA"), undefined);
  assert.equal(rm.roomOfPlayer("1"), undefined);
  assert.equal(rm.roomOfPlayer("2"), undefined);
});

test("leave for a player in no room returns undefined", () => {
  const rm = createRoomManager({ generateCode: codes() });
  assert.equal(rm.leave("nobody"), undefined);
});

test("after leaving, the player's next room is the one they are in", () => {
  const rm = createRoomManager({ generateCode: codes() });
  rm.createRoom({ id: "1", nickname: "P1" });
  rm.leave("1");
  rm.createRoom({ id: "1", nickname: "P1" });
  assert.equal(rm.roomOfPlayer("1").code, "BBBB");
});

test("joining your own room is rejected", () => {
  const rm = createRoomManager({ generateCode: codes() });
  rm.createRoom({ id: "1", nickname: "P1" });
  const j = rm.joinRoom("AAAA", { id: "1", nickname: "P1" });
  assert.equal(j.ok, false);
  assert.match(j.reason, /already/i);
});

test("default generateCode retries past collisions", () => {
  let i = 0;
  const seq = ["AAAA", "AAAA", "BBBB"]; // first two collide
  const rm = createRoomManager({ generateCode: () => seq[i++] });
  const first = rm.createRoom({ id: "1", nickname: "P1" });
  assert.equal(first.code, "AAAA");
  const second = rm.createRoom({ id: "2", nickname: "P2" });
  assert.equal(second.code, "BBBB"); // skipped the colliding AAAA
});
