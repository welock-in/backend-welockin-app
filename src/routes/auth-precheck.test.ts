import assert from "node:assert/strict";
import { test } from "node:test";
import { generateKeyPairSync } from "node:crypto";
import jwt from "jsonwebtoken";
import request from "supertest";
import { createApp } from "../app";
import { signToken } from "../lib/jwt";
import { prisma } from "../lib/prisma";
import { env } from "../lib/env";
import { ledgerHash } from "../lib/hash";
import { maskEmail } from "../lib/user";

/*
 * POST /api/auth/precheck (S1/N4 + L1/N6) and the signup gates it backs up.
 *
 * The contract under test is a PRIVACY contract as much as a feature: an
 * unauthenticated caller may learn that the device in their hand has a paying
 * account, masked — and nothing else. Several tests below therefore pin what
 * the response must NOT contain, not only what it must.
 *
 * House pattern throughout: no test database, Prisma methods are monkey-patched
 * per test and restored in `t.after` (see auth-email.test.ts, whose fakes these
 * mirror). The fakes honour exactly the filters the code under test sends —
 * `isRefunded: false`, the test-row OR gate, the deviceId equality — so
 * deleting a filter from the query turns a test red instead of quietly passing.
 */

// Off for the whole file except the two tests that are ABOUT the limiter: the
// counter fails open on a database error, so leaving it on would only bury
// assertions under `[rate-limit] counter unavailable` noise.
(env as { authRateLimitDisabled: boolean }).authRateLimitDisabled = true;

const app = createApp();

const OWNER_ID = "507f1f77bcf86cd799439022";
const OWNER_EMAIL = "owner@example.com";
const STRANGER_ID = "507f1f77bcf86cd799439033";
const DEVICE = "ios-2b6f0cc9-04ff-4b9a-8e2f-1c8e6d9a0b11";
const IDFV = "8A9E4F20-33AA-46D2-9CBF-1B7B4E2D5A6C";
const deviceHeader = { "x-welockin-device-id": DEVICE };

type Ctx = { after: (fn: () => void) => void };
type Row = Record<string, any>;

const copy = <T extends Row>(row: T | null | undefined): T | null =>
  row ? ({ ...row } as T) : null;

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

/** Pin an env flag for one test and put it back. Flags are read at call time. */
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

const daysFromNow = (n: number) => new Date(Date.now() + n * 24 * 60 * 60 * 1000);

/* ── the fakes ────────────────────────────────────────────────────────────── */

/** Device rows, honouring the deviceId filter, the recency order and `take`. */
function fakeDevices(t: Ctx, rows: Row[]) {
  return stubMethod(t, prisma.device as any, "findMany", async (args: any) => {
    let matches = rows.filter((r) => r.deviceId === args?.where?.deviceId);
    matches = matches
      .slice()
      .sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime());
    if (args?.take) matches = matches.slice(0, args.take);
    return matches.map((r) => ({ userId: r.userId }));
  });
}

function fakeUsers(t: Ctx, seed: Row[]) {
  const store: Row[] = seed.map((r) => ({
    passwordHash: null,
    emailVerified: true,
    plan: "trial",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...r,
  }));
  stubMethod(t, prisma.user as any, "findUnique", async (args: any) => {
    const w = args?.where ?? {};
    return copy(
      store.find(
        (r) =>
          (w.id !== undefined && r.id === w.id) || (w.email !== undefined && r.email === w.email),
      ),
    );
  });
  const creates = stubMethod(t, prisma.user as any, "create", async (args: any) => {
    const row = {
      id: `507f1f77bcf86cd7994390${40 + store.length}`,
      plan: "trial",
      emailVerified: false,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...args.data,
    };
    store.push(row);
    return copy(row);
  });
  return { store, creates };
}

/** Does a row pass the `hideTestRowsFor` OR-gate the queries carry? */
const passesTestGate = (row: Row, or: Row[] | undefined): boolean => {
  if (!or) return true;
  return or.some((clause) => {
    if (clause.NOT?.testMode === true) return row.testMode !== true;
    if (clause.provider !== undefined) return row.provider === clause.provider;
    return false;
  });
};

