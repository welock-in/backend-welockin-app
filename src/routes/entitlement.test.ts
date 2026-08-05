import assert from "node:assert/strict";
import { test } from "node:test";
import request from "supertest";
import { Prisma } from "@prisma/client";
import { createApp } from "../app";
import { signToken } from "../lib/jwt";
import { prisma } from "../lib/prisma";
import { env } from "../lib/env";
import { ledgerHash } from "../lib/hash";

import { stubNoSubscriptions } from "./test-helpers";

stubNoSubscriptions();

const app = createApp();
const userId = "507f1f77bcf86cd799439011";
const otherUserId = "507f1f77bcf86cd799439022";
const auth = {
  authorization: `Bearer ${signToken({ sub: userId, email: "user@example.com" })}`,
};
const otherAuth = {
  authorization: `Bearer ${signToken({ sub: otherUserId, email: "other@example.com" })}`,
};

const MAC = "mac-af2c7ca4-ba2a-5f93-b21d-8c038f226086";
const OTHER_MAC = "mac-11111111-2222-3333-4444-555555555555";
const dev = (id: string) => ({ "x-welockin-device-id": id });

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

const days = (n: number) => new Date(Date.now() + n * 24 * 60 * 60 * 1000);

/**
 * An in-memory stand-in for the ledger that ENFORCES the global unique index on
 * `deviceIdHash`, because that index is the entire anti-farm mechanism. A stub
 * that merely records calls would let every test below pass while the real thing
 * handed out unlimited trials.
 */
function fakeLedger(t: Ctx, seed: any[] = []) {
  const store: any[] = seed.map((r, i) => ({
    id: `claim-${i}`,
    createdAt: new Date(2020, 0, 1 + i),
    trialDays: env.trialDays,
    ...r,
  }));

  stubMethod(t, prisma.trialClaim as any, "findFirst", async (args: any) => {
    const or: any[] = args.where.OR ?? [];
    const matches = store.filter((row) =>
      or.some(
        (c) =>
          (c.deviceIdHash !== undefined && row.deviceIdHash === c.deviceIdHash) ||
          (c.firstUserId !== undefined && row.firstUserId === c.firstUserId) ||
          (c.idfvHash !== undefined && row.idfvHash === c.idfvHash),
      ),
    );
    matches.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    return matches[0] ?? null;
  });

  stubMethod(t, prisma.trialClaim as any, "create", async (args: any) => {
    if (store.some((r) => r.deviceIdHash === args.data.deviceIdHash)) {
      throw new Prisma.PrismaClientKnownRequestError("duplicate", {
        code: "P2002",
        clientVersion: "5",
      });
    }
    const row = { id: `claim-${store.length}`, createdAt: new Date(2030, 0, store.length), ...args.data };
    store.push(row);
    return row;
  });

  stubMethod(t, prisma.trialClaim as any, "update", async (args: any) => {
    const row = store.find((r) => r.id === args.where.id);
    return row ?? null;
  });

  return store;
}

/** The account row. `trialEndsAt: null` is what every post-ledger account has. */
function account(t: Ctx, over: Record<string, unknown> = {}) {
  stubMethod(t, prisma.user as any, "findUnique", async () => ({
    trialEndsAt: null,
    compActive: false,
    compedUntil: null,
    accessRevoked: false,
    ...over,
  }));
  return stubMethod(t, prisma.user as any, "update", async () => ({}));
}

function noPurchases(t: Ctx) {
  stubMethod(t, prisma.purchase as any, "findMany", async () => []);
}

/* ── reading ──────────────────────────────────────────────────────────── */

test("entitlement requires a bearer token", async () => {
  const res = await request(app).get("/api/entitlement");
  assert.equal(res.status, 401);
});

