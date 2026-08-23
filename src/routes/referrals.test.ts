import assert from "node:assert/strict";
import { test } from "node:test";
import request from "supertest";
import { createApp } from "../app";
import { prisma } from "../lib/prisma";
import { env } from "../lib/env";
import { signAdminToken } from "../lib/admin-jwt";
import { REFERRAL_WINDOW_DAYS, summarise } from "./referrals";

/*
 * The QR-code counter.
 *
 * Two things here are worth a test rather than a reading. The write endpoint is
 * PUBLIC — it has to be, its callers have no account — so what stops it becoming
 * a free-text table is the allow-list, and an allow-list nobody tests is an
 * allow-list that will be widened by accident. And the tally is only ever moved
 * by an atomic increment, because the API is serverless and a read-then-write
 * loses scans exactly when a campaign is working; that is invisible in
 * production and obvious here.
 *
 * Same harness as contact.test.ts: no test database, Prisma methods are
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

// --- write side --------------------------------------------------------------

test("a scan of the printed code bumps today's bucket, atomically", async (t) => {
  const upserts = stubMethod(t, prisma.referralHit as any, "upsert", async () => ({}));

  const res = await request(app).post("/api/referrals/hit").send({ source: "qrcode" });

  assert.equal(res.status, 204);
  assert.equal(upserts.length, 1);
  const args = upserts[0][0];
  assert.deepEqual(args.where.source_day.source, "qrcode");
  assert.match(args.where.source_day.day, /^\d{4}-\d{2}-\d{2}$/, "the bucket key is a UTC day");
  assert.equal(args.create.count, 1);
  // The load-bearing line: an increment, never `count: previous + 1`.
  assert.deepEqual(args.update, { count: { increment: 1 } });
});

test("an unknown source is discarded silently, not refused", async (t) => {
  const upserts = stubMethod(t, prisma.referralHit as any, "upsert", async () => ({}));

  const res = await request(app).post("/api/referrals/hit").send({ source: "not-a-campaign" });

  // 204 rather than 400: someone holding a retired flyer is not a client error,
  // and a 4xx here would surface as a failed request in their browser console.
  assert.equal(res.status, 204);
  assert.equal(upserts.length, 0, "nothing outside the allow-list reaches the database");
});

test("two first-scans-of-the-day race, and neither is lost", async (t) => {
  // The loser of the unique-index race: its create is rejected because the
  // winner's row already exists.
  stubMethod(t, prisma.referralHit as any, "upsert", async () => {
    throw new Error("E11000 duplicate key");
  });
  const bumps = stubMethod(t, prisma.referralHit as any, "updateMany", async () => ({ count: 1 }));

  const res = await request(app).post("/api/referrals/hit").send({ source: "qrcode" });

  assert.equal(res.status, 204);
  assert.equal(bumps.length, 1, "the losing scan bumps the winner's row instead of vanishing");
  assert.deepEqual(bumps[0][0].data, { count: { increment: 1 } });
});

test("a request with no source is a 400", async () => {
  const res = await request(app).post("/api/referrals/hit").send({});
  assert.equal(res.status, 400);
});

// --- read side ---------------------------------------------------------------

test("the console's read is admin-only", async () => {
  const res = await request(app).get("/api/admin/referrals");
  assert.equal(res.status, 401);
});

test("the console gets totals and a zero-filled window", async (t) => {
  const now = new Date("2026-08-23T09:00:00.000Z");
  stubMethod(t, prisma.referralHit as any, "findMany", async () => [
    { source: "qrcode", day: "2026-06-01", count: 40 }, // outside the window
    { source: "qrcode", day: "2026-08-20", count: 5 },
    { source: "qrcode", day: "2026-08-23", count: 7 },
  ]);

  const res = await request(app).get("/api/admin/referrals").set(auth);

  assert.equal(res.status, 200);
  const qr = res.body.sources.find((s: any) => s.source === "qrcode");
  assert.equal(qr.total, 52, "total counts every day ever, not just the window");
  assert.equal(qr.days.length, REFERRAL_WINDOW_DAYS);
});

test("summarise: today, the last seven days, and the days in between", () => {
  const now = new Date("2026-08-23T09:00:00.000Z");
  const summary = summarise(
    [
      { source: "qrcode", day: "2026-06-01", count: 40 }, // long before the window
      { source: "qrcode", day: "2026-08-16", count: 3 }, // 7 days back — outside
      { source: "qrcode", day: "2026-08-17", count: 4 }, // the oldest day still in
      { source: "qrcode", day: "2026-08-20", count: 5 },
      { source: "qrcode", day: "2026-08-23", count: 7 }, // today
    ],
    now,
  );

  const qr = summary.sources.find((s) => s.source === "qrcode")!;
  assert.equal(qr.total, 59);
  assert.equal(qr.today, 7);
  // Inclusive of today and the six days before it: 17th + 20th + 23rd. The 16th
  // is the off-by-one this asserts against.
  assert.equal(qr.last7d, 16);

  assert.equal(qr.days.length, REFERRAL_WINDOW_DAYS);
  assert.equal(qr.days[0].day, "2026-08-10", "oldest first");
  assert.equal(qr.days[qr.days.length - 1].day, "2026-08-23", "today last");
  // A day nobody scanned is a zero, not a gap — a sparkline that skips empty
  // days draws a flatter, wrong curve.
  assert.equal(qr.days.find((d) => d.day === "2026-08-18")!.count, 0);
  assert.equal(qr.days.find((d) => d.day === "2026-08-20")!.count, 5);
});

test("summarise: a campaign nobody has scanned yet still shows up, at zero", () => {
  const summary = summarise([], new Date("2026-08-23T09:00:00.000Z"));

  const qr = summary.sources.find((s) => s.source === "qrcode");
  assert.ok(qr, "the console must render the counter before the first scan");
  assert.equal(qr!.total, 0);
  assert.equal(qr!.days.length, REFERRAL_WINDOW_DAYS);
});