/** Purchases, honouring userId, `isRefunded: false` AND the test-row gate. */
function fakePurchases(t: Ctx, rows: Row[]) {
  return stubMethod(t, prisma.purchase as any, "findFirst", async (args: any) => {
    const w = args?.where ?? {};
    return copy(
      rows.find(
        (r) =>
          (w.userId === undefined || r.userId === w.userId) &&
          (w.isRefunded === undefined || r.isRefunded === w.isRefunded) &&
          passesTestGate(r, w.OR),
      ),
    );
  });
}

/** A subscription row that `subscriptionGrants` says still grants. */
const grantingSub = (userId: string, over: Row = {}): Row => ({
  userId,
  provider: "lemonsqueezy",
  status: "active",
  validUntil: daysFromNow(20),
  variantId: "",
  pauseMode: null,
  trialEndsAt: null,
  trialCancelledAt: null,
  providerUpdatedAt: new Date(),
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

function fakeSubscriptions(t: Ctx, rows: Row[]) {
  return stubMethod(t, prisma.subscription as any, "findMany", async (args: any) => {
    const w = args?.where ?? {};
    return rows
      .filter((r) => (w.userId === undefined || r.userId === w.userId) && passesTestGate(r, w.OR))
      .map((r) => ({ ...r }));
  });
}

function fakeAuthProviders(t: Ctx, rows: Row[]) {
  stubMethod(t, prisma.authProvider as any, "findMany", async (args: any) =>
    rows
      .filter((r) => r.userId === args?.where?.userId)
      .map((r) => ({ provider: r.provider })),
  );
}

/** TrialClaim lookups for the fallback legs (idfv, then fingerprint). */
function fakeClaims(t: Ctx, rows: Row[]) {
  stubMethod(t, prisma.trialClaim as any, "findFirst", async (args: any) => {
    const w = args?.where ?? {};
    const matches = rows
      .filter((r) => w.idfvHash !== undefined && r.idfvHash === w.idfvHash)
      .sort((a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0));
    return copy(matches[0]);
  });
  stubMethod(t, prisma.trialClaim as any, "findUnique", async (args: any) =>
    copy(rows.find((r) => r.id === args?.where?.id)),
  );
}

/** The AppleTxOwner registry rows the Apple-transaction leg reads. */
function fakeAppleTxOwners(t: Ctx, rows: Row[]) {
  return stubMethod(t, prisma.appleTxOwner as any, "findUnique", async (args: any) =>
    copy(rows.find((r) => r.originalTransactionId === args?.where?.originalTransactionId)),
  );
}

/** The paying-owner world most tests start from: one device, one lifetime. */
function payingOwnerWorld(
  t: Ctx,
  over: { purchase?: Row | null; subs?: Row[]; owner?: Row; providers?: Row[] } = {},
) {
  const users = fakeUsers(t, [
    { id: OWNER_ID, email: OWNER_EMAIL, passwordHash: "$2a$10$hash", ...(over.owner ?? {}) },
  ]);
  fakeDevices(t, [{ deviceId: DEVICE, userId: OWNER_ID, lastSeenAt: new Date() }]);
  fakePurchases(
    t,
    over.purchase === null
      ? []
      : [
          {
            userId: OWNER_ID,
            provider: "revenuecat",
            isRefunded: false,
            ...(over.purchase ?? {}),
          },
        ],
  );
  fakeSubscriptions(t, over.subs ?? []);
  fakeAuthProviders(t, over.providers ?? [{ userId: OWNER_ID, provider: "apple" }]);
  return users;
}

/* ════════════════════════════════════════════════════════════════════════════
 * THE PRECHECK ROUTE
 * ══════════════════════════════════════════════════════════════════════════ */

test("a device on a lifetime owner answers known + the masked account (purchase leg)", async (t) => {
  payingOwnerWorld(t);

  const res = await request(app).post("/api/auth/precheck").set(deviceHeader).send({});

  assert.equal(res.status, 200);
  assert.equal(res.body.device.known, true);
  assert.deepEqual(res.body.device.payingAccount, {
    maskedEmail: maskEmail(OWNER_EMAIL),
    billingProvider: "APPLE",
    loginMethods: ["password", "apple"],
    isCurrentUser: false,
    blocksSignup: true,
  });
  assert.equal(typeof res.body.serverTime, "string");
});

test("a granting subscription is paying too, and names its store", async (t) => {
  payingOwnerWorld(t, { purchase: null, subs: [grantingSub(OWNER_ID)] });

  const res = await request(app).post("/api/auth/precheck").set(deviceHeader).send({});

  assert.equal(res.status, 200);
  assert.equal(res.body.device.known, true);
  assert.equal(res.body.device.payingAccount.billingProvider, "LEMON_SQUEEZY");
  // Reported, but web money never blocks a signup on this phone.
  assert.equal(res.body.device.payingAccount.blocksSignup, false);
});

test("blocksSignup is true for Apple money in either pipe: app_store lifetime or revenuecat sub", async (t) => {
  payingOwnerWorld(t, { purchase: { provider: "app_store" } });
  const lifetime = await request(app).post("/api/auth/precheck").set(deviceHeader).send({});
  assert.equal(lifetime.status, 200);
  assert.equal(lifetime.body.device.payingAccount.billingProvider, "APPLE");
  assert.equal(lifetime.body.device.payingAccount.blocksSignup, true);

  payingOwnerWorld(t, {
    purchase: null,
    subs: [grantingSub(OWNER_ID, { provider: "revenuecat" })],
  });
  const sub = await request(app).post("/api/auth/precheck").set(deviceHeader).send({});
  assert.equal(sub.status, 200);
  assert.equal(sub.body.device.payingAccount.billingProvider, "APPLE");
  assert.equal(sub.body.device.payingAccount.blocksSignup, true);
});

test("a comp is deliberately NOT a paying account", async (t) => {
  // Real money is the bar: an admin courtesy must not block a signup.
  payingOwnerWorld(t, { purchase: null, owner: { compActive: true, compedUntil: null } });

  const res = await request(app).post("/api/auth/precheck").set(deviceHeader).send({});

  assert.equal(res.status, 200);
  assert.equal(res.body.device.known, true, "the device is still recognised");
  assert.equal(res.body.device.payingAccount, null, "but nobody is PAYING");
});

test("a refunded purchase does not count, and neither does an expired subscription", async (t) => {
  payingOwnerWorld(t, {
    purchase: { isRefunded: true },
    subs: [grantingSub(OWNER_ID, { status: "expired", validUntil: daysFromNow(-30) })],
  });

  const res = await request(app).post("/api/auth/precheck").set(deviceHeader).send({});

  assert.equal(res.status, 200);
  assert.equal(res.body.device.known, true);
  assert.equal(res.body.device.payingAccount, null);
});

test("a deleted account self-heals: its Device rows are gone, so the phone is free (N13)", async (t) => {
  // Device rows cascade with the user; only the ledger claim survives, with
  // firstUserId nulled — and a claim with no owner must name nobody.
  fakeDevices(t, []);
  fakeClaims(t, [{ id: "claim-0", idfvHash: ledgerHash(IDFV), firstUserId: null }]);

  const res = await request(app)
    .post("/api/auth/precheck")
    .set(deviceHeader)
    .send({ idfv: IDFV });

  assert.equal(res.status, 200);
  assert.equal(res.body.device.known, false);
  assert.equal(res.body.device.payingAccount, null);
});

test("the idfv leg finds the owner after a reinstall wiped the Device rows", async (t) => {
  fakeDevices(t, []);
  fakeClaims(t, [
    { id: "claim-0", idfvHash: ledgerHash(IDFV), firstUserId: OWNER_ID, createdAt: new Date() },
  ]);
  fakeUsers(t, [{ id: OWNER_ID, email: OWNER_EMAIL, passwordHash: "$2a$10$hash" }]);
  fakePurchases(t, [{ userId: OWNER_ID, provider: "lemonsqueezy", isRefunded: false }]);
  fakeSubscriptions(t, []);
  fakeAuthProviders(t, []);

  const res = await request(app)
    .post("/api/auth/precheck")
    .set(deviceHeader)
    .send({ idfv: IDFV });

  assert.equal(res.status, 200);
  assert.equal(res.body.device.known, false, "no Device row matched — known is about Device rows");
  assert.equal(res.body.device.payingAccount.billingProvider, "LEMON_SQUEEZY");
  assert.deepEqual(res.body.device.payingAccount.loginMethods, ["password"]);
});

test("an unreliable device id fails open — the shared sink is never looked up", async (t) => {
  const deviceReads = fakeDevices(t, [
    // A row that WOULD match if the sink were looked up.
    { deviceId: "win-unidentified", userId: OWNER_ID, lastSeenAt: new Date() },
  ]);

  const res = await request(app)
    .post("/api/auth/precheck")
    .set({ "x-welockin-device-id": "win-unidentified" })
    .send({});

  assert.equal(res.status, 200);
  assert.equal(res.body.device.known, false);
  assert.equal(res.body.device.payingAccount, null);
  assert.equal(deviceReads.length, 0, "the sink id must never reach the database");
});

test("isCurrentUser: true for the owner's token, false for a stranger's, garbage, or none", async (t) => {
  payingOwnerWorld(t);

  const asOwner = await request(app)
    .post("/api/auth/precheck")
    .set(deviceHeader)
    .set({ authorization: `Bearer ${signToken({ sub: OWNER_ID, email: OWNER_EMAIL })}` })
    .send({});
  const asStranger = await request(app)
    .post("/api/auth/precheck")
    .set(deviceHeader)
    .set({ authorization: `Bearer ${signToken({ sub: STRANGER_ID, email: "s@example.com" })}` })
    .send({});
  const garbage = await request(app)
    .post("/api/auth/precheck")
    .set(deviceHeader)
    .set({ authorization: "Bearer not-a-jwt" })
    .send({});
  const anonymous = await request(app).post("/api/auth/precheck").set(deviceHeader).send({});

  assert.equal(asOwner.body.device.payingAccount.isCurrentUser, true);
  assert.equal(asStranger.body.device.payingAccount.isCurrentUser, false);
  assert.equal(garbage.status, 200, "an invalid token is anonymous, never a 401");
  assert.equal(garbage.body.device.payingAccount.isCurrentUser, false);
  assert.equal(anonymous.body.device.payingAccount.isCurrentUser, false);
});

test("PRIVACY PIN: the response never carries the raw email or the account id", async (t) => {
  payingOwnerWorld(t);

  const res = await request(app).post("/api/auth/precheck").set(deviceHeader).send({});

  assert.equal(res.status, 200);
  const wire = JSON.stringify(res.body);
  assert.ok(!wire.includes(OWNER_EMAIL), "the raw address must never leave the server here");
  assert.ok(!wire.includes(OWNER_ID), "nor the account id");
  assert.ok(wire.includes(maskEmail(OWNER_EMAIL)), "the mask is all a stranger gets");
});

/* ── the Apple-transaction leg (V1) ───────────────────────────────────────── */

/*
 * One Apple ID, one WeLockIn account — the leg that works when the device leg
 * cannot: Device rows die with a hand-deleted account (N13), the AppleTxOwner
 * row does not. The phone sends StoreKit's original_transaction_id; the
 * registry answers with the account the money last funded, or with the fact
 * that it funded a ghost.
 */

const APPLE_TX = "2000000123456789";

test("a living Apple-transaction owner outranks every device-leg candidate — and always blocks", async (t) => {
  const APPLE_OWNER_ID = "507f1f77bcf86cd799439055";
  const APPLE_OWNER_EMAIL = "tx-owner@example.com";
  // The device leg finds a Lemon Squeezy payer (reportable, never blocking).
  // The Apple ID's transaction names a DIFFERENT account — one with ZERO
  // Purchase/Subscription rows, because the receipt itself is the evidence.
  fakeUsers(t, [
    { id: OWNER_ID, email: OWNER_EMAIL, passwordHash: "$2a$10$hash" },
    { id: APPLE_OWNER_ID, email: APPLE_OWNER_EMAIL },
  ]);
  fakeDevices(t, [{ deviceId: DEVICE, userId: OWNER_ID, lastSeenAt: new Date() }]);
  fakePurchases(t, []);
  fakeSubscriptions(t, [grantingSub(OWNER_ID)]);
  fakeAuthProviders(t, [{ userId: APPLE_OWNER_ID, provider: "apple" }]);
  fakeAppleTxOwners(t, [{ originalTransactionId: APPLE_TX, userId: APPLE_OWNER_ID }]);

  const res = await request(app)
    .post("/api/auth/precheck")
    .set(deviceHeader)
    .send({ appleOriginalTransactionId: APPLE_TX });

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.device.payingAccount, {
    maskedEmail: maskEmail(APPLE_OWNER_EMAIL),
    billingProvider: "APPLE",
    loginMethods: ["apple"],
    blocksSignup: true,
    isCurrentUser: false,
  });
  assert.ok(!("appleTxOrphaned" in res.body.device), "an owner that exists is not an orphan");
  // The privacy contract holds on this leg too.
  const wire = JSON.stringify(res.body);
  assert.ok(!wire.includes(APPLE_OWNER_EMAIL), "the raw address never leaves the server");
  assert.ok(!wire.includes(APPLE_OWNER_ID), "nor the account id");
});

test("a ghost owner answers appleTxOrphaned — the Apple ID paid, nobody is left to name", async (t) => {
  // The hand-deleted-account hole the registry exists to close: Device rows
  // are gone (cascade), the User is gone, but the AppleTxOwner row survives
  // pointing at the dead id. The client blocks signup on this flag.
  const GHOST_ID = "507f1f77bcf86cd799439066";
  fakeUsers(t, []);
  fakeDevices(t, []);
  fakeAppleTxOwners(t, [{ originalTransactionId: APPLE_TX, userId: GHOST_ID }]);

  const res = await request(app)
    .post("/api/auth/precheck")
    .set(deviceHeader)
    .send({ appleOriginalTransactionId: APPLE_TX });

  assert.equal(res.status, 200);
  assert.equal(res.body.device.known, false, "the device leg self-healed as N13 promises…");
  assert.equal(res.body.device.payingAccount, null, "…and names nobody");
  assert.equal(res.body.device.appleTxOrphaned, true, "but the Apple ID's money is remembered");
});

test("without the field the response is byte-for-byte the prior wire — no appleTxOrphaned key", async (t) => {
  payingOwnerWorld(t);
  const lookups = fakeAppleTxOwners(t, [{ originalTransactionId: APPLE_TX, userId: OWNER_ID }]);

  const res = await request(app).post("/api/auth/precheck").set(deviceHeader).send({});

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.device, {
    known: true,
    payingAccount: {
      maskedEmail: maskEmail(OWNER_EMAIL),
      billingProvider: "APPLE",
      loginMethods: ["password", "apple"],
      blocksSignup: true,
      isCurrentUser: false,
    },
  });
  assert.equal(lookups.length, 0, "no field, no registry read");
});

