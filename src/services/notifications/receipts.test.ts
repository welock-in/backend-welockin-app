import assert from "node:assert/strict";
import { test } from "node:test";
import { prisma } from "../../lib/prisma";
import { checkNotificationReceipts } from "./receipts";

test("receipts expose provider errors without deleting devices or killing newer registrations", async (t) => {
  const date = new Date(Date.now() - 20 * 60_000);
  const writes: any[] = [];
  mockPrisma(t, prisma.notificationDelivery, "updateMany", async (args: any) => { writes.push(args); return { count: 1 }; });
  mockPrisma(t, prisma.notificationDelivery, "findMany", async () => [
    { id: "1", ticketId: "ok", token: "a", userId: "u", createdAt: date },
    { id: "2", ticketId: "dead", token: "b", userId: "u", createdAt: date },
    { id: "3", ticketId: "wait", token: "c", userId: "u", createdAt: date },
  ]);
  t.mock.method(globalThis, "fetch", async () => ({ ok: true, status: 200, json: async () => ({ data: {
    ok: { status: "ok" }, dead: { status: "error", message: "gone", details: { error: "DeviceNotRegistered" } },
  } }) }));
  let disabled: any;
  mockPrisma(t, prisma.pushToken, "updateMany", async (args: any) => { disabled = args; return { count: 1 }; });
  mockPrisma(t, prisma.device, "deleteMany", async () => { throw new Error("never delete the device"); });
  const report = await checkNotificationReceipts();
  assert.equal(report.confirmed, 1);
  assert.equal(report.failed, 1);
  assert.equal(report.waiting, 1);
  assert.equal(writes[1].data.status, "provider_confirmed");
  assert.equal(writes[2].data.error, "DeviceNotRegistered: gone");
  assert.equal(disabled.where.token, "b");
  assert.deepEqual(disabled.where.updatedAt, { lte: date });
});

function mockPrisma(t: { after: (cb: () => void) => void }, target: any, name: string, implementation: (...args: any[]) => any) {
  const original = target[name];
  target[name] = implementation;
  t.after(() => { target[name] = original; });
}