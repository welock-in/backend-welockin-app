import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import request from "supertest";
import { runId, startMongo, stopMongo } from "./harness";

let prisma: any;
let app: any;
let signToken: (payload: { sub: string; email: string }) => string;
let originalFetch: typeof fetch;
let failMemberCreate = false;
let failPushClaim = false;
let failAttemptCooldownWrite = false;
let failDeliveryAuditWrite = false;
let afterPushClaim: (() => Promise<void>) | null = null;
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
    if (failAttemptCooldownWrite && params.model === "FriendFocusMember" && params.action === "update" && params.args.data.lastAttemptAt) {
      throw new Error("Injected attempt cooldown failure");
    }
    if (failDeliveryAuditWrite && params.model === "NotificationDelivery" && params.action === "createMany") {
      throw new Error("Injected delivery audit failure after Expo acceptance");
    }
    if (failPushClaim && params.model === "FriendFocusEvent" && params.action === "updateMany" && params.args.data.pushClaimedAt) {
      throw new Error("Injected pre-dispatch claim failure");
    }
    const result = await next(params);
    if (afterPushClaim && params.model === "FriendFocusEvent" && params.action === "updateMany" && params.args.data.pushClaimedAt) {
      const hook = afterPushClaim;
      afterPushClaim = null;
      await hook();
    }
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
const attempt = (room: any, entry: any, eventId: string, kind = "app") =>
  request(app).post(`/api/friend-focus/rooms/${room.id}/attempts`).set(entry.auth).send({ kind, eventId });
const events = (room: any, entry: any, after?: string) =>
  request(app).get(`/api/friend-focus/rooms/${room.id}/events`).set(entry.auth).query(after ? { after } : {});

async function activeRoom(count = 2, hardLock = true) {
  const result = await waitingRoom(count, hardLock);
  assert.equal((await start(result.room, result.accounts[0])).status, 200);
  return result;
}

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

test("attempts persist without push tokens and expose only generic peer events", async () => {
  const { room, accounts } = await activeRoom();
  const [actor, peer] = accounts;
  await prisma.friendFocusMember.update({ where: { roomId_userId: { roomId: room.id, userId: actor.user.id } }, data: { displayName: "Alice\n\u202eBob" } });
  const actorCursor = (await events(room, actor)).body.nextCursor;
  const bootstrap = await events(room, peer);
  assert.deepEqual(bootstrap.body.events, []);
  assert.equal(bootstrap.body.hasMore, false);
  assert.match(bootstrap.body.nextCursor, /^[A-Za-z0-9_-]{1,256}$/);
  const response = await attempt(room, actor, "generic-website", "website");
  assert.deepEqual(response.body, { accepted: true, notified: 0 });
  const page = await events(room, peer, bootstrap.body.nextCursor);
  assert.equal(page.body.events.length, 1);
  assert.deepEqual(Object.keys(page.body.events[0]).sort(), ["actorDisplayName", "createdAt", "id", "kind"]);
  assert.equal(page.body.events[0].kind, "website");
  assert.equal(page.body.events[0].actorDisplayName, "Alice Bob", "legacy names cannot poison a whole desktop page with control characters");
  assert.match(page.body.events[0].id, /^[a-f0-9]{24}$/);
  assert.ok(Number.isFinite(Date.parse(page.body.events[0].createdAt)));
  assert.deepEqual((await events(room, actor, actorCursor)).body.events, []);
  assert.deepEqual((await events(room, peer, page.body.nextCursor)).body.events, []);
  assert.deepEqual((await events(room, peer)).body.events, [], "a fresh attach never replays history");
});

test("attempt and event routes require the current member; legacy capability still works without JWT", async () => {
  const { room, accounts } = await activeRoom();
  const outsider = await account();
  assert.equal((await request(app).get(`/api/friend-focus/rooms/${room.id}/events`)).status, 401);
  assert.equal((await request(app).post(`/api/friend-focus/rooms/${room.id}/attempts`).send({ kind: "app", eventId: "no-auth" })).status, 401);
  assert.equal((await events(room, outsider)).status, 404);
  assert.equal((await attempt(room, outsider, "outsider")).status, 404);
  assert.equal((await attempt(room, accounts[0], "bad-kind", "domain")).status, 400);
  assert.equal((await attempt(room, accounts[0], "private/url")).status, 400);
  const current = await stored(room.id);
  const token = current.members.find((m: any) => m.userId === accounts[0].user.id).attemptToken;
  const legacy = await request(app).post(`/api/friend-focus/rooms/${room.id}/blocked-attempt`).send({ attemptToken: token });
  assert.equal(legacy.status, 202);
  assert.deepEqual(legacy.body, { accepted: true, notified: 0 });
  assert.equal(await prisma.friendFocusEvent.count({ where: { roomId: room.id, sequence: { not: null } } }), 1);
  const invalid = await request(app).post(`/api/friend-focus/rooms/${room.id}/blocked-attempt`).send({ attemptToken: "invalid-capability-with-enough-entropy" });
  assert.equal(invalid.status, 404);
});

