import assert from "node:assert/strict";
import { test } from "node:test";
import request from "supertest";
import { createApp } from "../app";
import { signToken } from "../lib/jwt";
import { prisma } from "../lib/prisma";
import { env } from "../lib/env";
import { getProvider } from "../lib/purchase-providers";
import { RC_PRODUCT_YEARLY, type RcSubscriber } from "../lib/revenuecat";
import { stubAccountGuard } from "./test-helpers";

/*
 * /api/billing is what the paywall talks to in the seconds after a purchase.
 * What these tests pin: the subject of a refresh is ALWAYS the token's owner
 * (a body can never redirect it), a RevenueCat outage is a clean retryable
 * answer rather than a fake entitlement, and the resolved view carries the
 * `plan`/`validUntil` the mobile client renders.
 */

stubAccountGuard();

const app = createApp();
const USER = "507f1f77bcf86cd799439011";
const OTHER = "507f1f77bcf86cd799439022";
const FUTURE = new Date("2026-09-01T00:00:00.000Z");
const auth = { authorization: `Bearer ${signToken({ sub: USER, email: "user@example.com" })}` };

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

function setEnv(t: Ctx, patch: Record<string, unknown>) {
  const before: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    before[k] = (env as any)[k];
    (env as any)[k] = v;
  }
  t.after(() => {
    for (const [k, v] of Object.entries(before)) (env as any)[k] = v;
  });
}

/**
 * Open the RevenueCat door for one test. The registry snapshots `enabled` at
 * module load (when the test environment has no RevenueCat config), so the
 * entry itself is flipped, exactly the way setEnv flips the env object.
 */
function providerOpen(t: Ctx) {
  const rc = getProvider("revenuecat")!;
  const before = rc.enabled;
  rc.enabled = true;
  setEnv(t, { revenuecatEnabled: true, revenuecatSecretApiKey: "sk_test_secret" });
  t.after(() => {
    rc.enabled = before;
  });
}

function stubFetch(t: Ctx, answer: () => RcSubscriber | { boom: true }) {
  return stubMethod(t, globalThis as any, "fetch", async () => {
    const a = answer();
    if ("boom" in a && a.boom) throw new Error("network down");
    return new Response(JSON.stringify({ subscriber: a }), { status: 200 });
  });
}

/** The resolver's reads, stubbed to a chosen set of billing rows. */
function stubResolver(
  t: Ctx,
  rows: { purchases?: any[]; subscriptions?: any[] } = {},
) {
  const userFind = stubMethod(t, prisma.user as any, "findUnique", async (args: any) => ({
    // One superset answers both the account guard's read and the resolver's.
    id: args?.where?.id ?? USER,
    email: "user@example.com",
    emailVerified: true,
    passwordChangedAt: null,
    trialEndsAt: null,
    compActive: false,
    compedUntil: null,
    accessRevoked: false,
  }));
  return {
    userFind,
    purchaseFindMany: stubMethod(t, prisma.purchase as any, "findMany", async () => rows.purchases ?? []),
    subFindMany: stubMethod(t, prisma.subscription as any, "findMany", async () => rows.subscriptions ?? []),
    claimFindFirst: stubMethod(t, prisma.trialClaim as any, "findFirst", async () => null),
    userUpdate: stubMethod(t, prisma.user as any, "update", async () => ({})),
    subUpsert: stubMethod(t, prisma.subscription as any, "upsert", async () => ({})),
    purchaseUpsert: stubMethod(t, prisma.purchase as any, "upsert", async () => ({})),
    // The sync's authoritative sweep runs before the resolver reads.
    subSweep: stubMethod(t, prisma.subscription as any, "updateMany", async () => ({ count: 0 })),
    purchaseSweep: stubMethod(t, prisma.purchase as any, "updateMany", async () => ({ count: 0 })),
  };
}

/** The row syncUserFromRevenueCat would have written for a live yearly. */
const rcYearlyRow = (over: Record<string, unknown> = {}) => ({
  provider: "revenuecat",
  status: "active",
  validUntil: FUTURE,
  trialEndsAt: null,
  interval: "yearly",
  customerPortalUrl: null,
  updatePaymentUrl: null,
  ...over,
});

const yearlySubscriber = (): RcSubscriber => ({
  subscriptions: {
    [RC_PRODUCT_YEARLY]: {
      expires_date: FUTURE.toISOString(),
      period_type: "normal",
      is_sandbox: false,
    },
  },
  entitlements: { pro: { product_identifier: RC_PRODUCT_YEARLY } },
  management_url: "https://apps.apple.com/account/subscriptions",
});

/* ── the refresh ────────────────────────────────────────────────────────── */

test("a refresh without a token is a 401 — nothing is fetched for strangers", async (t) => {
  providerOpen(t);
  const fetches = stubFetch(t, yearlySubscriber);
  stubResolver(t);

  const res = await request(app).post("/api/billing/revenuecat/refresh").send({});

  assert.equal(res.status, 401);
  assert.equal(fetches.length, 0);
});

