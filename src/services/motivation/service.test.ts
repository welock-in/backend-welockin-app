import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { drainMotivationReminders, saveMotivationContext } from "./service";
import { nextMotivationAt } from "./schedule";

const USER = "507f1f77bcf86cd799439011";
const TOKEN = "ExponentPushToken[test-motivation-token]";

function stub(t: TestContext, object: Record<string, any>, key: string, replacement: (...args: any[]) => any) {
  const original = object[key];
  object[key] = replacement;
  t.after(() => { object[key] = original; });
}

test("the first mobile context enables all days by default", async (t) => {
  stub(t, prisma.motivationPreference as any, "findUnique", async () => null);
  stub(t, prisma.motivationSend as any, "findUnique", async () => null);
  let created: any;
  stub(t, prisma.motivationPreference as any, "create", async (args: any) => {
    created = args.data;
    return args.data;
  });
  const settings = await saveMotivationContext(USER, "Europe/Paris", "fr");
  assert.equal(settings.enabled, true);
  assert.deepEqual(settings.weekdays, [0, 1, 2, 3, 4, 5, 6]);
  assert.ok(created.nextSendAt instanceof Date);
});

test("foreground context sync preserves an existing opt-out", async (t) => {
  stub(t, prisma.motivationPreference as any, "findUnique", async () => ({
    enabled: false, weekdays: [0, 2], timeZone: "Europe/Paris", language: "fr", nextSendAt: null,
  }));
  stub(t, prisma.motivationPreference as any, "update", async () => { throw new Error("unexpected update"); });
  const settings = await saveMotivationContext(USER, "Europe/Paris", "fr");
  assert.equal(settings.enabled, false);
  assert.deepEqual(settings.weekdays, [0, 2]);
});

test("an overlapping reminder run sends at most once for one local day", async (t) => {
  const scheduledAt = nextMotivationAt(new Date("2026-10-07T12:00:00Z"), "Europe/Paris", [0, 1, 2, 3, 4, 5, 6], USER);
  assert.ok(scheduledAt);
  const preference = {
    id: "507f1f77bcf86cd799439012", userId: USER, enabled: true,
    weekdays: [0, 1, 2, 3, 4, 5, 6], timeZone: "Europe/Paris", language: "fr", nextSendAt: scheduledAt,
  };
  stub(t, prisma.motivationPreference as any, "findMany", async () => [preference]);
  stub(t, prisma.motivationPreference as any, "findFirst", async () => ({ id: preference.id }));
  stub(t, prisma.motivationPreference as any, "updateMany", async () => ({ count: 1 }));
  stub(t, prisma.focusEvent as any, "findFirst", async () => null);
  stub(t, prisma.liveSession as any, "findFirst", async () => null);
  stub(t, prisma.pushToken as any, "findMany", async () => [{ token: TOKEN, deviceId: "phone", userId: USER }]);
  stub(t, prisma.device as any, "findFirst", async () => ({ id: "507f1f77bcf86cd799439013" }));
  stub(t, prisma.user as any, "findUnique", async () => ({ displayName: null }));
  stub(t, prisma.motivationSend as any, "findMany", async () => []);
  let claims = 0;
  stub(t, prisma.motivationSend as any, "create", async () => {
    if (claims++ === 0) return {};
    throw new Prisma.PrismaClientKnownRequestError("duplicate", { code: "P2002", clientVersion: "5.22.0" });
  });
  stub(t, prisma.motivationSend as any, "update", async () => ({}));
  stub(t, prisma.notificationDelivery as any, "findMany", async () => []);
  stub(t, prisma.notificationDelivery as any, "createMany", async () => ({ count: 1 }));
  let requests = 0;
  stub(t, globalThis as any, "fetch", async () => {
    requests++;
    return { ok: true, json: async () => ({ data: [{ status: "ok", id: "ticket-1" }] }) };
  });

  const first = await drainMotivationReminders(scheduledAt);
  const replay = await drainMotivationReminders(scheduledAt);
  assert.equal(first.sent, 1);
  assert.equal(replay.contended, 1);
  assert.equal(requests, 1);
});

test("a focus session already recorded today suppresses the reminder", async (t) => {
  const scheduledAt = nextMotivationAt(new Date("2026-10-07T12:00:00Z"), "Europe/Paris", [0, 1, 2, 3, 4, 5, 6], USER);
  assert.ok(scheduledAt);
  stub(t, prisma.motivationPreference as any, "findMany", async () => [{
    id: "507f1f77bcf86cd799439012", userId: USER, enabled: true,
    weekdays: [0, 1, 2, 3, 4, 5, 6], timeZone: "Europe/Paris", language: "fr", nextSendAt: scheduledAt,
  }]);
  stub(t, prisma.motivationPreference as any, "updateMany", async () => ({ count: 1 }));
  stub(t, prisma.focusEvent as any, "findFirst", async () => ({ id: "already-focused" }));
  stub(t, prisma.liveSession as any, "findFirst", async () => null);
  stub(t, prisma.motivationSend as any, "create", async () => { throw new Error("unexpected claim"); });
  const report = await drainMotivationReminders(scheduledAt);
  assert.equal(report.skipped, 1);
  assert.equal(report.sent, 0);
});