test("a junk transaction id is treated as absent — never a 500, never a refusal", async (t) => {
  fakeUsers(t, []);
  fakeDevices(t, []);
  const lookups = fakeAppleTxOwners(t, []);

  // Beyond the bounds (and even the wrong type): `.catch(undefined)` folds it
  // to absent instead of failing the one call the signup flow depends on.
  for (const junk of ["x".repeat(4000), 12345, "   "]) {
    const res = await request(app)
      .post("/api/auth/precheck")
      .set(deviceHeader)
      .send({ appleOriginalTransactionId: junk });
    assert.equal(res.status, 200, `junk ${JSON.stringify(junk).slice(0, 20)} must not fail the call`);
    assert.equal(res.body.device.payingAccount, null);
    assert.ok(!("appleTxOrphaned" in res.body.device));
  }
  assert.equal(lookups.length, 0, "junk never reaches the database");

  // …and a well-formed id that matches nothing is simply case c: unchanged.
  const unknown = await request(app)
    .post("/api/auth/precheck")
    .set(deviceHeader)
    .send({ appleOriginalTransactionId: "999999999999" });
  assert.equal(unknown.status, 200);
  assert.equal(unknown.body.device.payingAccount, null);
  assert.ok(!("appleTxOrphaned" in unknown.body.device));
  assert.equal(lookups.length, 1);
});

