import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test, before, after } from "node:test";
import request from "supertest";
import { startMongo, stopMongo, runId } from "./harness";

/**
 * The admin trial-cancellation guarantees, against a real MongoDB replica set.
 *
 * Everything in `npm test` runs with `prisma` stubbed per method, which is the
 * right shape for logic and useless for the questions below. A stub can prove
 * the code CALLS `$transaction`; only a real replica set can say what MongoDB
 * does when two of them collide, what error the driver actually raises, or
 * whether a rollback really left nothing behind. A retry policy written against
 * an assumed error code is a retry policy that has never been tested.
 *
 * So these drive the REAL Express app over REAL HTTP against a REAL database.
 * The trick that makes it possible is ordering: `startMongo()` sets
 * `DATABASE_URL` before anything imports `src/lib/prisma`, and Prisma resolves
 * that variable at client construction — so a dynamic import inside `before()`
 * hands the app a client pointed at the disposable replica set. A static import
 * at the top of the file would construct it first, against nothing.
 *
 * DETERMINISM. `FROZEN_NOW` is not installed as a fake global `Date` here: the
 * MongoDB driver times its own heartbeats and server selection off `Date.now()`,
 * and freezing it underneath the driver stalls the connection pool. Instead
 * every fixture date is derived from that constant, which removes the wall-clock
 * flakiness without lying to the driver about what time it is.
 */

let prisma: any;
let app: any;
let adminAuth: Record<string, string>;
let signToken: (p: { sub: string; email: string }) => string;
let subscriptionGrants: any;
let isRetryableRaceError: (e: unknown) => boolean;
let drainCancels: any;
let MAX_ATTEMPTS: number;

const DAY = 24 * 60 * 60 * 1000;
/** See `src/lib/test-clock.ts` — the same instant, derived not installed. */
const NOW = new Date("2026-08-11T12:00:00.000Z");
const at = (days: number) => new Date(NOW.getTime() + days * DAY);

const WEBHOOK_SECRET = "whsec-mongo-test";
const STORE = "364783";
const V_MONTHLY = "1986433";
const V_YEARLY = "1986420";
const V_LIFETIME = "1960881";

before(async () => {
  await startMongo(); // sets process.env.DATABASE_URL

  // Set BEFORE the dynamic import: `src/lib/env.ts` snapshots the environment at
  // module load, so anything assigned afterwards is invisible to the app.
  process.env.ADMIN_USERNAME = "qa-admin";
  process.env.ADMIN_PASSWORD = "qa-admin-password";
  process.env.LEMONSQUEEZY_API_KEY = "test-key";
  process.env.LEMONSQUEEZY_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.LEMONSQUEEZY_STORE_ID = STORE;
  process.env.LEMONSQUEEZY_VARIANT_MONTHLY = V_MONTHLY;
  process.env.LEMONSQUEEZY_VARIANT_YEARLY = V_YEARLY;
  process.env.LEMONSQUEEZY_VARIANT_ID = V_LIFETIME;
  process.env.EMAIL_VERIFICATION_ENFORCED = "false";

  const [p, a, adminJwt, jwt, subLib, tasks] = await Promise.all([
    import("../../src/lib/prisma"),
    import("../../src/app"),
    import("../../src/lib/admin-jwt"),
    import("../../src/lib/jwt"),
    import("../../src/lib/subscription"),
    import("../../src/lib/billing-tasks"),
  ]);
  prisma = p.prisma;
  app = a.createApp();
  signToken = jwt.signToken;
  subscriptionGrants = subLib.subscriptionGrants;
  isRetryableRaceError = tasks.isRetryableRaceError;
  drainCancels = tasks.drainCancels;
  MAX_ATTEMPTS = tasks.MAX_ATTEMPTS;
  adminAuth = { Authorization: `Bearer ${adminJwt.signAdminToken("qa-admin")}` };
});

after(async () => {
  await prisma?.$disconnect();
  await stopMongo();
});

// ── fixtures ─────────────────────────────────────────────────────────────────

let seq = 0;

/** A user plus a running trial, each in its own namespace so tests never share. */
async function makeTrial(tag: string) {
  const n = ++seq;
  const user = await prisma.user.create({
    data: {
      email: `qa-${runId}-${tag}-${n}@example.test`,
      plan: "trial",
      emailVerified: true,
    },
  });
  const externalId = `sub-${runId}-${tag}-${n}`;
  const sub = await prisma.subscription.create({
    data: {
      userId: user.id,
      provider: "lemonsqueezy",
      externalId,
      variantId: V_MONTHLY,
      interval: "month",
      status: "on_trial",
      trialEndsAt: at(3),
      validUntil: at(3),
      renewsAt: at(3),
      providerUpdatedAt: at(-1),
      testMode: false,
    },
  });
  return {
    user,
    sub,
    externalId,
    token: signToken({ sub: user.id, email: user.email }),
    auth: { Authorization: `Bearer ${signToken({ sub: user.id, email: user.email })}` },
  };
}

const cancelAsAdmin = (userId: string, externalId: string, reason: string) =>
  request(app)
    .post(`/api/admin/users/${userId}/cancel-subscription`)
    .set(adminAuth)
    .send({ reason, externalId });

/** Swap `globalThis.fetch` for the duration of one test. */
function stubFetch(t: any, impl: (url: any, init: any) => Promise<any>) {
  const real = globalThis.fetch;
  (globalThis as any).fetch = impl;
  t.after(() => {
    (globalThis as any).fetch = real;
  });
}

/**
 * Hold every arrival until `n` of them are waiting, then release together.
 *
 * Without this the two requests serialise: the second reads the first one's row
 * and the collision never happens, leaving a green test that never touched the
 * race it claims to cover. Releasing both provider calls at the same instant is
 * what forces both transactions to start together.
 */
function barrier(n: number) {
  let seen = 0;
  let open!: () => void;
  const gate = new Promise<void>((r) => {
    open = r;
  });
  return async () => {
    if (++seen >= n) open();
    await gate;
  };
}

function silenceErrors(t: any) {
  const real = console.error;
  console.error = () => {};
  t.after(() => {
    console.error = real;
  });
}

const tasksFor = (externalId: string) =>
  prisma.billingTask.findMany({ where: { provider: "lemonsqueezy", externalId, kind: "cancel" } });

const auditFor = (userId: string) =>
  prisma.adminAuditLog.findMany({
    where: { targetUserId: userId, action: "cancel_subscription" },
    orderBy: { createdAt: "asc" },
  });


/**
 * Forget any outstanding acquisition for this account.
 *
 * Minting a checkout now takes a per-account lock that lasts half an hour — the
 * whole point of `checkout-lock.mongo.test.ts`. The tests in THIS file are about
 * eligibility and skip_trial, and they check several plans in a row against the
 * same underlying state, so each one has to start from "nothing in flight".
 * Clearing it explicitly is what keeps the two files testing different things.
 */
async function clearAcquisition(userId: string) {
  if (!userId) return;
  await prisma.acquisitionLock.deleteMany({ where: { userId } });
  await prisma.checkoutIntent.deleteMany({ where: { userId } });
}

/** The product's own access predicate, asked about the row as it now stands. */
async function grantsAccess(id: string): Promise<boolean> {
  const row = await prisma.subscription.findUnique({ where: { id } });
  return subscriptionGrants(row, new Date());
}

// ── §2 — real concurrency ────────────────────────────────────────────────────

/**
 * What error does MongoDB actually raise when our unique index rejects the
 * loser of a race — and does the retry policy actually cover THAT error?
 *
 * Asked directly rather than inferred. The policy allowlists P2002, P2034 and
 * Mongo's own retryable labels; this proves the real collision lands inside
 * that allowlist instead of merely being assumed to.
 */
test("the loser of a real index race raises an error the retry policy covers", async () => {
  const externalId = `sub-${runId}-rawrace`;
  const insert = () =>
    prisma.billingTask.create({
      data: { provider: "lemonsqueezy", externalId, kind: "cancel", reason: "admin-cancel" },
    });

  const settled = await Promise.allSettled([insert(), insert()]);
  const losers = settled.filter((s) => s.status === "rejected");
  assert.equal(losers.length, 1, "exactly one insert must lose to the unique index");

  const err = (losers[0] as PromiseRejectedResult).reason;
  const observed = {
    name: err?.name,
    code: err?.code,
    labels: err?.errorLabels,
  };
  console.info(`[qa] observed race error: ${JSON.stringify(observed)}`);

  assert.ok(
    isRetryableRaceError(err),
    `the retry policy does not cover the error the database actually raised: ${JSON.stringify(observed)}`,
  );
  // And the policy must still REFUSE things that are not races.
  assert.equal(isRetryableRaceError(new Error("connection string is malformed")), false);
  assert.equal(isRetryableRaceError(new TypeError("bad argument")), false);
});

/**
 * Two operators pressing Cancel at the same instant, ten times over.
 *
 * Repeated because a single round can go green by accident: if the two requests
 * happen to serialise, the second one simply reads the first one's row and no
 * transaction ever collides. Ten rounds with a synchronising barrier make that
 * accident vanishingly unlikely, and any round that produces a 500 or a 503
 * fails the whole test.
 */