test("a shared rolling cooldown and durable request keys survive cross-platform retries", async () => {
  const { room, accounts } = await activeRoom();
  const actor = accounts[0];
  assert.equal((await attempt(room, actor, "first")).body.accepted, true);
  assert.equal((await attempt(room, actor, "suppressed", "website")).body.accepted, false);
  const current = await stored(room.id);
  const member = current.members.find((m: any) => m.userId === actor.user.id);
  const legacy = await request(app).post(`/api/friend-focus/rooms/${room.id}/blocked-attempt`).send({ attemptToken: member.attemptToken });
  assert.equal(legacy.body.accepted, false, "iOS and Windows share the same cooldown");
  await prisma.friendFocusMember.update({ where: { id: member.id }, data: { lastAttemptAt: new Date(Date.now() - 61_000) } });
  assert.equal((await attempt(room, actor, "suppressed")).body.accepted, false, "retry cannot turn an earlier suppression into a new event");
  assert.equal((await attempt(room, actor, "first", "website")).body.accepted, true);
  assert.equal((await attempt(room, actor, "next")).body.accepted, true);
  const published = await prisma.friendFocusEvent.findMany({ where: { roomId: room.id, sequence: { not: null } }, orderBy: { sequence: "asc" } });
  assert.deepEqual(published.map((e: any) => e.sequence), [1, 2]);
  assert.equal(published[0].kind, "app", "retry cannot change the original kind");
});

test("concurrent duplicate requests allocate exactly one event and one push", async () => {
  const { room, accounts } = await activeRoom();
  await prisma.pushToken.create({ data: { userId: accounts[1].user.id, token: `ExponentPushToken[${room.id}]` } });
  const savedFetch = globalThis.fetch;
  let sends = 0;
  globalThis.fetch = (async () => {
    sends++;
    return new Response(JSON.stringify({ data: [{ status: "ok", id: "concurrent-ticket" }] }), { status: 200 });
  }) as typeof fetch;
  try {
    const results = await race(room, [() => attempt(room, accounts[0], "same"), () => attempt(room, accounts[0], "same")]);
    assert.deepEqual(results.map((r) => r.status), [202, 202]);
    assert.equal(await prisma.friendFocusEvent.count({ where: { roomId: room.id } }), 1);
    assert.equal((await stored(room.id)).eventSequence, 1);
    assert.equal(sends, 1);
  } finally { globalThis.fetch = savedFetch; }
});

test("concurrent different requests from one actor cannot both bypass cooldown", async () => {
  const { room, accounts } = await activeRoom();
  const results = await race(room, [() => attempt(room, accounts[0], "one"), () => attempt(room, accounts[0], "two")]);
  assert.deepEqual(results.map((r) => r.status), [202, 202]);
  assert.deepEqual(results.map((r) => r.body.accepted).sort(), [false, true]);
  assert.equal((await stored(room.id)).eventSequence, 1);
});

test("a report racing bootstrap commits strictly after its captured cursor", async () => {
  const { room, accounts } = await activeRoom();
  const [bootstrap, reported] = await race(room, [() => events(room, accounts[1]), () => attempt(room, accounts[0], "bootstrap-race")]);
  assert.equal(bootstrap.status, 200);
  assert.equal(reported.status, 202);
  assert.equal((await events(room, accounts[1], bootstrap.body.nextCursor)).body.events.length, 1);
});

