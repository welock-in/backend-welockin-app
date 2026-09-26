import assert from "node:assert/strict";
import { test } from "node:test";
import request from "supertest";
import { createApp } from "../app";
import { stubAccountGuard } from "./test-helpers";
import { signToken } from "../lib/jwt";
import { prisma } from "../lib/prisma";
import { resolveAudience, resolveDeviceAudiences } from "../services/notifications/audience";
import { deterministicObjectId } from "../lib/deterministic-id";
import { Prisma } from "@prisma/client";

// Cross-device focus. The invite rows are the source of truth (desktops have no
// push transport at all), so these pin the parts a dropped notification cannot
// paper over: who may be targeted, what a late joiner runs for, and scoping.

const app = createApp();

// This router now sits behind the account guard (see app.ts), which reads the
// caller's account on every request. Answer that one read for the whole file;
// every other user lookup still falls through and fails loudly if unstubbed.
stubAccountGuard();
const userId = "507f1f77bcf86cd799439011";
const MAC = "mac-ba2f7ca4-ba2a-5f93-b21d-8c038f226086";
const PHONE = "ios-57dd1ac9-3acb-40e2-8e6a-b6c79bc80dd3";
const auth = { authorization: `Bearer ${signToken({ sub: userId, email: "user@example.com" })}` };

function stubMethod(
  t: { after: (fn: () => void) => void },
  target: Record<string, any>,
  name: string,
  implementation: (...args: any[]) => any,
) {
  const original = target[name];
  const calls: any[][] = [];
  target[name] = (...args: any[]) => {
    calls.push(args);
    return implementation(...args);
  };
  t.after(() => {
    target[name] = original;
  });
  return calls;
}

function inviteRow(over: Record<string, unknown> = {}) {
  return {
    id: "65f000000000000000000011",
    userId,
    sessionId: "sess-1",
    fromDeviceId: MAC,
    fromDeviceName: "MacBook Pro de Hedi",
    toDeviceId: PHONE,
    sessionName: "Deep work",
    hardLock: true,
    endsAt: new Date(Date.now() + 45 * 60 * 1000),
    status: "pending",
    respondedAt: null,
    createdAt: new Date(),
    ...over,
  };
}

const body = {
  sessionId: "sess-1",
  sessionName: "Deep work",
  durationSeconds: 45 * 60,
  hardLock: true,
  targetDeviceIds: [PHONE],
};

test("a device id that is not on the account is never invited", async (t) => {
  // The request supplies ids. Trusting them would let one account push a focus
  // onto a stranger's machine.
  stubMethod(t, prisma.device as any, "findMany", async () => []);
  const creates = stubMethod(t, prisma.focusInvite as any, "create", async () => inviteRow());
  stubMethod(t, prisma.focusInvite as any, "findMany", async () => []);

  const res = await request(app)
    .post("/api/focus-invites")
    .set({ ...auth, "x-welockin-device-id": MAC })
    .send({ ...body, targetDeviceIds: ["ios-somebody-elses-phone-0000000000"] });

  assert.equal(res.status, 201);
  assert.equal(res.body.invited, 0);
  assert.equal(creates.length, 0);
});

test("the origin device never invites itself", async (t) => {
  stubMethod(t, prisma.device as any, "findMany", async () => [{ deviceId: MAC }]);
  const creates = stubMethod(t, prisma.focusInvite as any, "create", async () => inviteRow());
  stubMethod(t, prisma.focusInvite as any, "findMany", async () => []);

  const res = await request(app)
    .post("/api/focus-invites")
    .set({ ...auth, "x-welockin-device-id": MAC })
    .send({ ...body, targetDeviceIds: [MAC] });

  assert.equal(res.body.invited, 0);
  assert.equal(creates.length, 0, "a Mac must not invite itself into its own session");
});

