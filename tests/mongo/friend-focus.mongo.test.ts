import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import request from "supertest";
import { runId, startMongo, stopMongo } from "./harness";

let prisma: any;
let app: any;
let signToken: (payload: { sub: string; email: string }) => string;
let originalFetch: typeof fetch;
let failMemberCreate = false;
let sequence = 0;
type Gate = { roomId: string; code: string; arrivals: number; released: Promise<void>; release: () => void };
let gate: Gate | null = null;

before(async () => {
  const uri = await startMongo();
  assert.match(uri, /^mongodb:\/\/127\.0\.0\.1:/, "only the disposable local replica set is allowed");
  process.env.AUTH_RATE_LIMIT_DISABLED = "true";
  process.env.DEVICE_BINDING_ENFORCED = "false";
  process.env.RESEND_API_KEY = "";
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("External calls are forbidden in room tests"); }) as typeof fetch;
  const [p, a, jwt] = await Promise.all([import("../../src/lib/prisma"), import("../../src/app"), import("../../src/lib/jwt")]);
  prisma = p.prisma;
  app = a.createApp();
  signToken = jwt.signToken;
  prisma.$use(async (params: any, next: any) => {
    if (failMemberCreate && params.model === "FriendFocusMember" && params.action === "create") {
      throw new Error("Injected member write failure");
    }
    const result = await next(params);
    const current = gate;
    if (current && params.model === "FriendFocusRoom" && params.action === "findUnique" &&
        (params.args.where.id === current.roomId || params.args.where.inviteCode === current.code) && current.arrivals < 2) {
      current.arrivals++;
      if (current.arrivals === 2) current.release();
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Two concurrent room reads did not arrive")), 4_000);
        current.released.then(() => { clearTimeout(timer); resolve(); }, reject);
      });
    }
    return result;
  });
});

after(async () => {
  if (originalFetch) globalThis.fetch = originalFetch;
  await prisma?.$disconnect();
  await stopMongo();
});

async function account() {
  const user = await prisma.user.create({ data: { email: `${runId}-room-${++sequence}@example.test` } });
  return { user, auth: { authorization: `Bearer ${signToken({ sub: user.id, email: user.email })}` } };
}