test("ten synchronised double cancellations stay idempotent", async (t) => {
  silenceErrors(t);
  const ROUNDS = 10;

  for (let round = 0; round < ROUNDS; round++) {
    const { user, sub, externalId } = await makeTrial("race");
    const arrive = barrier(2);
    stubFetch(t, async () => {
      await arrive(); // both provider calls released together
      throw new Error("ECONNREFUSED");
    });

    const [a, b] = await Promise.all([
      cancelAsAdmin(user.id, externalId, `round ${round} operator A`),
      cancelAsAdmin(user.id, externalId, `round ${round} operator B`),
    ]);

    for (const res of [a, b]) {
      assert.notEqual(res.status, 500, `round ${round}: a normal race is not a server error`);
      assert.notEqual(res.status, 503, `round ${round}: a normal race is not unavailable`);
      assert.equal(res.status, 202, `round ${round}: ${res.text}`);
      assert.equal(res.body.queued, true, `round ${round}`);
      assert.equal(
        res.body.entitlementRevoked,
        true,
        `round ${round}: both callers must be told access stopped`,
      );
    }

    const tasks = await tasksFor(externalId);
    assert.equal(tasks.length, 1, `round ${round}: exactly one BillingTask`);
    assert.equal(tasks[0].doneAt ?? null, null, `round ${round}: still owed`);

    const after = await prisma.subscription.findUnique({ where: { id: sub.id } });
    assert.ok(after.trialCancelledAt, `round ${round}: the trial must be revoked`);
    assert.equal(
      await grantsAccess(sub.id),
      false,
      `round ${round}: a revoked trial must not grant`,
    );

    // A second pair of clicks must not move the first revocation.
    const firstAt = after.trialCancelledAt.getTime();
    const arriveAgain = barrier(2);
    stubFetch(t, async () => {
      await arriveAgain();
      throw new Error("ECONNREFUSED");
    });
    const [c, d] = await Promise.all([
      cancelAsAdmin(user.id, externalId, `round ${round} retry A`),
      cancelAsAdmin(user.id, externalId, `round ${round} retry B`),
    ]);
    for (const res of [c, d]) {
      assert.equal(res.status, 202, `round ${round} retry: ${res.text}`);
      assert.equal(res.body.entitlementRevoked, true, `round ${round} retry`);
    }
    assert.equal((await tasksFor(externalId)).length, 1, `round ${round}: still one task`);
    const replayed = await prisma.subscription.findUnique({ where: { id: sub.id } });
    assert.equal(
      replayed.trialCancelledAt.getTime(),
      firstAt,
      `round ${round}: the first revocation timestamp must not move`,
    );

    // §8 — every attempt identifiable, none contradicting the outcome.
    const rows = await auditFor(user.id);
    assert.equal(rows.length, 4, `round ${round}: one audit row per accepted attempt`);
    const reasons = rows.map((r: any) => r.reason).sort();
    assert.deepEqual(
      reasons,
      [
        `round ${round} operator A`,
        `round ${round} operator B`,
        `round ${round} retry A`,
        `round ${round} retry B`,
      ].sort(),
      `round ${round}: every operator's own words survive, unmerged`,
    );
    for (const r of rows) {
      assert.deepEqual(
        r.after,
        { cancelled: false, queued: true },
        `round ${round}: no row may claim an outcome the caller did not get`,
      );
      const blob = JSON.stringify(r);
      assert.ok(!blob.includes("test-key"), `round ${round}: no credential in the audit row`);
      assert.ok(!blob.includes("api.lemonsqueezy"), `round ${round}: no provider URL either`);
    }
  }
});

// ── §3 — no reactivation after an admin cancellation ─────────────────────────

/**
 * A cancelled trial must not be resumable, and the refusal must be legible.
 *
 * The interesting half is WHY it is refused. The admin path deliberately does
 * not rewrite `status` — the webhook is the sole writer of provider state — so
 * the row an operator just cancelled still reads `on_trial` locally. The
 * customer-facing resume filter asks for a row that is `cancelled` AND still
 * granting, and a revoked trial is neither. Both legs have to hold: if the
 * webhook later lands and does set `cancelled`, the tombstone is what keeps
 * `subscriptionGrants` false and the row out of the filter.
 *
 * `reasonCode` rather than prose because a console that has to string-match an
 * error message to decide what to show is a console that breaks on a reword.
 */
for (const variant of [
  { name: "provider confirmed (200)", ok: true },
  { name: "provider unreachable, queued (202)", ok: false },
] as const) {
  test(`no reactivation after an admin cancellation — ${variant.name}`, async (t) => {
    silenceErrors(t);
    const { user, sub, externalId, auth } = await makeTrial("react");

    // A consumed trial ledger entry, which must survive all of this.
    const deviceIdHash = `hash-${runId}-react-${variant.ok ? "ok" : "queued"}`;
    await prisma.trialClaim.create({
      data: {
        deviceIdHash,
        firstUserId: user.id,
        startedAt: at(-3),
        endsAt: at(3),
        status: "card_trial",
      },
    });

    stubFetch(t, async () => {
      if (!variant.ok) throw new Error("ECONNREFUSED");
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: { attributes: { ends_at: at(3).toISOString() } } }),
      };
    });
    const cancelled = await cancelAsAdmin(user.id, externalId, "operator cancelled the trial");
    assert.equal(cancelled.status, variant.ok ? 200 : 202, cancelled.text);
    assert.equal(cancelled.body.entitlementRevoked, true);

    const tombstoned = await prisma.subscription.findUnique({ where: { id: sub.id } });
    assert.ok(tombstoned.trialCancelledAt, "the tombstone must exist before we try to resume");
    const tombstoneAt = tombstoned.trialCancelledAt.getTime();

    // Now the customer presses Resume. No provider call may leave the process.
    const calls: any[] = [];
    stubFetch(t, async (url: any) => {
      calls.push(String(url));
      throw new Error("no provider call should have been made");
    });
    const resumed = await request(app).post("/api/subscription/reactivate").set(auth).send({});

    assert.equal(resumed.status, 409, resumed.text);
    assert.equal(
      resumed.body.code,
      "SUBSCRIPTION_NOT_REACTIVATABLE",
      "the console needs a stable code, not prose to string-match",
    );
    assert.deepEqual(calls, [], "a refused resume must never reach Lemon Squeezy");

    const after = await prisma.subscription.findUnique({ where: { id: sub.id } });
    assert.equal(after.trialCancelledAt.getTime(), tombstoneAt, "the tombstone is unchanged");
    assert.equal(await grantsAccess(sub.id), false, "and access is still refused");

    const claim = await prisma.trialClaim.findUnique({ where: { deviceIdHash } });
    assert.ok(claim, "the trial ledger entry must still be consumed");
    assert.equal(claim.firstUserId, user.id);
  });
}

// ── §4 — late and out-of-order webhooks ──────────────────────────────────────

/** Sign and post a delivery exactly as Lemon Squeezy would. */
async function deliver(body: unknown) {
  const raw = JSON.stringify(body);
  const signature = crypto.createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("hex");
  return request(app)
    .post("/api/webhooks/lemonsqueezy")
    .set("Content-Type", "application/json")
    .set("X-Signature", signature)
    .send(raw);
}

function subEvent(opts: {
  event: string;
  externalId: string;
  userId: string;
  status: string;
  updatedAt: Date;
  trialEndsAt?: Date | null;
  endsAt?: Date | null;
}) {
  return {
    meta: { event_name: opts.event, custom_data: { user_id: opts.userId } },
    data: {
      id: opts.externalId,
      attributes: {
        user_email: "buyer@example.test",
        status: opts.status,
        store_id: Number(STORE),
        variant_id: Number(V_MONTHLY),
        trial_ends_at: (opts.trialEndsAt ?? at(3)).toISOString(),
        renews_at: at(3).toISOString(),
        ends_at: opts.endsAt ? opts.endsAt.toISOString() : null,
        updated_at: opts.updatedAt.toISOString(),
        test_mode: false,
        urls: { update_payment_method: "https://x/pay", customer_portal: "https://x/portal" },
      },
    },
  };
}

/** Cancel a trial as an operator, provider confirming, and return the tombstone. */
async function cancelledTrial(t: any, tag: string) {
  const fixture = await makeTrial(tag);
  stubFetch(t, async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: { attributes: { ends_at: at(3).toISOString() } } }),
  }));
  const res = await cancelAsAdmin(fixture.user.id, fixture.externalId, `cancel for ${tag}`);
  assert.equal(res.status, 200, res.text);
  const row = await prisma.subscription.findUnique({ where: { id: fixture.sub.id } });
  assert.ok(row.trialCancelledAt, "precondition: the tombstone exists");
  return { ...fixture, tombstoneAt: row.trialCancelledAt.getTime() };
}

/**
 * A resume the customer pressed in Lemon Squeezy's own portal.
 *
 * This is the delivery the tombstone exists for. It is genuinely NEWER than
 * anything we hold, so the ordering guard lets it through and the provider
 * snapshot legitimately goes back to `on_trial` — and access must still be
 * refused, because the tombstone is not part of what a provider event may write.
 * Without it, a customer could cancel and un-cancel their way through an endless
 * trial.
 */
