import assert from "node:assert/strict";
import { test } from "node:test";
import request from "supertest";
import { createApp } from "../app";
import { signToken } from "../lib/jwt";
import { prisma } from "../lib/prisma";
import { env } from "../lib/env";
import { TRIAL_DAYS } from "../lib/entitlement";

const app = createApp();
const userId = "507f1f77bcf86cd799439011";
const auth = {
  authorization: `Bearer ${signToken({ sub: userId, email: "user@example.com" })}`,
};

function stubMethod(
  t: { after: (fn: () => void) => void },
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

const days = (n: number) => new Date(Date.now() + n * 24 * 60 * 60 * 1000);

/**
 * Stub the purchase lookup the route now performs.
 *
 * Every trial-era case below predates desktop payments and means "this account
 * has never bought anything" — which has to be said out loud now that the route
 * asks. Left unstubbed it is not a wrong answer but a thrown one: the real client
 * tries to open a connection and the request 500s.
 */
function noPurchases(t: any) {
  stubMethod(t, prisma.purchase as any, "findMany", async () => []);
}

test("entitlement requires a bearer token", async () => {
  const res = await request(app).get("/api/entitlement");
  assert.equal(res.status, 401);
});

test("a live trial window reports trialing + isPro, and cannot start another", async (t) => {
  stubMethod(t, prisma.user as any, "findUnique", async () => ({ trialEndsAt: days(9) }));
  noPurchases(t);

  const res = await request(app).get("/api/entitlement").set(auth);

  assert.equal(res.status, 200);
  assert.equal(res.body.status, "trialing");
  assert.equal(res.body.isPro, true);
  assert.equal(res.body.trialDurationDays, TRIAL_DAYS);
  // The account is already mid-trial: offering a fresh one would be a lie the
  // client would render as "start your free trial".
  assert.equal(res.body.canStartTrial, false);
});

test("an elapsed trial reports expired", async (t) => {
  stubMethod(t, prisma.user as any, "findUnique", async () => ({ trialEndsAt: days(-1) }));
  noPurchases(t);

  const res = await request(app).get("/api/entitlement").set(auth);

  assert.equal(res.body.status, "expired");
  assert.equal(res.body.isPro, false);
  // An account that already had its window cannot be handed a fresh one, even
  // once the window is behind it. This is the invariant the (unmerged) TrialClaim
  // ledger extends from the account to the machine.
  assert.equal(res.body.canStartTrial, false);
});

test("the countdown is anchored to the SERVER clock, not the caller's", async (t) => {
  const endsAt = days(3);
  stubMethod(t, prisma.user as any, "findUnique", async () => ({ trialEndsAt: endsAt }));
  noPurchases(t);

  const before = Date.now();
  const res = await request(app).get("/api/entitlement").set(auth);
  const after = Date.now();

  const serverTime = Date.parse(res.body.serverTime);
  assert.ok(serverTime >= before && serverTime <= after, "serverTime is this request's clock");
  assert.equal(res.body.trialEndsAt, endsAt.toISOString());
});

test("an account with no trial window ever stamped may start one", async (t) => {
  stubMethod(t, prisma.user as any, "findUnique", async () => ({ trialEndsAt: null }));
  noPurchases(t);

  const res = await request(app).get("/api/entitlement").set(auth);

  assert.equal(res.body.status, "expired");
  assert.equal(res.body.trialEndsAt, null);
  assert.equal(res.body.canStartTrial, true);
});

test("a token whose account was deleted gets a machine-readable 404", async (t) => {
  stubMethod(t, prisma.user as any, "findUnique", async () => null);
  noPurchases(t);

  const res = await request(app).get("/api/entitlement").set(auth);

  assert.equal(res.status, 404);
  assert.equal(res.body.code, "ACCOUNT_NOT_FOUND");
});

// --- desktop purchases (Lemon Squeezy) --------------------------------------

test("a paid desktop licence outranks an elapsed trial and reports active", async (t) => {
  stubMethod(t, prisma.user as any, "findUnique", async () => ({ trialEndsAt: days(-30) }));
  stubMethod(t, prisma.purchase as any, "findMany", async () => [{ isRefunded: false }]);

  const res = await request(app).get("/api/entitlement").set(auth);

  assert.equal(res.status, 200);
  assert.equal(res.body.status, "active");
  assert.equal(res.body.isPro, true);
});

test("a refunded purchase does not keep access", async (t) => {
  stubMethod(t, prisma.user as any, "findUnique", async () => ({ trialEndsAt: days(-30) }));
  stubMethod(t, prisma.purchase as any, "findMany", async () => [{ isRefunded: true }]);

  const res = await request(app).get("/api/entitlement").set(auth);

  assert.equal(res.body.status, "refunded");
  assert.equal(res.body.isPro, false);
});

// Someone who bought, was refunded, then bought again. Ranking the refund first
// would take away a licence they are currently paying for.
test("a live purchase beats an older refunded one", async (t) => {
  stubMethod(t, prisma.user as any, "findUnique", async () => ({ trialEndsAt: days(-30) }));
  stubMethod(t, prisma.purchase as any, "findMany", async () => [{ isRefunded: true }, { isRefunded: false }]);

  const res = await request(app).get("/api/entitlement").set(auth);

  assert.equal(res.body.status, "active");
  assert.equal(res.body.isPro, true);
});

// --- the rollout switch ------------------------------------------------------

/*
 * `enforced` is the desktop client's ONLY gate: AuthGate locks on
 * `enforced === true && !isPro`. While the server could not emit it, the paywall
 * was unreachable code in every production build and no customer could pay even
 * if they wanted to — so these two tests are the difference between having a
 * business model and describing one.
 */
test("enforcement is OFF by default, so no existing account is locked out by a deploy", async (t) => {
  stubMethod(t, prisma.user as any, "findUnique", async () => ({ trialEndsAt: days(-1) }));
  noPurchases(t);

  const res = await request(app).get("/api/entitlement").set(auth);

  assert.equal(res.body.enforced, false);
  assert.notEqual(res.body.enforced, undefined, "absent must be false on the wire, never undefined");
});

test("ENTITLEMENT_ENFORCED reaches the client, and never changes the status it reports", async (t) => {
  const before = env.entitlementEnforced;
  (env as any).entitlementEnforced = true;
  t.after(() => {
    (env as any).entitlementEnforced = before;
  });
  stubMethod(t, prisma.user as any, "findUnique", async () => ({ trialEndsAt: days(9) }));
  noPurchases(t);

  const res = await request(app).get("/api/entitlement").set(auth);

  assert.equal(res.body.enforced, true);
  // The switch says what the CLIENT may do, not what is true. A user mid-trial
  // stays `trialing` and pro whether or not enforcement is on.
  assert.equal(res.body.status, "trialing");
  assert.equal(res.body.isPro, true);
});