test("a refresh while the provider is closed is a 503, like every shut shop", async (t) => {
  // NOT providerOpen: the registry is in its test-environment default (off).
  const fetches = stubFetch(t, yearlySubscriber);
  stubResolver(t);

  const res = await request(app).post("/api/billing/revenuecat/refresh").set(auth).send({});

  assert.equal(res.status, 503);
  assert.equal(res.body.code, "PROVIDER_DISABLED");
  assert.equal(fetches.length, 0);
});

test("the refresh subject is the TOKEN's account — a userId in the body is ignored", async (t) => {
  providerOpen(t);
  const fetches = stubFetch(t, yearlySubscriber);
  stubResolver(t, { subscriptions: [rcYearlyRow()] });

  const res = await request(app)
    .post("/api/billing/revenuecat/refresh")
    .set(auth)
    .send({ userId: OTHER, app_user_id: OTHER });

  assert.equal(res.status, 200);
  assert.equal(fetches.length, 1);
  const url = String(fetches[0][0]);
  assert.ok(url.includes(USER), "the sync must be about the caller");
  assert.ok(!url.includes(OTHER), "a body can never redirect a sync to another account");
});

test("a successful refresh answers the resolved view, with plan and validUntil", async (t) => {
  providerOpen(t);
  stubFetch(t, yearlySubscriber);
  const db = stubResolver(t, { subscriptions: [rcYearlyRow()] });

  const res = await request(app).post("/api/billing/revenuecat/refresh").set(auth).send({});

  assert.equal(res.status, 200);
  assert.equal(res.body.status, "active");
  assert.equal(res.body.isPro, true);
  assert.equal(res.body.plan, "yearly");
  assert.equal(res.body.validUntil, FUTURE.toISOString());
  // …and the sync actually wrote what it fetched before resolving.
  assert.equal(db.subUpsert.length, 1);
  assert.equal(db.subUpsert[0][0].update.status, "active");
});

test("auto-renew OFF during an Apple trial still grants, and says trialing", async (t) => {
  // The 'cancelled' trap, end to end: the customer toggled auto-renew during
  // their trial, RevenueCat re-fetch shows on_trial + unsubscribe detected —
  // and the answer must still be access until the window ends.
  providerOpen(t);
  stubFetch(t, () => ({
    subscriptions: {
      [RC_PRODUCT_YEARLY]: {
        expires_date: FUTURE.toISOString(),
        period_type: "trial",
        unsubscribe_detected_at: "2026-08-11T00:00:00.000Z",
        is_sandbox: false,
      },
    },
    entitlements: { pro: { product_identifier: RC_PRODUCT_YEARLY } },
  }));
  const db = stubResolver(t, {
    subscriptions: [rcYearlyRow({ status: "on_trial", trialEndsAt: FUTURE })],
  });

  const res = await request(app).post("/api/billing/revenuecat/refresh").set(auth).send({});

  assert.equal(res.status, 200);
  assert.equal(res.body.isPro, true, "Apple promised the window — cutting it is the trap");
  assert.equal(res.body.status, "trialing");
  const written = db.subUpsert[0][0].update;
  assert.equal(written.status, "on_trial");
  assert.equal(written.willRenew, false);
});

test("a refunded RC subscription no longer grants — but the same user's lifetime still does", async (t) => {
  providerOpen(t);
  stubFetch(t, () => ({
    subscriptions: {
      [RC_PRODUCT_YEARLY]: {
        expires_date: FUTURE.toISOString(),
        refunded_at: "2026-08-01T00:00:00.000Z",
        is_sandbox: false,
      },
    },
    entitlements: {},
  }));
  const db = stubResolver(t, {
    subscriptions: [rcYearlyRow({ status: "expired" })],
    // A Lemon Squeezy lifetime (or an admin comp) is a SEPARATE grant and must
    // survive the refund of an unrelated subscription.
    purchases: [{ isRefunded: false }],
  });

  const res = await request(app).post("/api/billing/revenuecat/refresh").set(auth).send({});

  assert.equal(res.status, 200);
  assert.equal(res.body.status, "active");
  assert.equal(res.body.plan, "lifetime");
  assert.equal(db.subUpsert[0][0].update.status, "expired");
  assert.ok(db.subUpsert[0][0].update.revokedAt != null);
});

test("an RC lifetime purchase outranks an expired subscription", async (t) => {
  providerOpen(t);
  stubFetch(t, () => ({
    non_subscriptions: {
      "in.welock.app.lifetime": [
        { id: "txn9", purchase_date: "2026-08-01T00:00:00.000Z", is_sandbox: false },
      ],
    },
    entitlements: { pro: { product_identifier: "in.welock.app.lifetime" } },
  }));
  const db = stubResolver(t, {
    subscriptions: [rcYearlyRow({ status: "expired" })],
    purchases: [{ isRefunded: false }],
  });

  const res = await request(app).post("/api/billing/revenuecat/refresh").set(auth).send({});

  assert.equal(res.status, 200);
  assert.equal(res.body.status, "active");
  assert.equal(res.body.plan, "lifetime");
  assert.equal(res.body.validUntil, null, "a lifetime has no end date to count down");
  assert.equal(db.purchaseUpsert.length, 1);
  assert.equal(db.purchaseUpsert[0][0].update.isRefunded, false);
});