test("re-posting the same session keeps its deadline instead of stacking or extending it", async (t) => {
  stubMethod(t, prisma.device as any, "findMany", async () => [{ deviceId: PHONE }]);
  stubMethod(t, prisma.device as any, "findFirst", async () => ({ name: "MacBook Pro de Hedi" }));
  stubMethod(t, prisma.focusInvite as any, "findMany", async () => [inviteRow()]);
  stubMethod(t, prisma.pushToken as any, "findMany", async () => []);
  const updates = stubMethod(t, prisma.focusInvite as any, "update", async () => inviteRow());
  const creates = stubMethod(t, prisma.focusInvite as any, "create", async () => inviteRow());

  const res = await request(app)
    .post("/api/focus-invites")
    .set({ ...auth, "x-welockin-device-id": MAC })
    .send(body);

  assert.equal(res.status, 201);
  assert.equal(updates.length, 0);
  assert.equal(creates.length, 0, "a client retry must not produce two invites");
});

test("inviting a phone pushes it the pre-filled join screen — no seeded data needed", async (t) => {
  // The push that used to die in production: it went through the rule engine,
  // which needs NotificationRule + NotificationTemplate rows seeded in Mongo.
  // It is now built in code and sent through the same resolveAudience + deliver
  // primitives as the admin console's (working) test send. These stubs are the
  // COMPLETE data surface of a send — note there is no rule or template read.
  stubMethod(t, prisma.device as any, "findMany", async () => [{ deviceId: PHONE }]);
  stubMethod(t, prisma.device as any, "findFirst", async () => ({ name: "MacBook Pro de Hedi" }));
  stubMethod(t, prisma.focusInvite as any, "findMany", async () => []);
  stubMethod(t, prisma.focusInvite as any, "create", async () => inviteRow());
  const audienceReads = stubMethod(t, prisma.pushToken as any, "findMany", async () => [
    { token: "ExponentPushToken[iphone]", userId, deviceId: PHONE },
  ]);
  stubMethod(t, prisma.notificationDelivery as any, "findMany", async () => []);
  const written = stubMethod(t, prisma.notificationDelivery as any, "createMany", async () => ({ count: 1 }));
  const pushes = stubMethod(t, globalThis as any, "fetch", async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: [{ status: "ok", id: "ticket-1" }] }),
  }));

  const res = await request(app)
    .post("/api/focus-invites")
    .set({ ...auth, "x-welockin-device-id": MAC })
    .send(body);

  assert.equal(res.status, 201);
  assert.equal(res.body.invited, 1);

  // Audience: exactly the picked device's valid tokens, never the whole account.
  assert.deepEqual((audienceReads[0][0] as any).where.deviceId, { in: [PHONE] });

  assert.equal(pushes.length, 1);
  const [message] = JSON.parse((pushes[0][1] as any).body as string);
  assert.equal(message.to, "ExponentPushToken[iphone]");
  assert.equal(message.title, "MacBook Pro de Hedi started Deep work");
  assert.equal(message.body, "45 min. Tap to lock this phone too.");
  // The deep-link contract NotificationRouter navigates on — same params the
  // phone's own foreground poll synthesizes, so both paths open one screen.
  assert.equal(message.data.route, "/start-focus");
  const { endsAt, ...params } = message.data.params;
  assert.deepEqual(params, {
    source: "desktop",
    sessionId: "sess-1",
    min: "45",
    hard: "true",
  });
  // The absolute end rides along so a LATE tap can join for the remaining
  // time (or refuse a dead invite) instead of trusting the frozen `min`.
  const msLeft = new Date(endsAt).getTime() - Date.now();
  assert.ok(msLeft > 44 * 60 * 1000 && msLeft <= 45 * 60 * 1000, `endsAt ~45min out, got ${endsAt}`);

  // Deduped per DEVICE: a retry can't buzz this phone twice for one session,
  // while a second phone added to the session later still gets its own push.
  assert.equal((written[0][0] as any).data[0].dedupeKey, `focus_invited:${MAC}:sess-1:${PHONE}`);
});