test("a newer webhook restoring on_trial does not resurrect a revoked trial", async (t) => {
  silenceErrors(t);
  const f = await cancelledTrial(t, "wh-resume");

  const res = await deliver(
    subEvent({
      event: "subscription_updated",
      externalId: f.externalId,
      userId: f.user.id,
      status: "on_trial",
      updatedAt: at(0.5), // newer than the row's providerUpdatedAt (day -1)
    }),
  );
  assert.equal(res.status, 200, res.text);

  const row = await prisma.subscription.findUnique({ where: { id: f.sub.id } });
  assert.equal(row.status, "on_trial", "the provider snapshot may be refreshed");
  assert.ok(row.trialCancelledAt, "but the tombstone survives it");
  assert.equal(row.trialCancelledAt.getTime(), f.tombstoneAt, "and is not moved");
  assert.equal(await grantsAccess(f.sub.id), false, "access stays refused");
});

/**
 * A delivery that has been sitting in a retry queue and arrives after newer
 * state. The guard must drop it, and the tombstone must not care either way.
 */
test("an older webhook is refused by the ordering guard", async (t) => {
  silenceErrors(t);
  const f = await cancelledTrial(t, "wh-stale");

  // Move the row forward first, so the next delivery is genuinely behind it.
  await deliver(
    subEvent({
      event: "subscription_updated",
      externalId: f.externalId,
      userId: f.user.id,
      status: "past_due",
      updatedAt: at(1),
    }),
  );
  const mid = await prisma.subscription.findUnique({ where: { id: f.sub.id } });
  assert.equal(mid.status, "past_due");

  const res = await deliver(
    subEvent({
      event: "subscription_updated",
      externalId: f.externalId,
      userId: f.user.id,
      status: "active",
      updatedAt: at(-5), // long behind what we already recorded
    }),
  );
  assert.equal(res.status, 200, "a stale delivery is acknowledged, not errored");

  const row = await prisma.subscription.findUnique({ where: { id: f.sub.id } });
  assert.equal(row.status, "past_due", "the stale state must not be applied");
  assert.equal(row.trialCancelledAt.getTime(), f.tombstoneAt, "the tombstone is untouched");
  assert.equal(await grantsAccess(f.sub.id), false);
});

/** Lemon Squeezy retries deliveries. The second one must change nothing. */
test("a duplicated webhook is functionally idempotent", async (t) => {
  silenceErrors(t);
  const f = await cancelledTrial(t, "wh-dup");
  const body = subEvent({
    event: "subscription_updated",
    externalId: f.externalId,
    userId: f.user.id,
    status: "on_trial",
    updatedAt: at(0.5),
  });

  assert.equal((await deliver(body)).status, 200);
  const first = await prisma.subscription.findUnique({ where: { id: f.sub.id } });

  assert.equal((await deliver(body)).status, 200, "a redelivery is accepted");
  const second = await prisma.subscription.findUnique({ where: { id: f.sub.id } });

  assert.equal(second.status, first.status, "no second functional mutation");
  assert.equal(
    second.trialCancelledAt.getTime(),
    f.tombstoneAt,
    "and certainly not a new revocation date",
  );
  assert.equal(await grantsAccess(f.sub.id), false);
});

/** The provider confirming the cancellation we asked for. */
test("a cancelled webhook confirms the tombstone without moving it", async (t) => {
  silenceErrors(t);
  const f = await cancelledTrial(t, "wh-cancel");

  const res = await deliver(
    subEvent({
      event: "subscription_cancelled",
      externalId: f.externalId,
      userId: f.user.id,
      status: "cancelled",
      updatedAt: at(0.5),
      endsAt: at(3),
    }),
  );
  assert.equal(res.status, 200, res.text);

  const row = await prisma.subscription.findUnique({ where: { id: f.sub.id } });
  assert.equal(row.status, "cancelled");
  assert.ok(row.trialCancelledAt, "the tombstone is confirmed, not cleared");
  assert.equal(
    row.trialCancelledAt.getTime(),
    f.tombstoneAt,
    "the first revocation date stands — nothing here justifies moving it",
  );
  assert.equal(await grantsAccess(f.sub.id), false);
});

// ── §5 — no second trial, ever ───────────────────────────────────────────────

/** Capture the body of the outgoing checkout call and answer with a URL. */
function captureCheckout(t: any) {
  const sent: any[] = [];
  stubFetch(t, async (_url: any, init: any) => {
    sent.push(JSON.parse(init.body));
    return {
      ok: true,
      status: 201,
      json: async () => ({ data: { attributes: { url: "https://ls.test/checkout" } } }),
    };
  });
  return sent;
}

/**
 * A trial still running blocks a second subscription — with a code, not prose.
 */
test("an active trial blocks a new recurring checkout as ACTIVE_SUBSCRIPTION", async (t) => {
  silenceErrors(t);
  const f = await makeTrial("block-active");
  const sent = captureCheckout(t);

  for (const plan of ["monthly", "yearly"] as const) {
    await clearAcquisition(f.user.id);
    const res = await request(app).post("/api/checkout").set(f.auth).send({ plan });
    assert.equal(res.status, 409, `${plan}: ${res.text}`);
    assert.equal(res.body.code, "ACTIVE_SUBSCRIPTION");
  }
  assert.deepEqual(sent, [], "a refused checkout must never reach Lemon Squeezy");
  assert.equal(await grantsAccess(f.sub.id), true, "and the trial still grants");
});

/**
 * A cancellation we have NOT yet managed to deliver blocks buying — and this is
 * the case the tombstone alone would have got wrong.
 *
 * Access is already gone locally, so it is tempting to treat the customer as
 * free to buy. But Lemon Squeezy has not accepted anything yet: the first
 * subscription is still cancellable-but-not-cancelled, and selling a second one
 * now is how somebody ends up paying for both.
 */
test("a pending cancellation blocks buying as CANCELLATION_PENDING", async (t) => {
  silenceErrors(t);
  const f = await makeTrial("block-pending");
  stubFetch(t, async () => {
    throw new Error("ECONNREFUSED");
  });
  assert.equal((await cancelAsAdmin(f.user.id, f.externalId, "queued cancellation")).status, 202);

  assert.equal(await grantsAccess(f.sub.id), false, "access stops at once regardless");
  const [task] = await tasksFor(f.externalId);
  assert.equal(task.doneAt ?? null, null, "precondition: the task is genuinely pending");

  const sent = captureCheckout(t);
  for (const plan of ["monthly", "yearly"] as const) {
    await clearAcquisition(f.user.id);
    const res = await request(app).post("/api/checkout").set(f.auth).send({ plan });
    assert.equal(res.status, 409, `${plan}: ${res.text}`);
    assert.equal(res.body.code, "CANCELLATION_PENDING");
  }
  assert.deepEqual(sent, [], "no checkout may be minted while a cancellation is owed");
});

/**
 * The drain gets through, no webhook ever arrives — and buying unblocks anyway.
 *
 * The block must last exactly as long as the work is genuinely owed. Waiting on
 * a webhook to release it would put a customer's ability to pay at the mercy of
 * a delivery that may never come.
 */
test("a drained cancellation unblocks buying without any webhook", async (t) => {
  silenceErrors(t);
  const f = await makeTrial("block-drained");
  stubFetch(t, async () => {
    throw new Error("ECONNREFUSED");
  });
  assert.equal((await cancelAsAdmin(f.user.id, f.externalId, "queued, will drain")).status, 202);

  // Blocked while owed.
  assert.equal(
    (await request(app).post("/api/checkout").set(f.auth).send({ plan: "monthly" })).status,
    409,
  );

  stubFetch(t, async () => ({ ok: true, status: 200, json: async () => ({ data: {} }) }));
  await drainCancels();
  const [task] = await tasksFor(f.externalId);
  assert.ok(task.doneAt, "precondition: the drain settled it");

  const row = await prisma.subscription.findUnique({ where: { id: f.sub.id } });
  assert.ok(row.trialCancelledAt, "the tombstone is kept");
  assert.equal(row.status, "on_trial", "and NO webhook has rewritten the snapshot");

  const sent = captureCheckout(t);
  for (const plan of ["monthly", "yearly"] as const) {
    await clearAcquisition(f.user.id);
    const res = await request(app).post("/api/checkout").set(f.auth).send({ plan });
    assert.equal(res.status, 201, `${plan} must unblock on the drain alone: ${res.text}`);
  }
  for (const body of sent) {
    assert.equal(body.data.attributes.checkout_options?.skip_trial, true);
  }
  assert.equal(await prisma.trialClaim.count({ where: { firstUserId: f.user.id } }), 0);
});

/**
 * Every attempt spent and the provider never accepted. Access stays gone, and
 * buying stays shut — but with a code that says a human is needed, rather than
 * "come back in a moment", which would never become true.
 */
