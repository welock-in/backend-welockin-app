import assert from "node:assert/strict";
import { test } from "node:test";
import request from "supertest";
import { createApp } from "../app";
import { prisma } from "../lib/prisma";
import { env } from "../lib/env";
import { signAdminToken } from "../lib/admin-jwt";
import { FUNNEL_ACTIVE_WINDOW_MS, summarise } from "./funnel";

/*
 * The signup-funnel step log.
 *
 * The write endpoint is PUBLIC — the funnel runs before the account exists —
 * so what stands in for auth is worth pinning: the platform allow-list, and
 * the `eventCount` ordering guard that keeps a delayed earlier packet from
 * rolling a run's record backwards. The drop-off fold is the other thing worth
 * a test: "farthest step reached" must follow walk order, not log order.
 *
 * Same harness as referrals.test.ts: no test database, Prisma methods are
 * monkey-patched per test.
 */

// The limiter is not what is under test, and its counter is a Prisma table.
(env as { authRateLimitDisabled: boolean }).authRateLimitDisabled = true;

const app = createApp();

type Ctx = { after: (fn: () => void) => void };

function stubMethod(
  t: Ctx,
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

/** Admin auth is env-credential based; give the suite a usable token. */
const ORIGINAL_ADMIN_PASSWORD = env.adminPassword;
env.adminPassword = "test-admin-password";
const auth = { authorization: `Bearer ${signAdminToken(env.adminUsername)}` };
test.after(() => {
  env.adminPassword = ORIGINAL_ADMIN_PASSWORD;
});

const RUN_ID = "sub_0123456789abcdef";

function packet(overrides: Record<string, unknown> = {}) {
  return {
    runId: RUN_ID,
    seq: 2,
    platform: "windows",
    deviceId: "win-abc",
    deviceName: "DESKTOP-HEDI",
    appVersion: "0.3.34",
    startedAt: "2026-08-28T10:00:00.000Z",
    steps: [
      { step: "intro", enteredAt: null, leftAt: "2026-08-28T10:00:00.000Z", ms: null },
      { step: "name", enteredAt: "2026-08-28T10:00:00.000Z", leftAt: "2026-08-28T10:00:07.000Z", ms: 7000 },
    ],
    ...overrides,
  };
}

// --- write side --------------------------------------------------------------

test("a packet replaces the run's record, guarded so it can never go backwards", async (t) => {
  const updates = stubMethod(t, prisma.funnelRun as any, "updateMany", async () => ({ count: 1 }));
  const creates = stubMethod(t, prisma.funnelRun as any, "create", async () => ({}));

  const res = await request(app).post("/api/funnel/track").send(packet());

  assert.equal(res.status, 204);
  assert.equal(creates.length, 0, "an existing run is updated, not re-created");
  assert.equal(updates.length, 1);
  const args = updates[0][0];
  assert.equal(args.where.runId, RUN_ID);
  // The load-bearing line: the guard is the SEQ, not the log length — the
  // completion packet does not grow the log, so equal-length packets with
  // different content exist and only seq can order them.
  assert.deepEqual(args.where.seq, { lte: 2 });
  assert.equal(args.data.seq, 2);
  assert.equal(args.data.eventCount, 2);
  assert.equal(args.data.deviceName, "DESKTOP-HEDI");
  assert.equal(args.data.lastStep, "name", "lastStep falls back to the log's last entry");
  assert.equal(args.data.steps[1].ms, 7000);
});

test("a month-long dwell is clamped, never refused — a refusal would poison every later packet", async (t) => {
  const updates = stubMethod(t, prisma.funnelRun as any, "updateMany", async () => ({ count: 1 }));
  const cap = 30 * 24 * 60 * 60 * 1000;

  const res = await request(app)
    .post("/api/funnel/track")
    .send(
      packet({
        steps: [{ step: "name", enteredAt: "2026-07-01T10:00:00.000Z", leftAt: "2026-08-28T10:00:00.000Z", ms: cap * 2 }],
      }),
    );

  assert.equal(res.status, 204);
  assert.equal(updates[0][0].data.steps[0].ms, cap);
});

test("losing the create race retries the guarded replace instead of dropping the packet", async (t) => {
  const updates = stubMethod(t, prisma.funnelRun as any, "updateMany", async () => ({ count: 0 }));
  stubMethod(t, prisma.funnelRun as any, "create", async () => {
    throw Object.assign(new Error("E11000"), { code: "P2002" });
  });

  const res = await request(app).post("/api/funnel/track").send(packet());

  assert.equal(res.status, 204);
  // The row that won the race is not necessarily newer — the replace runs
  // again, still behind the same seq guard.
  assert.equal(updates.length, 2);
  assert.deepEqual(updates[1][0].where.seq, { lte: 2 });
});

test("the first packet of a run creates the record", async (t) => {
  stubMethod(t, prisma.funnelRun as any, "updateMany", async () => ({ count: 0 }));
  const creates = stubMethod(t, prisma.funnelRun as any, "create", async () => ({}));

  const res = await request(app).post("/api/funnel/track").send(packet());

  assert.equal(res.status, 204);
  assert.equal(creates.length, 1);
  assert.equal(creates[0][0].data.runId, RUN_ID);
});

test("an unknown platform is discarded silently, not refused and not written", async (t) => {
  const updates = stubMethod(t, prisma.funnelRun as any, "updateMany", async () => ({ count: 1 }));

  const res = await request(app)
    .post("/api/funnel/track")
    .send(packet({ platform: "toaster" }));

  assert.equal(res.status, 204);
  assert.equal(updates.length, 0);
});

test("a malformed run id is a 400 — that shape is our own client's contract", async () => {
  const res = await request(app).post("/api/funnel/track").send(packet({ runId: "x" }));
  assert.equal(res.status, 400);
});

test("a baroque computer name is truncated, never a 400", async (t) => {
  const updates = stubMethod(t, prisma.funnelRun as any, "updateMany", async () => ({ count: 1 }));

  const res = await request(app)
    .post("/api/funnel/track")
    .send(packet({ deviceName: "N".repeat(300) }));

  assert.equal(res.status, 204);
  assert.equal(updates[0][0].data.deviceName.length, 80);
});

test("an unparseable startedAt is dropped silently — no t0, no run", async (t) => {
  const updates = stubMethod(t, prisma.funnelRun as any, "updateMany", async () => ({ count: 1 }));

  const res = await request(app)
    .post("/api/funnel/track")
    .send(packet({ startedAt: "not-a-date" }));

  assert.equal(res.status, 204);
  assert.equal(updates.length, 0);
});

// --- the fold ----------------------------------------------------------------

const NOW = new Date("2026-08-28T12:00:00.000Z");

function storedRun(overrides: Record<string, any> = {}) {
  return {
    runId: RUN_ID,
    platform: "windows",
    deviceId: "win-abc",
    deviceName: "DESKTOP-HEDI",
    osVersion: null,
    appVersion: "0.3.34",
    funnelVersion: "desktop_v2",
    locale: "fr-FR",
    withAccount: true,
    screenTotal: 13,
    startedAt: new Date("2026-08-28T11:00:00.000Z"),
    completedAt: null,
    lastSeenAt: new Date("2026-08-28T11:05:00.000Z"),
    lastStep: "plan",
    steps: [
      { step: "intro", enteredAt: null, leftAt: "2026-08-28T11:00:00.000Z", ms: null },
      { step: "name", enteredAt: "2026-08-28T11:00:00.000Z", leftAt: "2026-08-28T11:00:07.000Z", ms: 7000 },
      { step: "plan", enteredAt: "2026-08-28T11:00:07.000Z", leftAt: null, ms: null },
    ],
    ...overrides,
  };
}

test("status: completed beats the clock; otherwise the active window decides", () => {
  const { runs } = summarise(
    [
      storedRun({ runId: "run_completed_00", completedAt: new Date("2026-08-28T11:06:00.000Z") }),
      storedRun({ runId: "run_active_00000", lastSeenAt: new Date(NOW.getTime() - FUNNEL_ACTIVE_WINDOW_MS + 1000) }),
      storedRun({ runId: "run_abandoned_00", lastSeenAt: new Date("2026-08-28T11:05:00.000Z") }),
    ],
    NOW,
  );
  assert.deepEqual(
    runs.map((r) => r.status),
    ["completed", "active", "abandoned"],
  );
  // Completed: startedAt → completedAt. Abandoned: startedAt → lastSeenAt.
  assert.equal(runs[0].durationMs, 6 * 60 * 1000);
  assert.equal(runs[2].durationMs, 5 * 60 * 1000);
});

test("drop-off follows walk order, not log order, and only abandoned runs drop", () => {
  const { summary } = summarise(
    [
      // A restart: the log revisits `name` AFTER `plan` — farthest is still plan.
      storedRun({
        runId: "run_restarted_00",
        lastStep: "name",
        steps: [
          { step: "plan", enteredAt: null, leftAt: null, ms: null },
          { step: "name", enteredAt: null, leftAt: null, ms: null },
        ],
      }),
      storedRun({
        runId: "run_completed_00",
        completedAt: new Date("2026-08-28T11:06:00.000Z"),
        lastStep: "verify",
        steps: [{ step: "verify", enteredAt: null, leftAt: null, ms: null }],
      }),
    ],
    NOW,
  );
  const plan = summary.dropoff.find((d) => d.step === "plan");
  assert.equal(plan?.droppedHere, 1, "the restarted run's drop lands on its farthest step");
  const verify = summary.dropoff.find((d) => d.step === "verify");
  assert.equal(verify?.droppedHere, 0, "a completed run never counts as a drop");
  const stepList = summary.dropoff.map((d) => d.step);
  assert.deepEqual(stepList, [...stepList].sort((a, b) => stepList.indexOf(a) - stepList.indexOf(b)));
  assert.ok(stepList.indexOf("name") < stepList.indexOf("plan"), "walk order, not log order");
});

test("a corrupt stored step log renders as empty, never crashes the console", () => {
  const { runs } = summarise([storedRun({ steps: { not: "an array" } })], NOW);
  assert.deepEqual(runs[0].steps, []);
});

// --- read side ---------------------------------------------------------------

test("the console read is admin-gated", async () => {
  const res = await request(app).get("/api/admin/funnel");
  assert.equal(res.status, 401);
});

test("the console gets runs, summary and the walk order back", async (t) => {
  stubMethod(t, prisma.funnelRun as any, "findMany", async () => [
    storedRun({ completedAt: new Date("2026-08-28T11:06:00.000Z") }),
  ]);

  const res = await request(app).get("/api/admin/funnel").set(auth);

  assert.equal(res.status, 200);
  assert.equal(res.body.runs.length, 1);
  assert.equal(res.body.runs[0].deviceName, "DESKTOP-HEDI");
  assert.equal(res.body.summary.completed, 1);
  assert.equal(res.body.windowDays, 14);
  assert.ok(Array.isArray(res.body.stepOrder));
});

test("the platform filter and window clamp reach the query", async (t) => {
  const finds = stubMethod(t, prisma.funnelRun as any, "findMany", async () => []);

  const res = await request(app)
    .get("/api/admin/funnel?platform=macos&days=9999&take=9999")
    .set(auth);

  assert.equal(res.status, 200);
  const args = finds[0][0];
  assert.equal(args.where.platform, "macos");
  assert.equal(args.take, 500);
  assert.equal(res.body.windowDays, 90);
});
