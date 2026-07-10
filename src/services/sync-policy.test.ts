import assert from "node:assert/strict";
import { test } from "node:test";
import { shouldReplaceSnapshot } from "./sync-policy";
import { syncPushSchema } from "../validation/schemas";

const event = {
  name: "Phone focus",
  startedAt: 1_784_000_000_000,
  endedAt: 1_784_001_800_000,
  plannedSeconds: 1800,
  completed: true,
  hardLock: false,
};

test("the current PC payload replaces the complete snapshot", () => {
  const input = syncPushSchema.parse({ blocklists: [], sessions: [], schedules: [] });
  assert.equal(shouldReplaceSnapshot(input), true);
});

test("a legacy mobile event push cannot overwrite the PC snapshot", () => {
  const input = syncPushSchema.parse({
    blocklists: [{ stale: true }],
    sessions: [{ stale: true }],
    events: [event],
  });
  assert.equal(shouldReplaceSnapshot(input), false);
});

test("an event-only request leaves the PC snapshot untouched", () => {
  const input = syncPushSchema.parse({ events: [event] });
  assert.equal(shouldReplaceSnapshot(input), false);
});

test("a caller can explicitly combine a snapshot replacement and events", () => {
  const input = syncPushSchema.parse({
    blocklists: [],
    sessions: [],
    events: [event],
    replaceSnapshot: true,
  });
  assert.equal(shouldReplaceSnapshot(input), true);
});