test("a dead-lettered cancellation blocks buying as BILLING_SUPPORT_REQUIRED", async (t) => {
  silenceErrors(t);
  const f = await makeTrial("block-dlq");
  stubFetch(t, async () => {
    throw new Error("ECONNREFUSED");
  });
  assert.equal((await cancelAsAdmin(f.user.id, f.externalId, "will dead-letter")).status, 202);

  const [task] = await tasksFor(f.externalId);
  await prisma.billingTask.update({
    where: { id: task.id },
    data: { attempts: MAX_ATTEMPTS },
  });

  assert.equal(await grantsAccess(f.sub.id), false, "access is still refused");
  const sent = captureCheckout(t);
  const res = await request(app).post("/api/checkout").set(f.auth).send({ plan: "monthly" });
  assert.equal(res.status, 409, res.text);
  assert.equal(res.body.code, "BILLING_SUPPORT_REQUIRED");
  assert.deepEqual(sent, [], "no checkout while the provider never accepted the cancellation");
});

/**
 * A refusal Lemon Squeezy will not reconsider — a 4xx that is a decision, not a
 * "come back later". Nothing was cancelled, so nothing may pretend otherwise.
 */
test("a non-recoverable provider refusal leaves the trial active, not pending", async (t) => {
  silenceErrors(t);
  const f = await makeTrial("block-4xx");
  stubFetch(t, async () => ({
    ok: false,
    status: 422,
    json: async () => ({ errors: [{ detail: "cannot be cancelled" }] }),
  }));
  const res = await cancelAsAdmin(f.user.id, f.externalId, "provider will refuse");
  assert.equal(res.status, 400, res.text);

  const row = await prisma.subscription.findUnique({ where: { id: f.sub.id } });
  assert.equal(row.trialCancelledAt ?? null, null, "no tombstone — nothing was cancelled");
  assert.equal((await tasksFor(f.externalId)).length, 0, "and nothing was queued");
  assert.equal(await grantsAccess(f.sub.id), true, "the trial is still running");

  const checkout = await request(app).post("/api/checkout").set(f.auth).send({ plan: "monthly" });
  assert.equal(checkout.status, 409);
  assert.equal(
    checkout.body.code,
    "ACTIVE_SUBSCRIPTION",
    "it is an active subscription — claiming a cancellation is pending would be false",
  );
});

/**
 * And once the subscription really is over, the trial must not come back.
 *
 * `skip_trial` is decided entirely server-side from "has this account ever had a
 * subscription row" — so a client that names a plan gets a plan, and nothing it
 * can put in the request changes whether a trial is attached.
 */
for (const plan of ["monthly", "yearly"] as const) {
  test(`a ${plan} checkout after a revoked trial carries skip_trial:true`, async (t) => {
    silenceErrors(t);
    const f = await cancelledTrial(t, `co-${plan}`);
    // The subscription has run its course; only now can a checkout be minted.
    await prisma.subscription.update({ where: { id: f.sub.id }, data: { status: "expired" } });
    const sent = captureCheckout(t);

    const res = await request(app)
      .post("/api/checkout")
      .set(f.auth)
      // Everything a hostile desktop build might try to smuggle in.
      .send({
        plan,
        skip_trial: false,
        checkout_options: { skip_trial: false },
        variantId: "9999999",
        variant_id: "9999999",
        trialDays: 30,
      });

    assert.equal(res.status, 201, res.text);
    assert.equal(sent.length, 1);
    const attrs = sent[0].data.attributes;
    assert.equal(
      attrs.checkout_options?.skip_trial,
      true,
      "a revoked trial must never be offered again",
    );
    assert.equal(
      sent[0].data.relationships.variant.data.id,
      plan === "monthly" ? V_MONTHLY : V_YEARLY,
      "the variant is resolved server-side, never taken from the caller",
    );
    assert.equal(sent[0].data.relationships.store.data.id, STORE);
    assert.equal(attrs.checkout_data.custom.user_id, f.user.id);

    // Nothing about this may have handed out a fresh trial locally.
    const row = await prisma.subscription.findUnique({ where: { id: f.sub.id } });
    assert.ok(row.trialCancelledAt, "the tombstone stands");
    assert.equal(row.trialEndsAt.getTime(), at(3).getTime(), "no new internal trialEndsAt");
    assert.equal(
      await prisma.trialClaim.count({ where: { firstUserId: f.user.id } }),
      0,
      "minting a checkout must not write a trial ledger entry",
    );
  });
}

/** Both plans at once — neither may slip through while the other is in flight. */
test("parallel monthly and yearly checkouts both skip the trial", async (t) => {
  silenceErrors(t);
  const f = await cancelledTrial(t, "co-par");
  await prisma.subscription.update({ where: { id: f.sub.id }, data: { status: "expired" } });
  const sent = captureCheckout(t);

  // ONE AT A TIME NOW. Two simultaneous mints are the double-payment race, and
  // it has its own file — here the question is only whether each plan, taken on
  // its own, is sold without a trial.
  for (const plan of ["monthly", "yearly"] as const) {
    await clearAcquisition(f.user.id);
    const res = await request(app).post("/api/checkout").set(f.auth).send({ plan });
    assert.equal(res.status, 201, `${plan}: ${res.text}`);
  }
  assert.equal(sent.length, 2);
  for (const body of sent) {
    assert.equal(body.data.attributes.checkout_options?.skip_trial, true);
  }
  assert.equal(await prisma.trialClaim.count({ where: { firstUserId: f.user.id } }), 0);
});

/** Lifetime is not a subscription, so there is no trial to suppress or offer. */
test("a lifetime checkout carries no trial options at all", async (t) => {
  silenceErrors(t);
  const f = await cancelledTrial(t, "co-life");
  await prisma.subscription.update({ where: { id: f.sub.id }, data: { status: "expired" } });
  const sent = captureCheckout(t);

  const res = await request(app).post("/api/checkout").set(f.auth).send({ plan: "lifetime" });
  assert.equal(res.status, 201, res.text);
  assert.equal(
    sent[0].data.attributes.checkout_options,
    undefined,
    "lifetime never carries checkout_options — there is no trial on it to skip",
  );
  assert.equal(sent[0].data.relationships.variant.data.id, V_LIFETIME);
});

// ── §6 — the outbox actually drains ──────────────────────────────────────────

/**
 * The 202 promise, carried out.
 *
 * A queued cancellation is only honest if something eventually performs it, so
 * this runs the real drain rather than asserting a row exists and stopping.
 */
test("a queued cancellation drains, stays revoked, and is idempotent", async (t) => {
  silenceErrors(t);
  const f = await makeTrial("drain-ok");
  stubFetch(t, async () => {
    throw new Error("ECONNREFUSED");
  });
  const queued = await cancelAsAdmin(f.user.id, f.externalId, "queued for the drain");
  assert.equal(queued.status, 202, queued.text);

  let tasks = await tasksFor(f.externalId);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].doneAt ?? null, null, "pending before the drain");
  const revokedAt = (
    await prisma.subscription.findUnique({ where: { id: f.sub.id } })
  ).trialCancelledAt.getTime();

  // Lemon Squeezy is reachable again.
  const calls: string[] = [];
  stubFetch(t, async (url: any) => {
    calls.push(String(url));
    return { ok: true, status: 200, json: async () => ({ data: { attributes: {} } }) };
  });
  const first = await drainCancels();
  assert.ok(first.settled >= 1, `the drain must settle the task: ${JSON.stringify(first)}`);
  // Filtered by id: the drain is global by design and the earlier tests in this
  // file leave their own tasks pending, so a bare call count measures the suite
  // rather than the behaviour under test.
  const mine = () => calls.filter((u) => u.includes(f.externalId));
  assert.equal(mine().length, 1, "exactly one provider call for THIS subscription");

  tasks = await tasksFor(f.externalId);
  assert.ok(tasks[0].doneAt, "the task is finished");
  assert.equal(tasks[0].lastError ?? null, null);

  const row = await prisma.subscription.findUnique({ where: { id: f.sub.id } });
  assert.ok(row.trialCancelledAt, "draining must not clear the tombstone");
  assert.equal(row.trialCancelledAt.getTime(), revokedAt, "nor move it");
  assert.equal(await grantsAccess(f.sub.id), false, "and access stays refused");

  // A second drain must not re-send anything.
  const before = mine().length;
  await drainCancels();
  assert.equal(mine().length, before, "a settled task is never re-sent");
  assert.equal((await tasksFor(f.externalId)).length, 1);
});

/**
 * And when the provider is still refusing, the failure has to be recorded
 * without ever handing access back.
 */
test("a failed drain backs off and keeps the trial revoked", async (t) => {
  silenceErrors(t);
  const f = await makeTrial("drain-fail");
  stubFetch(t, async () => {
    throw new Error("ECONNREFUSED");
  });
  assert.equal((await cancelAsAdmin(f.user.id, f.externalId, "queued, will fail")).status, 202);
  const revokedAt = (
    await prisma.subscription.findUnique({ where: { id: f.sub.id } })
  ).trialCancelledAt.getTime();

  stubFetch(t, async () => ({
    ok: false,
    status: 500,
    json: async () => ({ errors: [{ detail: "upstream is unwell" }] }),
  }));
  const before = new Date();
  await drainCancels();

  const [task] = await tasksFor(f.externalId);
  assert.equal(task.attempts, 1, "the attempt is counted");
  assert.equal(task.doneAt ?? null, null, "and it is still owed");
  assert.ok(task.lastError, "with the reason recorded");
  assert.ok(!task.lastError.includes("test-key"), "and no credential in it");
  assert.ok(
    task.nextAttemptAt.getTime() > before.getTime(),
    "the next attempt is pushed into the future — backoff, not a hot loop",
  );
  assert.equal(task.lockedAt ?? null, null, "the lock is released for the next run");

  const row = await prisma.subscription.findUnique({ where: { id: f.sub.id } });
  assert.equal(row.trialCancelledAt.getTime(), revokedAt, "a provider failure restores nothing");
  assert.equal(await grantsAccess(f.sub.id), false);
});