test("a target with no push token gets its invite row and nothing else", async (t) => {
  // A desktop, or a phone whose token was silenced: polling is its transport.
  stubMethod(t, prisma.device as any, "findMany", async () => [{ deviceId: PHONE }]);
  stubMethod(t, prisma.device as any, "findFirst", async () => ({ name: "MacBook Pro de Hedi" }));
  stubMethod(t, prisma.focusInvite as any, "findMany", async () => []);
  const creates = stubMethod(t, prisma.focusInvite as any, "create", async () => inviteRow());
  stubMethod(t, prisma.pushToken as any, "findMany", async () => []);
  const pushes = stubMethod(t, globalThis as any, "fetch", async () => {
    throw new Error("no push may leave for a tokenless target");
  });

  const res = await request(app)
    .post("/api/focus-invites")
    .set({ ...auth, "x-welockin-device-id": MAC })
    .send(body);

  assert.equal(res.status, 201);
  assert.equal(res.body.invited, 1);
  assert.equal(creates.length, 1);
  assert.equal(pushes.length, 0);
});

test("a push failure never fails the invite — polling still finds the row", async (t) => {
  stubMethod(t, prisma.device as any, "findMany", async () => [{ deviceId: PHONE }]);
  stubMethod(t, prisma.device as any, "findFirst", async () => ({ name: "MacBook Pro de Hedi" }));
  stubMethod(t, prisma.focusInvite as any, "findMany", async () => []);
  stubMethod(t, prisma.focusInvite as any, "create", async () => inviteRow());
  stubMethod(t, prisma.pushToken as any, "findMany", async () => {
    throw new Error("push infrastructure down");
  });

  const res = await request(app)
    .post("/api/focus-invites")
    .set({ ...auth, "x-welockin-device-id": MAC })
    .send(body);

  assert.equal(res.status, 201, "the invite is the product; the push is an accelerator");
  assert.equal(res.body.invited, 1);
});

test("pending returns the remaining time, not the original duration", async (t) => {
  // A Mac that wakes up 30 minutes into a 45-minute session joins for 15, or the
  // two devices would unlock at different times.
  stubMethod(t, prisma.focusInvite as any, "findMany", async () => [
    inviteRow({ endsAt: new Date(Date.now() + 15 * 60 * 1000) }),
  ]);

  const res = await request(app)
    .get("/api/focus-invites/pending")
    .set({ ...auth, "x-welockin-device-id": PHONE });

  assert.equal(res.status, 200);
  const [invite] = res.body.invites;
  assert.ok(invite.remainingSeconds > 14 * 60 && invite.remainingSeconds <= 15 * 60);
  assert.equal(invite.hardLock, true);
});

test("an invite whose session already ended is not offered", async (t) => {
  stubMethod(t, prisma.focusInvite as any, "findMany", async () => [
    inviteRow({ endsAt: new Date(Date.now() - 60 * 1000) }),
  ]);

  const res = await request(app)
    .get("/api/focus-invites/pending")
    .set({ ...auth, "x-welockin-device-id": PHONE });

  assert.deepEqual(res.body.invites, []);
});

test("pending is scoped to the calling device and its account", async (t) => {
  const finds = stubMethod(t, prisma.focusInvite as any, "findMany", async () => []);

  await request(app)
    .get("/api/focus-invites/pending")
    .set({ ...auth, "x-welockin-device-id": PHONE });

  const where = (finds[0][0] as any).where;
  assert.equal(where.userId, userId);
  assert.equal(where.toDeviceId, PHONE);
  assert.equal(where.status, "pending");
});

test("polling without a device id answers empty rather than failing", async (t) => {
  // The poller runs every few seconds; an error here would be a failure loop.
  const finds = stubMethod(t, prisma.focusInvite as any, "findMany", async () => []);

  const res = await request(app).get("/api/focus-invites/pending").set(auth);

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.invites, []);
  assert.equal(finds.length, 0);
});

test("accepting an invite addressed to another device is a 404", async (t) => {
  const finds = stubMethod(t, prisma.focusInvite as any, "findFirst", async () => null);

  const res = await request(app)
    .post("/api/focus-invites/65f000000000000000000011/accept")
    .set({ ...auth, "x-welockin-device-id": "mac-99999999-9999-9999-9999-999999999999" });

  assert.equal(res.status, 404);
  const where = (finds[0][0] as any).where;
  assert.equal(where.userId, userId);
  assert.equal(where.toDeviceId, "mac-99999999-9999-9999-9999-999999999999");
});

