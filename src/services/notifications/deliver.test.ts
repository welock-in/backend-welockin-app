import assert from "node:assert/strict";
import { test } from "node:test";
import { prisma } from "../../lib/prisma";
import { deliver } from "./deliver";

/*
 * Uninstalling is invisible: nothing runs on an iPhone when the app is deleted,
 * so Expo's `DeviceNotRegistered` ticket is the only moment the backend can ever
 * learn it happened. It used to be spent on the token alone — the Device row
 * stayed on the account forever, and the user kept seeing a phone that no longer
 * had WeLockIn on it.
 */

const USER = "507f1f77bcf86cd799439011";
const DEVICE = "ios-57dd1ac9-3acb-40e2-8e6a-b6c79bc80dd3";
const TOKEN = "ExponentPushToken[uninstalled-phone]";

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

/** One Expo ticket back, ok or errored — the whole send path in a stub. */
function stubExpo(t: Parameters<typeof stubMethod>[0], ticket: Record<string, unknown>) {
  stubMethod(t, globalThis as any, "fetch", async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: [ticket] }),
  }));
}

test("a DeviceNotRegistered ticket disables push but keeps the device for foreground recovery", async (t) => {
  stubExpo(t, { status: "error", message: "not registered", details: { error: "DeviceNotRegistered" } });
  stubMethod(t, prisma.notificationDelivery as any, "createMany", async () => ({ count: 1 }));
  const invalidated = stubMethod(t, prisma.pushToken as any, "updateMany", async () => ({ count: 1 }));
  const lookups = stubMethod(t, prisma.pushToken as any, "findMany", async () => [
    { userId: USER, deviceId: DEVICE },
  ]);
  // No other valid token remains for this phone → it really is uninstalled.
  stubMethod(t, prisma.pushToken as any, "count", async () => 0);
  const removed = stubMethod(t, prisma.device as any, "deleteMany", async () => ({ count: 1 }));

  const summary = await deliver([{ token: TOKEN, userId: USER }], { title: "t", body: "b" }, { source: "test" });

  assert.equal(summary.pruned, 1, "the token is still marked invalid");
  assert.equal(summary.forgotten, 0);
  assert.equal(invalidated.length, 1);
  assert.equal(lookups.length, 0);
  assert.equal(removed.length, 0);
});

test("a delivered push never touches the device list", async (t) => {
  stubExpo(t, { status: "ok", id: "ticket-1" });
  stubMethod(t, prisma.notificationDelivery as any, "createMany", async () => ({ count: 1 }));
  const invalidated = stubMethod(t, prisma.pushToken as any, "updateMany", async () => ({ count: 0 }));
  const removed = stubMethod(t, prisma.device as any, "deleteMany", async () => ({ count: 0 }));

  const summary = await deliver([{ token: TOKEN, userId: USER }], { title: "t", body: "b" }, { source: "test" });

  assert.equal(summary.sent, 1);
  assert.equal(summary.forgotten, 0);
  assert.equal(invalidated.length, 0);
  assert.equal(removed.length, 0, "a healthy device must never be removed by a successful send");
});

test("a failed attempt does not dedupe the retry away", async (t) => {
  stubExpo(t, { status: "ok", id: "ticket-2" });
  stubMethod(t, prisma.notificationDelivery as any, "createMany", async () => ({ count: 1 }));
  // The audit log keeps one row per ATTEMPT — only rows that actually went out
  // may count as "already seen", or one Expo outage would mute a key forever.
  const dedupeReads = stubMethod(t, prisma.notificationDelivery as any, "findMany", async () => []);

  const summary = await deliver(
    [{ token: TOKEN, userId: USER }],
    { title: "t", body: "b" },
    { source: "test", dedupeKey: "k:1" },
  );

  assert.equal(summary.sent, 1);
  assert.deepEqual((dedupeReads[0][0] as any).where.status.in, ["sent", "provider_confirmed", "receipt_missing"]);
});

test("an Expo 200 with no tickets records errors, never phantom sends", async (t) => {
  // A malformed Expo response (200, no data array) used to leave the optimistic
  // "sent" in place — and a phantom "sent" row would dedupe every retry away.
  stubMethod(t, globalThis as any, "fetch", async () => ({
    ok: true,
    status: 200,
    json: async () => ({ errors: [{ code: "INTERNAL" }] }),
  }));
  const written = stubMethod(t, prisma.notificationDelivery as any, "createMany", async () => ({ count: 1 }));

  const summary = await deliver([{ token: TOKEN, userId: USER }], { title: "t", body: "b" }, { source: "test" });

  assert.equal(summary.sent, 0);
  assert.equal(summary.failed, 1);
  assert.equal((written[0][0] as any).data[0].status, "error");
});

test("a token with no device row prunes cleanly instead of deleting everything", async (t) => {
  stubExpo(t, { status: "error", message: "not registered", details: { error: "DeviceNotRegistered" } });
  stubMethod(t, prisma.notificationDelivery as any, "createMany", async () => ({ count: 1 }));
  stubMethod(t, prisma.pushToken as any, "updateMany", async () => ({ count: 1 }));
  // A token registered before its Device row existed carries deviceId: null. A
  // delete built from it would have no device filter at all.
  stubMethod(t, prisma.pushToken as any, "findMany", async () => [{ userId: USER, deviceId: null }]);
  const removed = stubMethod(t, prisma.device as any, "deleteMany", async () => ({ count: 99 }));

  const summary = await deliver([{ token: TOKEN, userId: USER }], { title: "t", body: "b" }, { source: "test" });

  assert.equal(summary.pruned, 1);
  assert.equal(summary.forgotten, 0);
  assert.equal(removed.length, 0, "an unattributed token must not delete a single device");
});