/* ── rate limits ──────────────────────────────────────────────────────────── */

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

test("both limiter keys are consumed, and the device key is the ledger hash, never the raw id", async (t) => {
  setEnv(t, { authRateLimitDisabled: false });
  const keys = fakeThrottle(t, 5);
  fakeDevices(t, []);

  const res = await request(app).post("/api/auth/precheck").set(deviceHeader).send({});

  assert.equal(res.status, 200);
  assert.equal(keys.length, 2);
  assert.ok(keys[0].startsWith("precheck:ip:"));
  assert.equal(keys[1], `precheck:device:${ledgerHash(DEVICE)}`);
  assert.ok(!keys[1].includes(DEVICE), "throttle rows must not become a device registry");
});

test("over the window → the standard 429 shape", async (t) => {
  setEnv(t, { authRateLimitDisabled: false });
  fakeThrottle(t, 31);

  const res = await request(app).post("/api/auth/precheck").set(deviceHeader).send({});

  assert.equal(res.status, 429);
  assert.deepEqual(res.body, { error: "Too many requests" });
});

/* ════════════════════════════════════════════════════════════════════════════
 * THE SIGNUP GATES (defence in depth behind the client's interstitial)
 * ══════════════════════════════════════════════════════════════════════════ */

test("register on a paying device: 409 with the mask and the ways back in — flag ON", async (t) => {
  setEnv(t, { signupPayingDeviceBlock: true });
  const { creates } = payingOwnerWorld(t);

  const res = await request(app)
    .post("/api/auth/register")
    .set(deviceHeader)
    .send({ email: "newcomer@example.com", password: "hunter2hunter2" });

  assert.equal(res.status, 409);
  assert.equal(res.body.code, "DEVICE_LINKED_TO_PAYING_ACCOUNT");
  assert.equal(res.body.maskedEmail, maskEmail(OWNER_EMAIL));
  assert.deepEqual(res.body.loginMethods, ["password", "apple"]);
  assert.ok(!JSON.stringify(res.body).includes(OWNER_EMAIL), "the 409 is masked too");
  assert.equal(creates.length, 0, "no account was minted");
});