test("a live claim reports trialing + isPro, and cannot start another", async (t) => {
  account(t);
  noPurchases(t);
  fakeLedger(t, [{ deviceIdHash: ledgerHash(MAC), firstUserId: userId, endsAt: days(9) }]);

  const res = await request(app).get("/api/entitlement").set(auth).set(dev(MAC));

  assert.equal(res.status, 200);
  assert.equal(res.body.status, "trialing");
  assert.equal(res.body.isPro, true);
  assert.equal(res.body.canStartTrial, false);
});

/*
 * Every account that existed before the ledger carries the window registration
 * used to stamp. Reading only the ledger would turn all of them `expired` the
 * moment this deploys.
 */
test("an account from before the ledger keeps the window it is inside", async (t) => {
  const legacyEnds = days(5);
  account(t, { trialEndsAt: legacyEnds });
  noPurchases(t);
  fakeLedger(t, []);

  const res = await request(app).get("/api/entitlement").set(auth).set(dev(MAC));

  assert.equal(res.body.status, "trialing");
  assert.equal(res.body.trialEndsAt, legacyEnds.toISOString(), "the legacy column is what it reports");
  assert.equal(res.body.canStartTrial, false, "a legacy window is still a claimed one");
});

test("a claim outranks the legacy column", async (t) => {
  const claimEnds = days(9);
  account(t, { trialEndsAt: days(-100) });
  noPurchases(t);
  fakeLedger(t, [{ deviceIdHash: ledgerHash(MAC), firstUserId: userId, endsAt: claimEnds }]);

  const res = await request(app).get("/api/entitlement").set(auth).set(dev(MAC));

  assert.equal(res.body.status, "trialing");
  assert.equal(res.body.trialEndsAt, claimEnds.toISOString());
});

/*
 * Seeing your status must never be the thing that consumes your trial — a client
 * that polls entitlement on every launch would otherwise claim on behalf of
 * someone who never asked.
 */
test("reading entitlement never creates a claim", async (t) => {
  account(t);
  noPurchases(t);
  const store = fakeLedger(t, []);

  const res = await request(app).get("/api/entitlement").set(auth).set(dev(MAC));

  assert.equal(store.length, 0);
  assert.equal(res.body.canStartTrial, true, "and it says one is available");
});

test("the countdown is anchored to the SERVER clock", async (t) => {
  const endsAt = days(3);
  account(t);
  noPurchases(t);
  fakeLedger(t, [{ deviceIdHash: ledgerHash(MAC), firstUserId: userId, endsAt }]);

  const before = Date.now();
  const res = await request(app).get("/api/entitlement").set(auth).set(dev(MAC));
  const after = Date.now();

  const serverTime = Date.parse(res.body.serverTime);
  assert.ok(serverTime >= before && serverTime <= after);
  assert.equal(res.body.trialEndsAt, endsAt.toISOString());
});

test("a token whose account was deleted gets a machine-readable 404", async (t) => {
  stubMethod(t, prisma.user as any, "findUnique", async () => null);
  noPurchases(t);
  fakeLedger(t, []);

  const res = await request(app).get("/api/entitlement").set(auth).set(dev(MAC));

  assert.equal(res.status, 404);
  assert.equal(res.body.code, "ACCOUNT_NOT_FOUND");
});

/* ── claiming ─────────────────────────────────────────────────────────── */

test("claiming starts a full window on a hardware-identified Mac", async (t) => {
  account(t);
  noPurchases(t);
  const store = fakeLedger(t, []);

  const res = await request(app)
    .post("/api/entitlement/trial")
    .set(auth)
    .set(dev(MAC))
    .send({ hardwareBacked: true });

  assert.equal(res.status, 200);
  assert.equal(res.body.status, "trialing");
  assert.equal(store.length, 1);
  assert.equal(store[0].trialDays, env.trialDays);
  assert.equal(store[0].flagged, false);
  assert.equal(store[0].deviceIdHash, ledgerHash(MAC), "the raw device id is never stored");
  assert.ok(!JSON.stringify(store[0]).includes(MAC));
});

