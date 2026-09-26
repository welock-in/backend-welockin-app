import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import request from "supertest";
import { runId, startMongo, stopMongo } from "./harness";

let prisma: any, app: any, env: any, adminAuth: any;
let signToken: (payload: { sub: string; email: string }) => string;
let originalFetch: typeof fetch;
let sequence = 0;
let failCreateId: string | undefined;
type Gate = { model: string; action: string; key: string; arrivals: number; released: Promise<void>; release: () => void };
let gate: Gate | undefined;

before(async () => {
  const uri = await startMongo();
  assert.match(uri, /^mongodb:\/\/127\.0\.0\.1:/, "never use a non-disposable database");
  process.env.AUTH_RATE_LIMIT_DISABLED = "true";
  process.env.DEVICE_BINDING_ENFORCED = "false";
  process.env.RESEND_API_KEY = "";
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("No external calls in focus v2 tests"); }) as typeof fetch;
  const [p, a, jwt, config, adminJwt] = await Promise.all([import("../../src/lib/prisma"),
    import("../../src/app"), import("../../src/lib/jwt"), import("../../src/lib/env"), import("../../src/lib/admin-jwt")]);
  prisma = p.prisma; app = a.createApp(); signToken = jwt.signToken; env = config.env;
  adminAuth = { authorization: `Bearer ${adminJwt.signAdminToken("focus-v2-qa")}` };
  prisma.$use(async (params: any, next: any) => {
    if (failCreateId && params.model === "FocusEvent" && params.action === "create" && params.args.data.clientEventId === failCreateId) {
      failCreateId = undefined;
      throw new Error("Injected interruption between event writes");
    }
    const current = gate;
    const matches = current && params.model === current.model && params.action === current.action &&
      (params.args.data?.clientEventId === current.key || params.args.where?.id === current.key);
    // Event race must meet before insertion; room race after reading stale state.
    const result = params.action === "findUnique" ? await next(params) : undefined;
    if (matches && current.arrivals < 2) {
      current.arrivals++;
      if (current.arrivals === 2) current.release();
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Concurrent operations did not meet")), 5000);
        current.released.then(() => { clearTimeout(timer); resolve(); }, reject);
      });
    }
    return params.action === "findUnique" ? result : next(params);
  });
});

beforeEach(async () => { await prisma.focusEvent.deleteMany({}); });
after(async () => {
  if (originalFetch) globalThis.fetch = originalFetch;
  await prisma?.$disconnect();
  await stopMongo();
});

async function account(registered = true) {
  const user = await prisma.user.create({ data: { email: `${runId}-v2-${++sequence}@example.test`, emailVerified: true } });
  const deviceId = `device-${user.id}`;
  if (registered) await prisma.device.create({ data: { userId: user.id, deviceId, name: "QA", platform: "windows" } });
  return { user, deviceId, auth: { authorization: `Bearer ${signToken({ sub: user.id, email: user.email })}` } };
}

function event(account: any, changes: Record<string, unknown> = {}) {
  const end = new Date(Date.now() - 60_000);
  return { clientEventId: `session-${++sequence}`, deviceId: account.deviceId, platform: "windows", name: "Focus QA",
    startedAt: new Date(end.getTime() - 1800_000).toISOString(), endedAt: end.toISOString(),
    plannedSeconds: 1800, actualSeconds: 1500, completed: true, hardLock: false, ...changes };
}
const post = (owner: any, events: any[], route = "/api/sync/events/v2") =>
  request(app).post(route).set(owner.auth).send({ eventVersion: 2, events });

async function race(model: string, action: string, key: string, operations: (() => PromiseLike<any>)[]) {
  let release!: () => void;
  const current: Gate = { model, action, key, arrivals: 0,
    released: new Promise<void>((resolve) => { release = resolve; }), release: () => release() };
  gate = current;
  try {
    const responses = await Promise.all(operations.map((operation) => operation()));
    assert.equal(current.arrivals, 2, "force genuine competing snapshots/writes");
    return responses;
  } finally { gate = undefined; current.release(); }
}

