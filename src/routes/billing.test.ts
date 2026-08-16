import assert from "node:assert/strict";
import { test } from "node:test";
import request from "supertest";
import { createApp } from "../app";
import { signToken } from "../lib/jwt";
import { prisma } from "../lib/prisma";
import { env } from "../lib/env";
import { getProvider } from "../lib/purchase-providers";
import {
  RC_LIFETIME_PRODUCT_IDS,
  RC_PRODUCT_MONTHLY,
  RC_PRODUCT_YEARLY,
  type RcSubscriber,
} from "../lib/revenuecat";
import { REAL_ORDER_CREATED } from "./lemonsqueezy-fixtures";
import { stubAccountGuard, stubNoBillingHolds } from "./test-helpers";

/*
 * /api/billing is what the paywall talks to in the seconds after a purchase.
 * What these tests pin: the subject of a refresh is ALWAYS the token's owner
 * (a body can never redirect it), a RevenueCat outage is a clean retryable
 * answer rather than a fake entitlement, and the resolved view carries the
 * `plan`/`validUntil` the mobile client renders.
 */

stubAccountGuard();
stubNoBillingHolds();

const app = createApp();
const USER = "507f1f77bcf86cd799439011";
const OTHER = "507f1f77bcf86cd799439022";
const FUTURE = new Date("2026-09-01T00:00:00.000Z");
/** The one lifetime product. Never a literal here — the literal is pinned once,
 *  in lib/revenuecat.test.ts, so a typo cannot be copied into a fixture. */
const RC_LIFETIME = RC_LIFETIME_PRODUCT_IDS[0];
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

/**
 * Apply the test-row fragment the route built to a fixture row, the way Mongo
 * would. Without this the stubs would hand every row back whatever the `where`
 * said, and a test claiming "a sandbox purchase grants nothing" would be
 * asserting on a query it never ran.
 */
function visibleUnder(where: any, row: Record<string, any>): boolean {
  const clauses = where?.OR as Record<string, any>[] | undefined;
  if (!clauses) return true;
  return clauses.some((clause) =>
    "NOT" in clause ? row.testMode !== true : clause.provider === row.provider,
  );
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
    purchaseFindMany: stubMethod(t, prisma.purchase as any, "findMany", async (args: any) =>
      (rows.purchases ?? []).filter((r) => visibleUnder(args?.where, r)),
    ),
    subFindMany: stubMethod(t, prisma.subscription as any, "findMany", async (args: any) =>
      (rows.subscriptions ?? []).filter((r) => visibleUnder(args?.where, r)),
    ),
    claimFindFirst: stubMethod(t, prisma.trialClaim as any, "findFirst", async () => null),
    // The ownership registry the sync consults before granting (R2). Baseline:
    // unclaimed; conflict tests re-stub rcClaimFind after calling stubResolver.
    rcClaimFind: stubMethod(t, prisma.rcSubscriberClaim as any, "findUnique", async () => null),
    rcClaimCreate: stubMethod(t, prisma.rcSubscriberClaim as any, "create", async () => ({})),
    rcClaimUpdate: stubMethod(t, prisma.rcSubscriberClaim as any, "update", async () => ({})),
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
  assert.equal("restoreConflict" in res.body, false, "no conflict, no field — absence is the signal");
  // …and the sync actually wrote what it fetched before resolving.
  assert.equal(db.subUpsert.length, 1);
  assert.equal(db.subUpsert[0][0].update.status, "active");
});