test("accepting marks the invite accepted", async (t) => {
  stubMethod(t, prisma.focusInvite as any, "findFirst", async () => inviteRow());
  const updates = stubMethod(t, prisma.focusInvite as any, "updateMany", async () => ({ count: 1 }));

  const res = await request(app)
    .post("/api/focus-invites/65f000000000000000000011/accept")
    .set({ ...auth, "x-welockin-device-id": PHONE });

  assert.equal(res.status, 200);
  assert.equal((updates[0][0] as any).data.status, "accepted");
  assert.equal((updates[0][0] as any).where.status, "pending");
});

test("the specificDevices audience targets nobody when no device was picked", async (t) => {
  // The dangerous failure is the opposite: an empty pick quietly broadcasting to
  // every device on the account.
  const finds = stubMethod(t, prisma.pushToken as any, "findMany", async () => []);

  const none = await resolveAudience({ mode: "specificDevices" }, { userId });
  assert.deepEqual(none, []);
  assert.equal(finds.length, 0, "no query at all, rather than an unfiltered one");

  await resolveAudience({ mode: "specificDevices" }, { userId, targetDeviceIds: [PHONE] });
  assert.deepEqual((finds[0][0] as any).where.deviceId, { in: [PHONE] });
});

test("all 13 selected devices are invited and unavailable ids are explicit", async (t) => {
  const ids = Array.from({ length: 13 }, (_, n) => `windows-device-${n}`);
  stubMethod(t, prisma.device as any, "findMany", async () => ids.map(deviceId => ({ deviceId, platform: "windows" })));
  stubMethod(t, prisma.device as any, "findFirst", async () => ({ name: "Origin" }));
  stubMethod(t, prisma.focusInvite as any, "findMany", async () => []);
  const writes = stubMethod(t, prisma.focusInvite as any, "create", async ({ data }) => inviteRow(data));
  stubMethod(t, prisma.pushToken as any, "findMany", async () => []);
  const res = await request(app).post("/api/focus-invites")
    .set({ ...auth, "x-welockin-device-id": MAC }).send({ ...body, targetDeviceIds: [...ids, "unknown"] });
  assert.equal(res.status, 201);
  assert.equal(res.body.invited, 13);
  assert.equal(writes.length, 13);
  assert.equal(res.body.delivery.filter((d: any) => d.status === "polling").length, 13);
  assert.deepEqual(res.body.delivery.find((d: any) => d.deviceId === "unknown"), { deviceId: "unknown", status: "unavailable" });
  assert.equal(writes[0][0].data.id, deterministicObjectId("focus-invite", userId, MAC, body.sessionId, ids[0]));
});

test("iPad without token reports push unavailable while keeping its invitation", async (t) => {
  stubMethod(t, prisma.device as any, "findMany", async () => [{ deviceId: PHONE, platform: "ipados" }]);
  stubMethod(t, prisma.device as any, "findFirst", async () => ({ name: "Origin" }));
  stubMethod(t, prisma.focusInvite as any, "findMany", async () => []);
  stubMethod(t, prisma.focusInvite as any, "create", async ({ data }) => inviteRow(data));
  stubMethod(t, prisma.pushToken as any, "findMany", async () => []);
  const endsAt = new Date(Date.now() + 90_000).toISOString();
  const res = await request(app).post("/api/focus-invites")
    .set({ ...auth, "x-welockin-device-id": MAC }).send({ ...body, endsAt });
  assert.equal(res.status, 201);
  assert.equal(res.body.invites[0].endsAt, endsAt);
  assert.deepEqual(res.body.delivery, [{ deviceId: PHONE, status: "push_unavailable" }]);
});

test("expired outgoing invitations are rejected before any database write", async () => {
  const res = await request(app).post("/api/focus-invites")
    .set({ ...auth, "x-welockin-device-id": MAC }).send({ ...body, endsAt: new Date(Date.now() - 1000).toISOString() });
  assert.equal(res.status, 400);
});

