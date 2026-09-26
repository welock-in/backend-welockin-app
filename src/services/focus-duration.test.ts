import assert from "node:assert/strict";
import { test } from "node:test";
import { durationBreakdown, focusDuration, focusEventDurationView } from "./focus-duration";
import { focusEventsV2Schema } from "../validation/schemas";

const startedAt = new Date("2026-09-26T10:00:00Z");
const event = (wallSeconds: number, plannedSeconds = 1800, actualSeconds = 1500) => ({
  startedAt, endedAt: new Date(startedAt.getTime() + wallSeconds * 1000),
  plannedSeconds, actualSeconds, eventVersion: 2,
});

test("v2 credits measured focus once for fixed windows, extended pauses, additions and early stop", () => {
  for (const [wall, planned, actual] of [[1800, 1800, 1500], [2100, 1800, 1800],
    [3000, 2700, 2700], [620, 1800, 600], [0, 0, 0]]) {
    assert.deepEqual(focusDuration(event(wall, planned, actual)), { seconds: actual, basis: "measured" });
  }
});

test("invalid measured duration cannot inflate or fall back to legacy credit", () => {
  for (const e of [event(1200), event(1800, 1000), event(-1), event(1800, 1800, -1),
    event(1800, 1800, 1.5), { ...event(1800), actualSeconds: null },
    { ...event(1800), startedAt: new Date(NaN) }, { ...event(1800), eventVersion: 3 }]) {
    assert.deepEqual(focusDuration(e), { seconds: 0, basis: "unavailable" });
  }
});

test("legacy duration is bounded, explicitly estimated, and never invented without a budget", () => {
  assert.deepEqual(focusDuration({ ...event(7200, 1500), eventVersion: null }), { seconds: 1500, basis: "estimated" });
  assert.deepEqual(focusDuration({ ...event(1800.999), eventVersion: undefined }), { seconds: 1800, basis: "estimated" });
  for (const plannedSeconds of [0, null, undefined, -1]) {
    assert.deepEqual(focusDuration({ ...event(7200), eventVersion: null, plannedSeconds }), { seconds: 0, basis: "unavailable" });
  }
});

test("quality totals and raw admin annotations preserve the source event", () => {
  const measured = event(1800);
  const estimated = { ...event(7200), eventVersion: null };
  const unavailable = { ...event(1800), actualSeconds: null };
  assert.deepEqual(durationBreakdown([measured, estimated, unavailable]), {
    measuredSeconds: 1500, estimatedSeconds: 1800, measuredEvents: 1, estimatedEvents: 1, unavailableEvents: 1,
  });
  const quarantined = { ...measured, quarantined: true };
  assert.equal(focusEventDurationView(quarantined).creditedSeconds, 0);
  assert.equal(focusEventDurationView(quarantined).credited, false);
  assert.equal(focusEventDurationView(estimated).durationBasis, "estimated");
  assert.equal(quarantined.actualSeconds, 1500);
});

const wire = () => ({ name: "Focus", startedAt: startedAt.toISOString(), endedAt: "2026-09-26T10:30:00Z",
  plannedSeconds: 1800, actualSeconds: 1500, completed: true, hardLock: false,
  deviceId: "machine", platform: "windows", clientEventId: "stable-session" });

test("v2 schema requires the complete measured DTO and rejects unknown/snapshot fields", () => {
  const good = { eventVersion: 2, events: [wire()] };
  assert.equal(focusEventsV2Schema.parse(good).events[0].killedTotal, 0);
  for (const field of ["clientEventId", "deviceId", "platform", "actualSeconds", "completed", "hardLock"]) {
    const missing: any = wire(); delete missing[field];
    assert.equal(focusEventsV2Schema.safeParse({ ...good, events: [missing] }).success, false, field);
  }
  for (const payload of [{ ...good, eventVersion: 1 }, { ...good, sessions: [] },
    { ...good, events: [{ ...wire(), userId: "someone-else" }] },
    { ...good, events: [wire(), wire()] }, { ...good, events: [] },
    { ...good, events: Array.from({ length: 51 }, (_, i) => ({ ...wire(), clientEventId: String(i) })) }]) {
    assert.equal(focusEventsV2Schema.safeParse(payload).success, false);
  }
});

test("v2 numeric/date bounds are shared with the credited duration", () => {
  for (const change of [{ actualSeconds: 1801 }, { plannedSeconds: 1000 }, { actualSeconds: 0.5 },
    { startedAt: "2026-09-26T10:31:00Z" }, { endedAt: "invalid" },
    { actualSeconds: 2147483648 }, { plannedSeconds: 2147483648 }, { killedTotal: 2147483648 },
    { clientEventId: "x".repeat(257) }, { deviceId: " " }]) {
    assert.equal(focusEventsV2Schema.safeParse({ eventVersion: 2, events: [{ ...wire(), ...change }] }).success, false);
  }
  assert.equal(focusEventsV2Schema.safeParse({ eventVersion: 2, events: [{ ...wire(),
    endedAt: "2026-09-26T10:00:01.999Z", plannedSeconds: 2, actualSeconds: 2 }] }).success, false);
});