test("both v2 routes persist measured fields and replay exact IDs without changing snapshots", async () => {
  const owner = await account();
  const snapshot = await prisma.syncSnapshot.create({ data: { userId: owner.user.id,
    blocklists: [{ local: "private" }], sessions: [{ id: "active" }], schedules: [{ id: "calendar" }], revision: 8 } });
  for (const route of ["/api/sync/events/v2", "/api/focus-events/v2"]) {
    const input = event(owner, { platform: route.includes("focus-events") ? "ios" : "windows" });
    const first = await post(owner, [input], route);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.deepEqual(first.body, { eventVersion: 2, results: [{ clientEventId: input.clientEventId, status: "stored", credited: true }] });
    const replay = await post(owner, [input], route);
    assert.deepEqual(replay.body, { eventVersion: 2, results: [{ clientEventId: input.clientEventId, status: "deduped", credited: true }] });
    const saved = await prisma.focusEvent.findFirst({ where: { userId: owner.user.id, clientEventId: input.clientEventId } });
    assert.equal(saved.eventVersion, 2); assert.equal(saved.actualSeconds, 1500);
    assert.equal(saved.endedAt.toISOString(), input.endedAt);
  }
  assert.equal(await prisma.focusEvent.count(), 2);
  assert.deepEqual(await prisma.syncSnapshot.findUnique({ where: { userId: owner.user.id } }), snapshot);
});

test("auth and mobile attestation gates remain enforced before ingestion", async () => {
  const owner = await account(); const input = event(owner);
  for (const route of ["/api/sync/events/v2", "/api/focus-events/v2"]) {
    assert.equal((await request(app).post(route).send({ eventVersion: 2, events: [input] })).status, 401);
  }
  const previous = env.attestRequired; env.attestRequired = true;
  try {
    assert.equal((await post(owner, [input], "/api/focus-events/v2")).status, 501);
    assert.equal((await post(owner, [input])).status, 200);
  } finally { env.attestRequired = previous; }
  assert.equal(await prisma.focusEvent.count(), 1);
});

test("an invalid batch writes nothing, duplicate IDs and snapshot/user fields are rejected", async () => {
  const owner = await account(); const first = event(owner);
  const invalids = [[first, event(owner, { actualSeconds: 1801 })], [first, first], [],
    [event(owner, { userId: "507f1f77bcf86cd799439011" })],
    [event(owner, { deviceId: undefined })], [event(owner, { killedTotal: 2147483648 })],
    [event(owner, { endedAt: "not-a-date" })],
    Array.from({ length: 51 }, () => event(owner))];
  for (const invalid of invalids) assert.equal((await post(owner, invalid)).status, 400);
  const snapshot = await request(app).post("/api/sync/events/v2").set(owner.auth)
    .send({ eventVersion: 2, events: [first], blocklists: [], sessions: [] });
  assert.equal(snapshot.status, 400);
  assert.equal(await prisma.focusEvent.count(), 0);
  assert.equal(await prisma.syncSnapshot.count({ where: { userId: owner.user.id } }), 0);
});

test("50 events are accepted and the same client ID belongs independently to each account", async () => {
  const [a, b] = await Promise.all([account(), account()]);
  const events = Array.from({ length: 50 }, () => event(a));
  assert.equal((await post(a, events)).body.results.length, 50);
  const sameId = { ...events[0], deviceId: b.deviceId };
  assert.equal((await post(b, [sameId])).body.results[0].status, "stored");
  assert.equal(await prisma.focusEvent.count(), 51);
});

test("concurrent identical requests yield one insert and one explicit deduplication", async () => {
  const owner = await account(); const input = event(owner);
  const responses = await race("FocusEvent", "create", input.clientEventId, [() => post(owner, [input]), () => post(owner, [input])]);
  assert.deepEqual(responses.map((r) => r.status), [200, 200]);
  assert.deepEqual(responses.map((r) => r.body.results[0].status).sort(), ["deduped", "stored"]);
  assert.equal(await prisma.focusEvent.count(), 1);
});