// ── §7 — the non-trial states must not have moved ────────────────────────────

/**
 * Cancelling a subscription that is NOT a trial takes nothing away today.
 *
 * The row keeps whatever period it already has, no tombstone is written, and the
 * response says `entitlementRevoked: false` so the console shows
 * `ACCESS_CONTINUES_MESSAGE` instead of promising an immediate cut-off. Note
 * what is deliberately NOT asserted here: that this customer paid. `active` is
 * also what a 100% discount and a manual provider adjustment produce, and
 * nothing in this database can tell those apart.
 */
test("cancelling a non-trial subscription revokes nothing today", async (t) => {
  silenceErrors(t);
  const f = await makeTrial("nontrial");
  await prisma.subscription.update({
    where: { id: f.sub.id },
    data: {
      status: "active",
      // A stale trial date left behind by an early conversion — the trap that
      // made the dates alone an unsafe way to recognise a trial.
      trialEndsAt: at(3),
      validUntil: at(20),
      endsAt: at(20),
    },
  });

  stubFetch(t, async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: { attributes: { ends_at: at(20).toISOString() } } }),
  }));
  const res = await cancelAsAdmin(f.user.id, f.externalId, "customer asked to stop renewing");

  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.cancelled, true);
  assert.equal(
    res.body.entitlementRevoked,
    false,
    "a non-trial keeps its remaining period — claiming otherwise misleads the operator",
  );

  const row = await prisma.subscription.findUnique({ where: { id: f.sub.id } });
  assert.equal(row.trialCancelledAt ?? null, null, "no tombstone belongs on a non-trial row");
  assert.equal(await grantsAccess(f.sub.id), true, "access continues to the end of the period");
});

/** A trial whose window has already closed grants nothing, tombstone or not. */
test("an expired trial grants no access", async (t) => {
  silenceErrors(t);
  const f = await makeTrial("expired");
  await prisma.subscription.update({
    where: { id: f.sub.id },
    data: { trialEndsAt: at(-1), validUntil: at(-1), renewsAt: at(-1) },
  });
  assert.equal(await grantsAccess(f.sub.id), false, "the window closed — nothing to grant");
});

/** The exact sentences the console must show, pinned so a reword is a test failure. */
test("the operator-facing wording never claims a payment happened", async () => {
  const lib = await import("../../src/lib/subscription");
  assert.equal(
    lib.ACCESS_CONTINUES_MESSAGE,
    "The customer keeps access until the current access period ends.",
  );
  for (const msg of [lib.ACCESS_CONTINUES_MESSAGE, lib.ACCESS_REVOKED_NOW_MESSAGE]) {
    assert.ok(!/\bpaid\b/i.test(msg), `"${msg}" claims a payment the data cannot prove`);
  }
});

// ── the checkout contradiction after a strict trial cancellation ─────────────

/**
 * Cancelling a trial must return the customer to the paywall, not to a wall.
 *
 * The product rule is one sentence: revoking a trial ends access at once, burns
 * the trial for good, and drops the customer back on the paywall where they can
 * buy monthly or yearly WITHOUT a new trial. Three of those four held. The
 * fourth did not: the admin path deliberately does not rewrite `status` (the
 * webhook is the only writer of provider state), so the row still read
 * `on_trial` locally, `subscriptionIsLive` counted it, and the checkout was
 * refused outright. The customer had no access AND could not pay for any — they
 * had to wait for the subscription to reach `expired`.
 *
 * That is the contradiction this pass exists to remove.
 */
test("a confirmed trial cancellation returns the customer to the paywall", async (t) => {
  silenceErrors(t);
  const f = await makeTrial("paywall");

  // 1-2. Cancel it, provider confirming synchronously.
  stubFetch(t, async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: { attributes: { ends_at: at(3).toISOString() } } }),
  }));
  const cancelled = await cancelAsAdmin(f.user.id, f.externalId, "customer asked us to stop");
  assert.equal(cancelled.status, 200, cancelled.text);
  assert.equal(cancelled.body.entitlementRevoked, true);

  // 3. Access is gone immediately.
  assert.equal(await grantsAccess(f.sub.id), false, "a revoked trial grants nothing");

  // 4-5. And both recurring plans can be bought right now — no waiting for a
  // webhook, no waiting for `expired`.
  const sent = captureCheckout(t);
  for (const plan of ["monthly", "yearly"] as const) {
    await clearAcquisition(f.user.id);
    const res = await request(app).post("/api/checkout").set(f.auth).send({ plan });
    assert.equal(res.status, 201, `${plan} must be purchasable at once: ${res.text}`);
  }

  assert.equal(sent.length, 2);
  for (const body of sent) {
    assert.equal(
      body.data.attributes.checkout_options?.skip_trial,
      true,
      "the trial is spent — it must never be offered again",
    );
  }
  assert.deepEqual(
    sent.map((b: any) => b.data.relationships.variant.data.id),
    [V_MONTHLY, V_YEARLY],
    "the variant stays a server decision",
  );
  assert.equal(
    await prisma.trialClaim.count({ where: { firstUserId: f.user.id } }),
    0,
    "and no new trial is reserved",
  );
  const row = await prisma.subscription.findUnique({ where: { id: f.sub.id } });
  assert.equal(row.trialEndsAt.getTime(), at(3).getTime(), "no new internal trial window");
});

// ── §7 — what must NOT have changed ──────────────────────────────────────────

/**
 * A paid subscription the customer cancelled, still running out its period.
 *
 * DOCUMENTING THE EXISTING POLICY rather than changing it. This customer keeps
 * access to the end of the current period and has two real routes — Resume, or
 * Change plan — so quietly selling them a second subscription would produce a
 * support ticket about being billed twice. Only a TRIAL gets the fast path,
 * because a trial keeps no remaining period worth protecting.
 *
 * No tombstone is what distinguishes it: this row was never a revoked trial.
 */
test("a cancelled PAID subscription with time left still blocks buying", async (t) => {
  silenceErrors(t);
  const f = await makeTrial("paid-cancelled");
  await prisma.subscription.update({
    where: { id: f.sub.id },
    data: {
      status: "cancelled",
      trialEndsAt: null,
      validUntil: at(20),
      endsAt: at(20),
    },
  });
  assert.equal(await grantsAccess(f.sub.id), true, "they keep the rest of the period");

  const sent = captureCheckout(t);
  const res = await request(app).post("/api/checkout").set(f.auth).send({ plan: "monthly" });
  assert.equal(res.status, 409, res.text);
  assert.equal(
    res.body.code,
    "CANCELLED_ACCESS_REMAINING",
    "its own code: the useful actions here are Resume and Change plan, not 'you already have one'",
  );
  assert.deepEqual(sent, [], "no second paid subscription may be created silently");
});

/** Lifetime is a different saga and the recurring fix must not have touched it. */
test("lifetime stays purchasable while a recurring cancellation is pending", async (t) => {
  silenceErrors(t);
  const f = await makeTrial("life-saga");
  stubFetch(t, async () => {
    throw new Error("ECONNREFUSED");
  });
  assert.equal((await cancelAsAdmin(f.user.id, f.externalId, "queued cancellation")).status, 202);

  // Recurring is blocked...
  assert.equal(
    (await request(app).post("/api/checkout").set(f.auth).send({ plan: "monthly" })).status,
    409,
  );

  // ...and lifetime is not: it is not a subscription, it cannot double-bill a
  // recurring plan, and the webhook auto-cancels the subscription when it lands.
  const sent = captureCheckout(t);
  const res = await request(app).post("/api/checkout").set(f.auth).send({ plan: "lifetime" });
  assert.equal(res.status, 201, res.text);
  assert.equal(sent[0].data.relationships.variant.data.id, V_LIFETIME);
  assert.equal(
    sent[0].data.attributes.checkout_options,
    undefined,
    "lifetime never carries a trial to skip",
  );
});