test("a LEMON SQUEEZY payer on the device does NOT block registration, even with the flag ON", async (t) => {
  // The S1/N4 refinement: the block means "an Apple-billed purchase is bound
  // to this phone". A web-billed account that merely logged in here is
  // reported by the precheck, but a new signup must go straight through.
  setEnv(t, { signupPayingDeviceBlock: true });
  const { creates } = payingOwnerWorld(t, { purchase: null, subs: [grantingSub(OWNER_ID)] });
  // The verification code the route sends inline.
  stubMethod(t, prisma.emailVerification as any, "updateMany", async () => ({ count: 0 }));
  stubMethod(t, prisma.emailVerification as any, "create", async (args: any) => ({
    id: "ev-0",
    ...args.data,
  }));

  const res = await request(app)
    .post("/api/auth/register")
    .set(deviceHeader)
    .send({ email: "newcomer@example.com", password: "hunter2hunter2" });

  assert.equal(res.status, 201);
  assert.ok(res.body.token);
  assert.equal(creates.length, 1, "the account was minted despite the web-billed neighbour");
});

test("a device holding only FREE accounts never blocks: account after account signs up — flag ON", async (t) => {
  // The last row of the truth table (criterion N3 of the consolidated report):
  // Apple money blocks, web money is reported, and NO money — an account that
  // only ever logged in here — decides nothing. As long as nothing Apple-billed
  // is bound to the phone, it can mint and hold as many accounts as it likes.
  setEnv(t, { signupPayingDeviceBlock: true });
  const { creates } = payingOwnerWorld(t, { purchase: null });
  // The verification code the route sends inline.
  stubMethod(t, prisma.emailVerification as any, "updateMany", async () => ({ count: 0 }));
  stubMethod(t, prisma.emailVerification as any, "create", async (args: any) => ({
    id: "ev-0",
    ...args.data,
  }));

  // The precheck recognises the phone but names no payer.
  const pre = await request(app).post("/api/auth/precheck").set(deviceHeader).send({});
  assert.equal(pre.status, 200);
  assert.equal(pre.body.device.known, true, "the phone is recognised…");
  assert.equal(pre.body.device.payingAccount, null, "…but nobody on it is paying");

  // …and the register gate lets a second AND a third account through.
  const second = await request(app)
    .post("/api/auth/register")
    .set(deviceHeader)
    .send({ email: "second@example.com", password: "hunter2hunter2" });
  const third = await request(app)
    .post("/api/auth/register")
    .set(deviceHeader)
    .send({ email: "third@example.com", password: "hunter2hunter2" });

  assert.equal(second.status, 201);
  assert.equal(third.status, 201);
  assert.equal(creates.length, 2, "both new accounts were minted alongside the free owner");
});