test("sequence pagination handles equal timestamps and rejects malformed or foreign cursors", async () => {
  const { room, accounts } = await activeRoom();
  const cursor = (await events(room, accounts[1])).body.nextCursor;
  const createdAt = new Date();
  await prisma.friendFocusEvent.createMany({ data: Array.from({ length: 101 }, (_, i) => ({
    requestKey: `${room.id}-fixture-${i}`, roomId: room.id, actorUserId: accounts[0].user.id,
    actorDisplayName: "Host", kind: "app", sequence: i + 1, createdAt,
    expiresAt: new Date(Date.now() + 60_000),
  })) });
  await prisma.friendFocusRoom.update({ where: { id: room.id }, data: { eventSequence: 101 } });
  const first = await events(room, accounts[1], cursor);
  assert.equal(first.body.events.length, 100);
  assert.equal(first.body.hasMore, true);
  const second = await events(room, accounts[1], first.body.nextCursor);
  assert.equal(second.body.events.length, 1);
  assert.equal(second.body.hasMore, false);
  assert.equal(new Set([...first.body.events, ...second.body.events].map((e: any) => e.id)).size, 101);
  assert.deepEqual((await events(room, accounts[1], second.body.nextCursor)).body.events, []);
  assert.equal((await events(room, accounts[1], "not-a-cursor")).status, 400);
  const other = await activeRoom();
  assert.equal((await events(other.room, other.accounts[0], cursor)).status, 400);
  const future = Buffer.from(JSON.stringify({ v: 1, r: room.id, s: 102 })).toString("base64url");
  assert.equal((await events(room, accounts[1], future)).status, 400);
  await prisma.friendFocusMember.update({ where: { roomId_userId: { roomId: room.id, userId: accounts[1].user.id } }, data: { joinedAt: new Date(createdAt.getTime() + 1) } });
  assert.deepEqual((await events(room, accounts[1], cursor)).body.events, [], "history from before membership stays private");
});

test("waiting/ended rooms cannot report; a departed member loses reporting and reading", async () => {
  const waiting = await waitingRoom(2);
  assert.deepEqual((await attempt(waiting.room, waiting.accounts[0], "waiting")).body, { accepted: false, notified: 0 });
  const { room, accounts } = await activeRoom(2, false);
  const current = await stored(room.id);
  const token = current.members.find((m: any) => m.userId === accounts[1].user.id).attemptToken;
  assert.equal((await request(app).post(`/api/friend-focus/rooms/${room.id}/leave`).set(accounts[1].auth)).status, 200);
  assert.equal((await attempt(room, accounts[1], "after-leave")).status, 404);
  assert.equal((await events(room, accounts[1])).status, 404);
  assert.equal((await request(app).post(`/api/friend-focus/rooms/${room.id}/blocked-attempt`).send({ attemptToken: token })).status, 404);
  await prisma.friendFocusRoom.update({ where: { id: room.id }, data: { endsAt: new Date(Date.now() - 1) } });
  assert.deepEqual((await attempt(room, accounts[0], "after-end")).body, { accepted: false, notified: 0 });
  assert.equal(await prisma.friendFocusEvent.count({ where: { roomId: room.id } }), 0);
});

test("provider failure leaves the event readable and a retry does not allocate another", async () => {
  const { room, accounts } = await activeRoom();
  const cursor = (await events(room, accounts[1])).body.nextCursor;
  await prisma.pushToken.create({ data: { userId: accounts[1].user.id, token: `ExponentPushToken[${room.id}]` } });
  const savedFetch = globalThis.fetch;
  let fail = true;
  globalThis.fetch = (async (_url: any, init: any) => {
    assert.equal(await prisma.friendFocusEvent.count({ where: { roomId: room.id } }), 1, "persistence precedes Expo");
    const body = JSON.parse(init.body);
    assert.equal(body[0].expiration, Math.floor(new Date((await stored(room.id)).endsAt).getTime() / 1_000));
    if (fail) throw new Error("Simulated provider outage");
    return new Response(JSON.stringify({ data: [{ status: "ok", id: "recovered-ticket" }] }), { status: 200 });
  }) as typeof fetch;
  try {
    assert.deepEqual((await attempt(room, accounts[0], "retry")).body, { accepted: true, notified: 0 });
    assert.equal((await events(room, accounts[1], cursor)).body.events.length, 1);
    fail = false;
    assert.deepEqual((await attempt(room, accounts[0], "retry")).body, { accepted: true, notified: 1 });
    assert.equal(await prisma.friendFocusEvent.count({ where: { roomId: room.id } }), 1);
  } finally { globalThis.fetch = savedFetch; }
});