test("accept requires receiving device identity and rejects expired sessions", async (t) => {
  const noIdentity = await request(app).post("/api/focus-invites/65f000000000000000000011/accept").set(auth);
  assert.equal(noIdentity.status, 400);
  stubMethod(t, prisma.focusInvite as any, "findFirst", async () => inviteRow({ endsAt: new Date(Date.now() - 1000) }));
  const expired = await request(app).post("/api/focus-invites/65f000000000000000000011/accept")
    .set({ ...auth, "x-welockin-device-id": PHONE });
  assert.equal(expired.status, 400);
});

test("concurrent creation collision returns the winner without extending its deadline", async (t) => {
  const deadline = new Date(Date.now() + 120_000);
  stubMethod(t, prisma.device as any, "findMany", async () => [{ deviceId: PHONE, platform: "ios" }]);
  stubMethod(t, prisma.device as any, "findFirst", async () => ({ name: "Origin" }));
  stubMethod(t, prisma.focusInvite as any, "findMany", async () => []);
  stubMethod(t, prisma.focusInvite as any, "create", async () => { throw new Prisma.PrismaClientKnownRequestError("duplicate", { code: "P2002", clientVersion: "5.22" }); });
  const read = stubMethod(t, prisma.focusInvite as any, "findUnique", async () => inviteRow({ endsAt: deadline }));
  stubMethod(t, prisma.pushToken as any, "findMany", async () => []);
  const res = await request(app).post("/api/focus-invites")
    .set({ ...auth, "x-welockin-device-id": MAC }).send(body);
  assert.equal(res.status, 201);
  assert.equal(res.body.invites[0].endsAt, deadline.toISOString());
  assert.equal(read[0][0].where.id, deterministicObjectId("focus-invite", userId, MAC, body.sessionId, PHONE));
});

test("ending the source session cancels only its pending invitations", async (t) => {
  stubMethod(t, prisma.liveSession as any, "deleteMany", async () => ({ count: 1 }));
  const cancels = stubMethod(t, prisma.focusInvite as any, "updateMany", async () => ({ count: 2 }));
  const res = await request(app).post("/api/sessions/end").set(auth).send({ deviceId: MAC, sessionId: body.sessionId });
  assert.equal(res.status, 200);
  assert.deepEqual(cancels[0][0].where, { userId, fromDeviceId: MAC, status: "pending", sessionId: body.sessionId });
  assert.equal(cancels[0][0].data.status, "cancelled");
});

test("a cancelled invite cannot be accepted even before its original deadline", async (t) => {
  stubMethod(t, prisma.focusInvite as any, "findFirst", async () => inviteRow({ status: "cancelled" }));
  const res = await request(app).post("/api/focus-invites/65f000000000000000000011/accept")
    .set({ ...auth, "x-welockin-device-id": PHONE });
  assert.equal(res.status, 400);
});