test("claiming twice returns the same window, never a fresh one", async (t) => {
  account(t);
  noPurchases(t);
  const store = fakeLedger(t, []);

  const first = await request(app)
    .post("/api/entitlement/trial")
    .set(auth)
    .set(dev(MAC))
    .send({ hardwareBacked: true });
  const second = await request(app)
    .post("/api/entitlement/trial")
    .set(auth)
    .set(dev(MAC))
    .send({ hardwareBacked: true });

  assert.equal(store.length, 1);
  assert.equal(second.body.trialEndsAt, first.body.trialEndsAt);
});

test("a claim that has already elapsed is NOT renewed by claiming again", async (t) => {
  const elapsed = days(-30);
  account(t);
  noPurchases(t);
  const store = fakeLedger(t, [
    { deviceIdHash: ledgerHash(MAC), firstUserId: userId, endsAt: elapsed },
  ]);

  const res = await request(app)
    .post("/api/entitlement/trial")
    .set(auth)
    .set(dev(MAC))
    .send({ hardwareBacked: true });

  assert.equal(res.body.status, "expired");
  assert.equal(store.length, 1);
  assert.equal(store[0].endsAt, elapsed, "endsAt is stamped once and never moves");
});

/*
 * THE invariant this whole model exists for. A new email used to be a new
 * fortnight; the machine is what is scarce, so the machine is what is counted.
 */
test("a brand-new account on a machine that already claimed gets NO fresh window", async (t) => {
  const elapsed = days(-30);
  account(t);
  noPurchases(t);
  const store = fakeLedger(t, [
    { deviceIdHash: ledgerHash(MAC), firstUserId: "some-earlier-account", endsAt: elapsed },
  ]);

  const res = await request(app)
    .post("/api/entitlement/trial")
    .set(otherAuth)
    .set(dev(MAC))
    .send({ hardwareBacked: true });

  assert.equal(res.body.status, "expired");
  assert.equal(store.length, 1, "no second claim for one machine");
});

/*
 * `DELETE /api/me` hard-deletes the user row, which frees the email — so the
 * SAME address could go round again. The claim outlives the account precisely so
 * that changes nothing: `firstUserId` is nulled, the row stays.
 */
test("deleting the account and starting over lands on the same expired window", async (t) => {
  const elapsed = days(-30);
  account(t);
  noPurchases(t);
  const store = fakeLedger(t, [
    { deviceIdHash: ledgerHash(MAC), firstUserId: null, endsAt: elapsed },
  ]);

  const res = await request(app)
    .post("/api/entitlement/trial")
    .set(auth)
    .set(dev(MAC))
    .send({ hardwareBacked: true });

  assert.equal(res.body.status, "expired");
  assert.equal(store.length, 1);
});

/*
 * A second Mac on the SAME account must not be a second trial — but it must
 * still see the window the account is inside, rather than being told to start
 * one it cannot have.
 */
test("a second Mac on the same account shares the account's window", async (t) => {
  const endsAt = days(6);
  account(t);
  noPurchases(t);
  const store = fakeLedger(t, [
    { deviceIdHash: ledgerHash(MAC), firstUserId: userId, endsAt },
  ]);

  const res = await request(app)
    .post("/api/entitlement/trial")
    .set(auth)
    .set(dev(OTHER_MAC))
    .send({ hardwareBacked: true });

  assert.equal(res.body.status, "trialing");
  assert.equal(res.body.trialEndsAt, endsAt.toISOString());
  assert.equal(store.length, 1, "the account leg blocks the second claim");
});

/*
 * The check-then-act window between "is there a prior claim" and "create one" is
 * closed by the unique index, not by the read. Two simultaneous claims must
 * converge on one window rather than both proceeding.
 */
