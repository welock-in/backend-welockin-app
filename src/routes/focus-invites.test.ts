import assert from "node:assert/strict";
import { test } from "node:test";
import request from "supertest";
import { createApp } from "../app";
import { signToken } from "../lib/jwt";
import { prisma } from "../lib/prisma";
import { resolveAudience } from "../services/notifications/audience";

// Cross-device focus. The invite rows are the source of truth (desktops have no
// push transport at all), so these pin the parts a dropped notification cannot
// paper over: who may be targeted, what a late joiner runs for, and scoping.

const app = createApp();
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
  stubMethod(t, prisma.focusInvite as any, "findFirst", async () => null);

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
  stubMethod(t, prisma.focusInvite as any, "findFirst", async () => null);

  const res = await request(app)
    .post("/api/focus-invites")
    .set({ ...auth, "x-welockin-device-id": MAC })
    .send({ ...body, targetDeviceIds: [MAC] });

  assert.equal(res.body.invited, 0);
  assert.equal(creates.length, 0, "a Mac must not invite itself into its own session");
});

test("re-posting the same session updates the invite instead of stacking a second", async (t) => {
  stubMethod(t, prisma.device as any, "findMany", async () => [{ deviceId: PHONE }]);
  stubMethod(t, prisma.device as any, "findFirst", async () => ({ name: "MacBook Pro de Hedi" }));
  stubMethod(t, prisma.focusInvite as any, "findFirst", async () => inviteRow());
  const updates = stubMethod(t, prisma.focusInvite as any, "update", async () => inviteRow());
  const creates = stubMethod(t, prisma.focusInvite as any, "create", async () => inviteRow());

  const res = await request(app)
    .post("/api/focus-invites")
    .set({ ...auth, "x-welockin-device-id": MAC })
    .send(body);

  assert.equal(res.status, 201);
  assert.equal(updates.length, 1);
  assert.equal(creates.length, 0, "a client retry must not produce two invites");
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
  const updates = stubMethod(t, prisma.focusInvite as any, "update", async () =>
    inviteRow({ status: "accepted" }),
  );

  const res = await request(app)
    .post("/api/focus-invites/65f000000000000000000011/accept")
    .set({ ...auth, "x-welockin-device-id": PHONE });

  assert.equal(res.status, 200);
  assert.equal((updates[0][0] as any).data.status, "accepted");
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
