import assert from "node:assert/strict";
import { test } from "node:test";
import request from "supertest";
import { createApp } from "../app";
import { signToken } from "../lib/jwt";
import { prisma } from "../lib/prisma";
import { Prisma } from "@prisma/client";

// The devices API had no tests at all, which is part of how a Mac ended up with
// three rows in production. These pin the contract that replaced the binding:
// an idempotent upsert on (userId, deviceId), a redacted list, and no 409/429.

const app = createApp();
const userId = "507f1f77bcf86cd799439011";
const auth = { authorization: `Bearer ${signToken({ sub: userId, email: "user@example.com" })}` };
const DEVICE_ID = "mac-ba2f7ca4-ba2a-5f93-b21d-8c038f226086";

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

/** A stored row, including the columns the API must never hand back. */
function deviceRow(over: Record<string, unknown> = {}) {
  return {
    id: "65f0000000000000000000aa",
    userId,
    deviceId: DEVICE_ID,
    name: "MacBook Pro de Hedi",
    platform: "macos",
    kind: "desktop",
    model: "Mac16,8",
    osVersion: "26.5.1",
    appVersion: "0.1.0",
    lastSeenAt: new Date("2026-07-22T13:48:42.000Z"),
    createdAt: new Date("2026-07-22T13:41:49.000Z"),
    // Server-side bookkeeping that must not reach another machine on the account.
    idfv: "AAAA-IDFV-SECRET",
    pushToken: "ExponentPushToken[xxx]",
    attestKeyId: "key-id",
    ...over,
  };
}

const validBody = {
  deviceId: DEVICE_ID,
  name: "MacBook Pro de Hedi",
  platform: "macos",
  kind: "desktop",
  model: "Mac16,8",
  osVersion: "26.5.1",
  appVersion: "0.1.0",
};

test("registering the same deviceId twice updates one row and never creates a second", async (t) => {
  stubMethod(t, prisma.device as any, "findFirst", async () => deviceRow());
  const updates = stubMethod(t, prisma.device as any, "update", async () => deviceRow());
  const creates = stubMethod(t, prisma.device as any, "create", async () => deviceRow());

  const res = await request(app).post("/api/devices").set(auth).send(validBody);

  assert.equal(res.status, 200);
  assert.equal(updates.length, 1);
  assert.equal(creates.length, 0, "an existing device must never be re-created");
});

test("a second, different device is accepted — no DEVICE_CONFLICT any more", async (t) => {
  stubMethod(t, prisma.device as any, "findFirst", async () => null);
  stubMethod(t, prisma.device as any, "count", async () => 1);
  const creates = stubMethod(t, prisma.device as any, "create", async () =>
    deviceRow({ deviceId: "ios-57dd1ac9-3acb-40e2-8e6a-b6c79bc80dd3", platform: "ios" }),
  );

  const res = await request(app)
    .post("/api/devices")
    .set(auth)
    .send({ ...validBody, deviceId: "ios-57dd1ac9-3acb-40e2-8e6a-b6c79bc80dd3", platform: "ios" });

  assert.equal(res.status, 201);
  assert.equal(creates.length, 1);
  assert.equal(res.body.code, undefined);
});

test("a deviceId is required, and a junk one is rejected", async (t) => {
  const creates = stubMethod(t, prisma.device as any, "create", async () => deviceRow());
  stubMethod(t, prisma.device as any, "findFirst", async () => null);

  const missing = await request(app)
    .post("/api/devices")
    .set(auth)
    .send({ name: "Mac", platform: "macos" });
  assert.equal(missing.status, 400);

  const tooShort = await request(app)
    .post("/api/devices")
    .set(auth)
    .send({ ...validBody, deviceId: "abc" });
  assert.equal(tooShort.status, 400);

  assert.equal(creates.length, 0, "nothing may be written for an unidentified device");
});

test("platform spellings are normalised instead of stored as-is", async (t) => {
  stubMethod(t, prisma.device as any, "findFirst", async () => null);
  stubMethod(t, prisma.device as any, "count", async () => 0);
  const creates = stubMethod(t, prisma.device as any, "create", async () => deviceRow());

  const res = await request(app)
    .post("/api/devices")
    .set(auth)
    .send({ ...validBody, platform: "Mac" });

  assert.equal(res.status, 201);
  assert.equal((creates[0][0] as any).data.platform, "macos");
});

test("an unknown platform is rejected rather than silently stored", async (t) => {
  const creates = stubMethod(t, prisma.device as any, "create", async () => deviceRow());
  stubMethod(t, prisma.device as any, "findFirst", async () => null);

  const res = await request(app)
    .post("/api/devices")
    .set(auth)
    .send({ ...validBody, platform: "toaster" });

  assert.equal(res.status, 400);
  assert.equal(creates.length, 0);
});

test("the list is scoped to the caller's account", async (t) => {
  // Without this, a query missing its userId filter — every account's devices in
  // one response — would sail through the rest of the suite.
  const finds = stubMethod(t, prisma.device as any, "findMany", async () => []);

  await request(app).get("/api/devices").set(auth);

  assert.equal((finds[0][0] as any).where.userId, userId);
});