test("creation and push concurrency stay bounded, with every row persisted before any push", { timeout: 5000 }, async (t) => {
  const ids = Array.from({ length: 14 }, (_, index) => `ios-selected-${index}`);
  stubMethod(t, prisma.device as any, "findMany", async () => ids.map(deviceId => ({ deviceId, platform: "ios" })));
  stubMethod(t, prisma.device as any, "findFirst", async () => ({ name: "Source" }));
  const existingReads = stubMethod(t, prisma.focusInvite as any, "findMany", async () => []);
  let writesActive = 0, peakWrites = 0, written = 0;
  let releaseWrites!: () => void;
  const writeBarrier = new Promise<void>(resolve => { releaseWrites = resolve; });
  t.after(() => releaseWrites());
  stubMethod(t, prisma.focusInvite as any, "create", async ({ data }) => {
    peakWrites = Math.max(peakWrites, ++writesActive);
    if (writesActive === 6) releaseWrites();
    await writeBarrier;
    writesActive--;
    written++;
    return inviteRow(data);
  });
  const audienceReads = stubMethod(t, prisma.pushToken as any, "findMany", async () => {
    assert.equal(written, ids.length, "all rows exist before resolving the push audience");
    return ids.map((deviceId, index) => ({ deviceId, userId, token: `ExponentPushToken[target${index}]` }));
  });
  stubMethod(t, prisma.notificationDelivery as any, "findMany", async () => []);
  stubMethod(t, prisma.notificationDelivery as any, "createMany", async () => ({ count: 1 }));
  let pushesActive = 0, peakPushes = 0;
  let releasePushes!: () => void;
  const pushBarrier = new Promise<void>(resolve => { releasePushes = resolve; });
  t.after(() => releasePushes());
  const pushes = stubMethod(t, globalThis as any, "fetch", async (_url, options) => {
    assert.equal(written, ids.length, "Expo must never precede persistence");
    peakPushes = Math.max(peakPushes, ++pushesActive);
    if (pushesActive === 6) releasePushes();
    await pushBarrier;
    pushesActive--;
    const [{ to }] = JSON.parse(options.body);
    return { ok: true, status: 200, json: async () => ({ data: [{ status: "ok", id: `ticket-${to}` }] }) };
  });
  const res = await request(app).post("/api/focus-invites")
    .set({ ...auth, "x-welockin-device-id": MAC }).send({ ...body, targetDeviceIds: ids });
  assert.equal(res.status, 201);
  assert.equal(res.body.invited, 14);
  assert.equal(existingReads.length, 1, "one existing-invitation lookup, not one per device");
  assert.deepEqual(existingReads[0][0].where, { userId, fromDeviceId: MAC, sessionId: body.sessionId, toDeviceId: { in: ids } });
  assert.equal(audienceReads.length, 1, "one selected-token lookup, not one per device");
  assert.equal(peakWrites, 6);
  assert.equal(peakPushes, 6);
  assert.equal(pushes.length, 14);
  assert.ok(res.body.delivery.every((row: any) => row.status === "push_accepted"));
});

test("a failed creation drains started writes, allocates no more devices, and never reaches push", { timeout: 5000 }, async (t) => {
  const ids = Array.from({ length: 14 }, (_, index) => `ios-selected-${index}`);
  stubMethod(t, prisma.device as any, "findMany", async () => ids.map(deviceId => ({ deviceId, platform: "ios" })));
  stubMethod(t, prisma.device as any, "findFirst", async () => ({ name: "Source" }));
  stubMethod(t, prisma.focusInvite as any, "findMany", async () => []);
  let releaseWrites!: () => void;
  const pendingWrites = new Promise<void>(resolve => { releaseWrites = resolve; });
  let firstWaveStarted!: () => void;
  const started = new Promise<void>(resolve => { firstWaveStarted = resolve; });
  t.after(() => releaseWrites());
  let calls = 0, completed = 0;
  stubMethod(t, prisma.focusInvite as any, "create", async ({ data }) => {
    const position = calls++;
    if (calls === 6) firstWaveStarted();
    if (position === 0) throw new Error("database write failed");
    await pendingWrites;
    completed++;
    return inviteRow(data);
  });
  const audiences = stubMethod(t, prisma.pushToken as any, "findMany", async () => []);
  const pushes = stubMethod(t, globalThis as any, "fetch", async () => { throw new Error("unexpected push"); });
  let responseArrived = false;
  const response = request(app).post("/api/focus-invites")
    .set({ ...auth, "x-welockin-device-id": MAC }).send({ ...body, targetDeviceIds: ids })
    .then(result => { responseArrived = true; return result; });
  await started;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(responseArrived, false, "the response waits for already-started writes");
  assert.equal(calls, 6);
  releaseWrites();
  const res = await response;
  assert.equal(res.status, 500);
  assert.equal(calls, 6, "no devices beyond the first wave are allocated after failure");
  assert.equal(completed, 5, "all writes already in flight settle before the response");
  assert.equal(audiences.length, 0);
  assert.equal(pushes.length, 0);
});