test("a concurrent claim for the same machine collides instead of resetting", async (t) => {
  account(t);
  noPurchases(t);
  const store = fakeLedger(t, []);
  const original = (prisma.trialClaim as any).findFirst;
  // Both requests read "no prior claim", then both try to write.
  (prisma.trialClaim as any).findFirst = async () => null;
  t.after(() => {
    (prisma.trialClaim as any).findFirst = original;
  });

  const both = await Promise.all([
    request(app).post("/api/entitlement/trial").set(auth).set(dev(MAC)).send({ hardwareBacked: true }),
    request(app).post("/api/entitlement/trial").set(auth).set(dev(MAC)).send({ hardwareBacked: true }),
  ]);

  assert.equal(both[0].status, 200);
  assert.equal(both[1].status, 200);
  assert.equal(store.length, 1, "the unique index is the lock");
});

/*
 * `device.rs` falls back to a random file-persisted UUID when IOKit cannot be
 * read. That identity is resettable, so the full window would make "break the
 * hardware lookup" the bypass.
 */
test("a machine that could not prove its hardware gets a short, flagged window", async (t) => {
  account(t);
  noPurchases(t);
  const store = fakeLedger(t, []);

  await request(app)
    .post("/api/entitlement/trial")
    .set(auth)
    .set(dev(MAC))
    .send({ hardwareBacked: false });

  assert.equal(store[0].trialDays, env.trialDaysUnverified);
  assert.equal(store[0].flagged, true);
  assert.ok(env.trialDaysUnverified < env.trialDays);
});

/*
 * "Not stated" is NOT "unproven". No shipped client sends this field, so
 * inferring failure from its absence would quietly cut every existing user to a
 * three-day trial the day the ledger deploys. Only a client that LOOKED for the
 * hardware id and failed gets the short window — and the anchor is still one
 * window per machine either way, so the benefit of the doubt costs nothing.
 */
test("a client that never heard of hardwareBacked still gets a full window", async (t) => {
  account(t);
  noPurchases(t);
  const store = fakeLedger(t, []);

  await request(app).post("/api/entitlement/trial").set(auth).set(dev(MAC)).send({});

  assert.equal(store[0].trialDays, env.trialDays);
  assert.equal(store[0].flagged, false);
});

test("claiming without a device id is refused", async (t) => {
  account(t);
  noPurchases(t);
  fakeLedger(t, []);

  const res = await request(app).post("/api/entitlement/trial").set(auth).send({});

  assert.equal(res.status, 400);
});

test("a client clock years out of step is recorded, not obeyed", async (t) => {
  account(t);
  noPurchases(t);
  const store = fakeLedger(t, []);

  await request(app)
    .post("/api/entitlement/trial")
    .set(auth)
    .set(dev(MAC))
    .send({ hardwareBacked: true, clientTime: new Date(Date.now() + 400 * 24 * 3600 * 1000).toISOString() });

  assert.equal(store[0].skewStrikes, 1);
  assert.equal(store[0].flagged, true);
  // The window is still ours: a machine set to the future gets no extra day.
  const ends = new Date(store[0].endsAt).getTime() - Date.now();
  assert.ok(ends < (env.trialDays + 1) * 24 * 3600 * 1000);
});

/* ── the signup path ──────────────────────────────────────────────────── */

/**
 * Registration claims too, because no shipped client knows about
 * `POST /api/entitlement/trial` yet — leaving the claim to that endpoint alone
 * would mean every account created by a current build resolved `expired` from
 * its first second.
 */
function signupStubs(t: Ctx, newUserId: string) {
  stubMethod(t, prisma.user as any, "findUnique", async () => null); // email is free
  return stubMethod(t, prisma.user as any, "create", async () => ({
    id: newUserId,
    email: "fresh@example.com",
    plan: "trial",
    createdAt: new Date(),
    updatedAt: new Date(),
  }));
}

test("registering on a fresh Mac starts the trial without any client change", async (t) => {
  signupStubs(t, userId);
  const store = fakeLedger(t, []);

  const res = await request(app)
    .post("/api/auth/register")
    .set(dev(MAC))
    .send({ email: "fresh@example.com", password: "hunter2hunter2" });

  assert.equal(res.status, 201);
  assert.equal(store.length, 1);
  assert.equal(store[0].trialDays, env.trialDays);
});