test("the list is redacted and flags the calling device", async (t) => {
  stubMethod(t, prisma.device as any, "findMany", async () => [
    deviceRow(),
    deviceRow({ id: "65f0000000000000000000bb", deviceId: "win-abc12345", platform: "windows" }),
  ]);

  const res = await request(app)
    .get("/api/devices")
    .set({ ...auth, "x-welockin-device-id": DEVICE_ID });

  assert.equal(res.status, 200);
  const [mac, pc] = res.body.devices as Record<string, unknown>[];

  assert.equal(mac.isCurrent, true, "the caller's own device must be flagged by the server");
  assert.equal(pc.isCurrent, false);
  assert.equal(mac.name, "MacBook Pro de Hedi");
  assert.equal(mac.model, "Mac16,8");

  for (const leaked of ["userId", "idfv", "pushToken", "attestKeyId"]) {
    assert.equal(mac[leaked], undefined, `${leaked} must not be exposed to other devices`);
  }
  assert.equal(res.body.max, undefined, "the fictional 3-device cap is gone");
});

test("removing an unknown device is a 404, not a silent success", async (t) => {
  stubMethod(t, prisma.device as any, "deleteMany", async () => ({ count: 0 }));

  const res = await request(app).delete("/api/devices/mac-does-not-exist").set(auth);

  assert.equal(res.status, 404);
});

test("removing a real device reports what was removed", async (t) => {
  const deletes = stubMethod(t, prisma.device as any, "deleteMany", async () => ({ count: 1 }));

  const res = await request(app).delete(`/api/devices/${DEVICE_ID}`).set(auth);

  assert.equal(res.status, 200);
  assert.equal(res.body.removed, 1);
  const where = (deletes[0][0] as any).where;
  // Scoped to the caller: one account can never delete another's device...
  assert.equal(where.userId, userId);
  // ...and to the ONE device named in the path. Asserting only the userId would
  // let a filter that dropped :deviceId — wiping every device on the account —
  // pass as a green test.
  assert.equal(where.deviceId, DEVICE_ID);
});

test("a heartbeat refreshes a stale lastSeenAt and stays quiet when fresh", async (t) => {
  const stale = deviceRow({ lastSeenAt: new Date(Date.now() - 60 * 60 * 1000) });
  stubMethod(t, prisma.device as any, "findFirst", async () => stale);
  const updates = stubMethod(t, prisma.device as any, "update", async () => stale);

  const res = await request(app)
    .post("/api/devices/heartbeat")
    .set({ ...auth, "x-welockin-device-id": DEVICE_ID });

  assert.equal(res.status, 204);
  assert.equal(updates.length, 1, "a desktop's last-seen must actually move");

  const fresh = deviceRow({ lastSeenAt: new Date() });
  stubMethod(t, prisma.device as any, "findFirst", async () => fresh);
  const freshUpdates = stubMethod(t, prisma.device as any, "update", async () => fresh);

  const second = await request(app)
    .post("/api/devices/heartbeat")
    .set({ ...auth, "x-welockin-device-id": DEVICE_ID });

  assert.equal(second.status, 204);
  assert.equal(freshUpdates.length, 0, "throttled: no write when it was just seen");
});

test("the 50-device ceiling is actually enforced", async (t) => {
  stubMethod(t, prisma.device as any, "findFirst", async () => null);
  stubMethod(t, prisma.device as any, "count", async () => 50);
  const creates = stubMethod(t, prisma.device as any, "create", async () => deviceRow());

  const res = await request(app)
    .post("/api/devices")
    .set(auth)
    .send({ ...validBody, deviceId: "mac-11111111-2222-3333-4444-555555555555" });

  assert.equal(res.status, 409);
  assert.equal(creates.length, 0, "deleting the guard must not keep this suite green");
});

test("a concurrent first registration resolves to the winner instead of erroring", async (t) => {
  // Mongo has no real upsert here, so two devices registering at once both reach
  // create() and one loses on the unique index. The loser must still see success.
  const winner = deviceRow();
  let findCall = 0;
  stubMethod(t, prisma.device as any, "findFirst", async () => (findCall++ === 0 ? null : winner));
  stubMethod(t, prisma.device as any, "count", async () => 0);
  stubMethod(t, prisma.device as any, "create", async () => {
    throw new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "x" });
  });
  const credited = stubMethod(t, prisma.focusEvent as any, "updateMany", async () => ({ count: 0 }));

  const res = await request(app).post("/api/devices").set(auth).send(validBody);

  assert.equal(res.status, 200);
  assert.equal(res.body.device.deviceId, DEVICE_ID);
  assert.equal(credited.length, 1, "the race winner must still release the event backlog");
});

test("registering releases focus events reported before the device was known", async (t) => {
  stubMethod(t, prisma.device as any, "findFirst", async () => null);
  stubMethod(t, prisma.device as any, "count", async () => 0);
  stubMethod(t, prisma.device as any, "create", async () => deviceRow());
  const credited = stubMethod(t, prisma.focusEvent as any, "updateMany", async () => ({ count: 3 }));

  const res = await request(app).post("/api/devices").set(auth).send(validBody);

  assert.equal(res.status, 201);
  assert.equal(credited.length, 1);
  const args = credited[0][0] as any;
  assert.deepEqual(args.where, { userId, deviceId: DEVICE_ID, quarantined: true });
  assert.deepEqual(args.data, { quarantined: false });
});

test("a heartbeat without a device id is refused, and is scoped to the caller", async (t) => {
  const finds = stubMethod(t, prisma.device as any, "findFirst", async () => null);

  const noId = await request(app).post("/api/devices/heartbeat").set(auth);
  assert.equal(noId.status, 404);
  assert.equal(finds.length, 0, "no lookup should happen without a device id");

  const unknown = await request(app)
    .post("/api/devices/heartbeat")
    .set({ ...auth, "x-welockin-device-id": "mac-99999999-9999-9999-9999-999999999999" });
  assert.equal(unknown.status, 404);
  assert.equal((finds[0][0] as any).where.userId, userId);
});
