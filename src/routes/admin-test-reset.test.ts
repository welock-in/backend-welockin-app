import assert from "node:assert/strict";
import { test } from "node:test";
import request from "supertest";
import jwt from "jsonwebtoken";
import { createApp } from "../app";
import { prisma } from "../lib/prisma";
import { env } from "../lib/env";
import { signAdminToken } from "../lib/admin-jwt";

/**
 * POST /api/admin/test/reset-user — the tester's reset button.
 *
 * What these tests pin is the tool's ONE promise: honesty. It may clean a lot
 * or a little, but the report must say exactly which legs ran, a failed leg
 * must never silently abort the others, and the Apple sentence must be on
 * every response — because the one thing the tool cannot do (clear Apple's
 * sandbox purchase history) is the thing a tester would otherwise spend an
 * afternoon rediscovering.
 */

const app = createApp();
const USER = "507f1f77bcf86cd799439011";
const EMAIL = "tester@example.com";

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

function withTestMode(t: Ctx, on: boolean) {
  const before = env.lemonSqueezyAllowTestMode;
  (env as any).lemonSqueezyAllowTestMode = on;
  t.after(() => {
    (env as any).lemonSqueezyAllowTestMode = before;
  });
}

function withRcKey(t: Ctx) {
  const before = env.revenuecatSecretApiKey;
  (env as any).revenuecatSecretApiKey = "sk_test";
  t.after(() => {
    (env as any).revenuecatSecretApiKey = before;
  });
}

function stubFetch(t: Ctx, impl: (...a: any[]) => any) {
  const original = globalThis.fetch;
  (globalThis as any).fetch = impl;
  t.after(() => {
    (globalThis as any).fetch = original;
  });
}

function silenceConsoleError(t: Ctx) {
  const real = console.error;
  console.error = () => {};
  t.after(() => {
    console.error = real;
  });
}

/**
 * Every read and write the reset touches, answering the happy path, with each
 * call recorded so a test can assert both the outcome AND the scope of the
 * WHEREs — for a delete tool the scope IS the safety.
 */
function stubDb(t: Ctx, over: Record<string, any> = {}) {
  return {
    userFind: stubMethod(
      t,
      prisma.user as any,
      "findFirst",
      over.userFind ?? (async () => ({ id: USER, email: EMAIL })),
    ),
    userUpdate: stubMethod(
      t,
      prisma.user as any,
      "update",
      over.userUpdate ?? (async (a: any) => ({ id: USER, ...a.data })),
    ),
    userDelete: stubMethod(
      t,
      prisma.user as any,
      "delete",
      over.userDelete ?? (async () => ({ id: USER })),
    ),
    claimFind: stubMethod(
      t,
      prisma.rcSubscriberClaim as any,
      "findMany",
      over.claimFind ?? (async () => [{ originalAppUserId: "orig-app-user-1" }]),
    ),
    claimDelete: stubMethod(t, prisma.rcSubscriberClaim as any, "deleteMany", async () => ({ count: 1 })),
    subFind: stubMethod(
      t,
      prisma.subscription as any,
      "findMany",
      over.subFind ??
        (async () => [
          { externalId: "77001", status: "active" },
          // Nothing left to stop on these two — they must not be enqueued.
          { externalId: "77002", status: "expired" },
          { externalId: "77003", status: "cancelled" },
        ]),
    ),
    taskFind: stubMethod(t, prisma.billingTask as any, "findUnique", async () => null),
    taskCreate: stubMethod(t, prisma.billingTask as any, "create", async (a: any) => a.data),
    trialFind: stubMethod(
      t,
      prisma.trialClaim as any,
      "findMany",
      over.trialFind ?? (async () => [{ id: "claim-1" }, { id: "claim-2" }]),
    ),
    signalDelete: stubMethod(t, prisma.deviceSignal as any, "deleteMany", async () => ({ count: 3 })),
    trialDelete: stubMethod(t, prisma.trialClaim as any, "deleteMany", async () => ({ count: 2 })),
    orderDelete: stubMethod(
      t,
      prisma.consumedOrder as any,
      "deleteMany",
      over.orderDelete ?? (async () => ({ count: 4 })),
    ),
    audit: stubMethod(t, prisma.adminAuditLog as any, "create", async () => ({})),
  };
}

const send = (body: unknown = { email: EMAIL, confirmEmail: EMAIL }) =>
  request(app).post("/api/admin/test/reset-user").set(auth).send(body as object);

/* ── the gates ───────────────────────────────────────────────────────────── */

test("the reset is 503 when test tools are disabled, and reads nothing", async (t) => {
  withTestMode(t, false);
  const db = stubDb(t);

  const res = await send();

  assert.equal(res.status, 503);
  assert.equal(db.userFind.length, 0, "not even the lookup runs behind a closed gate");
});

