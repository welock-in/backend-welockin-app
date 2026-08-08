import assert from "node:assert/strict";
import { test } from "node:test";
import request from "supertest";
import { createApp } from "../app";
import { prisma } from "../lib/prisma";
import { env } from "../lib/env";
import { signAdminToken } from "../lib/admin-jwt";

/**
 * The recourse routes: comp, revoke, and giving a machine its trial back.
 *
 * They exist because the "one trial per machine" ledger WILL be wrong sometimes
 * — a shared family PC, a resold laptop, a replaced motherboard — and a rule
 * with no way out turns a support ticket into a lost customer. So what these
 * tests pin is not the happy path but the two properties that make the routes
 * safe to hand to a human: every write is audited with a mandatory reason, and
 * the destructive one cannot be reached by a mis-click.
 */

const app = createApp();
const USER = "507f1f77bcf86cd799439011";

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

const ORIGINAL_ADMIN_PASSWORD = env.adminPassword;
env.adminPassword = "test-admin-password";
const auth = { authorization: `Bearer ${signAdminToken(env.adminUsername)}` };
test.after(() => {
  env.adminPassword = ORIGINAL_ADMIN_PASSWORD;
});

const USER_ROW = {
  id: USER,
  email: "user@example.com",
  compActive: false,
  compedUntil: null,
  accessRevoked: false,
  trialEndsAt: new Date("2026-08-10T00:00:00.000Z"),
};

/** Stubs the reads and writes these routes touch, and records them. */
function stubDb(t: Ctx, over: Record<string, any> = {}) {
  stubMethod(t, prisma.user as any, "findUnique", over.userFind ?? (async () => ({ ...USER_ROW })));
  return {
    userUpdate: stubMethod(t, prisma.user as any, "update", async (a: any) => ({
      ...USER_ROW,
      ...a.data,
    })),
    audit: stubMethod(t, prisma.adminAuditLog as any, "create", async () => ({})),
    claimFind: stubMethod(
      t,
      prisma.trialClaim as any,
      "findMany",
      over.claimFind ?? (async () => [{ id: "claim-1", endsAt: USER_ROW.trialEndsAt, deviceIdHash: "h" }]),
    ),
    claimDelete: stubMethod(t, prisma.trialClaim as any, "deleteMany", async () => ({ count: 1 })),
    signalDelete: stubMethod(t, prisma.deviceSignal as any, "deleteMany", async () => ({ count: 3 })),
  };
}

/* ── Comp ────────────────────────────────────────────────────────────── */

test("a comp without a reason is refused", async (t) => {
  stubDb(t);
  const res = await request(app).post(`/api/admin/users/${USER}/comp`).set(auth).send({});
  assert.equal(res.status, 400);
});

test("a comp with no end date is a LIFETIME grant, and is audited", async (t) => {
  const db = stubDb(t);

  const res = await request(app)
    .post(`/api/admin/users/${USER}/comp`)
    .set(auth)
    .send({ reason: "support goodwill after a botched reinstall" });

  assert.equal(res.status, 200);
  assert.equal(db.userUpdate[0][0].data.compActive, true);
  assert.equal(db.userUpdate[0][0].data.compedUntil, null, "no end date means lifetime");
  assert.equal(db.audit.length, 1, "the override is recorded");
  assert.equal(db.audit[0][0].data.action, "comp");
  assert.equal(db.audit[0][0].data.targetUserId, USER);
  assert.match(db.audit[0][0].data.reason, /botched reinstall/);
});

test("a comp with an end date is time-boxed, not lifetime", async (t) => {
  const db = stubDb(t);

  await request(app)
    .post(`/api/admin/users/${USER}/comp`)
    .set(auth)
    .send({ reason: "extending the trial by a week", until: "2026-09-01T00:00:00.000Z" });

  assert.ok(db.userUpdate[0][0].data.compedUntil instanceof Date);
});

/* ── Revoke ──────────────────────────────────────────────────────────── */

test("a revocation is recorded with its reason", async (t) => {
  const db = stubDb(t);

  const res = await request(app)
    .post(`/api/admin/users/${USER}/revoke`)
    .set(auth)
    .send({ reason: "chargeback on order 9090213" });

  assert.equal(res.status, 200);
  assert.equal(db.userUpdate[0][0].data.accessRevoked, true);
  assert.ok(db.userUpdate[0][0].data.revokedAt instanceof Date);
  assert.equal(db.audit[0][0].data.action, "revoke");
});

test("undoing a revocation clears the stamp rather than leaving a stale date", async (t) => {
  const db = stubDb(t);

  await request(app)
    .delete(`/api/admin/users/${USER}/revoke`)
    .set(auth)
    .send({ reason: "chargeback was reversed" });

  assert.equal(db.userUpdate[0][0].data.accessRevoked, false);
  assert.equal(db.userUpdate[0][0].data.revokedAt, null);
});

/* ── Trial reset — the destructive one ───────────────────────────────── */

/*
 * This route performs the exact operation the ledger exists to prevent. The
 * confirmation is the whole safety mechanism, so it is the thing worth pinning:
 * without it, a mis-click on the wrong row in an admin list hands out a second
 * free window and there is no way to tell it apart from a legitimate reset.
 */