/** Nothing a client sends may change what it is sold or whether a trial rides along. */
test("hostile checkout parameters are ignored end to end", async (t) => {
  silenceErrors(t);
  const f = await cancelledTrial(t, "hostile");
  const sent = captureCheckout(t);

  const res = await request(app)
    .post("/api/checkout")
    .set(f.auth)
    .send({
      plan: "monthly",
      skip_trial: false,
      skipTrial: false,
      trialDays: 30,
      trial_ends_at: at(30).toISOString(),
      checkout_options: { skip_trial: false },
      variantId: "9999999",
      variant_id: "9999999",
      storeId: "111",
      accountId: "000000000000000000000000",
      userId: "000000000000000000000000",
      price: 0,
    });

  assert.equal(res.status, 201, res.text);
  const body = sent[0];
  assert.equal(body.data.attributes.checkout_options.skip_trial, true);
  assert.equal(body.data.relationships.variant.data.id, V_MONTHLY);
  assert.equal(body.data.relationships.store.data.id, STORE);
  assert.equal(
    body.data.attributes.checkout_data.custom.user_id,
    f.user.id,
    "the account credited is the token's, never the body's",
  );
  const raw = JSON.stringify(body);
  assert.ok(!raw.includes("9999999"), "no client variant reached the provider");
  assert.ok(!raw.includes("trialDays"), "no client trial parameter did either");
});

/** Two checkouts at once, after a confirmed cancellation. Neither gets a trial. */
test("concurrent monthly and yearly checkouts after cancellation get no trial", async (t) => {
  silenceErrors(t);
  const f = await cancelledTrial(t, "conc-buy");
  const sent = captureCheckout(t);

  for (const plan of ["monthly", "yearly"] as const) {
    await clearAcquisition(f.user.id);
    const res = await request(app).post("/api/checkout").set(f.auth).send({ plan });
    assert.equal(res.status, 201, `${plan}: ${res.text}`);
  }
  for (const body of sent) {
    assert.equal(body.data.attributes.checkout_options?.skip_trial, true);
  }
  assert.equal(
    await prisma.trialClaim.count({ where: { firstUserId: f.user.id } }),
    0,
    "minting checkouts reserves no trial — the ledger is written by the webhook",
  );
});

// ── §8 — the outbox read, against the real database ──────────────────────────

/**
 * The absent-vs-null trap, on the field the whole decision turns on.
 *
 * Prisma on MongoDB does not store an optional field that was never given a
 * value, so `doneAt` is ABSENT on a fresh task rather than null. A decision
 * written as `doneAt === null` would read absent as "not settled" by accident on
 * one path and as settled on another; `!= null` is the only test that sees both
 * shapes the same way. Written as a test because the same trap already made the
 * outbox inert once.
 */
test("a task with an ABSENT doneAt reads exactly like an explicit null", async (t) => {
  silenceErrors(t);
  const absent = await makeTrial("absent");
  const explicit = await makeTrial("explicit");

  // Created with no `doneAt` key at all — the field does not exist on the doc.
  await prisma.billingTask.create({
    data: {
      provider: "lemonsqueezy",
      externalId: absent.externalId,
      kind: "cancel",
      reason: "admin-cancel",
    },
  });
  await prisma.billingTask.create({
    data: {
      provider: "lemonsqueezy",
      externalId: explicit.externalId,
      kind: "cancel",
      reason: "admin-cancel",
      doneAt: null,
      lockedAt: null,
      lastError: null,
    },
  });
  await prisma.subscription.updateMany({
    where: { id: { in: [absent.sub.id, explicit.sub.id] } },
    data: { trialCancelledAt: at(0) },
  });

  for (const f of [absent, explicit]) {
    const res = await request(app).post("/api/checkout").set(f.auth).send({ plan: "monthly" });
    assert.equal(res.status, 409, `${f.externalId}: ${res.text}`);
    assert.equal(res.body.code, "CANCELLATION_PENDING", "both shapes mean the same thing");
  }
});

/**
 * The lock is a worker-coordination device, not a statement about the customer.
 *
 * A task held by a crashed worker, or one whose lock has gone stale past the
 * TTL, is owed either way — so the checkout decision must read `doneAt` and
 * `attempts`, never `lockedAt`. Tying it to the TTL would let a purchase unblock
 * because a worker died, which has nothing to do with whether Lemon Squeezy
 * accepted the cancellation.
 */
test("the checkout decision ignores the lock and its TTL entirely", async (t) => {
  silenceErrors(t);
  const f = await makeTrial("lockttl");
  stubFetch(t, async () => {
    throw new Error("ECONNREFUSED");
  });
  assert.equal((await cancelAsAdmin(f.user.id, f.externalId, "queued")).status, 202);
  const [task] = await tasksFor(f.externalId);

  for (const lockedAt of [null, new Date(), new Date(Date.now() - 60 * 60_000)]) {
    await prisma.billingTask.update({ where: { id: task.id }, data: { lockedAt } });
    const res = await request(app).post("/api/checkout").set(f.auth).send({ plan: "monthly" });
    assert.equal(res.status, 409, `lockedAt=${lockedAt}: ${res.text}`);
    assert.equal(
      res.body.code,
      "CANCELLATION_PENDING",
      "the lock must not move the customer-facing decision",
    );
  }
});

// ── §9 — an unambiguous state for the desktop and the console ────────────────

/**
 * The client must never read an English sentence to know what to show.
 *
 * Per plan, because the answers are not the same answer. A customer on a live
 * monthly plan may not buy yearly — Change plan is the route — yet may buy
 * lifetime, and one account-wide `canPurchase` has to be wrong about one of
 * them. This is the shape the desktop paywall renders from.
 */
test("GET /api/subscription reports a decision per plan", async (t) => {
  silenceErrors(t);
  const read = (auth: any) => request(app).get("/api/subscription").set(auth);

  // 1. A brand-new account: a trial is on offer, and the lengths are stated.
  const fresh = await prisma.user.create({
    data: { email: `qa-${runId}-fresh@example.test`, plan: "free", emailVerified: true },
  });
  const freshAuth = {
    Authorization: `Bearer ${signToken({ sub: fresh.id, email: fresh.email })}`,
  };
  let res = await read(freshAuth);
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.body.purchaseEligibility.monthly, {
    canPurchase: true,
    reasonCode: "ELIGIBLE_WITH_TRIAL",
    trialMode: "eligible",
    trialDays: 3,
  });
  assert.deepEqual(res.body.purchaseEligibility.yearly, {
    canPurchase: true,
    reasonCode: "ELIGIBLE_WITH_TRIAL",
    trialMode: "eligible",
    trialDays: 7,
  });
  assert.deepEqual(res.body.purchaseEligibility.lifetime, {
    canPurchase: true,
    reasonCode: "ELIGIBLE_WITHOUT_TRIAL",
    trialMode: "none",
    trialDays: 0,
  });

  // 2. A trial running: recurring shut, lifetime open — the saga, stated.
  const active = await makeTrial("plan-active");
  res = await read(active.auth);
  for (const plan of ["monthly", "yearly"] as const) {
    assert.equal(res.body.purchaseEligibility[plan].reasonCode, "ACTIVE_SUBSCRIPTION");
    assert.equal(res.body.purchaseEligibility[plan].canPurchase, false);
    assert.equal(res.body.purchaseEligibility[plan].trialMode, "none");
  }
  assert.equal(res.body.purchaseEligibility.lifetime.canPurchase, true);

  // 3. Cancellation owed: recurring pending, lifetime still open.
  const pending = await makeTrial("plan-pending");
  stubFetch(t, async () => {
    throw new Error("ECONNREFUSED");
  });
  assert.equal((await cancelAsAdmin(pending.user.id, pending.externalId, "queued")).status, 202);
  res = await read(pending.auth);
  assert.equal(res.body.purchaseEligibility.monthly.reasonCode, "CANCELLATION_PENDING");
  assert.equal(res.body.purchaseEligibility.yearly.reasonCode, "CANCELLATION_PENDING");
  assert.equal(
    res.body.purchaseEligibility.lifetime.canPurchase,
    true,
    "lifetime is not a subscription and cannot become a second one",
  );

  // 4. Every attempt spent.
  const [task] = await tasksFor(pending.externalId);
  await prisma.billingTask.update({ where: { id: task.id }, data: { attempts: MAX_ATTEMPTS } });
  res = await read(pending.auth);
  assert.equal(res.body.purchaseEligibility.monthly.reasonCode, "BILLING_SUPPORT_REQUIRED");
  assert.equal(res.body.purchaseEligibility.lifetime.canPurchase, true);

  // 5. Confirmed cancellation: back at the paywall, trial spent.
  const eligible = await cancelledTrial(t, "plan-eligible");
  res = await read(eligible.auth);
  for (const plan of ["monthly", "yearly"] as const) {
    assert.deepEqual(res.body.purchaseEligibility[plan], {
      canPurchase: true,
      reasonCode: "ELIGIBLE_WITHOUT_TRIAL",
      trialMode: "skip",
      trialDays: 0,
    });
  }

  // 6. Lifetime owned: every plan shut, including lifetime itself.
  await prisma.purchase.create({
    data: {
      userId: eligible.user.id,
      provider: "lemonsqueezy",
      store: "lemonsqueezy",
      externalId: `order-${runId}-life`,
      productId: V_LIFETIME,
      purchasedAt: at(-1),
      isRefunded: false,
      testMode: false,
    },
  });
  res = await read(eligible.auth);
  for (const plan of ["monthly", "yearly", "lifetime"] as const) {
    assert.equal(res.body.purchaseEligibility[plan].reasonCode, "LIFETIME_ALREADY_OWNED", plan);
    assert.equal(res.body.purchaseEligibility[plan].canPurchase, false, plan);
  }

  // Nothing here is `message`-shaped. The client branches on codes only.
  assert.equal(res.body.purchaseEligibility.monthly.message, undefined);
});