test("an audience lookup failure does not falsely report native desktop delivery as failed", async (t) => {
  stubMethod(t, prisma.device as any, "findMany", async () => [
    { deviceId: PHONE, platform: "ios" }, { deviceId: "windows-selected", platform: "windows" },
  ]);
  stubMethod(t, prisma.device as any, "findFirst", async () => ({ name: "Source" }));
  stubMethod(t, prisma.focusInvite as any, "findMany", async () => []);
  stubMethod(t, prisma.focusInvite as any, "create", async ({ data }) => inviteRow(data));
  stubMethod(t, prisma.pushToken as any, "findMany", async () => { throw new Error("audience database unavailable"); });
  const res = await request(app).post("/api/focus-invites")
    .set({ ...auth, "x-welockin-device-id": MAC }).send({ ...body, targetDeviceIds: [PHONE, "windows-selected"] });
  assert.equal(res.status, 201);
  assert.deepEqual(res.body.delivery, [
    { deviceId: PHONE, status: "push_failed" }, { deviceId: "windows-selected", status: "polling" },
  ]);
});

test("bulk audience never mixes devices or accounts, and an empty selection queries nobody", async (t) => {
  const reads = stubMethod(t, prisma.pushToken as any, "findMany", async () => [
    { deviceId: PHONE, userId, token: "ExponentPushToken[selected]" },
    { deviceId: PHONE, userId: "other-user", token: "ExponentPushToken[other-account]" },
    { deviceId: "not-selected", userId, token: "ExponentPushToken[not-selected]" },
    { deviceId: null, userId, token: "ExponentPushToken[unattributed]" },
  ]);
  assert.equal((await resolveDeviceAudiences(userId, [])).size, 0);
  assert.equal(reads.length, 0);
  const audiences = await resolveDeviceAudiences(userId, [PHONE, PHONE]);
  assert.deepEqual(reads[0][0].where, { valid: true, userId, deviceId: { in: [PHONE] } });
  assert.deepEqual([...audiences], [[PHONE, [{ token: "ExponentPushToken[selected]", userId }]]]);
});

test("fourteen persisted invitations retain nine missing-push warnings without failing healthy targets", async (t) => {
  const phones = Array.from({ length: 12 }, (_, index) => `ios-selected-${index}`);
  const macs = ["mac-selected-1", "mac-selected-2"];
  const ids = [...phones, ...macs];
  stubMethod(t, prisma.device as any, "findMany", async () => [
    ...phones.map(deviceId => ({ deviceId, platform: "ios" })),
    ...macs.map(deviceId => ({ deviceId, platform: "macos" })),
  ]);
  stubMethod(t, prisma.device as any, "findFirst", async () => ({ name: "Source" }));
  stubMethod(t, prisma.focusInvite as any, "findMany", async () => []);
  const writes = stubMethod(t, prisma.focusInvite as any, "create", async ({ data }) => inviteRow(data));
  const audienceReads = stubMethod(t, prisma.pushToken as any, "findMany", async () => phones.slice(0, 3)
    .map((deviceId, index) => ({ deviceId, userId, token: `ExponentPushToken[active${index}]` })));
  stubMethod(t, prisma.notificationDelivery as any, "findMany", async () => []);
  stubMethod(t, prisma.notificationDelivery as any, "createMany", async () => ({ count: 1 }));
  const pushes = stubMethod(t, globalThis as any, "fetch", async () => ({
    ok: true, status: 200, json: async () => ({ data: [{ status: "ok", id: "accepted-ticket" }] }),
  }));
  const res = await request(app).post("/api/focus-invites")
    .set({ ...auth, "x-welockin-device-id": MAC }).send({ ...body, targetDeviceIds: ids });
  assert.equal(res.status, 201);
  assert.equal(res.body.invited, 14);
  assert.equal(writes.length, 14);
  assert.equal(audienceReads.length, 1);
  assert.equal(pushes.length, 3);
  const count = (status: string) => res.body.delivery.filter((row: any) => row.status === status).length;
  assert.equal(count("push_accepted"), 3);
  assert.equal(count("push_unavailable"), 9);
  assert.equal(count("polling"), 2);
  assert.equal(count("push_failed"), 0);
  assert.equal(count("unavailable"), 0);
});
