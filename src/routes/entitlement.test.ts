import assert from "node:assert/strict";
import { test } from "node:test";
import request from "supertest";
import { createApp } from "../app";
import { signToken } from "../lib/jwt";
import { prisma } from "../lib/prisma";
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

test("entitlement requires a bearer token", async () => {
  const res = await request(app).get("/api/entitlement");
  assert.equal(res.status, 401);
});

test("a live trial window reports trialing + isPro, and cannot start another", async (t) => {
  stubMethod(t, prisma.user as any, "findUnique", async () => ({ trialEndsAt: days(9) }));

  const res = await request(app).get("/api/entitlement").set(auth);

  assert.equal(res.status, 200);
  assert.equal(res.body.status, "trialing");
  assert.equal(res.body.isPro, true);
  assert.equal(res.body.trialDurationDays, TRIAL_DAYS);
  // The account is already mid-trial: offering a fresh one would be a lie the
  // client would render as "start your free trial".
  assert.equal(res.body.canStartTrial, false);
});

test("an elapsed trial reports expired, and stays unbuyable until StoreKit lands", async (t) => {
  stubMethod(t, prisma.user as any, "findUnique", async () => ({ trialEndsAt: days(-1) }));

  const res = await request(app).get("/api/entitlement").set(auth);

  assert.equal(res.body.status, "expired");
  assert.equal(res.body.isPro, false);
  // No Purchase row can exist yet, so `active` is unreachable — asserted so the
  // day someone wires StoreKit, this test fails and forces the route's two
  // hard-coded `false`s to be revisited.
  assert.equal(res.body.canStartTrial, false);
});

test("the countdown is anchored to the SERVER clock, not the caller's", async (t) => {
  const endsAt = days(3);
  stubMethod(t, prisma.user as any, "findUnique", async () => ({ trialEndsAt: endsAt }));

  const before = Date.now();
  const res = await request(app).get("/api/entitlement").set(auth);
  const after = Date.now();

  const serverTime = Date.parse(res.body.serverTime);
  assert.ok(serverTime >= before && serverTime <= after, "serverTime is this request's clock");
  assert.equal(res.body.trialEndsAt, endsAt.toISOString());
});

test("an account with no trial window ever stamped may start one", async (t) => {
  stubMethod(t, prisma.user as any, "findUnique", async () => ({ trialEndsAt: null }));

  const res = await request(app).get("/api/entitlement").set(auth);

  assert.equal(res.body.status, "expired");
  assert.equal(res.body.trialEndsAt, null);
  assert.equal(res.body.canStartTrial, true);
});

test("a token whose account was deleted gets a machine-readable 404", async (t) => {
  stubMethod(t, prisma.user as any, "findUnique", async () => null);

  const res = await request(app).get("/api/entitlement").set(auth);

  assert.equal(res.status, 404);
  assert.equal(res.body.code, "ACCOUNT_NOT_FOUND");
});
