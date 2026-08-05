import assert from "node:assert/strict";
import { test } from "node:test";
import request from "supertest";
import { createApp } from "../app";
import { prisma } from "../lib/prisma";
import { env } from "../lib/env";

/**
 * The scheduled reminder.
 *
 * Two properties carry it, and both are about damage rather than features: an
 * unauthenticated caller must never be able to make us email real customers, and
 * a customer must never be warned twice about the same charge.
 */

const app = createApp();

type Ctx = { after: (fn: () => void) => void };

function stubMethod(t: Ctx, target: Record<string, any>, name: string, impl: (...a: any[]) => any) {
  const original = target[name];
  const calls: any[][] = [];
  target[name] = (...args: any[]) => {
    calls.push(args);
    return impl(...args);
  };
  t.after(() => {
    target[name] = original;
  });
  return calls;
}

const SECRET = "cron-test-secret";
const ORIGINAL = env.cronSecret;
env.cronSecret = SECRET;
test.after(() => {
  env.cronSecret = ORIGINAL;
});

const auth = { authorization: `Bearer ${SECRET}` };

const dueRow = (over: Record<string, any> = {}) => ({
  id: "sub-1",
  interval: "yearly",
  trialEndsAt: new Date(Date.now() + 40 * 60 * 60 * 1000),
  customerPortalUrl: "https://x/portal",
  user: { email: "buyer@example.com" },
  ...over,
});

/* ── Who may ring the bell ───────────────────────────────────────────── */

test("no secret, no send", async (t) => {
  const finds = stubMethod(t, prisma.subscription as any, "findMany", async () => [dueRow()]);

  const res = await request(app).get("/api/cron/trial-reminders");

  assert.equal(res.status, 401);
  assert.equal(finds.length, 0, "the database is not even read");
});

test("a wrong secret is refused", async (t) => {
  stubMethod(t, prisma.subscription as any, "findMany", async () => [dueRow()]);
  const res = await request(app)
    .get("/api/cron/trial-reminders")
    .set({ authorization: "Bearer not-the-secret" });
  assert.equal(res.status, 401);
});

/*
 * An UNSET secret closes the route rather than opening it. A fresh deploy is in
 * that state, and failing open there would expose an endpoint that emails real
 * customers for as long as it took someone to notice.
 */
test("an unconfigured secret disables the job instead of exposing it", async (t) => {
  const saved = env.cronSecret;
  env.cronSecret = "";
  t.after(() => {
    env.cronSecret = saved;
  });
  stubMethod(t, prisma.subscription as any, "findMany", async () => [dueRow()]);

  const res = await request(app).get("/api/cron/trial-reminders").set(auth);
  assert.equal(res.status, 401);
});

/* ── Sending once ────────────────────────────────────────────────────── */

test("a due trial is stamped BEFORE the send, so a crash cannot double-warn", async (t) => {
  stubMethod(t, prisma.subscription as any, "findMany", async () => [dueRow()]);
  const updates = stubMethod(t, prisma.subscription as any, "update", async () => ({}));
  // No RESEND key in tests, so the send reports `skipped` — which is a FAILURE
  // for our purposes and must unstamp the row.
  const res = await request(app).get("/api/cron/trial-reminders").set(auth);

  assert.equal(res.status, 200);
  assert.ok(updates.length >= 1, "the row is stamped before anything is sent");
  assert.ok(updates[0][0].data.trialReminderSentAt instanceof Date);
});

/*
 * A send that failed must not leave someone unwarned for ever. The stamp is
 * rolled back so the next run retries — which recovers a transient Resend error
 * without reopening the duplicate risk for a job that died mid-write.
 */
test("a failed send unstamps the row so the next run retries", async (t) => {
  stubMethod(t, prisma.subscription as any, "findMany", async () => [dueRow()]);
  const updates = stubMethod(t, prisma.subscription as any, "update", async () => ({}));

  const res = await request(app).get("/api/cron/trial-reminders").set(auth);

  assert.equal(res.body.failed, 1, "an unconfigured mailer is a failure, not a success");
  assert.equal(updates.length, 2, "stamped, then unstamped");
  assert.equal(updates[1][0].data.trialReminderSentAt, null);
});

/*
 * The query is what makes this idempotent across runs — already-reminded rows
 * never come back, and the window is wide enough that a daily job cannot step
 * over someone.
 */
test("the query asks only for un-reminded trials inside the window", async (t) => {
  const finds = stubMethod(t, prisma.subscription as any, "findMany", async () => []);
  stubMethod(t, prisma.subscription as any, "update", async () => ({}));

  await request(app).get("/api/cron/trial-reminders").set(auth);

  const where = finds[0][0].where;
  assert.equal(where.status, "on_trial");
  assert.equal(where.trialReminderSentAt, null, "already-warned rows never return");
  assert.ok(where.trialEndsAt.gte instanceof Date);
  assert.ok(where.trialEndsAt.lte instanceof Date);
  const spanHours = (where.trialEndsAt.lte - where.trialEndsAt.gte) / 3_600_000;
  assert.ok(spanHours >= 24, "wide enough that a daily run cannot step over anyone");
});