test("mixed candidates: the APPLE-billed account drives the block and its mask is the one shown", async (t) => {
  setEnv(t, { signupPayingDeviceBlock: true });
  const APPLE_OWNER_ID = "507f1f77bcf86cd799439044";
  const APPLE_OWNER_EMAIL = "apple-owner@example.com";
  // The Lemon Squeezy payer used the phone LAST — recency alone would name
  // them — but only the Apple-billed account is bound to this phone's store.
  fakeUsers(t, [
    { id: OWNER_ID, email: OWNER_EMAIL, passwordHash: "$2a$10$hash" },
    { id: APPLE_OWNER_ID, email: APPLE_OWNER_EMAIL },
  ]);
  fakeDevices(t, [
    { deviceId: DEVICE, userId: OWNER_ID, lastSeenAt: new Date() },
    { deviceId: DEVICE, userId: APPLE_OWNER_ID, lastSeenAt: new Date(Date.now() - 60_000) },
  ]);
  fakePurchases(t, [{ userId: APPLE_OWNER_ID, provider: "app_store", isRefunded: false }]);
  fakeSubscriptions(t, [grantingSub(OWNER_ID)]);
  fakeAuthProviders(t, [{ userId: APPLE_OWNER_ID, provider: "apple" }]);

  const res = await request(app).post("/api/auth/precheck").set(deviceHeader).send({});

  assert.equal(res.status, 200);
  assert.equal(res.body.device.payingAccount.maskedEmail, maskEmail(APPLE_OWNER_EMAIL));
  assert.equal(res.body.device.payingAccount.billingProvider, "APPLE");
  assert.equal(res.body.device.payingAccount.blocksSignup, true);
  assert.deepEqual(res.body.device.payingAccount.loginMethods, ["apple"]);

  // …and the register gate names the SAME account in its 409.
  const reg = await request(app)
    .post("/api/auth/register")
    .set(deviceHeader)
    .send({ email: "newcomer@example.com", password: "hunter2hunter2" });
  assert.equal(reg.status, 409);
  assert.equal(reg.body.code, "DEVICE_LINKED_TO_PAYING_ACCOUNT");
  assert.equal(reg.body.maskedEmail, maskEmail(APPLE_OWNER_EMAIL));
});