test("a failed cooldown write rolls back the event, cursor allocation and request claim", async () => {
  const { room, accounts } = await activeRoom();
  failAttemptCooldownWrite = true;
  try { assert.equal((await attempt(room, accounts[0], "rollback")).status, 500); }
  finally { failAttemptCooldownWrite = false; }
  assert.equal(await prisma.friendFocusEvent.count({ where: { roomId: room.id } }), 0);
  assert.equal((await stored(room.id)).eventSequence, null);
  assert.deepEqual((await attempt(room, accounts[0], "rollback")).body, { accepted: true, notified: 0 });
  assert.equal((await stored(room.id)).eventSequence, 1);
});

test("current room deadline and actor membership are rechecked before Expo dispatch", async () => {
  for (const changed of ["ended", "left"]) {
    const { room, accounts } = await activeRoom(2, false);
    await prisma.pushToken.create({ data: { userId: accounts[1].user.id, token: `ExponentPushToken[${room.id}]` } });
    afterPushClaim = async () => {
      if (changed === "ended") {
        await prisma.friendFocusRoom.update({ where: { id: room.id }, data: { endsAt: new Date(Date.now() - 1) } });
      } else {
        assert.equal((await request(app).post(`/api/friend-focus/rooms/${room.id}/leave`).set(accounts[0].auth)).status, 200);
      }
    };
    const savedFetch = globalThis.fetch;
    let sends = 0;
    globalThis.fetch = (async () => { sends++; throw new Error("No send may occur after leave/end"); }) as typeof fetch;
    try {
      assert.equal((await attempt(room, accounts[0], "dispatch-race")).status, 202);
      assert.equal(sends, 0);
    } finally { afterPushClaim = null; globalThis.fetch = savedFetch; }
  }
});

test("a database failure after Expo acceptance retains the claim and prevents ambiguous replay", async () => {
  const { room, accounts } = await activeRoom();
  const cursor = (await events(room, accounts[1])).body.nextCursor;
  await prisma.pushToken.create({ data: { userId: accounts[1].user.id, token: `ExponentPushToken[${room.id}]` } });
  const savedFetch = globalThis.fetch;
  let sends = 0;
  globalThis.fetch = (async () => {
    sends++;
    return new Response(JSON.stringify({ data: [{ status: "ok", id: "accepted-before-db-failure" }] }), { status: 200 });
  }) as typeof fetch;
  failDeliveryAuditWrite = true;
  try {
    assert.deepEqual((await attempt(room, accounts[0], "ambiguous")).body, { accepted: true, notified: 0 });
    failDeliveryAuditWrite = false;
    assert.deepEqual((await attempt(room, accounts[0], "ambiguous")).body, { accepted: true, notified: 0 });
    assert.equal(sends, 1);
    assert.equal((await events(room, accounts[1], cursor)).body.events.length, 1);
  } finally { failDeliveryAuditWrite = false; globalThis.fetch = savedFetch; }
});

test("deleting an actor removes their event records through the Prisma cascade", async () => {
  const { room, accounts } = await activeRoom();
  assert.equal((await attempt(room, accounts[1], "before-delete")).body.accepted, true);
  assert.equal(await prisma.friendFocusEvent.count({ where: { roomId: room.id } }), 1);
  await prisma.user.delete({ where: { id: accounts[1].user.id } });
  assert.equal(await prisma.friendFocusEvent.count({ where: { roomId: room.id } }), 0);
  assert.equal((await stored(room.id)).members.length, 1);
});


test("a push claim storage outage preserves accepted events for desktop and legacy iOS", async () => {
  for (const legacy of [false, true]) {
    const { room, accounts } = await activeRoom();
    const token = (await stored(room.id)).members.find((m: any) => m.userId === accounts[0].user.id).attemptToken;
    failPushClaim = true;
    let result;
    try {
      result = legacy
        ? await request(app).post(`/api/friend-focus/rooms/${room.id}/blocked-attempt`).send({ attemptToken: token })
        : await attempt(room, accounts[0], "claim-storage-outage");
    } finally { failPushClaim = false; }
    assert.equal(result.status, 202);
    assert.equal(result.body.accepted, true);
    assert.equal(result.body.notified, 0);
    assert.equal(await prisma.friendFocusEvent.count({ where: { roomId: room.id } }), 1);
  }
});