test("a transferred-away lifetime loser is swept refunded — but a same-user LS lifetime still grants", async (t) => {
  // The HIGH-severity leak, at the route: the loser re-fetches to an EMPTY
  // subscriber, so the sweep must revoke its RC lifetime — while a Lemon
  // Squeezy lifetime (or a comp) the sweep is scoped away from keeps granting.
  providerOpen(t);
  stubFetch(t, () => ({ subscriptions: {}, non_subscriptions: {}, entitlements: {} }));
  const db = stubResolver(t, {
    // Post-sweep state the resolver sees: the RC lifetime is now refunded, and
    // a SEPARATE Lemon Squeezy lifetime remains granting.
    purchases: [{ isRefunded: true }, { isRefunded: false }],
  });

  const res = await request(app).post("/api/billing/revenuecat/refresh").set(auth).send({});

  assert.equal(res.status, 200);
  // The sweep fired, scoped to this user's RC rows only, sparing nothing.
  assert.equal(db.purchaseSweep.length, 1);
  const where = db.purchaseSweep[0][0].where;
  assert.equal(where.userId, USER);
  assert.equal(where.provider, "revenuecat");
  assert.deepEqual(where.externalId.notIn, []);
  assert.equal(db.purchaseSweep[0][0].data.isRefunded, true);
  // …and the LS lifetime the sweep never touched still grants.
  assert.equal(res.body.status, "active");
  assert.equal(res.body.plan, "lifetime");
});

test("a RevenueCat outage is a clean 502 the client can retry — never a fake view", async (t) => {
  providerOpen(t);
  stubFetch(t, () => ({ boom: true }));
  stubResolver(t);

  const res = await request(app).post("/api/billing/revenuecat/refresh").set(auth).send({});

  assert.equal(res.status, 502);
  assert.equal(res.body.code, "UPSTREAM_UNAVAILABLE");
});

test("a body we cannot read is a 502 too — and revokes nothing on the way", async (t) => {
  providerOpen(t);
  stubMethod(
    t,
    globalThis as any,
    "fetch",
    async () => new Response(JSON.stringify({ request_date: "2026-08-12" }), { status: 200 }),
  );
  const db = stubResolver(t);

  const res = await request(app).post("/api/billing/revenuecat/refresh").set(auth).send({});

  assert.equal(res.status, 502);
  assert.equal(res.body.code, "UPSTREAM_UNAVAILABLE");
  assert.equal(db.subSweep.length, 0, "an unreadable answer must not withdraw paid access");
  assert.equal(db.purchaseSweep.length, 0);
});

/* ── the alias ──────────────────────────────────────────────────────────── */

test("GET /api/billing/entitlement serves the same view, even while the shop is shut", async (t) => {
  // Deliberately NOT providerOpen: reading your access must never depend on
  // whether new purchases may currently be written.
  stubResolver(t, { subscriptions: [rcYearlyRow()] });

  const res = await request(app).get("/api/billing/entitlement").set(auth);

  assert.equal(res.status, 200);
  assert.equal(res.body.status, "active");
  assert.equal(res.body.plan, "yearly");
  assert.equal(res.body.validUntil, FUTURE.toISOString());
});

/* ── sandbox isolation at read time ─────────────────────────────────────── */

test("the resolver's reads carry the per-provider sandbox gate", async (t) => {
  // The isolation itself is pinned as a unit on hideTestRows; what the route
  // owes is USING it — with each provider's own flag, so a sandbox row can
  // only ever be opened by REVENUECAT_ALLOW_SANDBOX, never by the LS flag.
  setEnv(t, { revenuecatAllowSandbox: true, lemonSqueezyAllowTestMode: false });
  const db = stubResolver(t);

  const res = await request(app).get("/api/billing/entitlement").set(auth);

  assert.equal(res.status, 200);
  const where = db.subFindMany[0][0].where;
  assert.deepEqual(where.OR, [{ NOT: { testMode: true } }, { provider: "revenuecat" }]);
  const purchaseWhere = db.purchaseFindMany[0][0].where;
  assert.deepEqual(purchaseWhere.OR, [{ NOT: { testMode: true } }, { provider: "revenuecat" }]);
});

test("with the sandbox flag OFF, a testMode row is invisible to the reads", async (t) => {
  setEnv(t, { revenuecatAllowSandbox: false, lemonSqueezyAllowTestMode: false });
  const db = stubResolver(t);

  await request(app).get("/api/billing/entitlement").set(auth);

  assert.deepEqual(db.subFindMany[0][0].where.OR, [{ NOT: { testMode: true } }]);
});