test("it is unreachable without an admin token", async (t) => {
  withTestMode(t, true);
  const res = await request(app)
    .post("/api/admin/test/reset-user")
    .send({ email: EMAIL, confirmEmail: EMAIL });
  assert.equal(res.status, 401);
});

test("a confirmEmail that does not match is refused before anything is touched", async (t) => {
  withTestMode(t, true);
  const db = stubDb(t);

  const res = await send({ email: EMAIL, confirmEmail: "other@example.com" });

  assert.equal(res.status, 400);
  assert.match(String(res.body.error ?? ""), /confirmEmail/);
  assert.equal(db.userFind.length, 0, "nothing is even looked up on a mismatch");
  assert.equal(db.userDelete.length, 0);
});

test("an email with no account is a 404, never a partial sweep", async (t) => {
  withTestMode(t, true);
  const db = stubDb(t, { userFind: async () => null });

  const res = await send();

  assert.equal(res.status, 404);
  for (const writes of [db.userUpdate, db.userDelete, db.trialDelete, db.orderDelete]) {
    assert.equal(writes.length, 0, "no leg may run without a resolved account");
  }
});

/* ── the happy path: the full honest report ──────────────────────────────── */

test("a full reset reports every leg, and the Apple sentence is always there", async (t) => {
  withTestMode(t, true);
  withRcKey(t);
  const db = stubDb(t);
  const rcCalls: { url: string; method: string }[] = [];
  stubFetch(t, async (url: any, init: any) => {
    rcCalls.push({ url: String(url), method: init?.method ?? "GET" });
    return new Response("{}", { status: 200 });
  });

  const res = await send();

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  const report = res.body.report;
  assert.equal(report.sessionsRevoked, true);
  // Both keys: the account's own id (what every sync fetches by) and the
  // claimed original_app_user_id — each deleted at RevenueCat, both reported.
  assert.deepEqual(report.rcSubscribersDeleted, [USER, "orig-app-user-1"]);
  assert.deepEqual(report.rcSubscriberFailures, []);
  assert.equal(report.lsCancelsEnqueued, 1, "expired/cancelled rows are not re-cancelled");
  assert.equal(report.accountDeleted, true);
  assert.equal(report.trialClaimsDeleted, 2);
  assert.equal(report.consumedOrdersDeleted, 4);
  assert.deepEqual(report.failures, []);

  // THE sentence. Always present, verbatim enough to name the console path —
  // the report must never imply Apple was cleaned.
  assert.match(report.appleSide, /^NOT cleared/);
  assert.match(report.appleSide, /App Store Connect/);
  assert.match(report.appleSide, /Clear Purchase History/);
  assert.match(report.appleSide, /TestFlight subscription keeps renewing/);

  // The sessions leg wrote the same lever a password reset pulls.
  assert.ok(db.userUpdate[0][0].data.passwordChangedAt instanceof Date);

  // RevenueCat was told to DELETE both subscribers.
  assert.equal(rcCalls.length, 2);
  for (const c of rcCalls) {
    assert.equal(c.method, "DELETE");
    assert.match(c.url, /\/v1\/subscribers\//);
  }

  // The claim rows go only for keys RevenueCat actually released.
  assert.deepEqual(db.claimDelete[0][0].where.originalAppUserId.in, [USER, "orig-app-user-1"]);

  // The LS cancel went through the outbox with the reset's own reason.
  assert.equal(db.taskCreate[0][0].data.externalId, "77001");
  assert.equal(db.taskCreate[0][0].data.reason, "test-reset-user");

  // The account went through the shared deleter.
  assert.deepEqual(db.userDelete[0][0].where, { id: USER });

  // The audit row: action + the report as meta, WITHOUT the static sentence
  // (documentation is not something that happened).
  assert.equal(db.audit[0][0].data.action, "test_reset_user");
  assert.equal(db.audit[0][0].data.targetUserId, USER);
  const meta = db.audit[0][0].data.meta;
  assert.equal(meta.accountDeleted, true);
  assert.equal("appleSide" in meta, false, "the audit meta carries facts, not the static note");
});

test("ConsumedOrder deletion touches ONLY this user's revenuecat tombstones", async (t) => {
  withTestMode(t, true);
  withRcKey(t);
  const db = stubDb(t);
  stubFetch(t, async () => new Response("{}", { status: 200 }));

  await send();

  assert.equal(db.orderDelete.length, 1);
  const where = db.orderDelete[0][0].where;
  assert.equal(where.provider, "revenuecat", "a Lemon Squeezy tombstone must stay spent");
  assert.deepEqual(
    where.externalId,
    { startsWith: `${USER}:` },
    "only ids minted as `${userId}:` — nothing keyed on a provider's own order id",
  );
});

/* ── each leg fails ALONE: the others still run, the report still tells ──── */

test("a RevenueCat outage fails that leg only — the account still resets", async (t) => {
  withTestMode(t, true);
  withRcKey(t);
  silenceConsoleError(t);
  const db = stubDb(t);
  stubFetch(t, async () => {
    throw new Error("ECONNREFUSED");
  });

  const res = await send();

  assert.equal(res.status, 200, "a leg failure is reported, not thrown");
  assert.equal(res.body.ok, false, "but it is never called a clean reset");
  const report = res.body.report;
  assert.deepEqual(report.rcSubscribersDeleted, []);
  assert.equal(report.rcSubscriberFailures.length, 2, "each key's failure is reported");
  for (const f of report.rcSubscriberFailures) {
    assert.match(f.error, /unreachable/);
  }
  assert.equal(db.claimDelete.length, 0, "a claim survives until RevenueCat releases its subscriber");
  // Everything else still happened.
  assert.equal(report.sessionsRevoked, true);
  assert.equal(report.lsCancelsEnqueued, 1);
  assert.equal(report.accountDeleted, true);
  assert.equal(report.trialClaimsDeleted, 2);
  assert.match(report.appleSide, /^NOT cleared/);
});

test("a failed account delete is reported while the other legs still run", async (t) => {
  withTestMode(t, true);
  withRcKey(t);
  silenceConsoleError(t);
  const db = stubDb(t, {
    userDelete: async () => {
      throw new Error("mongo is down");
    },
  });
  stubFetch(t, async () => new Response("{}", { status: 200 }));

  const res = await send();

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, false);
  const report = res.body.report;
  assert.equal(report.accountDeleted, false);
  assert.deepEqual(
    report.failures.map((f: { step: string }) => f.step),
    ["account"],
  );
  assert.match(report.failures[0].error, /mongo is down/);
  // The legs after the failure still ran and are still reported.
  assert.equal(report.trialClaimsDeleted, 2);
  assert.equal(report.consumedOrdersDeleted, 4);
  assert.equal(db.trialDelete.length, 1);
  assert.match(report.appleSide, /^NOT cleared/);
});