test("with the flag OFF the same registration goes straight through", async (t) => {
  setEnv(t, { signupPayingDeviceBlock: false });
  const { creates } = payingOwnerWorld(t);
  // The verification code the route sends inline.
  stubMethod(t, prisma.emailVerification as any, "updateMany", async () => ({ count: 0 }));
  stubMethod(t, prisma.emailVerification as any, "create", async (args: any) => ({
    id: "ev-0",
    ...args.data,
  }));

  const res = await request(app)
    .post("/api/auth/register")
    .set(deviceHeader)
    .send({ email: "newcomer@example.com", password: "hunter2hunter2" });

  assert.equal(res.status, 201);
  assert.ok(res.body.token);
  assert.equal(creates.length, 1);
});

/* ── Sign in with Apple ───────────────────────────────────────────────────── */

// A real RS256 keypair, served as Apple's JWKS through a fetch stub: the token
// verification runs for real, which is the only way to reach the branches.
const appleKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const APPLE_KID = "precheck-test-kid";

function stubAppleJwks(t: Ctx) {
  const originalFetch = globalThis.fetch;
  (globalThis as any).fetch = async (url: unknown) => {
    if (String(url).includes("appleid.apple.com/auth/keys")) {
      const jwk = appleKeys.publicKey.export({ format: "jwk" });
      return {
        ok: true,
        status: 200,
        json: async () => ({ keys: [{ ...jwk, kid: APPLE_KID, use: "sig", alg: "RS256" }] }),
      };
    }
    return originalFetch(url as any);
  };
  t.after(() => {
    (globalThis as any).fetch = originalFetch;
  });
}