test("a restore keeps the plan's exact type: the MONTHLY product answers 'monthly', write and view alike", async (t) => {
  // Criterion N9 of the consolidated report. Restore rides this same refresh,
  // so the productId→plan mapping must hold through the row the sync WRITES and
  // the view the client renders — yearly is pinned above, lifetime below;
  // monthly completes the table, and a restored plan can never change species.
  providerOpen(t);
  stubFetch(t, () => ({
    subscriptions: {
      [RC_PRODUCT_MONTHLY]: {
        expires_date: FUTURE.toISOString(),
        period_type: "normal",
        is_sandbox: false,
      },
    },
    entitlements: { pro: { product_identifier: RC_PRODUCT_MONTHLY } },
  }));
  const db = stubResolver(t, { subscriptions: [rcYearlyRow({ interval: "monthly" })] });

  const res = await request(app).post("/api/billing/revenuecat/refresh").set(auth).send({});

  assert.equal(res.status, 200);
  assert.equal(res.body.isPro, true);
  assert.equal(res.body.plan, "monthly", "a restored monthly must never resurface as another plan");
  assert.equal(res.body.validUntil, FUTURE.toISOString());
  // …and the row the sync wrote says monthly too — the view was not guessing.
  assert.equal(db.subUpsert.length, 1);
  assert.equal(db.subUpsert[0][0].update.variantId, RC_PRODUCT_MONTHLY);
  assert.equal(db.subUpsert[0][0].update.interval, "monthly");
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
      [RC_LIFETIME]: [{ id: "txn9", purchase_date: "2026-08-01T00:00:00.000Z", is_sandbox: false }],
    },
    entitlements: { pro: { product_identifier: RC_LIFETIME } },
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

/* ── the restore conflict: "this purchase belongs to another account" ────── */

/*
 * The RC path's ownership registry (RcSubscriberClaim — see lib/revenuecat) can
 * refuse a sync: the fetched subscriber is claimed by a DIFFERENT, still-living
 * account. What the route owes the client is a 200 that says so: the normal
 * EntitlementView (honest about this account holding nothing) PLUS
 * `restoreConflict.maskedEmail`, which is what the iOS client renders as
 * "this purchase belongs to another account (o•••@ex•••.com)".
 */

/** The caller's user reads, with the OWNER (a different account) answerable. */
function stubUsersWithOwner(t: Ctx, owner: { id: string; email?: string } | ((args: any) => any)) {
  return stubMethod(t, prisma.user as any, "findUnique", async (args: any) => {
    if (args?.where?.id === OTHER) {
      return typeof owner === "function" ? owner(args) : owner;
    }
    return {
      id: args?.where?.id ?? USER,
      email: "user@example.com",
      emailVerified: true,
      passwordChangedAt: null,
      trialEndsAt: null,
      compActive: false,
      compedUntil: null,
      accessRevoked: false,
    };
  });
}

test("restoring ANOTHER account's purchase is a 200 with restoreConflict — and grants nothing", async (t) => {
  providerOpen(t);
  stubFetch(t, yearlySubscriber);
  const db = stubResolver(t); // no rows: the view honestly shows nothing owned
  stubMethod(t, prisma.rcSubscriberClaim as any, "findUnique", async () => ({
    id: "claim1",
    originalAppUserId: USER,
    userId: OTHER,
  }));
  stubUsersWithOwner(t, { id: OTHER, email: "owner@example.com" });
  stubMethod(t, console as any, "error", () => {});

  const res = await request(app).post("/api/billing/revenuecat/refresh").set(auth).send({});

  assert.equal(res.status, 200, "a conflict is an answer, not an error");
  assert.deepEqual(res.body.restoreConflict, { maskedEmail: "o•••@ex•••.com" });
  assert.equal(res.body.isPro, false, "the caller was granted nothing");
  assert.equal(db.subUpsert.length, 0, "not one granting row was written");
  assert.equal(db.purchaseUpsert.length, 0);
  // The caller's stale RC rows were revoked on the way — the conflict sweep.
  assert.equal(db.subSweep.length, 1);
  assert.deepEqual(db.subSweep[0][0].where.externalId.notIn, []);
  // …and the owner keeps the claim: nothing rewrote it.
  assert.equal(db.rcClaimCreate.length, 0);
  assert.equal(db.rcClaimUpdate.length, 0);
});

test("the resync's RC leg carries the same restoreConflict", async (t) => {
  providerOpen(t);
  stubFetch(t, yearlySubscriber);
  stubResolver(t);
  stubMethod(t, prisma.rcSubscriberClaim as any, "findUnique", async () => ({
    id: "claim1",
    originalAppUserId: USER,
    userId: OTHER,
  }));
  stubUsersWithOwner(t, { id: OTHER, email: "owner@example.com" });
  stubMethod(t, console as any, "error", () => {});

  const res = await request(app).post("/api/billing/resync").set(auth).send();

  assert.equal(res.status, 200);
  // The leg RAN — the conflict is its verdict, not its failure.
  assert.deepEqual(res.body.resynced, { lemonsqueezy: 0, revenuecat: true });
  assert.deepEqual(res.body.restoreConflict, { maskedEmail: "o•••@ex•••.com" });
});

test("an owner email that cannot be read masks to null — the conflict still surfaces", async (t) => {
  providerOpen(t);
  stubFetch(t, yearlySubscriber);
  stubResolver(t);
  stubMethod(t, prisma.rcSubscriberClaim as any, "findUnique", async () => ({
    id: "claim1",
    originalAppUserId: USER,
    userId: OTHER,
  }));
  // The sync's owner-EXISTS check (select id) succeeds; the route's email
  // lookup (select email) hits a database blip. The 200 must survive it.
  stubUsersWithOwner(t, (args: any) => {
    if (args?.select?.email === true) throw new Error("replica set unavailable");
    return { id: OTHER };
  });
  stubMethod(t, console as any, "error", () => {});

  const res = await request(app).post("/api/billing/revenuecat/refresh").set(auth).send({});

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.restoreConflict, { maskedEmail: null });
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

/* ── the sandbox allow-list ─────────────────────────────────────────────── */

/*
 * WHY A LIST AND NOT THE FLAG. There is no staging deploy to point TestFlight
 * at: one Vercel project, one Atlas database (README, "Deployment"). So
 * REVENUECAT_ALLOW_SANDBOX=true would not open the sandbox "for the testers",
 * it would open it for every account at once — and a StoreKit sandbox purchase
 * costs nothing while being signed by the same Apple chain as a real one. The
 * deploy therefore names the testers, and these tests are the guarantees that
 * naming buys.
 */

/** A granting lifetime bought in the StoreKit SANDBOX, mirrored as a test row. */
const sandboxLifetime = () => ({ isRefunded: false, testMode: true, provider: "revenuecat" });
/** The same product, bought for real. */
const paidLifetime = () => ({ isRefunded: false, provider: "revenuecat" });

test("a sandbox purchase grants NOTHING to an account nobody listed", async (t) => {
  setEnv(t, { revenuecatAllowSandbox: false, revenuecatSandboxAllowedUserIds: [] });
  stubResolver(t, { purchases: [sandboxLifetime()] });

  const res = await request(app).get("/api/billing/entitlement").set(auth);

  assert.equal(res.status, 200);
  assert.equal(res.body.isPro, false, "a free sandbox purchase is not a licence");
  assert.equal(res.body.status, "expired");
});

test("…and grants to the tester the deploy named, by account id", async (t) => {
  setEnv(t, { revenuecatAllowSandbox: false, revenuecatSandboxAllowedUserIds: [USER] });
  const db = stubResolver(t, { purchases: [sandboxLifetime()] });

  const res = await request(app).get("/api/billing/entitlement").set(auth);

  assert.equal(res.body.isPro, true);
  assert.equal(res.body.plan, "lifetime");
  assert.deepEqual(db.purchaseFindMany[0][0].where.OR, [
    { NOT: { testMode: true } },
    { provider: "revenuecat" },
  ]);
});

test("naming ANOTHER account opens nothing for this one", async (t) => {
  // The whole point of a list over a flag: one tester, not the user base.
  setEnv(t, { revenuecatAllowSandbox: false, revenuecatSandboxAllowedUserIds: [OTHER] });
  const db = stubResolver(t, { purchases: [sandboxLifetime()] });

  const res = await request(app).get("/api/billing/entitlement").set(auth);

  assert.equal(res.body.isPro, false);
  assert.deepEqual(db.purchaseFindMany[0][0].where.OR, [{ NOT: { testMode: true } }]);
});

test("closing the gate DELETES nothing — the paid row never depended on it", async (t) => {
  // The flag acts at READ time and only ever ADDS a clause. Proof in three
  // parts: with the gate shut the paid lifetime still grants beside an
  // invisible sandbox row; opening the gate makes the same untouched row
  // visible again; and neither read writes anything at all.
  const rows = { purchases: [paidLifetime(), sandboxLifetime()] };

  setEnv(t, { revenuecatAllowSandbox: false, revenuecatSandboxAllowedUserIds: [] });
  const shut = stubResolver(t, rows);
  const deletes = stubMethod(t, prisma.purchase as any, "deleteMany", async () => ({ count: 0 }));
  const shutRes = await request(app).get("/api/billing/entitlement").set(auth);

  assert.equal(shutRes.body.isPro, true, "the money the customer actually spent still counts");
  assert.equal(shut.purchaseFindMany[0][1] ?? undefined, undefined);
  assert.equal(shut.purchaseFindMany.length, 1);
  assert.equal(shut.purchaseUpsert.length, 0, "reading access writes no billing row");
  assert.equal(shut.purchaseSweep.length, 0, "…and revokes none");
  assert.equal(deletes.length, 0, "…and deletes none");

  // Re-open it: the SAME fixture rows are still there to be found.
  setEnv(t, { revenuecatSandboxAllowedUserIds: [USER] });
  const openRes = await request(app).get("/api/billing/entitlement").set(auth);
  assert.equal(openRes.body.isPro, true);
  assert.equal(shut.purchaseFindMany.length, 2);
  assert.deepEqual(shut.purchaseFindMany[1][0].where.OR, [
    { NOT: { testMode: true } },
    { provider: "revenuecat" },
  ]);
  assert.equal(rows.purchases.length, 2, "nothing was removed from the table by either read");
});

/* ════════════════════════════════════════════════════════════════════════════
 * POST /api/billing/resync — "I've already paid", with nothing but a session.
 *
 * What these tests pin: the Lemon Squeezy leg looks up the CALLER'S OWN email
 * and writes through the webhook's shared writers (so a resync can never mint
 * what a webhook would have refused — tombstones and test-mode gates
 * included); the RevenueCat leg degrades to a partial answer instead of
 * failing the call; and both rate-limit keys guard the door.
 * ══════════════════════════════════════════════════════════════════════════ */

/** The storefront, configured with the captured fixture's real ids. */
function lemonConfigured(t: Ctx) {
  setEnv(t, {
    lemonSqueezyApiKey: "test-key",
    lemonSqueezyStoreId: "364783",
    lemonSqueezyVariantId: "1960881",
    lemonSqueezyVariantMonthly: "1986433",
    lemonSqueezyVariantYearly: "1986420",
    lemonSqueezyAllowTestMode: false,
  });
}

/**
 * The captured REAL order (lemonsqueezy-fixtures.ts) as the API would list it,
 * re-owned by the test caller's email and flipped to live mode — each test
 * that wants the test-mode gate flips it back explicitly.
 */
function apiOrder(over: Record<string, unknown> = {}) {
  const data = JSON.parse(JSON.stringify(REAL_ORDER_CREATED.data)) as {
    attributes: Record<string, unknown>;
  };
  data.attributes = {
    ...data.attributes,
    user_email: "user@example.com",
    test_mode: false,
    ...over,
  };
  return data;
}

/** An API subscription object for the monthly variant, owned by the caller. */
function apiSub(over: Record<string, unknown> = {}) {
  return {
    id: "sub-777",
    type: "subscriptions",
    attributes: {
      store_id: 364783,
      variant_id: 1986433,
      product_id: 1254414,
      user_email: "user@example.com",
      status: "active",
      test_mode: false,
      trial_ends_at: null,
      renews_at: "2026-09-15T00:00:00.000Z",
      ends_at: null,
      updated_at: "2026-08-15T00:00:00.000Z",
      urls: {
        update_payment_method: "https://portal.lemonsqueezy.test/update",
        customer_portal: "https://portal.lemonsqueezy.test/portal",
      },
      ...over,
    },
  };
}

/** Answer the two LS list calls; anything else is a test failure. */
function stubLemonList(t: Ctx, orders: unknown[], subs: unknown[]) {
  return stubMethod(t, globalThis as any, "fetch", async (url: unknown) => {
    const u = String(url);
    if (u.includes("/v1/orders")) return new Response(JSON.stringify({ data: orders }), { status: 200 });
    if (u.includes("/v1/subscriptions")) return new Response(JSON.stringify({ data: subs }), { status: 200 });
    throw new Error(`unexpected fetch: ${u}`);
  });
}

test("a resync without a token is a 401 — nothing is fetched for strangers", async (t) => {
  lemonConfigured(t);
  const fetches = stubLemonList(t, [], []);

  const res = await request(app).post("/api/billing/resync").send();

  assert.equal(res.status, 401);
  assert.equal(fetches.length, 0);
});

test("a paid order found by the caller's own email is recorded through the shared writer", async (t) => {
  lemonConfigured(t);
  const db = stubResolver(t, { purchases: [{ isRefunded: false, provider: "lemonsqueezy" }] });
  const fetches = stubLemonList(t, [apiOrder()], []);
  stubMethod(t, prisma.purchase as any, "findUnique", async () => null);
  const consumedReads = stubMethod(t, prisma.consumedOrder as any, "findUnique", async () => null);
  const consumedWrites = stubMethod(t, prisma.consumedOrder as any, "upsert", async () => ({}));

  const res = await request(app).post("/api/billing/resync").set(auth).send();

  assert.equal(res.status, 200, res.text);
  // The lookup was by the TOKEN's email, scoped to OUR store — the caller can
  // only ever pull orders placed under the address they have proven they hold.
  const ordersUrl = String(fetches.find((c) => String(c[0]).includes("/v1/orders"))![0]);
  assert.ok(ordersUrl.includes("filter[store_id]=364783"));
  assert.ok(ordersUrl.includes("filter[user_email]=user%40example.com"));
  assert.ok(ordersUrl.includes("page[size]=10"));
  // …and the write went through recordPaidOrder: the same upsert key, the same
  // ownership, the same tombstone the webhook and /checkout/confirm leave.
  assert.equal(db.purchaseUpsert.length, 1);
  const upsert = db.purchaseUpsert[0][0];
  assert.equal(upsert.where.provider_externalId.externalId, "9090213");
  assert.equal(upsert.create.userId, USER);
  assert.equal(upsert.create.provider, "lemonsqueezy");
  assert.equal(consumedWrites.length, 1, "the consumed-order tombstone is written exactly once");
  assert.ok(consumedReads.length >= 1, "…and only after the tombstone was consulted");
  assert.deepEqual(res.body.resynced, { lemonsqueezy: 1, revenuecat: false });
  assert.equal(res.body.status, "active", "the answer is the freshly resolved view");
});

test("a consumed order is refused — the tombstone outlives the account that spent it", async (t) => {
  lemonConfigured(t);
  const db = stubResolver(t);
  stubLemonList(t, [apiOrder()], []);
  stubMethod(t, prisma.purchase as any, "findUnique", async () => null);
  stubMethod(t, prisma.consumedOrder as any, "findUnique", async () => ({ id: "tombstone" }));

  const res = await request(app).post("/api/billing/resync").set(auth).send();

  assert.equal(res.status, 200, "refusal is a zero, never an error — there is nothing to retry");
  assert.equal(db.purchaseUpsert.length, 0, "no Purchase may be re-minted from a spent order");
  assert.deepEqual(res.body.resynced, { lemonsqueezy: 0, revenuecat: false });
});

test("a test-mode order stays gated: the resync cannot open a door the webhook keeps shut", async (t) => {
  lemonConfigured(t);
  const db = stubResolver(t);
  stubLemonList(t, [apiOrder({ test_mode: true })], []);
  const consumedReads = stubMethod(t, prisma.consumedOrder as any, "findUnique", async () => null);

  const res = await request(app).post("/api/billing/resync").set(auth).send();

  assert.equal(res.status, 200);
  assert.equal(db.purchaseUpsert.length, 0);
  assert.equal(consumedReads.length, 0, "the writer was never even entered");
  assert.deepEqual(res.body.resynced, { lemonsqueezy: 0, revenuecat: false });
});

test("a subscription found by email is mirrored through the one subscription writer", async (t) => {
  lemonConfigured(t);
  const db = stubResolver(t);
  stubLemonList(t, [], [apiSub()]);
  // mirrorSubscriptionState's path: the guarded update matches nothing (no row
  // yet — db.subSweep answers count 0), no existing row, no tombstone → create.
  stubMethod(t, prisma.subscription as any, "findUnique", async () => null);
  stubMethod(t, prisma.consumedOrder as any, "findUnique", async () => null);
  stubMethod(t, prisma.consumedOrder as any, "upsert", async () => ({}));
  const subCreates = stubMethod(t, prisma.subscription as any, "create", async (a: any) => a.data);

  const res = await request(app).post("/api/billing/resync").set(auth).send();

  assert.equal(res.status, 200, res.text);
  assert.equal(subCreates.length, 1);
  const created = subCreates[0][0].data;
  assert.equal(created.userId, USER);
  assert.equal(created.provider, "lemonsqueezy");
  assert.equal(created.externalId, "sub-777");
  assert.equal(created.status, "active");
  assert.equal(created.interval, "monthly", "the variant map named the plan");
  assert.equal(created.customerPortalUrl, "https://portal.lemonsqueezy.test/portal");
  assert.deepEqual(res.body.resynced, { lemonsqueezy: 1, revenuecat: false });
});

test("a RevenueCat outage makes the resync PARTIAL — 200 with revenuecat:false, never a failure", async (t) => {
  // LS deliberately unconfigured: the RC leg alone is on trial here.
  providerOpen(t);
  stubFetch(t, () => ({ boom: true }));
  stubResolver(t);

  const res = await request(app).post("/api/billing/resync").set(auth).send();

  assert.equal(res.status, 200, "the other leg's work must never be reported lost");
  assert.deepEqual(res.body.resynced, { lemonsqueezy: 0, revenuecat: false });
});

test("a reachable RevenueCat syncs and reports so — and the view reflects what it wrote", async (t) => {
  providerOpen(t);
  stubFetch(t, yearlySubscriber);
  const db = stubResolver(t, { subscriptions: [rcYearlyRow()] });

  const res = await request(app).post("/api/billing/resync").set(auth).send();

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.resynced, { lemonsqueezy: 0, revenuecat: true });
  assert.equal(res.body.status, "active");
  assert.equal(res.body.plan, "yearly");
  assert.equal(db.subUpsert.length, 1, "the sync wrote before the view resolved");
});

test("with Lemon Squeezy unconfigured the leg is skipped entirely and reports zero", async (t) => {
  const fetches = stubMethod(t, globalThis as any, "fetch", async () => {
    throw new Error("nothing may be fetched on an unconfigured storefront");
  });
  stubResolver(t);

  const res = await request(app).post("/api/billing/resync").set(auth).send();

  assert.equal(res.status, 200);
  assert.equal(fetches.length, 0);
  assert.deepEqual(res.body.resynced, { lemonsqueezy: 0, revenuecat: false });
});

/* ── the resync rate limit ──────────────────────────────────────────────── */

function fakeThrottle(t: Ctx, countAfterBump: number) {
  const keys: string[] = [];
  stubMethod(t, prisma.authThrottle as any, "updateMany", async (args: any) => {
    keys.push(args.where.key);
    return { count: 1 };
  });
  stubMethod(t, prisma.authThrottle as any, "findUnique", async (args: any) => ({
    key: args.where.key,
    count: countAfterBump,
    windowStartedAt: new Date(),
  }));
  return keys;
}

test("both limiter keys are consumed — the account's, then the address's", async (t) => {
  setEnv(t, { authRateLimitDisabled: false });
  const keys = fakeThrottle(t, 1);
  stubResolver(t);

  const res = await request(app).post("/api/billing/resync").set(auth).send();

  assert.equal(res.status, 200);
  assert.deepEqual(keys.length, 2);
  assert.equal(keys[0], `resync:user:${USER}`);
  assert.ok(keys[1].startsWith("resync:ip:"));
});

test("over the window → the standard 429 shape, before anything is fetched or written", async (t) => {
  setEnv(t, { authRateLimitDisabled: false });
  fakeThrottle(t, 6);
  const fetches = stubMethod(t, globalThis as any, "fetch", async () => {
    throw new Error("a throttled request must not reach any provider");
  });

  const res = await request(app).post("/api/billing/resync").set(auth).send();

  assert.equal(res.status, 429);
  assert.deepEqual(res.body, { error: "Too many requests" });
  assert.equal(fetches.length, 0);
});

test("a body cannot ask for the sandbox: the gate is the account's, not the request's", async (t) => {
  // Same rule as the refresh subject above. The client is never a source of
  // environment — not the row's, and not the gate's.
  setEnv(t, { revenuecatAllowSandbox: false, revenuecatSandboxAllowedUserIds: [] });
  providerOpen(t);
  stubFetch(t, yearlySubscriber);
  const db = stubResolver(t, { purchases: [sandboxLifetime()] });

  const res = await request(app)
    .post("/api/billing/revenuecat/refresh")
    .set(auth)
    .send({ environment: "SANDBOX", allowSandbox: true, testMode: true });

  assert.equal(res.status, 200);
  assert.equal(res.body.isPro, false);
  assert.deepEqual(db.purchaseFindMany[0][0].where.OR, [{ NOT: { testMode: true } }]);
});