test("a failed session revocation does not stop the reset", async (t) => {
  withTestMode(t, true);
  withRcKey(t);
  silenceConsoleError(t);
  stubDb(t, {
    userUpdate: async () => {
      throw new Error("write refused");
    },
  });
  stubFetch(t, async () => new Response("{}", { status: 200 }));

  const res = await send();

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.report.sessionsRevoked, false);
  assert.deepEqual(
    res.body.report.failures.map((f: { step: string }) => f.step),
    ["sessions"],
  );
  assert.equal(res.body.report.accountDeleted, true);
});

/* ── the session revocation actually revokes ─────────────────────────────── */

/*
 * The reset writes `passwordChangedAt = now` — the SAME lever a password reset
 * pulls — so every JWT minted before this instant must die at the account
 * guard. Proved end to end: the stamp the reset wrote is fed to the guard, and
 * a token issued before it is refused where a token issued after it passes.
 */
test("a token minted before the reset is refused by the session guard", async (t) => {
  withTestMode(t, true);
  withRcKey(t);
  // The fresh-token control below runs into the entitlement route's own
  // (unstubbed) reads; its 500 is not what this test is about.
  silenceConsoleError(t);
  const db = stubDb(t);
  stubFetch(t, async () => new Response("{}", { status: 200 }));

  const res = await send();
  assert.equal(res.status, 200);
  const stamp: Date = db.userUpdate[0][0].data.passwordChangedAt;
  assert.ok(stamp instanceof Date);

  // The guard now reads the account state the reset left behind.
  stubMethod(t, prisma.user as any, "findUnique", async () => ({
    id: USER,
    email: EMAIL,
    emailVerified: true,
    passwordChangedAt: stamp,
  }));

  const tokenWithIat = (iat: number) =>
    jwt.sign({ sub: USER, email: EMAIL, iat }, env.jwtSecret);

  // Minted well before the reset — stale, and told so.
  const stale = await request(app)
    .get("/api/entitlement")
    .set("authorization", `Bearer ${tokenWithIat(Math.floor(stamp.getTime() / 1000) - 3600)}`);
  assert.equal(stale.status, 401);
  assert.match(String(stale.body.error ?? ""), /password changed/i);

  // Minted after the reset — the guard lets it through (whatever the route
  // itself then answers, it is not the guard's 401).
  const fresh = await request(app)
    .get("/api/entitlement")
    .set("authorization", `Bearer ${tokenWithIat(Math.floor(stamp.getTime() / 1000) + 10)}`);
  assert.notEqual(fresh.status, 401, "a post-reset token is not stale");
});
