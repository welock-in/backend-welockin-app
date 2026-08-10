import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import request from "supertest";
import { createApp } from "../app";
import { prisma } from "../lib/prisma";
import { env } from "../lib/env";

/**
 * The scheduled drain is the only unauthenticated-by-token route that spends our
 * Lemon Squeezy quota, so its guard is the whole test surface: an open endpoint
 * here is a free way for anyone to burn the API key and make the billing pipeline
 * fail precisely when it is needed.
 */

const app = createApp();
const SECRET = "cron-secret-for-tests";

function setSecret(t: TestContext, value: string) {
  const before = env.cronSecret;
  (env as any).cronSecret = value;
  t.after(() => {
    (env as any).cronSecret = before;
  });
}

/** The drain reads the outbox; nothing here is about what it finds. */
function stubEmptyOutbox(t: TestContext) {
  const bt = prisma.billingTask as any;
  const before = { findMany: bt.findMany, count: bt.count };
  bt.findMany = async () => [];
  bt.count = async () => 0;
  t.after(() => {
    bt.findMany = before.findMany;
    bt.count = before.count;
  });
}

function quiet(t: TestContext) {
  const realWarn = console.warn;
  const realError = console.error;
  console.warn = () => {};
  console.error = () => {};
  t.after(() => {
    console.warn = realWarn;
    console.error = realError;
  });
}

/*
 * AN UNSET SECRET REFUSES, rather than allowing everyone — which is how this kind
 * of guard usually fails. The safe reading of a missing secret is a cron that does
 * not run, visible in the console within a tick, rather than one anybody on the
 * internet can run, visible never.
 */
test("with no CRON_SECRET configured the route refuses everyone", async (t) => {
  setSecret(t, "");
  quiet(t);

  const res = await request(app)
    .post("/api/cron/billing-tasks")
    .set("authorization", "Bearer anything");

  assert.equal(res.status, 503);
});

test("a caller with no credentials is rejected", async (t) => {
  setSecret(t, SECRET);
  quiet(t);

  const res = await request(app).post("/api/cron/billing-tasks");

  assert.equal(res.status, 401);
});

test("a caller with the wrong secret is rejected", async (t) => {
  setSecret(t, SECRET);
  quiet(t);

  const res = await request(app)
    .post("/api/cron/billing-tasks")
    .set("authorization", "Bearer not-the-secret");

  assert.equal(res.status, 401);
});

test("a secret of the right length but wrong content is still rejected", async (t) => {
  // The compare is constant-time and length-checked; this pins that a same-length
  // value cannot slip through some accidental prefix comparison.
  setSecret(t, SECRET);
  quiet(t);

  const res = await request(app)
    .post("/api/cron/billing-tasks")
    .set("authorization", `Bearer ${"x".repeat(SECRET.length)}`);

  assert.equal(res.status, 401);
});

test("the scheduler's own request runs the drain and gets a report", async (t) => {
  setSecret(t, SECRET);
  stubEmptyOutbox(t);

  const res = await request(app)
    .post("/api/cron/billing-tasks")
    .set("authorization", `Bearer ${SECRET}`);

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { due: 0, settled: 0, contended: 0, stillOwed: 0, deadLettered: 0 });
});

/*
 * Vercel issues GET for cron paths. Both verbs exist deliberately — POST is what
 * an operator reaches for with curl during an incident — and both must be guarded
 * identically, because a guard applied to only one of them is no guard.
 */
test("GET is accepted for the scheduler, and guarded the same way", async (t) => {
  setSecret(t, SECRET);
  stubEmptyOutbox(t);
  quiet(t);

  const bad = await request(app).get("/api/cron/billing-tasks");
  assert.equal(bad.status, 401);

  const good = await request(app)
    .get("/api/cron/billing-tasks")
    .set("authorization", `Bearer ${SECRET}`);
  assert.equal(good.status, 200);
});

test("the secret is accepted with or without the Bearer prefix", async (t) => {
  // Schedulers and curl one-liners disagree about this often enough that a
  // rejection here would read as "the cron is broken" rather than "wrong header".
  setSecret(t, SECRET);
  stubEmptyOutbox(t);

  const res = await request(app).post("/api/cron/billing-tasks").set("authorization", SECRET);

  assert.equal(res.status, 200);
});