const appleIdentityToken = (sub: string, email?: string) =>
  jwt.sign(
    email ? { email, email_verified: "true" } : {},
    appleKeys.privateKey,
    {
      algorithm: "RS256",
      keyid: APPLE_KID,
      issuer: "https://appleid.apple.com",
      audience: env.appleBundleId,
      subject: sub,
      expiresIn: "1h",
    },
  );

test("/apple: a brand-new account on a paying device is blocked — the created branch", async (t) => {
  setEnv(t, { signupPayingDeviceBlock: true });
  stubAppleJwks(t);
  const { creates } = payingOwnerWorld(t);
  stubMethod(t, prisma.authProvider as any, "findUnique", async () => null);

  const res = await request(app)
    .post("/api/auth/apple")
    .set(deviceHeader)
    .send({ identityToken: appleIdentityToken("apple-sub-new", "fresh@example.com") });

  assert.equal(res.status, 409);
  assert.equal(res.body.code, "DEVICE_LINKED_TO_PAYING_ACCOUNT");
  assert.equal(res.body.maskedEmail, maskEmail(OWNER_EMAIL));
  assert.equal(creates.length, 0, "no account was minted");
});

test("/apple: re-login is NEVER blocked, even on a paying device with the flag on (L1)", async (t) => {
  setEnv(t, { signupPayingDeviceBlock: true });
  stubAppleJwks(t);
  // The device belongs to paying OWNER; the caller signs into their own,
  // separate, non-paying account B. Login must work — the paywall handles L1.
  payingOwnerWorld(t);
  const accountB = {
    id: STRANGER_ID,
    email: "b@example.com",
    passwordHash: null,
    emailVerified: true,
    plan: "trial",
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  stubMethod(t, prisma.authProvider as any, "findUnique", async () => ({
    id: "ap-0",
    userId: STRANGER_ID,
    provider: "apple",
    providerUid: "apple-sub-b",
    user: accountB,
  }));

  const res = await request(app)
    .post("/api/auth/apple")
    .set(deviceHeader)
    .send({ identityToken: appleIdentityToken("apple-sub-b") });

  assert.equal(res.status, 200);
  assert.ok(res.body.token);
  assert.equal(res.body.user.email, "b@example.com");
});