test("a trial reset whose confirmation does not match the path is refused", async (t) => {
  const db = stubDb(t);

  const res = await request(app)
    .post(`/api/admin/users/${USER}/trial-reset`)
    .set(auth)
    .send({ reason: "replaced motherboard", confirmUserId: "507f1f77bcf86cd799439099" });

  assert.equal(res.status, 400);
  assert.equal(db.claimDelete.length, 0, "nothing is deleted on a mismatch");
});

test("a trial reset deletes the signals with the claim, and clears the legacy window", async (t) => {
  const db = stubDb(t);

  const res = await request(app)
    .post(`/api/admin/users/${USER}/trial-reset`)
    .set(auth)
    .send({ reason: "replaced motherboard", confirmUserId: USER });

  assert.equal(res.status, 200);
  assert.equal(db.signalDelete.length, 1, "the hardware signals go with the claim");
  assert.equal(db.claimDelete.length, 1);
  assert.equal(
    db.userUpdate[0][0].data.trialEndsAt,
    null,
    "the legacy per-account window must go too, or the resolver keeps answering from it",
  );
  assert.equal(db.audit[0][0].data.action, "reset_trial");
});

test("a trial reset on an account with no claim is a no-op, not an error", async (t) => {
  const db = stubDb(t, { claimFind: async () => [] });

  const res = await request(app)
    .post(`/api/admin/users/${USER}/trial-reset`)
    .set(auth)
    .send({ reason: "nothing to reset", confirmUserId: USER });

  assert.equal(res.status, 200);
  assert.equal(res.body.claimsDeleted, 0);
  assert.equal(db.claimDelete.length, 0);
});

/* ── Admin cancel-subscription ───────────────────────────────────────── */

function stubFetch(t: Ctx, impl: (...a: any[]) => any) {
  const original = globalThis.fetch;
  (globalThis as any).fetch = impl;
  t.after(() => {
    (globalThis as any).fetch = original;
  });
}

test("admin cancel-subscription deletes at Lemon Squeezy and audits it", async (t) => {
  const db = stubDb(t);
  const ORIGINAL_KEY = env.lemonSqueezyApiKey;
  (env as any).lemonSqueezyApiKey = "test-key";
  t.after(() => {
    (env as any).lemonSqueezyApiKey = ORIGINAL_KEY;
  });
  stubMethod(t, prisma.subscription as any, "findFirst", async () => ({
    externalId: "77001",
    status: "active",
  }));
  let method = "";
  let url = "";
  stubFetch(t, async (u: string, i: any) => {
    method = i.method;
    url = u;
    return { ok: true, status: 200, json: async () => ({ data: { attributes: { ends_at: "2026-09-01T00:00:00.000Z" } } }) };
  });

  const res = await request(app)
    .post(`/api/admin/users/${USER}/cancel-subscription`)
    .set(auth)
    .send({ reason: "customer asked support to cancel", externalId: "77001" });

  assert.equal(res.status, 202);
  assert.equal(method, "DELETE");
  assert.ok(url.endsWith("/v1/subscriptions/77001"), url);
  assert.equal(res.body.endsAt, "2026-09-01T00:00:00.000Z");
  assert.equal(db.audit[0][0].data.action, "cancel_subscription");
});

test("admin cancel-subscription refuses an id that is not the account's", async (t) => {
  stubDb(t);
  const ORIGINAL_KEY = env.lemonSqueezyApiKey;
  (env as any).lemonSqueezyApiKey = "test-key";
  t.after(() => {
    (env as any).lemonSqueezyApiKey = ORIGINAL_KEY;
  });
  // The ownership scope is in the WHERE: findFirst({userId, externalId}) misses.
  const finds = stubMethod(t, prisma.subscription as any, "findFirst", async () => null);
  let called = false;
  stubFetch(t, async () => {
    called = true;
    return { ok: true, status: 200, json: async () => ({}) };
  });

  const res = await request(app)
    .post(`/api/admin/users/${USER}/cancel-subscription`)
    .set(auth)
    .send({ reason: "wrong id on purpose", externalId: "99999" });

  assert.equal(res.status, 404);
  assert.equal(called, false, "Lemon Squeezy is never called for a non-owned id");
  assert.equal(finds[0][0].where.userId, USER, "ownership is scoped in the query");
});

/* ── Audited writes ──────────────────────────────────────────────────── */

test("set-plan is audited with before/after", async (t) => {
  const db = stubDb(t, { userFind: async () => ({ ...USER_ROW, plan: "trial" }) });

  const res = await request(app)
    .post(`/api/admin/users/${USER}/plan`)
    .set(auth)
    .send({ plan: "lifetime", reason: "granted after a support call" });

  assert.equal(res.status, 200);
  assert.equal(db.audit.length, 1);
  assert.equal(db.audit[0][0].data.action, "set_plan");
  assert.equal(db.audit[0][0].data.after.plan, "lifetime");
});

/* ── Auth ────────────────────────────────────────────────────────────── */

test("none of these are reachable without an admin token", async () => {
  for (const path of [
    `/api/admin/users/${USER}/comp`,
    `/api/admin/users/${USER}/revoke`,
    `/api/admin/users/${USER}/cancel-subscription`,
  ]) {
    const res = await request(app).post(path).send({ reason: "no token" });
    assert.equal(res.status, 401, path);
  }
});