// ── §7 — the status call and the checkout cannot disagree ────────────────────

/**
 * Table-driven, over every state this pass can produce.
 *
 * For each, `GET /api/subscription` is read first and the checkout is then
 * called for all three plans. An API that advertises a purchase and then refuses
 * it — or refuses it for a reason the paywall never showed — is worse than one
 * that refuses consistently, because the customer has already decided to pay.
 */
test("every plan's advertised decision is the one the checkout enforces", async (t) => {
  silenceErrors(t);

  const scenarios: Array<{ name: string; make: () => Promise<{ auth: any; user?: any }> }> = [
    {
      name: "brand-new account",
      make: async () => {
        const u = await prisma.user.create({
          data: { email: `qa-${runId}-tbl-new@example.test`, plan: "free", emailVerified: true },
        });
        return { user: u, auth: { Authorization: `Bearer ${signToken({ sub: u.id, email: u.email })}` } };
      },
    },
    { name: "trial running", make: () => makeTrial("tbl-active") },
    {
      name: "cancellation pending",
      make: async () => {
        const f = await makeTrial("tbl-pending");
        stubFetch(t, async () => {
          throw new Error("ECONNREFUSED");
        });
        await cancelAsAdmin(f.user.id, f.externalId, "queued");
        return f;
      },
    },
    {
      name: "cancellation dead-lettered",
      make: async () => {
        const f = await makeTrial("tbl-dlq");
        stubFetch(t, async () => {
          throw new Error("ECONNREFUSED");
        });
        await cancelAsAdmin(f.user.id, f.externalId, "queued");
        const [task] = await tasksFor(f.externalId);
        await prisma.billingTask.update({
          where: { id: task.id },
          data: { attempts: MAX_ATTEMPTS },
        });
        return f;
      },
    },
    { name: "trial cancelled and confirmed", make: () => cancelledTrial(t, "tbl-done") },
    {
      name: "paid subscription cancelled, access remaining",
      make: async () => {
        const f = await makeTrial("tbl-paidcancel");
        await prisma.subscription.update({
          where: { id: f.sub.id },
          data: { status: "cancelled", trialEndsAt: null, validUntil: at(20), endsAt: at(20) },
        });
        return f;
      },
    },
  ];

  for (const scenario of scenarios) {
    const f = await scenario.make();
    const status = await request(app).get("/api/subscription").set(f.auth);
    assert.equal(status.status, 200, `${scenario.name}: ${status.text}`);

    for (const plan of ["monthly", "yearly", "lifetime"] as const) {
      // Each plan judged against the same underlying state, not against the
      // lock the previous plan's mint would otherwise be holding.
      await clearAcquisition((f as any).user?.id ?? "");
      const advertised = (await request(app).get("/api/subscription").set(f.auth)).body
        .purchaseEligibility[plan];
      const sent = captureCheckout(t);
      const res = await request(app).post("/api/checkout").set(f.auth).send({ plan });
      const where = `${scenario.name} / ${plan}`;

      if (!advertised.canPurchase) {
        assert.equal(res.status, 409, `${where}: ${res.text}`);
        assert.equal(res.body.code, advertised.reasonCode, `${where}: same reason, not just a 409`);
        assert.deepEqual(sent, [], `${where}: a refusal must not reach Lemon Squeezy`);
        continue;
      }

      assert.equal(res.status, 201, `${where}: advertised as purchasable — ${res.text}`);
      const options = sent[0].data.attributes.checkout_options;
      if (advertised.trialMode === "skip") {
        assert.equal(options?.skip_trial, true, `${where}: trialMode skip must send skip_trial`);
      } else {
        assert.equal(
          options,
          undefined,
          `${where}: trialMode ${advertised.trialMode} must not suppress the variant's trial`,
        );
      }
    }
  }
});


// ── §5 — a task belongs to ONE subscription, not to the account ──────────────

/** Give this account a second, long-dead subscription carrying a stuck task. */
async function withStrandedOldSubscription(
  userId: string,
  tag: string,
  patch: Record<string, unknown>,
) {
  const externalId = `sub-${runId}-old-${tag}`;
  await prisma.subscription.create({
    data: {
      userId,
      provider: "lemonsqueezy",
      externalId,
      variantId: V_MONTHLY,
      interval: "month",
      status: "expired", // Lemon Squeezy finished with it long ago
      trialEndsAt: at(-400),
      validUntil: at(-400),
      providerUpdatedAt: at(-400),
      testMode: false,
    },
  });
  await prisma.billingTask.create({
    data: {
      provider: "lemonsqueezy",
      externalId,
      kind: "cancel",
      reason: "admin-cancel",
      ...patch,
    },
  });
  return externalId;
}

/**
 * A stuck task on a dead subscription must not lock the account out of buying.
 *
 * The outbox lookup was already correlated by provider, externalId and kind — it
 * never read "all tasks for this user". The leak was one level up: the account
 * verdict took the first blocking row it found, and the block was evaluated
 * BEFORE asking whether Lemon Squeezy still had anything to do with that row. So
 * a cancellation abandoned years ago, on a subscription long since expired, held
 * a customer's current, properly-cancelled trial hostage.
 *
 * Our own bookkeeping being untidy is not a reason to refuse someone's money.
 */
for (const stranded of [
  { name: "pending", patch: {} },
  { name: "dead-lettered", patch: { attempts: 99 } },
] as const) {
  test(`a ${stranded.name} task on an OLD expired subscription does not block buying`, async (t) => {
    silenceErrors(t);
    const f = await cancelledTrial(t, `corr-${stranded.name}`);
    const oldId = await withStrandedOldSubscription(f.user.id, stranded.name, stranded.patch);

    // Precondition: the stranded task really is in the state we claim.
    const [old] = await tasksFor(oldId);
    assert.equal(old.doneAt ?? null, null, "the old task is genuinely unfinished");

    const sent = captureCheckout(t);
    for (const plan of ["monthly", "yearly"] as const) {
      await clearAcquisition(f.user.id);
      const res = await request(app).post("/api/checkout").set(f.auth).send({ plan });
      assert.equal(
        res.status,
        201,
        `${plan} must not be blocked by an unrelated dead row: ${res.text}`,
      );
    }
    for (const body of sent) {
      assert.equal(body.data.attributes.checkout_options?.skip_trial, true);
    }

    // The mints above still hold the account's acquisition lock; this assertion
    // is about the cancellation state, not about the lock.
    await clearAcquisition(f.user.id);
    const status = await request(app).get("/api/subscription").set(f.auth);
    assert.equal(status.body.purchaseEligibility.monthly.reasonCode, "ELIGIBLE_WITHOUT_TRIAL");
  });
}

/** The correlation itself: provider, externalId and kind all have to match. */
test("only a task matching provider, externalId AND kind counts", async (t) => {
  silenceErrors(t);
  const f = await makeTrial("corr-keys");
  await prisma.subscription.update({
    where: { id: f.sub.id },
    data: { trialCancelledAt: at(0) },
  });

  // A task for the SAME subscription id but another provider, and another kind.
  await prisma.billingTask.createMany({
    data: [
      {
        provider: "stripe",
        externalId: f.externalId,
        kind: "cancel",
        reason: "another provider entirely",
      },
      {
        provider: "lemonsqueezy",
        externalId: f.externalId,
        kind: "refund",
        reason: "a different operation on the same subscription",
      },
    ],
  });

  const sent = captureCheckout(t);
  const res = await request(app).post("/api/checkout").set(f.auth).send({ plan: "monthly" });
  assert.equal(
    res.status,
    201,
    `neither foreign key may be mistaken for our cancellation: ${res.text}`,
  );
  assert.equal(sent[0].data.attributes.checkout_options.skip_trial, true);

  // And the one that DOES match still blocks.
  await prisma.billingTask.create({
    data: {
      provider: "lemonsqueezy",
      externalId: f.externalId,
      kind: "cancel",
      reason: "the real one",
    },
  });
  // Clear the link the assertion above minted: with one still ready, the reuse
  // path would hand it straight back and never reach the cancellation check.
  await clearAcquisition(f.user.id);
  const blocked = await request(app).post("/api/checkout").set(f.auth).send({ plan: "monthly" });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, "CANCELLATION_PENDING");
});

// ── §6 — absent, null, and set ───────────────────────────────────────────────

/**
 * The three shapes `doneAt` can take on MongoDB, and what each must mean.
 *
 * Prisma does not store an optional field that was never given a value, so a
 * fresh task has NO `doneAt` key at all — not a null one. A decision written as
 * `doneAt === null` reads absent as unsettled on one path and settled on
 * another. `!= null` is the only test that sees both the same way, and the same
 * trap already made this outbox inert once.
 */