test("concurrent conflicting requests never acknowledge both payloads or overwrite the winner", async () => {
  const owner = await account(); const input = event(owner);
  const responses = await race("FocusEvent", "create", input.clientEventId,
    [() => post(owner, [input]), () => post(owner, [{ ...input, actualSeconds: 1400 }])]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
  const conflict = responses.find((r) => r.status === 409)!;
  assert.equal(conflict.body.code, "FOCUS_EVENT_CONFLICT");
  assert.equal(conflict.body.clientEventId, input.clientEventId);
  assert.equal(conflict.body.results, undefined);
  assert.equal(await prisma.focusEvent.count(), 1);
});

test("all immutable content is checked before writing other entries in a replay batch", async () => {
  const owner = await account(); const input = event(owner);
  assert.equal((await post(owner, [input])).status, 200);
  for (const change of [{ actualSeconds: 1400 }, { name: "Changed" }, { platform: "macos" },
    { deviceId: "other-device" }, { plannedSeconds: 2000 }, { completed: false }, { hardLock: true },
    { killedTotal: 1 }, { emergencyUsed: true }, { startedAt: new Date(new Date(input.startedAt).getTime() - 1000).toISOString() },
    { endedAt: new Date(new Date(input.endedAt).getTime() + 1000).toISOString() }]) {
    const response = await post(owner, [event(owner), { ...input, ...change }]);
    assert.equal(response.status, 409, JSON.stringify(change));
    assert.equal(response.body.clientEventId, input.clientEventId);
  }
  assert.equal(await prisma.focusEvent.count(), 1);
});

test("legacy ingestion remains usable and a v1 copy cannot masquerade as a v2 acknowledgement", async () => {
  const owner = await account(); const input = event(owner);
  const { actualSeconds, ...legacy } = input;
  assert.equal((await request(app).post("/api/focus-events").set(owner.auth).send(legacy)).status, 201);
  assert.equal((await post(owner, [input])).status, 409);
  const second = event(owner); const { actualSeconds: ignored, ...oldDesktop } = second;
  assert.equal((await request(app).post("/api/sync/push").set(owner.auth).send({ events: [oldDesktop] })).status, 200);
  const modern = event(owner); assert.equal((await post(owner, [modern])).status, 200);
  const oldRetry = await request(app).post("/api/focus-events").set(owner.auth).send({ ...modern, actualSeconds: 1 });
  assert.equal(oldRetry.status, 200); assert.equal(oldRetry.body.deduped, true);
  assert.equal(oldRetry.body.event.actualSeconds, 1500); assert.equal(oldRetry.body.event.eventVersion, 2);
  assert.equal(await prisma.focusEvent.count(), 3);
});

test("legacy random-id copies and duplicate histories are checked rather than hidden by a map", async () => {
  const owner = await account(); const input = event(owner);
  assert.equal((await post(owner, [input])).status, 200);
  const saved = await prisma.focusEvent.findFirst({ where: { userId: owner.user.id } });
  const { id, createdAt, ...copy } = saved;
  await prisma.focusEvent.create({ data: { ...copy, eventVersion: null, actualSeconds: null } });
  const response = await post(owner, [input]);
  assert.equal(response.status, 409);
  assert.equal(await prisma.focusEvent.count(), 2);
});

test("interruption after one persisted entry is recoverable without losing or double-counting either entry", async () => {
  const owner = await account(); const inputs = [event(owner), event(owner)];
  failCreateId = inputs[1].clientEventId;
  const failed = await post(owner, inputs);
  assert.equal(failed.status, 500); assert.equal(failed.body.results, undefined);
  assert.equal(await prisma.focusEvent.count(), 1);
  const resumed = await post(owner, inputs);
  assert.equal(resumed.status, 200);
  assert.deepEqual(resumed.body.results.map((r: any) => r.status), ["deduped", "stored"]);
  assert.equal(await prisma.focusEvent.count(), 2);
});

test("unknown or foreign devices are terminally quarantined, including after later registration", async () => {
  const owner = await account(false); const other = await account();
  const inputs = [event(owner), event(owner, { deviceId: other.deviceId })];
  assert.ok((await post(owner, inputs)).body.results.every((r: any) => r.credited === false));
  await prisma.device.create({ data: { userId: owner.user.id, deviceId: owner.deviceId, name: "Late", platform: "windows" } });
  const replay = await post(owner, inputs);
  assert.deepEqual(replay.body.results.map((r: any) => [r.status, r.credited]), [["deduped", false], ["deduped", false]]);
  const { computeSummary } = await import("../../src/services/analytics");
  assert.equal((await computeSummary(owner.user.id)).totalSessions, 0);
});

test("real Mongo missing/null/false/true fields share the same credit and quality in every aggregate", async () => {
  const owner = await account(); const now = new Date();
  const startedAt = new Date(now.getTime() - 3 * 3600_000);
  const rows = [
    { eventVersion: 2, actualSeconds: 1500, plannedSeconds: 1800, wall: 1800, quarantined: false },
    { eventVersion: 2, actualSeconds: 1800, plannedSeconds: 1800, wall: 2100, quarantined: null },
    { eventVersion: null, actualSeconds: null, plannedSeconds: 1500, wall: 7200, quarantined: "missing" },
    { eventVersion: null, actualSeconds: null, plannedSeconds: 600, wall: 300, quarantined: false },
    { eventVersion: null, actualSeconds: null, plannedSeconds: 0, wall: 60, quarantined: null },
    { eventVersion: 2, actualSeconds: 1800, plannedSeconds: 1800, wall: 1800, quarantined: true },
    { eventVersion: 3, actualSeconds: 1800, plannedSeconds: 1800, wall: 1800, quarantined: false },
  ];
  for (const row of rows) {
    const { wall, quarantined, ...fields } = row;
    const saved = await prisma.focusEvent.create({ data: { userId: owner.user.id, name: "Historical", startedAt,
      endedAt: new Date(startedAt.getTime() + wall * 1000), completed: true, hardLock: false, killedTotal: 2,
      ...fields, quarantined: quarantined === "missing" ? false : quarantined } });
    if (quarantined === "missing") await prisma.$runCommandRaw({ update: "FocusEvent", updates: [{
      q: { _id: { $oid: saved.id } }, u: { $unset: { quarantined: "", eventVersion: "", actualSeconds: "" } },
    }] });
  }
  const beforeRows = await prisma.focusEvent.findMany({ orderBy: { id: "asc" } });
  const [analytics, stats, impact] = await Promise.all([import("../../src/services/analytics"),
    import("../../src/services/admin-stats"), import("../../src/services/focus-duration-impact")]);
  const summary = await analytics.computeSummary(owner.user.id, now);
  const profile = await stats.computeUserStats(owner.user.id, now);
  const global = await stats.overview(now);
  const list = await stats.usersList({ search: owner.user.email }, now);
  const expectedQuality = { measuredSeconds: 3300, estimatedSeconds: 1800, measuredEvents: 2, estimatedEvents: 2, unavailableEvents: 2 };
  assert.equal(summary.focusedSecondsWeek, 5100); assert.equal(summary.totalSessions, 6);
  assert.deepEqual(summary.durationQuality, expectedQuality);
  assert.equal(profile.totalFocusSeconds, 5100); assert.equal(profile.totalSessions, 6); assert.equal(profile.totalKilled, 12);
  assert.equal(profile.focusSecondsLast7d, summary.focusedSecondsWeek);
  assert.deepEqual(profile.durationQuality, expectedQuality);
  assert.equal(global.totalFocusSeconds, 5100); assert.equal(global.totalSessions, 6);
  assert.deepEqual(global.durationQuality, expectedQuality);
  assert.equal(list.users[0].totalFocusSeconds, 5100); assert.equal(list.users[0].sessionCount, 6);
  assert.deepEqual(list.users[0].durationQuality, expectedQuality);
  const report = await impact.auditFocusDurationImpact(prisma);
  const originalQuery = await prisma.focusEvent.findMany({ where: { quarantined: { not: true } } });
  assert.equal(report.previousUserEvents, originalQuery.length);
  assert.equal(report.previousUserEvents, 5, "the old Mongo predicate includes null but excludes an absent field");
  assert.equal(report.previousUserSeconds, 6060);
  assert.equal(report.previousUserSeconds, originalQuery.reduce((sum: number, e: any) => sum + (e.endedAt - e.startedAt) / 1000, 0));
  assert.equal(report.previousAdminSeconds, 15060); assert.equal(report.correctedSeconds, 5100);
  assert.equal(report.quarantinedEvents, 1); assert.equal(report.correctedEvents, 6);
  assert.deepEqual(await prisma.focusEvent.findMany({ orderBy: { id: "asc" } }), beforeRows, "reads never rewrite history");
  const history = await request(app).get(`/api/admin/users/${owner.user.id}/events`).set(adminAuth);
  assert.equal(history.status, 200); assert.equal(history.body.total, 7);
  const quarantined = history.body.events.find((e: any) => e.quarantined === true);
  assert.equal(quarantined.credited, false); assert.equal(quarantined.creditedSeconds, 0); assert.equal(quarantined.actualSeconds, 1800);
  assert.equal(history.body.events.filter((e: any) => e.durationBasis === "estimated").length, 2);
  const profileResponse = await request(app).get(`/api/admin/users/${owner.user.id}`).set(adminAuth);
  assert.equal(profileResponse.status, 200);
  assert.deepEqual(profileResponse.body.stats.durationQuality, expectedQuality);
  assert.equal(profileResponse.body.recentEvents.find((e: any) => e.quarantined === true).creditedSeconds, 0);
});

async function waitingRoom(hardLock = true) {
  const [host, guest] = await Promise.all([account(), account()]);
  const created = await request(app).post("/api/friend-focus/rooms").set(host.auth).send({
    name: "V2 leave", durationMinutes: 50, hardLock, displayName: "Host" });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const room = created.body.room;
  const joined = await request(app).post("/api/friend-focus/join").set(guest.auth)
    .send({ code: room.inviteCode, acceptedHardLock: hardLock });
  assert.equal(joined.status, 200);
  await prisma.friendFocusMember.updateMany({ where: { roomId: room.id }, data: { ready: true } });
  return { room, host, guest, hostMemberId: room.members.find((m: any) => m.isMe).id,
    guestMemberId: joined.body.room.members.find((m: any) => m.isMe).id };
}
const leave = (room: any, owner: any, expectedMemberId: string) =>
  request(app).post(`/api/friend-focus/rooms/${room.id}/leave/v2`).set(owner.auth).send({ expectedMemberId });
const start = (room: any, host: any) => request(app).post(`/api/friend-focus/rooms/${room.id}/start`).set(host.auth);

test("v2 guest departure replays and a stale intent cannot remove a new participation", async () => {
  const { room, guest, guestMemberId } = await waitingRoom();
  assert.deepEqual((await leave(room, guest, guestMemberId)).body, { version: 2, membershipId: guestMemberId, status: "left" });
  assert.equal((await leave(room, guest, guestMemberId)).body.status, "already_left");
  const rejoined = await request(app).post("/api/friend-focus/join").set(guest.auth).send({ code: room.inviteCode, acceptedHardLock: true });
  const newMemberId = rejoined.body.room.members.find((m: any) => m.isMe).id;
  assert.equal(rejoined.status, 200); assert.notEqual(newMemberId, guestMemberId);
  assert.equal((await leave(room, guest, guestMemberId)).body.status, "superseded");
  assert.equal((await prisma.friendFocusMember.findUnique({ where: { id: newMemberId } })).userId, guest.user.id);
});

test("v2 host cancellation preserves legacy membership and its replay remains terminal", async () => {
  const { room, host, guest, hostMemberId } = await waitingRoom();
  assert.equal((await leave(room, host, hostMemberId)).body.status, "left");
  assert.equal((await leave(room, host, hostMemberId.toUpperCase())).body.status, "already_left");
  assert.equal((await prisma.friendFocusRoom.findUnique({ where: { id: room.id } })).status, "ended");
  assert.ok(await prisma.friendFocusMember.findUnique({ where: { id: hostMemberId } }));
  assert.equal((await request(app).get(`/api/friend-focus/rooms/${room.id}`).set(guest.auth)).body.room.status, "ended");
});

test("v2 absent rooms/members give a terminal ACK without removing another account's member", async () => {
  const { room, host, guest, guestMemberId } = await waitingRoom();
  const outsider = await account();
  assert.equal((await leave(room, outsider, guestMemberId)).body.status, "already_left");
  assert.equal((await leave(room, host, guestMemberId)).body.status, "superseded");
  assert.ok(await prisma.friendFocusMember.findUnique({ where: { id: guestMemberId } }));
  await prisma.friendFocusMember.deleteMany({ where: { roomId: room.id } });
  await prisma.friendFocusRoom.delete({ where: { id: room.id } });
  assert.equal((await leave(room, guest, guestMemberId)).body.status, "already_left");
  assert.equal((await leave(room, guest, "invalid")).status, 400);
});

test("v2 hard active departure is refused, expired and soft sessions can leave", async () => {
  const hard = await waitingRoom(); assert.equal((await start(hard.room, hard.host)).status, 200);
  assert.equal((await leave(hard.room, hard.guest, hard.guestMemberId)).status, 409);
  await prisma.friendFocusRoom.update({ where: { id: hard.room.id }, data: { endsAt: new Date(Date.now() - 1000) } });
  assert.equal((await leave(hard.room, hard.guest, hard.guestMemberId)).body.status, "left");
  const soft = await waitingRoom(false); assert.equal((await start(soft.room, soft.host)).status, 200);
  assert.equal((await leave(soft.room, soft.host, soft.hostMemberId)).body.status, "left");
  assert.equal(await prisma.friendFocusMember.count({ where: { roomId: soft.room.id } }), 1);
});

test("v2 simultaneous start/departure shares the existing transactional room lock", async () => {
  const { room, host, guest, guestMemberId } = await waitingRoom();
  const responses = await race("FriendFocusRoom", "findUnique", room.id, [() => start(room, host), () => leave(room, guest, guestMemberId)]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
  const current = await prisma.friendFocusRoom.findUnique({ where: { id: room.id }, include: { members: true } });
  assert.equal(current.members.length, current.status === "active" ? 2 : 1);
});