/*
 * The farm, walked end to end through the real registration route rather than
 * the claim endpoint: a second account, a different email, the same Mac.
 */
test("a second account on the same Mac gets no second window", async (t) => {
  signupStubs(t, otherUserId);
  const store = fakeLedger(t, [
    { deviceIdHash: ledgerHash(MAC), firstUserId: userId, endsAt: days(-30) },
  ]);

  const res = await request(app)
    .post("/api/auth/register")
    .set(dev(MAC))
    .send({ email: "second@example.com", password: "hunter2hunter2" });

  assert.equal(res.status, 201, "the account is still allowed — only the trial is not");
  assert.equal(store.length, 1);
});

test("registering without a device id still works, it just claims nothing", async (t) => {
  signupStubs(t, userId);
  const store = fakeLedger(t, []);

  const res = await request(app)
    .post("/api/auth/register")
    .send({ email: "fresh@example.com", password: "hunter2hunter2" });

  assert.equal(res.status, 201);
  assert.equal(store.length, 0);
});

/*
 * A ledger write that fails must never cost someone the account they just made:
 * they would have no way to retry it, and the row they did get would be unusable.
 */
test("a ledger failure does not cost the user their account", async (t) => {
  signupStubs(t, userId);
  fakeLedger(t, []);
  stubMethod(t, prisma.trialClaim as any, "create", async () => {
    throw new Error("mongo is down");
  });

  const res = await request(app)
    .post("/api/auth/register")
    .set(dev(MAC))
    .send({ email: "fresh@example.com", password: "hunter2hunter2" });

  assert.equal(res.status, 201);
  assert.ok(res.body.token);
});

/* ── purchases, comps, revocations ────────────────────────────────────── */

test("a paid licence outranks an elapsed trial", async (t) => {
  account(t);
  stubMethod(t, prisma.purchase as any, "findMany", async () => [{ isRefunded: false }]);
  fakeLedger(t, [{ deviceIdHash: ledgerHash(MAC), firstUserId: userId, endsAt: days(-30) }]);

  const res = await request(app).get("/api/entitlement").set(auth).set(dev(MAC));

  assert.equal(res.body.status, "active");
  assert.equal(res.body.isPro, true);
});

test("a refunded purchase does not keep access", async (t) => {
  account(t);
  stubMethod(t, prisma.purchase as any, "findMany", async () => [{ isRefunded: true }]);
  fakeLedger(t, []);

  const res = await request(app).get("/api/entitlement").set(auth).set(dev(MAC));

  assert.equal(res.body.status, "refunded");
  assert.equal(res.body.isPro, false);
});

test("a live purchase beats an older refunded one", async (t) => {
  account(t);
  stubMethod(t, prisma.purchase as any, "findMany", async () => [
    { isRefunded: true },
    { isRefunded: false },
  ]);
  fakeLedger(t, []);

  const res = await request(app).get("/api/entitlement").set(auth).set(dev(MAC));

  assert.equal(res.body.status, "active");
});

/*
 * The comp is how the whole existing cohort survives the day enforcement is
 * switched on, and how support extends a trial. Before this it was hard-coded
 * `false` and the `comped` status was unreachable.
 */
test("an admin comp grants access with no purchase and no trial", async (t) => {
  account(t, { compActive: true, compedUntil: days(30) });
  noPurchases(t);
  fakeLedger(t, [{ deviceIdHash: ledgerHash(MAC), firstUserId: userId, endsAt: days(-90) }]);

  const res = await request(app).get("/api/entitlement").set(auth).set(dev(MAC));

  assert.equal(res.body.status, "comped");
  assert.equal(res.body.isPro, true);
});