async function waitingRoom(count: number, hardLock = true) {
  const accounts = await Promise.all(Array.from({ length: count }, account));
  const created = await request(app).post("/api/friend-focus/rooms").set(accounts[0].auth).send({
    name: "Concurrency test", displayName: "Host", durationMinutes: 50, hardLock,
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const room = created.body.room;
  for (const entry of accounts.slice(1)) {
    const joined = await request(app).post("/api/friend-focus/join").set(entry.auth).send({ code: room.inviteCode, acceptedHardLock: hardLock });
    assert.equal(joined.status, 200, JSON.stringify(joined.body));
  }
  await prisma.friendFocusMember.updateMany({ where: { roomId: room.id }, data: { ready: true } });
  return { room, accounts };
}

async function race(room: { id: string; inviteCode: string }, operations: (() => PromiseLike<any>)[]) {
  let release!: () => void;
  const current = { roomId: room.id, code: room.inviteCode, arrivals: 0, released: new Promise<void>((resolve) => { release = resolve; }), release: () => release() };
  gate = current;
  try {
    const results = await Promise.all(operations.map((operation) => operation()));
    assert.equal(current.arrivals, 2, "the competing transactions must read stale snapshots before either proceeds");
    return results;
  } finally { gate = null; current.release(); }
}

const stored = (id: string) => prisma.friendFocusRoom.findUnique({ where: { id }, include: { members: true } });
const start = (room: any, entry: any) => request(app).post(`/api/friend-focus/rooms/${room.id}/start`).set(entry.auth);
const join = (room: any, entry: any) => request(app).post("/api/friend-focus/join").set(entry.auth).send({ code: room.inviteCode, acceptedHardLock: room.hardLock });

test("two stale joins cannot grow a three-member room past four", async () => {
  const { room } = await waitingRoom(3);
  const guests = await Promise.all([account(), account()]);
  const results = await race(room, guests.map((guest) => () => join(room, guest)));
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  assert.equal((await stored(room.id)).members.length, 4);
});

test("two simultaneous joins by the same user are idempotent", async () => {
  const { room } = await waitingRoom(1);
  const guest = await account();
  const results = await race(room, [() => join(room, guest), () => join(room, guest)]);
  assert.deepEqual(results.map((r) => r.status), [200, 200]);
  assert.equal((await stored(room.id)).members.length, 2);
  assert.equal(results[0].body.room.me.attemptToken, results[1].body.room.me.attemptToken);
});

test("a simultaneous ready withdrawal and start have one consistent outcome", async () => {
  const { room, accounts } = await waitingRoom(2);
  const results = await race(room, [() => start(room, accounts[0]), () =>
    request(app).post(`/api/friend-focus/rooms/${room.id}/ready`).set(accounts[1].auth).send({ ready: false })]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  const current = await stored(room.id);
  if (current.status === "active") assert.ok(current.members.every((m: any) => m.ready));
  else { assert.equal(current.status, "waiting"); assert.equal(current.members.find((m: any) => m.userId === accounts[1].user.id).ready, false); }
});

test("a simultaneous Hard Lock start and departure cannot remove an active member", async () => {
  const { room, accounts } = await waitingRoom(2);
  const results = await race(room, [() => start(room, accounts[0]), () =>
    request(app).post(`/api/friend-focus/rooms/${room.id}/leave`).set(accounts[1].auth)]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  const current = await stored(room.id);
  if (current.status === "active") assert.equal(current.members.length, 2);
  else { assert.equal(current.status, "waiting"); assert.equal(current.members.length, 1); }
});

test("a simultaneous join and start cannot start with an unready late participant", async () => {
  const { room, accounts } = await waitingRoom(2);
  const guest = await account();
  const results = await race(room, [() => start(room, accounts[0]), () => join(room, guest)]);
  const current = await stored(room.id);
  if (current.status === "active") {
    assert.deepEqual(results.map((r) => r.status), [200, 404]);
    assert.equal(current.members.length, 2);
  } else {
    assert.deepEqual(results.map((r) => r.status), [409, 200]);
    assert.equal(current.status, "waiting");
    assert.equal(current.members.length, 3);
    assert.equal(current.members.find((m: any) => m.userId === guest.user.id).ready, false);
  }
});

test("simultaneous starts retain one exact shared clock", async () => {
  const { room, accounts } = await waitingRoom(2);
  const results = await race(room, [() => start(room, accounts[0]), () => start(room, accounts[0])]);
  assert.deepEqual(results.map((r) => r.status), [200, 200]);
  assert.equal(results[0].body.room.startsAt, results[1].body.room.startsAt);
  assert.equal(results[0].body.room.endsAt, results[1].body.room.endsAt);
  const current = await stored(room.id);
  assert.equal(current.endsAt.getTime() - current.startsAt.getTime(), 50 * 60_000);
});

test("expired waiting rooms reject transitions and expose ended to existing clients", async () => {
  const { room, accounts } = await waitingRoom(2);
  await prisma.friendFocusRoom.update({ where: { id: room.id }, data: { expiresAt: new Date(Date.now() - 1_000) } });
  const guest = await account();
  const responses = await Promise.all([start(room, accounts[0]), join(room, guest),
    request(app).post(`/api/friend-focus/rooms/${room.id}/ready`).set(accounts[1].auth).send({ ready: false }),
    request(app).get(`/api/friend-focus/rooms/${room.id}`).set(accounts[0].auth),
    request(app).get(`/api/friend-focus/invitations/${room.inviteCode}`).set(guest.auth)]);
  assert.deepEqual(responses.map((r) => r.status), [409, 404, 409, 200, 404]);
  assert.equal(responses[3].body.room.status, "ended");
  const leave = await request(app).post(`/api/friend-focus/rooms/${room.id}/leave`).set(accounts[0].auth);
  assert.equal(leave.status, 200);
  assert.equal((await stored(room.id)).status, "ended");
});

test("a failed member write rolls back the parent-room lock and membership", async () => {
  const { room } = await waitingRoom(1);
  const guest = await account();
  const before = await stored(room.id);
  failMemberCreate = true;
  let response: any;
  try { response = await join(room, guest); } finally { failMemberCreate = false; }
  assert.equal(response.status, 500);
  const after = await stored(room.id);
  assert.equal(after.updatedAt.getTime(), before.updatedAt.getTime());
  assert.equal(after.members.length, 1);
});
