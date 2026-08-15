import assert from "node:assert/strict";
import { test } from "node:test";
import request from "supertest";
import { createApp } from "../app";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { freezeClock, fromFrozen } from "../lib/test-clock";
import { env } from "../lib/env";
import { signAdminToken } from "../lib/admin-jwt";
import { stubNoBillingHolds } from "./test-helpers";

// The set-plan route answers with the RESOLVED entitlement, whose eligibility
// leg (lib/eligibility-io.ts) reads holds and claims no test here installs.
stubNoBillingHolds();

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
  // The interactive-transaction shape: the callback gets a client carrying the
  // same models, so the per-method stubs above apply inside it. `over.tx` lets a
  // test make the transaction itself fail — which is how the 503 path is proved.
  stubMethod(
    t,
    prisma as any,
    "$transaction",
    over.tx ?? (async (fn: any) => (typeof fn === "function" ? fn(prisma) : Promise.all(fn))),
  );
  stubMethod(t, prisma.billingTask as any, "findUnique", over.taskFind ?? (async () => null));
  return {
    taskCreate: stubMethod(t, prisma.billingTask as any, "create", async (a: any) => ({ id: "task-1", ...a.data })),
    taskUpdate: stubMethod(t, prisma.billingTask as any, "update", async () => ({ id: "task-1" })),
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

/** What the post-write recompute reads. Nothing owned, nothing subscribed. */
function stubResolver(t: Ctx) {
  stubMethod(t, prisma.user as any, "findUniqueOrThrow", async () => ({ ...USER_ROW }));
  stubMethod(t, prisma.purchase as any, "findMany", async () => []);
  stubMethod(t, prisma.subscription as any, "findMany", async () => []);
  stubMethod(t, prisma.trialClaim as any, "findFirst", async () => null);
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

  assert.equal(res.status, 200, "an immediate provider success is 200, not 202");
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

/* ── Test lab: synthetic subscriptions ───────────────────────────────── */

function withTestMode(t: Ctx, on: boolean) {
  const before = env.lemonSqueezyAllowTestMode;
  (env as any).lemonSqueezyAllowTestMode = on;
  t.after(() => {
    (env as any).lemonSqueezyAllowTestMode = before;
  });
}

test("conjuring a synthetic subscription forces testMode and a sim_ id", async (t) => {
  stubDb(t);
  withTestMode(t, true);
  const created = stubMethod(t, prisma.subscription as any, "create", async (a: any) => ({ id: "s1", ...a.data }));

  const res = await request(app)
    .post(`/api/admin/users/${USER}/test-subscription`)
    .set(auth)
    .send({ reason: "testing mid-active month", status: "active", interval: "monthly", remainingDays: 17 });

  assert.equal(res.status, 201);
  const data = created[0][0].data;
  assert.equal(data.testMode, true, "always test-mode, never grantable in a live deploy");
  assert.ok(data.externalId.startsWith("sim_"), "a synthetic id can never collide with a real LS id");
  assert.equal(data.status, "active");
  // 17 days out (validUntil, renewsAt for an active row).
  const days = (new Date(data.validUntil).getTime() - Date.now()) / 86_400_000;
  assert.ok(days > 16.9 && days < 17.1, `validUntil ~17d, got ${days}`);
});

test("the test lab is 503 when test mode is off (gate 1)", async (t) => {
  stubDb(t);
  withTestMode(t, false);
  const created = stubMethod(t, prisma.subscription as any, "create", async () => ({}));

  const res = await request(app)
    .post(`/api/admin/users/${USER}/test-subscription`)
    .set(auth)
    .send({ reason: "should be blocked", status: "active", remainingDays: 5 });

  assert.equal(res.status, 503);
  assert.equal(created.length, 0, "no row is written when the tools are disabled");
});

test("even a synthetic client testMode:false is ignored — the row is forced test", async (t) => {
  stubDb(t);
  withTestMode(t, true);
  const created = stubMethod(t, prisma.subscription as any, "create", async (a: any) => ({ id: "s1", ...a.data }));

  await request(app)
    .post(`/api/admin/users/${USER}/test-subscription`)
    .set(auth)
    // A caller trying to smuggle a real-looking row.
    .send({ reason: "smuggle attempt", status: "active", remainingDays: 5, testMode: false, externalId: "999" });

  assert.equal(created[0][0].data.testMode, true);
  assert.ok(created[0][0].data.externalId.startsWith("sim_"));
});

test("DELETE refuses a row that is not a sim row (webhook stays sole writer)", async (t) => {
  stubDb(t);
  withTestMode(t, true);
  // A REAL LS row (numeric id, testMode false) must be untouchable by the lab.
  stubMethod(t, prisma.subscription as any, "findUnique", async () => ({
    id: "real1",
    userId: USER,
    externalId: "2417513",
    testMode: false,
    status: "active",
    validUntil: new Date(),
  }));
  const del = stubMethod(t, prisma.subscription as any, "delete", async () => ({}));

  const res = await request(app)
    .delete(`/api/admin/users/${USER}/test-subscription/real1`)
    .set(auth)
    .send({ reason: "must be refused" });

  assert.equal(res.status, 404, "a webhook-owned row is never deletable by the test lab");
  assert.equal(del.length, 0);
});

/* ── Lifecycle transitions & time travel ─────────────────────────────── */

test("→ expired is always a LOCAL write (Lemon Squeezy has no 'end it now')", async (t) => {
  stubDb(t);
  withTestMode(t, true);
  stubMethod(t, prisma.subscription as any, "findFirst", async () => ({
    id: "real1",
    userId: USER,
    externalId: "2417513",
    testMode: false,
    status: "active",
    validUntil: new Date(Date.now() + 20 * 86_400_000),
  }));
  const updated = stubMethod(t, prisma.subscription as any, "update", async (a: any) => a.data);
  let calledLs = false;
  stubFetch(t, async () => {
    calledLs = true;
    return { ok: true, status: 200, json: async () => ({}) };
  });

  const res = await request(app)
    .post(`/api/admin/users/${USER}/subscription-transition`)
    .set(auth)
    .send({ reason: "end it for the test", externalId: "2417513", to: "expired" });

  assert.equal(res.status, 202);
  assert.equal(res.body.via, "local", "and it says so, so nobody mistakes it for a real ending");
  assert.equal(calledLs, false);
  assert.equal(updated[0][0].data.status, "expired");
});

test("→ active on a REAL trial converts it at Lemon Squeezy (charges now)", async (t) => {
  stubDb(t);
  withTestMode(t, true);
  const ORIGINAL = env.lemonSqueezyApiKey;
  (env as any).lemonSqueezyApiKey = "test-key";
  t.after(() => {
    (env as any).lemonSqueezyApiKey = ORIGINAL;
  });
  stubMethod(t, prisma.subscription as any, "findFirst", async () => ({
    id: "real1",
    userId: USER,
    externalId: "2417513",
    testMode: false,
    status: "on_trial",
    validUntil: new Date(Date.now() + 3 * 86_400_000),
  }));
  let sent: any = null;
  let method = "";
  stubFetch(t, async (_u: string, i: any) => {
    method = i.method;
    sent = JSON.parse(i.body);
    return { ok: true, status: 200, json: async () => ({}) };
  });

  const res = await request(app)
    .post(`/api/admin/users/${USER}/subscription-transition`)
    .set(auth)
    .send({ reason: "start pro now", externalId: "2417513", to: "active" });

  assert.equal(res.status, 202);
  assert.equal(res.body.via, "lemonsqueezy", "the real pipeline is what we want to test");
  assert.equal(method, "PATCH");
  assert.equal(sent.data.attributes.invoice_immediately, true);
  assert.ok(sent.data.attributes.trial_ends_at, "the trial is ended now");
});

test("setting the time on a REAL trial writes trial_ends_at at Lemon Squeezy", async (t) => {
  stubDb(t);
  withTestMode(t, true);
  const ORIGINAL = env.lemonSqueezyApiKey;
  (env as any).lemonSqueezyApiKey = "test-key";
  t.after(() => {
    (env as any).lemonSqueezyApiKey = ORIGINAL;
  });
  stubMethod(t, prisma.subscription as any, "findFirst", async () => ({
    id: "real1",
    userId: USER,
    externalId: "2417513",
    testMode: false,
    status: "on_trial",
    validUntil: new Date(Date.now() + 6 * 86_400_000),
  }));
  stubMethod(t, prisma.subscription as any, "update", async (a: any) => a.data);
  let sent: any = null;
  stubFetch(t, async (_u: string, i: any) => {
    sent = JSON.parse(i.body);
    return { ok: true, status: 200, json: async () => ({}) };
  });

  // 6 days left -> 2 days and 3 hours.
  const res = await request(app)
    .post(`/api/admin/users/${USER}/subscription-time`)
    .set(auth)
    .send({ reason: "jump to the reminder window", externalId: "2417513", days: 2, hours: 3 });

  assert.equal(res.status, 202);
  assert.equal(res.body.via, "lemonsqueezy");
  const ends = Date.parse(sent.data.attributes.trial_ends_at);
  const hoursOut = (ends - Date.now()) / 3_600_000;
  assert.ok(hoursOut > 50 && hoursOut < 52, `expected ~51h, got ${hoursOut}`);
});

test("the lifecycle controls are 503 when test mode is off", async (t) => {
  stubDb(t);
  withTestMode(t, false);

  const a = await request(app)
    .post(`/api/admin/users/${USER}/subscription-transition`)
    .set(auth)
    .send({ reason: "blocked", externalId: "x", to: "expired" });
  const b = await request(app)
    .post(`/api/admin/users/${USER}/subscription-time`)
    .set(auth)
    .send({ reason: "blocked", externalId: "x", days: 1, hours: 0 });

  assert.equal(a.status, 503);
  assert.equal(b.status, 503);
});

/* ── Audited writes ──────────────────────────────────────────────────── */

/*
 * SET-PLAN USED TO DO NOTHING, convincingly.
 *
 * It wrote `User.plan` — a CACHE that `resolveAndCache` rewrites from the real
 * rows on the next /api/entitlement call. The console showed the new plan, the
 * audit log recorded a change, the customer's access never moved, and the row
 * reverted within minutes. So the test asserts the LEVER now, not the label:
 * the complimentary grant that `computeEntitlement` actually reads.
 */
test("set-plan flips the entitlement lever, not just the cached label", async (t) => {
  const db = stubDb(t, { userFind: async () => ({ ...USER_ROW, plan: "trial" }) });
  stubResolver(t);

  const res = await request(app)
    .post(`/api/admin/users/${USER}/plan`)
    .set(auth)
    .send({
      plan: "lifetime",
      reason: "granted after a support call",
      // A grant with no end date is the one nobody ever notices again, so it has
      // to be typed out rather than clicked.
      confirmUserId: USER,
    });

  assert.equal(res.status, 200);
  const wrote = db.userUpdate[0][0].data;
  assert.equal(wrote.compActive, true, "the grant is written where the resolver looks");
  assert.equal(wrote.compedUntil, null, "lifetime is the one plan allowed to be open-ended");
  assert.equal(db.audit.length, 1);
  assert.equal(db.audit[0][0].data.action, "set_plan");
  assert.match(db.audit[0][0].data.reason, /support call/, "and the reason is kept");
  assert.ok(res.body.entitlement, "the response carries the RESOLVED state, not the wish");
});

/*
 * A PERMANENT grant is the only one that can never be spotted later: it appears
 * in no expiry sweep and no renewal report, and ends only if a human remembers
 * it exists. So it is guarded the same way the trial reset is — by making the
 * operator repeat the id back.
 */
test("a lifetime grant with no end date needs the user id repeated back", async (t) => {
  const db = stubDb(t, { userFind: async () => ({ ...USER_ROW }) });
  stubResolver(t);

  const res = await request(app)
    .post(`/api/admin/users/${USER}/plan`)
    .set(auth)
    .send({ plan: "lifetime", reason: "support goodwill" });

  assert.equal(res.status, 400);
  assert.equal(db.userUpdate.length, 0, "nothing is granted on a mis-click");
});

test("a wrong confirmation is refused like a missing one", async (t) => {
  const db = stubDb(t, { userFind: async () => ({ ...USER_ROW }) });
  stubResolver(t);

  const res = await request(app)
    .post(`/api/admin/users/${USER}/plan`)
    .set(auth)
    .send({ plan: "lifetime", reason: "support goodwill", confirmUserId: "507f1f77bcf86cd799439099" });

  assert.equal(res.status, 400);
  assert.equal(db.userUpdate.length, 0);
});

/*
 * Every hand-granted Pro used to be permanent, which is not a decision anyone
 * made — it is what happens when a field is omitted.
 */
test("a Pro grant must carry an end date", async (t) => {
  const db = stubDb(t, { userFind: async () => ({ ...USER_ROW }) });
  stubResolver(t);

  const res = await request(app)
    .post(`/api/admin/users/${USER}/plan`)
    .set(auth)
    .send({ plan: "pro", reason: "two weeks while their card is reissued" });

  assert.equal(res.status, 400);
  assert.equal(db.userUpdate.length, 0);
});

test("a Pro grant with an end date is time-boxed", async (t) => {
  const db = stubDb(t, { userFind: async () => ({ ...USER_ROW }) });
  stubResolver(t);
  const until = new Date(Date.now() + 14 * 86_400_000).toISOString();

  const res = await request(app)
    .post(`/api/admin/users/${USER}/plan`)
    .set(auth)
    .send({ plan: "pro", reason: "two weeks while their card is reissued", until });

  assert.equal(res.status, 200);
  assert.equal(db.userUpdate[0][0].data.compActive, true);
  assert.equal(db.userUpdate[0][0].data.compedUntil?.toISOString(), until);
});

test("an end date already in the past is refused rather than granted and ignored", async (t) => {
  const db = stubDb(t, { userFind: async () => ({ ...USER_ROW }) });
  stubResolver(t);

  const res = await request(app)
    .post(`/api/admin/users/${USER}/plan`)
    .set(auth)
    .send({ plan: "pro", reason: "backdated by mistake", until: "2020-01-01T00:00:00.000Z" });

  assert.equal(res.status, 400);
  assert.equal(db.userUpdate.length, 0);
});

/* ── the reason is mandatory, and a reason of spaces is not a reason ─────── */

test("set-plan without a reason is refused", async (t) => {
  const db = stubDb(t, { userFind: async () => ({ ...USER_ROW }) });
  stubResolver(t);

  const res = await request(app).post(`/api/admin/users/${USER}/plan`).set(auth).send({ plan: "free" });

  assert.equal(res.status, 400);
  assert.equal(db.userUpdate.length, 0);
});

test("a reason of whitespace is the same as no reason", async (t) => {
  const db = stubDb(t, { userFind: async () => ({ ...USER_ROW }) });
  stubResolver(t);

  const res = await request(app)
    .post(`/api/admin/users/${USER}/plan`)
    .set(auth)
    .send({ plan: "free", reason: "     " });

  assert.equal(res.status, 400);
  assert.equal(db.userUpdate.length, 0);
});

/*
 * WITHDRAWING is a money decision too. Taking someone's access away without a
 * stated reason is exactly as unexplainable six months later as granting it.
 */
test("set-plan to a non-granting plan withdraws the comp, and still needs a reason", async (t) => {
  const db = stubDb(t, { userFind: async () => ({ ...USER_ROW, compActive: true }) });
  stubResolver(t);

  const res = await request(app)
    .post(`/api/admin/users/${USER}/plan`)
    .set(auth)
    .send({ plan: "free", reason: "grant expired" });

  assert.equal(res.status, 200);
  assert.equal(db.userUpdate[0][0].data.compActive, false);
  assert.match(db.audit[0][0].data.reason, /grant expired/);
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

/* ── BUG T1-07 — the console's "trial" silently REVOKED ───────────────────
 *
 * The console dropdown offers "trial"; the backend spells the granting status
 * "trialing". Picking it validated cleanly, skipped the end-date requirement,
 * and wrote compActive:false. The operator read "give them a trial"; it took the
 * grant away, and looked like success.
 *
 * An unknown plan name is now refused rather than treated as a withdrawal.
 */
test("an unknown plan name is refused, not silently treated as a revocation", async (t) => {
  const db = stubDb(t, { userFind: async () => ({ ...USER_ROW, compActive: true }) });
  stubResolver(t);

  const res = await request(app)
    .post(`/api/admin/users/${USER}/plan`)
    .set(auth)
    .send({ plan: "trial", reason: "meant to give them a trial" });

  assert.equal(res.status, 400);
  assert.match(String(res.body.error ?? ""), /Unknown plan/i);
  assert.equal(db.userUpdate.length, 0, "nothing was revoked behind the operator's back");
});

test("the documented withdrawal names still work", async (t) => {
  for (const plan of ["free", "none", "expired", "revoked"]) {
    await t.test(plan, async (t2) => {
      const db = stubDb(t2, { userFind: async () => ({ ...USER_ROW, compActive: true }) });
      stubResolver(t2);
      const res = await request(app)
        .post(`/api/admin/users/${USER}/plan`)
        .set(auth)
        .send({ plan, reason: "grant is over" });
      assert.equal(res.status, 200);
      assert.equal(db.userUpdate[0][0].data.compActive, false);
    });
  }
});

/* ── BUG T1-04 — an admin cancel that fails was simply lost ───────────────
 *
 * Deleting a user through this console enqueues the cancellation so an outage
 * postpones it. This route threw a 400 and remembered nothing, so an operator
 * pressing Cancel during a Lemon Squeezy outage left the customer being charged
 * with no record anywhere that anyone had tried.
 */
test("an admin cancel that cannot reach Lemon Squeezy is queued, not lost", async (t) => {
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
  const queued: any[] = [];
  stubMethod(t, prisma.billingTask as any, "findUnique", async () => null);
  stubMethod(t, prisma.billingTask as any, "create", async (a: any) => {
    queued.push(a.data);
    return a.data;
  });
  stubMethod(t, prisma.billingTask as any, "updateMany", async () => ({ count: 1 }));
  stubMethod(t, prisma.billingTask as any, "update", async () => ({}));
  const realError = console.error;
  console.error = () => {};
  t.after(() => {
    console.error = realError;
  });
  stubFetch(t, async () => {
    throw new Error("ECONNREFUSED");
  });

  const res = await request(app)
    .post(`/api/admin/users/${USER}/cancel-subscription`)
    .set(auth)
    .send({ reason: "customer asked by email", externalId: "77001" });

  // 202 since the contract became explicit: accepted, and still owed.
  assert.equal(res.status, 202, "accepted for deferred processing, not a client error");
  assert.equal(res.body.queued, true);
  assert.equal(res.body.cancelled, false);
  assert.equal(queued.length, 1, "the cancellation is OWED, not forgotten");
  assert.equal(queued[0].externalId, "77001");
  assert.equal(queued[0].reason, "admin-cancel");
});

test("a 5xx from Lemon Squeezy is queued too; a 4xx decision is not", async (t) => {
  for (const [status, shouldQueue] of [[503, true], [422, false]] as const) {
    await t.test(`HTTP ${status}`, async (t2) => {
      stubDb(t2);
      const ORIGINAL_KEY = env.lemonSqueezyApiKey;
      (env as any).lemonSqueezyApiKey = "test-key";
      t2.after(() => {
        (env as any).lemonSqueezyApiKey = ORIGINAL_KEY;
      });
      stubMethod(t2, prisma.subscription as any, "findFirst", async () => ({
        externalId: "77001",
        status: "active",
      }));
      const queued: any[] = [];
      stubMethod(t2, prisma.billingTask as any, "findUnique", async () => null);
      stubMethod(t2, prisma.billingTask as any, "create", async (a: any) => {
        queued.push(a.data);
        return a.data;
      });
      stubMethod(t2, prisma.billingTask as any, "updateMany", async () => ({ count: 1 }));
      stubMethod(t2, prisma.billingTask as any, "update", async () => ({}));
      const realError = console.error;
      console.error = () => {};
      t2.after(() => {
        console.error = realError;
      });
      stubFetch(t2, async () => ({ ok: false, status, json: async () => ({}), text: async () => "" }));

      await request(app)
        .post(`/api/admin/users/${USER}/cancel-subscription`)
        .set(auth)
        .send({ reason: "customer asked by email", externalId: "77001" });

      assert.equal(queued.length, shouldQueue ? 1 : 0);
    });
  }
});

/* ── the cancel contract, as three distinct OUTCOMES ─────────────────────────
 *
 * It used to answer 400 for all three, with the difference carried only in an
 * English sentence. So a client had to parse prose to learn whether a customer's
 * renewal had actually stopped — and 400 says "your request was invalid" about a
 * request that was accepted and durably queued. The status code is the contract.
 */

test("an immediate provider success answers 200 cancelled:true, queued:false", async (t) => {
  stubDb(t);
  const ORIGINAL_KEY = env.lemonSqueezyApiKey;
  (env as any).lemonSqueezyApiKey = "test-key";
  t.after(() => {
    (env as any).lemonSqueezyApiKey = ORIGINAL_KEY;
  });
  stubMethod(t, prisma.subscription as any, "findFirst", async () => ({
    externalId: "77001",
    status: "active",
  }));
  const queued: any[] = [];
  stubMethod(t, prisma.billingTask as any, "findUnique", async () => null);
  stubMethod(t, prisma.billingTask as any, "create", async (a: any) => {
    queued.push(a.data);
    return a.data;
  });
  stubFetch(t, async () => ({ ok: true, status: 200, json: async () => ({}) }));

  const res = await request(app)
    .post(`/api/admin/users/${USER}/cancel-subscription`)
    .set(auth)
    .send({ reason: "customer asked by email", externalId: "77001" });

  assert.equal(res.status, 200);
  assert.deepEqual(
    { cancelled: res.body.cancelled, queued: res.body.queued },
    { cancelled: true, queued: false },
  );
  assert.equal(queued.length, 0, "nothing is owed when the provider already did it");
});

test("a recoverable provider failure answers 202 cancelled:false, queued:true", async (t) => {
  for (const failure of ["network", 429, 503] as const) {
    await t.test(String(failure), async (t2) => {
      stubDb(t2);
      const ORIGINAL_KEY = env.lemonSqueezyApiKey;
      (env as any).lemonSqueezyApiKey = "test-key";
      t2.after(() => {
        (env as any).lemonSqueezyApiKey = ORIGINAL_KEY;
      });
      stubMethod(t2, prisma.subscription as any, "findFirst", async () => ({
        externalId: "77001",
        status: "active",
      }));
      const queued: any[] = [];
      stubMethod(t2, prisma.billingTask as any, "findUnique", async () => null);
      stubMethod(t2, prisma.billingTask as any, "create", async (a: any) => {
        queued.push(a.data);
        return a.data;
      });
      stubMethod(t2, prisma.billingTask as any, "updateMany", async () => ({ count: 1 }));
      stubMethod(t2, prisma.billingTask as any, "update", async () => ({}));
      const realError = console.error;
      console.error = () => {};
      t2.after(() => {
        console.error = realError;
      });
      stubFetch(t2, async () => {
        if (failure === "network") throw new Error("ECONNREFUSED");
        return { ok: false, status: failure, json: async () => ({}), text: async () => "" };
      });

      const res = await request(app)
        .post(`/api/admin/users/${USER}/cancel-subscription`)
        .set(auth)
        .send({ reason: "customer asked by email", externalId: "77001" });

      // 202: we accepted the instruction and will carry it out. NOT 400, which
      // tells the caller their request was wrong when it was not.
      assert.equal(res.status, 202, `${failure} must be Accepted, not a client error`);
      assert.deepEqual(
        { cancelled: res.body.cancelled, queued: res.body.queued },
        { cancelled: false, queued: true },
      );
      assert.equal(queued.length, 1, "exactly one task owed");
      assert.equal(queued[0].externalId, "77001");
      assert.equal(queued[0].kind, "cancel");
      assert.equal(queued[0].reason, "admin-cancel");
      assert.equal(queued[0].doneAt, null, "owed, not settled");
    });
  }
});

test("a non-recoverable provider refusal answers 4xx and owes nothing", async (t) => {
  stubDb(t);
  const ORIGINAL_KEY = env.lemonSqueezyApiKey;
  (env as any).lemonSqueezyApiKey = "test-key";
  t.after(() => {
    (env as any).lemonSqueezyApiKey = ORIGINAL_KEY;
  });
  stubMethod(t, prisma.subscription as any, "findFirst", async () => ({
    externalId: "77001",
    status: "active",
  }));
  const queued: any[] = [];
  stubMethod(t, prisma.billingTask as any, "findUnique", async () => null);
  stubMethod(t, prisma.billingTask as any, "create", async (a: any) => {
    queued.push(a.data);
    return a.data;
  });
  const realError = console.error;
  console.error = () => {};
  t.after(() => {
    console.error = realError;
  });
  stubFetch(t, async () => ({ ok: false, status: 422, json: async () => ({}), text: async () => "" }));

  const res = await request(app)
    .post(`/api/admin/users/${USER}/cancel-subscription`)
    .set(auth)
    .send({ reason: "customer asked by email", externalId: "77001" });

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(res.body.cancelled ?? false, false);
  assert.equal(res.body.queued ?? false, false, "a decision is not a retry");
  assert.equal(queued.length, 0, "nothing is owed for a refusal we understood");
});

/* ── cancelling a TRIAL from the console ─────────────────────────────────────
 *
 * Cancelling a trial ends access at once — a trial buys no grace, nobody was
 * charged. That rule lives in `subscriptionGrants` and is armed by the
 * `trialCancelledAt` tombstone, which the webhook writes and the CUSTOMER's own
 * /cancel route writes optimistically.
 *
 * The admin route wrote neither. So an operator cancelling a customer's trial
 * left them with access until a webhook happened to arrive — and on the 202 path,
 * where Lemon Squeezy is unreachable, no webhook arrives at all and the trial
 * goes on granting for the rest of its window.
 *
 * Dates are RELATIVE. A fixture pinned to a wall-clock instant took this suite
 * red mid-session once already.
 */

const TRIAL_ENDS_IN_3_DAYS = () => new Date(Date.now() + 3 * 86_400_000);

function stubTrialSubscription(t: Ctx) {
  const writes: any[] = [];
  stubMethod(t, prisma.subscription as any, "findFirst", async () => ({
    id: "row-1",
    externalId: "77001",
    status: "on_trial",
    trialEndsAt: TRIAL_ENDS_IN_3_DAYS(),
    trialCancelledAt: null,
  }));
  stubMethod(t, prisma.subscription as any, "updateMany", async (a: any) => {
    writes.push(a);
    return { count: 1 };
  });
  stubMethod(t, prisma.subscription as any, "update", async (a: any) => {
    writes.push(a);
    return {};
  });
  return writes;
}

function withKey(t: Ctx) {
  const before = env.lemonSqueezyApiKey;
  (env as any).lemonSqueezyApiKey = "test-key";
  t.after(() => {
    (env as any).lemonSqueezyApiKey = before;
  });
}

test("an admin cancelling a TRIAL writes the tombstone that ends access at once", async (t) => {
  const db = stubDb(t);
  withKey(t);
  const writes = stubTrialSubscription(t);
  stubFetch(t, async () => ({ ok: true, status: 200, json: async () => ({}) }));

  const res = await request(app)
    .post(`/api/admin/users/${USER}/cancel-subscription`)
    .set(auth)
    .send({ reason: "customer asked us to stop the trial", externalId: "77001" });

  assert.equal(res.status, 200);
  assert.deepEqual(
    { cancelled: res.body.cancelled, queued: res.body.queued },
    { cancelled: true, queued: false },
  );

  // The provider's status may stay `on_trial` until its webhook lands. The
  // tombstone is what must refuse access in the meantime.
  const tombstone = writes.find((w) => w.data?.trialCancelledAt);
  assert.ok(tombstone, "the trial tombstone must be written by the admin path too");
  assert.ok(tombstone.data.trialCancelledAt instanceof Date);

  // The human reason belongs in the audit; "admin-cancel" is an operational code.
  assert.match(db.audit.at(-1)![0].data.reason, /stop the trial/);
});

test("a queued (202) trial cancellation still ends access immediately", async (t) => {
  // The case that cannot self-heal: Lemon Squeezy is unreachable, so NO webhook
  // will arrive to write the tombstone later. If the admin path does not write
  // it now, the trial keeps granting for its whole window.
  const db = stubDb(t);
  withKey(t);
  const writes = stubTrialSubscription(t);
  const queued: any[] = [];
  stubMethod(t, prisma.billingTask as any, "findUnique", async () => null);
  stubMethod(t, prisma.billingTask as any, "create", async (a: any) => {
    queued.push(a.data);
    return a.data;
  });
  stubMethod(t, prisma.billingTask as any, "updateMany", async () => ({ count: 1 }));
  stubMethod(t, prisma.billingTask as any, "update", async () => ({}));
  const realError = console.error;
  console.error = () => {};
  t.after(() => {
    console.error = realError;
  });
  stubFetch(t, async () => {
    throw new Error("ECONNREFUSED");
  });

  const res = await request(app)
    .post(`/api/admin/users/${USER}/cancel-subscription`)
    .set(auth)
    .send({ reason: "customer asked us to stop the trial", externalId: "77001" });

  assert.equal(res.status, 202);
  assert.deepEqual(
    { cancelled: res.body.cancelled, queued: res.body.queued },
    { cancelled: false, queued: true },
  );
  assert.equal(queued.length, 1, "the provider call is owed");

  const tombstone = writes.find((w) => w.data?.trialCancelledAt);
  assert.ok(tombstone, "no webhook is coming — the tombstone must be written now");

  // THE AUDIT ASSERTION THAT WAS MISSING ON THIS PATH.
  const audited = db.audit.at(-1)![0].data;
  assert.match(audited.reason, /stop the trial/, "the operator's own words survive");
  assert.equal(audited.after.queued, true);
  assert.equal(audited.after.cancelled, false);
  assert.ok(!JSON.stringify(audited).includes("test-key"), "no credential in the audit row");
});

test("cancelling a PAID subscription writes no trial tombstone", async (t) => {
  // The guard against the strict trial policy cutting off paying customers.
  stubDb(t);
  withKey(t);
  const writes: any[] = [];
  stubMethod(t, prisma.subscription as any, "findFirst", async () => ({
    id: "row-1",
    externalId: "77001",
    status: "active",
    // Trialed long ago, converted, paid ever since.
    trialEndsAt: new Date(Date.now() - 60 * 86_400_000),
    trialCancelledAt: null,
  }));
  stubMethod(t, prisma.subscription as any, "updateMany", async (a: any) => {
    writes.push(a);
    return { count: 1 };
  });
  stubMethod(t, prisma.subscription as any, "update", async (a: any) => {
    writes.push(a);
    return {};
  });
  stubFetch(t, async () => ({ ok: true, status: 200, json: async () => ({}) }));

  const res = await request(app)
    .post(`/api/admin/users/${USER}/cancel-subscription`)
    .set(auth)
    .send({ reason: "customer asked by email", externalId: "77001" });

  assert.equal(res.status, 200);
  assert.equal(
    writes.filter((w) => w.data?.trialCancelledAt).length,
    0,
    "a paying customer keeps the period they bought",
  );
});

/* ── classification: a real trial vs a customer who has already paid ─────────
 *
 * There is no `hadSuccessfulPayment` column. The only signal that nobody has
 * been charged is Lemon Squeezy's own `status: "on_trial"` — the moment it says
 * `active`, money has moved, even if `trial_ends_at` is still in the future
 * (which is exactly what "Pay now" / `invoice_immediately` produces).
 *
 * The admin path keyed on the DATES alone, so cancelling an early-converted
 * subscription would have written the trial tombstone and cut off a customer who
 * had just paid.
 */

test("early payment inside the trial window is NOT treated as a trial", async (t) => {
  stubDb(t);
  withKey(t);
  const writes: any[] = [];
  stubMethod(t, prisma.subscription as any, "findFirst", async () => ({
    id: "row-1",
    externalId: "77001",
    // Converted early: LS took the money, so it is `active` — but the original
    // trial window has not elapsed yet.
    status: "active",
    trialEndsAt: new Date(Date.now() + 2 * 86_400_000),
    trialCancelledAt: null,
  }));
  stubMethod(t, prisma.subscription as any, "updateMany", async (a: any) => {
    writes.push(a);
    return { count: 1 };
  });
  stubMethod(t, prisma.subscription as any, "update", async (a: any) => {
    writes.push(a);
    return {};
  });
  stubFetch(t, async () => ({ ok: true, status: 200, json: async () => ({}) }));

  const res = await request(app)
    .post(`/api/admin/users/${USER}/cancel-subscription`)
    .set(auth)
    .send({ reason: "customer asked by email", externalId: "77001" });

  assert.equal(res.status, 200);
  assert.equal(
    writes.filter((w) => w.data?.trialCancelledAt).length,
    0,
    "they paid — the strict trial rule must not touch them",
  );
  assert.equal(res.body.entitlementRevoked, false, "access runs to the end of the current access period");
});

test("an already-tombstoned trial keeps its first timestamp", async (t) => {
  stubDb(t);
  withKey(t);
  const first = new Date(Date.now() - 3600_000);
  const writes: any[] = [];
  stubMethod(t, prisma.subscription as any, "findFirst", async () => ({
    id: "row-1",
    externalId: "77001",
    status: "on_trial",
    trialEndsAt: new Date(Date.now() + 3 * 86_400_000),
    trialCancelledAt: first,
  }));
  stubMethod(t, prisma.subscription as any, "updateMany", async (a: any) => {
    writes.push(a);
    return { count: 0 }; // set-once: the WHERE matches nothing
  });
  stubFetch(t, async () => ({ ok: true, status: 200, json: async () => ({}) }));

  await request(app)
    .post(`/api/admin/users/${USER}/cancel-subscription`)
    .set(auth)
    .send({ reason: "retry after a timeout", externalId: "77001" });

  const tombstones = writes.filter((w) => w.data?.trialCancelledAt);
  for (const w of tombstones) {
    assert.ok(w.where?.OR, "set-once: the write must be guarded so a retry cannot move the date");
  }
});

test("an expired trial needs no tombstone", async (t) => {
  stubDb(t);
  withKey(t);
  const writes: any[] = [];
  stubMethod(t, prisma.subscription as any, "findFirst", async () => ({
    id: "row-1",
    externalId: "77001",
    status: "on_trial",
    trialEndsAt: new Date(Date.now() - 86_400_000), // already over
    trialCancelledAt: null,
  }));
  stubMethod(t, prisma.subscription as any, "updateMany", async (a: any) => {
    writes.push(a);
    return { count: 1 };
  });
  stubFetch(t, async () => ({ ok: true, status: 200, json: async () => ({}) }));

  await request(app)
    .post(`/api/admin/users/${USER}/cancel-subscription`)
    .set(auth)
    .send({ reason: "housekeeping", externalId: "77001" });

  assert.equal(writes.filter((w) => w.data?.trialCancelledAt).length, 0);
});

/* ── a write that decides access may not be best-effort ──────────────────── */

test("a tombstone that cannot be written is NOT reported as a completed cancellation", async (t) => {
  stubDb(t);
  withKey(t);
  stubMethod(t, prisma.subscription as any, "findFirst", async () => ({
    id: "row-1",
    externalId: "77001",
    status: "on_trial",
    trialEndsAt: new Date(Date.now() + 3 * 86_400_000),
    trialCancelledAt: null,
  }));
  stubMethod(t, prisma.subscription as any, "updateMany", async () => {
    throw new Error("mongo is down");
  });
  const realError = console.error;
  console.error = () => {};
  t.after(() => {
    console.error = realError;
  });
  stubFetch(t, async () => ({ ok: true, status: 200, json: async () => ({}) }));

  const res = await request(app)
    .post(`/api/admin/users/${USER}/cancel-subscription`)
    .set(auth)
    .send({ reason: "customer asked by email", externalId: "77001" });

  // Lemon Squeezy DID cancel; our own revocation did not land. Answering 200
  // would tell the operator access is gone when the customer still has it.
  assert.equal(res.status, 503, "a security write that failed is not a success");
  assert.equal(res.body.providerCancelled, true, "say what actually happened");
  assert.equal(res.body.entitlementRevoked, false);
});

/**
 * A retry must not undo the first call's work — and must not forget what it did.
 *
 * The subtle half is the classification. Once the tombstone exists the row is no
 * longer a LIVE unpaid trial, and a predicate that conflated "is a trial" with
 * "still has a tombstone to write" would answer `entitlementRevoked: false` here
 * — telling an operator, about a customer whose access it just cut off, that
 * nothing was revoked. The two questions have to stay separate.
 */
test("retrying a queued trial cancellation writes nothing twice", async (t) => {
  const db = stubDb(t);
  withKey(t);
  const FIRST_REVOKED_AT = new Date(Date.now() - 60_000);
  const writes: any[] = [];
  stubMethod(t, prisma.subscription as any, "findFirst", async () => ({
    id: "row-1",
    externalId: "77001",
    status: "on_trial",
    trialEndsAt: TRIAL_ENDS_IN_3_DAYS(),
    trialCancelledAt: FIRST_REVOKED_AT, // the first call already revoked
  }));
  stubMethod(t, prisma.subscription as any, "updateMany", async (a: any) => {
    writes.push(a);
    return { count: 0 };
  });
  const created: any[] = [];
  stubMethod(t, prisma.billingTask as any, "findUnique", async () => ({
    id: "task-1",
    doneAt: null, // still owed from the first call
  }));
  stubMethod(t, prisma.billingTask as any, "create", async (a: any) => {
    created.push(a.data);
    return a.data;
  });
  const realError = console.error;
  console.error = () => {};
  t.after(() => {
    console.error = realError;
  });
  stubFetch(t, async () => {
    throw new Error("ECONNREFUSED");
  });

  const res = await request(app)
    .post(`/api/admin/users/${USER}/cancel-subscription`)
    .set(auth)
    .send({ reason: "operator retried after a timeout", externalId: "77001" });

  assert.equal(res.status, 202, "a retry is still accepted, not an error");
  assert.equal(res.body.queued, true);
  assert.equal(
    res.body.entitlementRevoked,
    true,
    "access IS cut off — the first call did it; a retry must not report otherwise",
  );
  assert.equal(created.length, 0, "the cancellation is owed once, not twice");
  assert.equal(
    writes.filter((w) => w.data?.trialCancelledAt).length,
    0,
    "the first revocation timestamp must not be moved",
  );
  assert.match(db.audit.at(-1)![0].data.reason, /retried after a timeout/);
});

/**
 * Two operators pressing Cancel at the same instant.
 *
 * The unique index on (provider, externalId, kind) is what stops the double
 * enqueue, so the loser's insert RAISES. That collision means "someone else
 * already recorded it" — success — and must not surface as a 500.
 */
test("two concurrent cancellations produce one task and no 500", async (t) => {
  stubDb(t);
  withKey(t);
  stubMethod(t, prisma.subscription as any, "findFirst", async () => ({
    id: "row-1",
    externalId: "77001",
    status: "on_trial",
    trialEndsAt: TRIAL_ENDS_IN_3_DAYS(),
    trialCancelledAt: null,
  }));
  const tombstones: any[] = [];
  stubMethod(t, prisma.subscription as any, "updateMany", async (a: any) => {
    // Set-once, enforced by the WHERE: only the first writer matches.
    const first = tombstones.length === 0;
    if (first) tombstones.push(a.data);
    return { count: first ? 1 : 0 };
  });
  const tasks: any[] = [];
  // THE REAL INTERLEAVING, forced. Left to chance, the two requests serialise and
  // the second one simply reads the first one's row — a green test that never
  // touched the race. Both readers must see "no task yet", so both attempt the
  // insert and one of them loses to the unique index.
  let reads = 0;
  stubMethod(t, prisma.billingTask as any, "findUnique", async () =>
    reads++ < 2 ? null : { id: "task-1", doneAt: null },
  );
  stubMethod(t, prisma.billingTask as any, "create", async (a: any) => {
    if (tasks.length) {
      throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "test",
      });
    }
    tasks.push(a.data);
    return a.data;
  });
  const realError = console.error;
  console.error = () => {};
  t.after(() => {
    console.error = realError;
  });
  stubFetch(t, async () => {
    throw new Error("ECONNREFUSED");
  });

  const send = () =>
    request(app)
      .post(`/api/admin/users/${USER}/cancel-subscription`)
      .set(auth)
      .send({ reason: "two operators pressed cancel together", externalId: "77001" });
  const [a, b] = await Promise.all([send(), send()]);

  for (const res of [a, b]) {
    assert.notEqual(res.status, 500, `a lost race is not a server error (${res.text})`);
    assert.equal(res.status, 202);
    assert.equal(res.body.entitlementRevoked, true);
  }
  assert.equal(tasks.length, 1, "exactly one cancellation is owed");
  assert.equal(tombstones.length, 1, "exactly one revocation timestamp");
});

/**
 * The OTHER 202 branch — a rate limit or a 5xx from Lemon Squeezy.
 *
 * It answers exactly like the unreachable branch, and for a while it did NOT do
 * exactly what that branch does: it queued the provider call and reported
 * `entitlementRevoked: true` while writing no tombstone at all. The response
 * told an operator access had stopped; the database still granted it for the
 * rest of the trial window.
 */
test("a provider 429 queues the cancellation AND revokes the trial", async (t) => {
  freezeClock(t);
  stubDb(t);
  withKey(t);
  const writes = stubTrialSubscription(t);
  const created: any[] = [];
  stubMethod(t, prisma.billingTask as any, "findUnique", async () => null);
  stubMethod(t, prisma.billingTask as any, "create", async (a: any) => {
    created.push(a.data);
    return a.data;
  });
  const realError = console.error;
  console.error = () => {};
  t.after(() => {
    console.error = realError;
  });
  stubFetch(t, async () => ({
    ok: false,
    status: 429,
    json: async () => ({ errors: [{ detail: "Too many requests" }] }),
  }));

  const res = await request(app)
    .post(`/api/admin/users/${USER}/cancel-subscription`)
    .set(auth)
    .send({ reason: "provider rate limited us", externalId: "77001" });

  assert.equal(res.status, 202);
  assert.equal(res.body.entitlementRevoked, true);
  assert.equal(created.length, 1, "the provider call is owed");
  assert.ok(
    writes.find((w) => w.data?.trialCancelledAt),
    "reporting entitlementRevoked without writing the tombstone is a lie",
  );
});

/**
 * An audit row must never describe an outcome the request did not have.
 *
 * The success path wrote its audit BEFORE the tombstone. When that write failed
 * the request answered 503 REVOCATION_NOT_PERSISTED — correctly — but left
 * behind a row saying the subscription was cancelled. An operator reading the
 * log afterwards would see a completed cancellation that never completed.
 */
test("a 503 leaves no audit row claiming the cancellation succeeded", async (t) => {
  freezeClock(t);
  const db = stubDb(t);
  withKey(t);
  stubMethod(t, prisma.subscription as any, "findFirst", async () => ({
    id: "row-1",
    externalId: "77001",
    status: "on_trial",
    trialEndsAt: fromFrozen(3),
    trialCancelledAt: null,
  }));
  stubMethod(t, prisma.subscription as any, "updateMany", async () => {
    throw new Error("mongo is down");
  });
  const realError = console.error;
  console.error = () => {};
  t.after(() => {
    console.error = realError;
  });
  stubFetch(t, async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: { attributes: { ends_at: null } } }),
  }));

  const res = await request(app)
    .post(`/api/admin/users/${USER}/cancel-subscription`)
    .set(auth)
    .send({ reason: "tombstone write will fail", externalId: "77001" });

  assert.equal(res.status, 503);
  assert.equal(res.body.code, "REVOCATION_NOT_PERSISTED");
  const claimed = db.audit.filter((c: any) => c[0]?.data?.after?.status === "cancelled");
  assert.equal(claimed.length, 0, "no audit row may claim an outcome the caller was denied");
});