test("an expired comp stops granting", async (t) => {
  account(t, { compActive: true, compedUntil: days(-1) });
  noPurchases(t);
  fakeLedger(t, []);

  const res = await request(app).get("/api/entitlement").set(auth).set(dev(MAC));

  assert.equal(res.body.status, "expired");
});

test("a comp with no end date is a lifetime grant", async (t) => {
  account(t, { compActive: true, compedUntil: null });
  noPurchases(t);
  fakeLedger(t, []);

  const res = await request(app).get("/api/entitlement").set(auth).set(dev(MAC));

  assert.equal(res.body.status, "comped");
});

test("a revocation outranks everything, including a paid licence", async (t) => {
  account(t, { accessRevoked: true, compActive: true });
  stubMethod(t, prisma.purchase as any, "findMany", async () => [{ isRefunded: false }]);
  fakeLedger(t, [{ deviceIdHash: ledgerHash(MAC), firstUserId: userId, endsAt: days(9) }]);

  const res = await request(app).get("/api/entitlement").set(auth).set(dev(MAC));

  assert.equal(res.body.status, "revoked");
  assert.equal(res.body.isPro, false);
});

/* ── the rollout switch ───────────────────────────────────────────────── */

/*
 * Pinned explicitly rather than read from the ambient environment. This test used
 * to assert the DEFAULT by simply not setting anything, which passed only for as
 * long as no `.env` existed in the repo — the day a local dev file turned
 * enforcement on, a green suite went red for a reason that had nothing to do with
 * the code.
 */
test("enforcement OFF is reported as false, never as an absent field", async (t) => {
  const before = env.entitlementEnforced;
  (env as any).entitlementEnforced = false;
  t.after(() => {
    (env as any).entitlementEnforced = before;
  });
  account(t);
  noPurchases(t);
  fakeLedger(t, []);

  const res = await request(app).get("/api/entitlement").set(auth).set(dev(MAC));

  assert.equal(res.body.enforced, false);
  assert.notEqual(res.body.enforced, undefined, "absent must be false on the wire");
});


test("ENTITLEMENT_ENFORCED reaches the client and never changes the status", async (t) => {
  const before = env.entitlementEnforced;
  (env as any).entitlementEnforced = true;
  t.after(() => {
    (env as any).entitlementEnforced = before;
  });
  account(t);
  noPurchases(t);
  fakeLedger(t, [{ deviceIdHash: ledgerHash(MAC), firstUserId: userId, endsAt: days(9) }]);

  const res = await request(app).get("/api/entitlement").set(auth).set(dev(MAC));

  assert.equal(res.body.enforced, true);
  assert.equal(res.body.status, "trialing");
  assert.equal(res.body.isPro, true);
});

/* ── the cache is a mirror, never an input ────────────────────────────── */

test("the computed status is mirrored onto the user row for the admin console", async (t) => {
  const updates = account(t);
  stubMethod(t, prisma.purchase as any, "findMany", async () => [{ isRefunded: false }]);
  fakeLedger(t, []);

  await request(app).get("/api/entitlement").set(auth).set(dev(MAC));

  const written = updates[0][0].data;
  assert.equal(written.entitlementStatus, "active");
  assert.equal(written.isProCached, true);
  // The legacy column the console renders, which used to say "trial" forever.
  assert.equal(written.plan, "active");
});

test("a cache write that fails does not turn a correct answer into a 500", async (t) => {
  stubMethod(t, prisma.user as any, "findUnique", async () => ({
    trialEndsAt: null,
    compActive: false,
    compedUntil: null,
    accessRevoked: false,
  }));
  stubMethod(t, prisma.user as any, "update", async () => {
    throw new Error("mongo is down");
  });
  noPurchases(t);
  fakeLedger(t, [{ deviceIdHash: ledgerHash(MAC), firstUserId: userId, endsAt: days(9) }]);

  const res = await request(app).get("/api/entitlement").set(auth).set(dev(MAC));

  assert.equal(res.status, 200);
  assert.equal(res.body.status, "trialing");
});
