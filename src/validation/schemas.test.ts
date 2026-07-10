import assert from "node:assert/strict";
import { test } from "node:test";
import { appleAuthSchema, focusEventInputSchema, syncPushSchema } from "./schemas";

const event = {
  name: "Deep work",
  startedAt: Date.UTC(2026, 6, 10, 8, 0, 0),
  endedAt: Date.UTC(2026, 6, 10, 8, 30, 0),
  plannedSeconds: 1800,
  completed: true,
  hardLock: false,
  platform: "android" as const,
  deviceId: "android-device-1",
  clientEventId: "event-1",
};

test("focus events accept the Android platform and stable device identity", () => {
  const parsed = focusEventInputSchema.parse(event);
  assert.equal(parsed.platform, "android");
  assert.equal(parsed.deviceId, "android-device-1");
  assert.equal(parsed.clientEventId, "event-1");
  assert.equal(parsed.emergencyUsed, false);
});

test("Apple auth strips untrusted email and name hints", () => {
  const parsed = appleAuthSchema.parse({
    identityToken: "signed-token",
    email: "victim@example.com",
    fullName: "Untrusted Name",
  });
  assert.deepEqual(parsed, { identityToken: "signed-token" });
});

test("sync accepts append-only events without a snapshot", () => {
  const parsed = syncPushSchema.parse({ events: [event] });
  assert.equal(parsed.events?.length, 1);
  assert.equal(parsed.replaceSnapshot, false);
});

test("sync requires both PC snapshot arrays when replacing state", () => {
  assert.throws(() => syncPushSchema.parse({ blocklists: [] }));
  assert.doesNotThrow(() =>
    syncPushSchema.parse({ blocklists: [], sessions: [], schedules: [] }),
  );
});
