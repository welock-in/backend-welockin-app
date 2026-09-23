import assert from "node:assert/strict";
import { test } from "node:test";
import { prisma } from "./prisma";
import { forgetUninstalledDevices } from "./push-tokens";

/*
 * The guard on forgetting a device: one dead token is not proof of an
 * uninstall. The Keychain device id survives a reinstall, so a fresh install
 * mints a NEW valid token for the SAME (userId, deviceId) while the old one
 * keeps bouncing with DeviceNotRegistered — and without the guard, that corpse
 * would delete the Device row of a phone that is alive, invitable and
 * reachable. Only a device with no valid token left has really stopped being one.
 */

const USER = "507f1f77bcf86cd799439011";
const DEVICE = "ios-57dd1ac9-3acb-40e2-8e6a-b6c79bc80dd3";

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

test("a device that still owns a valid token is never forgotten", async (t) => {
  stubMethod(t, prisma.pushToken as any, "findMany", async () => [
    { userId: USER, deviceId: DEVICE },
  ]);
  const aliveChecks = stubMethod(t, prisma.pushToken as any, "count", async () => 1);
  const removed = stubMethod(t, prisma.device as any, "deleteMany", async () => ({ count: 1 }));

  const forgotten = await forgetUninstalledDevices(["ExponentPushToken[old-corpse]"]);

  assert.equal(forgotten, 0);
  assert.equal(removed.length, 0, "a live install's device must survive its old token's corpse");
  // The check is scoped to this exact device and counts only living tokens.
  assert.deepEqual((aliveChecks[0][0] as any).where, { userId: USER, deviceId: DEVICE, valid: true });
});

test("a device with no valid token left is forgotten", async (t) => {
  stubMethod(t, prisma.pushToken as any, "findMany", async () => [
    { userId: USER, deviceId: DEVICE },
  ]);
  stubMethod(t, prisma.pushToken as any, "count", async () => 0);
  const removed = stubMethod(t, prisma.device as any, "deleteMany", async () => ({ count: 1 }));

  const forgotten = await forgetUninstalledDevices(["ExponentPushToken[uninstalled]"]);

  assert.equal(forgotten, 1);
  assert.deepEqual((removed[0][0] as any).where, { userId: USER, deviceId: DEVICE });
});