test("doneAt absent, null and set are read as pending, pending, settled", async (t) => {
  silenceErrors(t);
  const cases = [
    { name: "absent", data: {}, expect: "CANCELLATION_PENDING" },
    { name: "null", data: { doneAt: null, lockedAt: null, lastError: null }, expect: "CANCELLATION_PENDING" },
    { name: "set", data: { doneAt: at(0) }, expect: null },
  ] as const;

  for (const c of cases) {
    const f = await makeTrial(`shape-${c.name}`);
    await prisma.subscription.update({
      where: { id: f.sub.id },
      data: { trialCancelledAt: at(0) },
    });
    await prisma.billingTask.create({
      data: {
        provider: "lemonsqueezy",
        externalId: f.externalId,
        kind: "cancel",
        reason: "admin-cancel",
        ...c.data,
      },
    });

    const sent = captureCheckout(t);
    const res = await request(app).post("/api/checkout").set(f.auth).send({ plan: "monthly" });
    if (c.expect) {
      assert.equal(res.status, 409, `${c.name}: ${res.text}`);
      assert.equal(res.body.code, c.expect, c.name);
      assert.deepEqual(sent, [], `${c.name}: nothing may be minted`);
    } else {
      assert.equal(res.status, 201, `${c.name}: ${res.text}`);
      assert.equal(sent[0].data.attributes.checkout_options.skip_trial, true);
    }
  }
});

/**
 * Dead-lettered is not a status column — there is none on `BillingTask`. It is
 * `attempts >= MAX_ATTEMPTS` with `doneAt` still empty, which is exactly how
 * `drainCancels` counts it. This pins the two readings together so a future
 * change to one cannot silently disagree with the other.
 */
test("the checkout and the drain agree on what dead-lettered means", async (t) => {
  silenceErrors(t);
  const f = await makeTrial("dlq-canon");
  stubFetch(t, async () => {
    throw new Error("ECONNREFUSED");
  });
  assert.equal((await cancelAsAdmin(f.user.id, f.externalId, "queued")).status, 202);
  const [task] = await tasksFor(f.externalId);

  // One below the threshold: still ordinary pending work for both readers.
  await prisma.billingTask.update({
    where: { id: task.id },
    data: { attempts: MAX_ATTEMPTS - 1 },
  });
  let res = await request(app).post("/api/checkout").set(f.auth).send({ plan: "monthly" });
  assert.equal(res.body.code, "CANCELLATION_PENDING", "one attempt short is not dead-lettered");

  await prisma.billingTask.update({ where: { id: task.id }, data: { attempts: MAX_ATTEMPTS } });
  res = await request(app).post("/api/checkout").set(f.auth).send({ plan: "monthly" });
  assert.equal(res.body.code, "BILLING_SUPPORT_REQUIRED", "at the threshold it is");

  const drained = await drainCancels();
  assert.ok(
    drained.deadLettered >= 1,
    `the drain must count the same row: ${JSON.stringify(drained)}`,
  );

  // Settled outranks the attempt count: a task that succeeded on its last try is
  // done, however many failures preceded it.
  await prisma.billingTask.update({ where: { id: task.id }, data: { doneAt: at(0) } });
  captureCheckout(t); // the provider is reachable again for the purchase below
  res = await request(app).post("/api/checkout").set(f.auth).send({ plan: "monthly" });
  assert.equal(res.status, 201, res.text);
});

// ── §8 — two checkouts at once ───────────────────────────────────────────────

/**
 * The gap this file used to document is closed — verified here, from the side
 * that first noticed it.
 *
 * The old version of this test asserted that BOTH mints succeeded and said so
 * plainly, because at the time they did: `POST /api/checkout` reserved nothing,
 * so a customer with two tabs could pay two links. The per-account acquisition
 * lock now makes that impossible, and the detailed proof — every plan pairing,
 * ten synchronised rounds each — lives in `checkout-lock.mongo.test.ts`. What
 * remains here is the assertion this file cares about: whatever happens to the
 * second request, no trial is granted and none is reserved.
 */
test("two simultaneous checkouts mint exactly one payable link", async (t) => {
  silenceErrors(t);
  const f = await cancelledTrial(t, "conc-gap");
  const sent = captureCheckout(t);

  const [m, y] = await Promise.all([
    request(app).post("/api/checkout").set(f.auth).send({ plan: "monthly" }),
    request(app).post("/api/checkout").set(f.auth).send({ plan: "yearly" }),
  ]);

  assert.equal(sent.length, 1, "exactly one payment URL may exist");
  const winners = [m, y].filter((r) => r.status === 201);
  const losers = [m, y].filter((r) => r.status !== 201);
  assert.equal(winners.length, 1, `${m.text} / ${y.text}`);
  assert.equal(losers[0].body.code, "CHECKOUT_IN_PROGRESS");

  assert.equal(sent[0].data.attributes.checkout_options?.skip_trial, true);
  assert.equal(sent[0].data.attributes.checkout_data.custom.user_id, f.user.id);
  assert.equal(
    await prisma.trialClaim.count({ where: { firstUserId: f.user.id } }),
    0,
    "minting reserves no trial — the ledger is written by the webhook",
  );
  assert.equal(
    await prisma.subscription.count({ where: { userId: f.user.id } }),
    1,
    "minting creates no subscription — only paying does",
  );
});

/**
 * The other half of the same question: once ONE of those checkouts is paid and
 * mirrored, the second URL's account is no longer eligible. The block is not
 * retroactive on an already-issued URL, but the state that would authorise a
 * fresh one is gone.
 */
test("once a second subscription exists, further checkouts are refused", async (t) => {
  silenceErrors(t);
  const f = await cancelledTrial(t, "conc-after");

  // The customer paid one of the two URLs; the webhook mirrored a live plan.
  await prisma.subscription.create({
    data: {
      userId: f.user.id,
      provider: "lemonsqueezy",
      externalId: `sub-${runId}-conc-second`,
      variantId: V_YEARLY,
      interval: "year",
      status: "active",
      validUntil: at(365),
      renewsAt: at(365),
      providerUpdatedAt: at(0),
      testMode: false,
    },
  });

  const sent = captureCheckout(t);
  const res = await request(app).post("/api/checkout").set(f.auth).send({ plan: "monthly" });
  assert.equal(res.status, 409, res.text);
  assert.equal(res.body.code, "ACTIVE_SUBSCRIPTION");
  assert.deepEqual(sent, [], "no third subscription may be minted");

  const status = await request(app).get("/api/subscription").set(f.auth);
  assert.equal(status.body.purchaseEligibility.monthly.reasonCode, "ACTIVE_SUBSCRIPTION");
  assert.equal(status.body.purchaseEligibility.yearly.reasonCode, "ACTIVE_SUBSCRIPTION");
});

/**
 * The two cancellations expire differently, proved at the endpoint the app asks.
 *
 * `grantsAccess` above reads the predicate. This reads /api/entitlement — what
 * the desktop actually receives — because the distinction only matters if it
 * survives the route: a paid subscriber who cancels has bought a period and
 * keeps it to the instant the SERVER names; a trial buys no period, so cancelling
 * one ends access now.
 *
 * Getting this backwards is expensive in both directions. Cutting a paid
 * customer off early takes access they paid for. Letting a cancelled trial run
 * on gives the product away and, worse, leaves the paywall hidden from someone
 * we have already decided must see it.
 */
test("a cancelled paid subscription keeps access to the server's instant; a cancelled trial keeps none", async (t) => {
  silenceErrors(t);

  // ── the paid one ──────────────────────────────────────────────────────────
  const paid = await makeTrial("expiry-paid");
  const until = at(20);
  await prisma.subscription.update({
    where: { id: paid.sub.id },
    data: { status: "active", trialEndsAt: at(3), validUntil: until, endsAt: until },
  });
  stubFetch(t, async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: { attributes: { ends_at: until.toISOString() } } }),
  }));
  assert.equal((await cancelAsAdmin(paid.user.id, paid.externalId, "stop renewing")).status, 200);

  const paidEnt = await request(app).get("/api/entitlement").set(paid.auth);
  assert.equal(paidEnt.status, 200, paidEnt.text);
  assert.equal(paidEnt.body.isPro, true, "a cancelled paid period is still a paid period");
  assert.equal(
    new Date(paidEnt.body.validUntil).getTime(),
    until.getTime(),
    "the end must be the server's instant, not a client's idea of one",
  );

  // ── the trial one ─────────────────────────────────────────────────────────
  const trial = await makeTrial("expiry-trial");
  stubFetch(t, async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: { attributes: { ends_at: null } } }),
  }));
  const res = await cancelAsAdmin(trial.user.id, trial.externalId, "trial revoked");
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.entitlementRevoked, true);

  const trialEnt = await request(app).get("/api/entitlement").set(trial.auth);
  assert.equal(trialEnt.status, 200, trialEnt.text);
  assert.equal(trialEnt.body.isPro, false, "a cancelled trial keeps no remaining period");

  // And the paywall it lands on offers no second trial: the row still exists,
  // so the trial is spent — on yearly as much as on the plan it was used for.
  const status = await request(app).get("/api/subscription").set(trial.auth);
  for (const plan of ["monthly", "yearly"]) {
    assert.equal(status.body.purchaseEligibility[plan].trialMode, "skip", plan);
    assert.equal(status.body.purchaseEligibility[plan].canPurchase, true, plan);
  }
});
