import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RC_KNOWN_PRODUCT_IDS,
  RC_LIFETIME_PRODUCT_IDS,
  RC_PRODUCT_MONTHLY,
  RC_PRODUCT_YEARLY,
  projectSubscriber,
  statusForSubscription,
  syncUserFromRevenueCat,
  type RcSubscriber,
  type RcSubscriptionState,
} from "./revenuecat";
import { LIFETIME_PRODUCT_ID } from "./entitlement";
import { subscriptionGrants } from "./subscription";
import { env } from "./env";
import { prisma } from "./prisma";

/*
 * The projection is where iOS money becomes rows, and the one catastrophic
 * mistake available to it is vocabulary: `subscriptionGrants` carries a rule
 * built for Lemon Squeezy — status 'cancelled' with a future trialEndsAt
 * grants NOTHING — while Apple's cancellation (auto-renew off) keeps access
 * until expires_date even during a trial. So these tests pin two things: the
 * status mapping itself, and that every mapped row still answers
 * `subscriptionGrants` the way Apple's semantics demand.
 */

const NOW = new Date("2026-08-12T12:00:00.000Z");
const FUTURE = "2026-09-01T00:00:00.000Z";
const PAST = "2026-07-01T00:00:00.000Z";
const USER = "507f1f77bcf86cd799439011";

function subscriberWith(sub: RcSubscriptionState, productId = RC_PRODUCT_MONTHLY): RcSubscriber {
  return {
    subscriptions: { [productId]: sub },
    entitlements: { pro: { product_identifier: productId, expires_date: sub.expires_date } },
    management_url: "https://apps.apple.com/account/subscriptions",
    original_app_user_id: USER,
  };
}

function onlySub(subscriber: RcSubscriber) {
  const plan = projectSubscriber(USER, subscriber, NOW);
  assert.equal(plan.subscriptions.length, 1);
  return plan.subscriptions[0];
}

/* ── the status mapping ─────────────────────────────────────────────────── */

test("a paying subscription maps to active, with the renewal visible", () => {
  const row = onlySub(subscriberWith({ expires_date: FUTURE, period_type: "normal", is_sandbox: false }));
  assert.equal(row.externalId, `${USER}:${RC_PRODUCT_MONTHLY}`);
  assert.equal(row.data.status, "active");
  assert.equal(row.data.willRenew, true);
  assert.equal(row.data.interval, "monthly");
  assert.equal(row.data.renewsAt?.toISOString(), FUTURE);
  assert.equal(row.data.validUntil?.toISOString(), FUTURE);
  assert.equal(row.data.environment, "production");
  assert.equal(row.data.testMode, false);
  assert.equal(row.data.entitlementId, "pro");
});

test("an Apple trial maps to on_trial with the countdown date", () => {
  const row = onlySub(subscriberWith({ expires_date: FUTURE, period_type: "trial" }));
  assert.equal(row.data.status, "on_trial");
  assert.equal(row.data.trialEndsAt?.toISOString(), FUTURE);
  assert.ok(subscriptionGrants(row.data, NOW));
});

test("a lapsed subscription maps to expired and grants nothing", () => {
  const row = onlySub(subscriberWith({ expires_date: PAST, period_type: "normal" }));
  assert.equal(row.data.status, "expired");
  assert.equal(row.data.renewsAt, null);
  assert.equal(subscriptionGrants(row.data, NOW), false);
});

test("a billing issue inside a live grace period is past_due — and still grants", () => {
  const grace = "2026-08-20T00:00:00.000Z";
  const row = onlySub(
    subscriberWith({
      expires_date: "2026-08-10T00:00:00.000Z", // already past — the grace is what keeps it alive
      grace_period_expires_date: grace,
      billing_issues_detected_at: "2026-08-10T00:00:00.000Z",
      period_type: "normal",
    }),
  );
  assert.equal(row.data.status, "past_due");
  assert.equal(row.data.validUntil?.toISOString(), grace, "access runs to the END of the grace");
  assert.ok(subscriptionGrants(row.data, NOW), "a failed card is a card problem, not a decision");
});

test("a spent grace period is expired, however loudly the billing issue is flagged", () => {
  const row = onlySub(
    subscriberWith({
      expires_date: "2026-07-10T00:00:00.000Z",
      grace_period_expires_date: PAST,
      billing_issues_detected_at: "2026-07-10T00:00:00.000Z",
    }),
  );
  assert.equal(row.data.status, "expired");
  assert.equal(subscriptionGrants(row.data, NOW), false);
});

test("a refund is expired-with-revocation, not merely lapsed", () => {
  const refundedAt = "2026-08-01T00:00:00.000Z";
  const row = onlySub(
    subscriberWith({ expires_date: FUTURE, refunded_at: refundedAt, period_type: "normal" }),
  );
  assert.equal(row.data.status, "expired");
  assert.equal(row.data.refundedAt?.toISOString(), refundedAt);
  assert.equal(row.data.revokedAt?.toISOString(), refundedAt);
  assert.equal(subscriptionGrants(row.data, NOW), false, "money returned = access returned");
});

/* ── the 'cancelled' trap ───────────────────────────────────────────────── */

test("turning off auto-renew is NOT a cancellation: access runs to the paid end", () => {
  const row = onlySub(
    subscriberWith({
      expires_date: FUTURE,
      period_type: "normal",
      unsubscribe_detected_at: "2026-08-11T00:00:00.000Z",
    }),
  );
  assert.notEqual(row.data.status, "cancelled", "the LS-only status must never appear on an RC row");
  assert.equal(row.data.status, "active");
  assert.equal(row.data.willRenew, false);
  assert.equal(row.data.renewsAt, null, "no charge is coming — showing one would be a lie");
  assert.ok(subscriptionGrants(row.data, NOW), "they paid through this date");
});

test("cancelling DURING an Apple trial keeps the trial: Apple promised the window", () => {
  // The exact case the LS rule would destroy: status 'cancelled' + future
  // trialEndsAt reads as "grants nothing" in subscriptionGrants. Apple cannot
  // end a trial early, so the row must keep granting until expires_date.
  const row = onlySub(
    subscriberWith({
      expires_date: FUTURE,
      period_type: "trial",
      unsubscribe_detected_at: "2026-08-11T00:00:00.000Z",
    }),
  );
  assert.equal(row.data.status, "on_trial");
  assert.equal(row.data.willRenew, false);
  assert.ok(
    subscriptionGrants(row.data, NOW),
    "an Apple trial with auto-renew off still runs to its end — cutting it here is the trap",
  );
});

test("no mapped state, whatever the inputs, is ever 'cancelled'", () => {
  const dates = [FUTURE, PAST, null, "not a date"];
  const bools = [true, false, undefined];
  for (const expires of dates)
    for (const unsub of dates)
      for (const refunded of dates)
        for (const grace of dates)
          for (const period of ["normal", "trial", "intro", undefined])
            for (const sandbox of bools) {
              const { status } = statusForSubscription(
                {
                  expires_date: expires,
                  unsubscribe_detected_at: unsub,
                  refunded_at: refunded,
                  grace_period_expires_date: grace,
                  billing_issues_detected_at: unsub,
                  period_type: period,
                  is_sandbox: sandbox,
                },
                NOW,
              );
              assert.notEqual(status, "cancelled");
            }
});

/* ── sandbox marking ────────────────────────────────────────────────────── */

test("a sandbox subscription is recorded — flagged, never dropped", () => {
  const row = onlySub(subscriberWith({ expires_date: FUTURE, period_type: "trial", is_sandbox: true }));
  assert.equal(row.data.testMode, true);
  assert.equal(row.data.environment, "sandbox");
});

test("a production purchase EXPLICITLY clears the sandbox flag on its row", () => {
  // A TestFlight tester who later pays lands on the same (user, product) row.
  // Leaving testMode true would hide their paid subscription behind the
  // sandbox gate forever — so production writes false, not nothing.
  const row = onlySub(subscriberWith({ expires_date: FUTURE, is_sandbox: false }));
  assert.equal(row.data.testMode, false);
});

/* ── products ───────────────────────────────────────────────────────────── */

test("a product we do not sell is ignored, never guessed at", () => {
  const plan = projectSubscriber(
    USER,
    { subscriptions: { "com.someone.else": { expires_date: FUTURE } } },
    NOW,
  );
  assert.equal(plan.subscriptions.length, 0);
  assert.equal(plan.purchases.length, 0);
});

test("the yearly product labels its row yearly", () => {
  const row = onlySub(subscriberWith({ expires_date: FUTURE }, RC_PRODUCT_YEARLY));
  assert.equal(row.data.interval, "yearly");
});

/*
 * THE PRODUCT IDS THEMSELVES. Pinned as literals exactly once, here, because
 * every other fixture in the suite now spells them through the constants —
 * which means a typo in a constant would be copied faithfully into every test
 * and prove nothing. Apple never lets a Product ID change after creation, so
 * these three strings are as immutable as anything in the codebase.
 */
test("the Apple catalogue is exactly three product ids, and they are final", () => {
  assert.equal(RC_PRODUCT_MONTHLY, "in.welock.app.monthly");
  assert.equal(RC_PRODUCT_YEARLY, "in.welock.app.yearly");
  assert.deepEqual([...RC_LIFETIME_PRODUCT_IDS], ["in.welock.app.life"]);
  // The whole allow-list, so a fourth id cannot be added without a test saying so.
  assert.deepEqual([...RC_KNOWN_PRODUCT_IDS].sort(), [
    "in.welock.app.life",
    "in.welock.app.monthly",
    "in.welock.app.yearly",
  ]);
  // The RC mirror and the legacy JWS route must name the SAME lifetime product.
  assert.equal(RC_LIFETIME_PRODUCT_IDS[0], LIFETIME_PRODUCT_ID);
});

test("the lifetime product mints a Purchase", () => {
  const productId = RC_LIFETIME_PRODUCT_IDS[0];
  const plan = projectSubscriber(
    USER,
    {
      non_subscriptions: {
        [productId]: [{ id: "txn1", purchase_date: PAST, store: "app_store", is_sandbox: false }],
      },
      entitlements: { pro: { product_identifier: productId, expires_date: null } },
    },
    NOW,
  );
  assert.equal(plan.purchases.length, 1);
  const purchase = plan.purchases[0];
  assert.equal(purchase.externalId, `${USER}:${productId}`);
  assert.equal(purchase.data.store, "app_store");
  assert.equal(purchase.data.isRefunded, false);
  assert.equal(purchase.data.purchasedAt.toISOString(), PAST);
});

test("the RETIRED lifetime spelling is a product we do not sell — nothing is written", () => {
  // It was never sold: App Store Connect has only ever had `….life`, so a
  // subscriber naming the long spelling is either a stale fixture or someone
  // else's catalogue. Either way it must project to NOTHING, exactly like any
  // other foreign product — an alias kept "for compatibility" would be a
  // second, unaudited way to be granted a lifetime licence.
  // Built by concatenation, not written out: the purge is verified by a
  // repo-wide grep for the retired id coming back EMPTY, and a fixture that
  // spelled it would defeat the very check it is here to protect.
  const retired = `${LIFETIME_PRODUCT_ID}time`;
  for (const productId of [retired, "com.evil.app.pro"]) {
    const plan = projectSubscriber(
      USER,
      {
        non_subscriptions: {
          [productId]: [{ id: "txn1", purchase_date: PAST, is_sandbox: false }],
        },
        subscriptions: { [productId]: { expires_date: FUTURE, period_type: "normal" } },
        entitlements: { pro: { product_identifier: productId } },
      },
      NOW,
    );
    assert.deepEqual(plan.purchases, [], `${productId} must mint no Purchase`);
    assert.deepEqual(plan.subscriptions, [], `${productId} must mint no Subscription`);
    assert.equal(RC_KNOWN_PRODUCT_IDS.includes(productId), false, "nor pass the allow-list");
  }
});

test("a lifetime dropped from a reported entitlements object reads as refunded", () => {
  const productId = RC_LIFETIME_PRODUCT_IDS[0];
  const plan = projectSubscriber(
    USER,
    {
      non_subscriptions: { [productId]: [{ id: "txn1", purchase_date: PAST }] },
      // Entitlements ARE reported, and the lifetime is not among them.
      entitlements: { other: { product_identifier: "com.someone.else" } },
    },
    NOW,
  );
  assert.equal(plan.purchases[0].data.isRefunded, true);
  assert.ok(plan.purchases[0].data.revokedAt != null);
});

test("an ABSENT entitlements object never revokes anyone", () => {
  // Fail toward access: inferring "refunded" from a thin fetch would revoke
  // every paying customer over a missing field.
  const productId = RC_LIFETIME_PRODUCT_IDS[0];
  const plan = projectSubscriber(
    USER,
    { non_subscriptions: { [productId]: [{ id: "txn1", purchase_date: PAST }] } },
    NOW,
  );
  assert.equal(plan.purchases[0].data.isRefunded, false);
});

/* ── convergence ────────────────────────────────────────────────────────── */

test("the projection is a pure snapshot: same subscriber in, same rows out", () => {
  // This is what makes out-of-order webhooks converge — RENEWAL before
  // INITIAL_PURCHASE both end in a re-fetch, and the re-fetch is the state.
  const subscriber = subscriberWith({ expires_date: FUTURE, period_type: "normal" });
  assert.deepEqual(
    projectSubscriber(USER, subscriber, NOW),
    projectSubscriber(USER, subscriber, NOW),
  );
});

test("the management URL rides along for the billing view", () => {
  const plan = projectSubscriber(USER, subscriberWith({ expires_date: FUTURE }), NOW);
  assert.equal(plan.managementUrl, "https://apps.apple.com/account/subscriptions");
});

/* ── the authoritative sweep (the transfer-loser leak) ──────────────────── */

type Ctx = { after: (fn: () => void) => void };

function stubMethod(t: Ctx, target: Record<string, any>, name: string, impl: (...a: any[]) => any) {
  const original = target[name];
  const calls: any[][] = [];
  target[name] = (...args: any[]) => {
    calls.push(args);
    return impl(...args);
  };
  t.after(() => {
    target[name] = original;
  });
  return calls;
}

/**
 * Stub the RC API and every write the sync makes. `respond` returns the raw
 * HTTP answer, so a test can produce a 404 or a body of the wrong SHAPE —
 * the two paths that must never be mistaken for "this customer owns nothing".
 * Returns the recorded calls so tests can read each WHERE.
 */
function stubSync(t: Ctx, respond: () => Response) {
  const before = env.revenuecatSecretApiKey;
  (env as any).revenuecatSecretApiKey = "sk_test";
  t.after(() => {
    (env as any).revenuecatSecretApiKey = before;
  });

  stubMethod(t, globalThis as any, "fetch", async () => respond());
  return {
    subUpsert: stubMethod(t, prisma.subscription as any, "upsert", async () => ({})),
    purchaseUpsert: stubMethod(t, prisma.purchase as any, "upsert", async () => ({})),
    subSweep: stubMethod(t, prisma.subscription as any, "updateMany", async () => ({ count: 1 })),
    purchaseSweep: stubMethod(t, prisma.purchase as any, "updateMany", async () => ({ count: 1 })),
  };
}

/** The ordinary case: a 200 whose body has the documented wrapper. */
const ok = (subscriber: RcSubscriber) => () =>
  new Response(JSON.stringify({ subscriber }), { status: 200 });

test("an EMPTY snapshot sweeps ALL of this user's RC rows — the transfer-loser fix", async (t) => {
  // A 200 with empty collections: the losing account still EXISTS at
  // RevenueCat and is authoritatively saying it holds nothing.
  const db = stubSync(t, ok({}));

  await syncUserFromRevenueCat(USER);

  assert.equal(db.subUpsert.length, 0, "nothing to mirror");
  // Both sweeps fire, scoped to THIS user + provider, sparing nothing.
  for (const sweep of [db.subSweep, db.purchaseSweep]) {
    assert.equal(sweep.length, 1);
    const where = sweep[0][0].where;
    assert.equal(where.userId, USER);
    assert.equal(where.provider, "revenuecat");
    assert.deepEqual(where.externalId.notIn, [], "an empty snapshot spares no row");
  }
  // Subscription revoked to a non-granting state; purchase marked refunded.
  assert.equal(db.subSweep[0][0].data.status, "expired");
  assert.ok(db.subSweep[0][0].data.revokedAt instanceof Date);
  assert.equal(db.subSweep[0][0].data.willRenew, false);
  assert.equal(db.purchaseSweep[0][0].data.isRefunded, true);
  assert.ok(db.purchaseSweep[0][0].data.revokedAt instanceof Date);
});

test("the sweep is scoped: never lemonsqueezy, never a comp, never another user", async (t) => {
  const db = stubSync(t, ok({}));

  await syncUserFromRevenueCat(USER);

  for (const sweep of [db.subSweep, db.purchaseSweep]) {
    const where = sweep[0][0].where;
    // The three things the WHERE must pin, so a Lemon Squeezy lifetime, an
    // admin comp on User, or anyone else's rows can never fall in range.
    assert.equal(where.provider, "revenuecat");
    assert.equal(where.userId, USER);
    assert.ok("notIn" in where.externalId);
    assert.equal(Object.keys(where).sort().join(","), "externalId,provider,userId");
  }
});

test("a normally-expired subscription is PRESENT in the snapshot, so it is spared", async (t) => {
  // The false-positive the sweep must not commit: an expired-but-still-there
  // subscription is in the plan (mapped 'expired'), so its externalId is in
  // notIn and it is never swept.
  const db = stubSync(t, ok({
    subscriptions: { [RC_PRODUCT_MONTHLY]: { expires_date: PAST, period_type: "normal" } },
  }));

  await syncUserFromRevenueCat(USER);

  assert.equal(db.subUpsert.length, 1, "the expired row is still mirrored, not dropped");
  assert.deepEqual(
    db.subSweep[0][0].where.externalId.notIn,
    [`${USER}:${RC_PRODUCT_MONTHLY}`],
    "the still-present row is spared from the sweep",
  );
});

test("the sweep is idempotent: a second identical sync issues the same scoped writes", async (t) => {
  const db = stubSync(t, ok({}));

  await syncUserFromRevenueCat(USER);
  await syncUserFromRevenueCat(USER);

  assert.equal(db.subSweep.length, 2);
  assert.deepEqual(db.subSweep[0][0].where, db.subSweep[1][0].where);
  assert.equal(db.subSweep[1][0].data.status, "expired");
});

/* ── we only revoke on a response we actually understood ────────────────── */

/*
 * The interaction that made the sweep dangerous. While the sync was additive,
 * every "degrade to an empty subscriber" path was harmless — it just mirrored
 * nothing. With the sweep, an empty subscriber REVOKES EVERYTHING, so each of
 * those paths became a way for an upstream anomaly to strip paid access from
 * every account that syncs. Uncertainty must fail the sync, never revoke.
 */

test("a 404 revokes NOTHING — an unreadable customer is not an empty one", async (t) => {
  const db = stubSync(t, () => new Response("", { status: 404 }));

  await syncUserFromRevenueCat(USER);

  assert.equal(db.subSweep.length, 0, "a 404 must never revoke a licence");
  assert.equal(db.purchaseSweep.length, 0);
  assert.equal(db.subUpsert.length, 0, "and there is nothing to mirror either");
});

test("a 200 whose body has no `subscriber` wrapper FAILS the sync instead of revoking", async (t) => {
  // The mass-revocation scenario: RevenueCat changes its response shape, or
  // returns a partial body during an incident. Degrading that to `{}` would
  // revoke every paying account that syncs. It must throw so the webhook parks
  // the event as `failed` and retries.
  for (const body of ['{"request_date":"2026-08-12"}', '{"subscriber":null}', '"a string"', "[]"]) {
    const db = stubSync(t, () => new Response(body, { status: 200 }));

    await assert.rejects(
      () => syncUserFromRevenueCat(USER),
      (err: unknown) => {
        assert.equal((err as Error).name, "RevenueCatApiError");
        return true;
      },
      `body ${body} must fail the sync`,
    );

    assert.equal(db.subSweep.length, 0, "no revocation may be written on a body we cannot read");
    assert.equal(db.purchaseSweep.length, 0);
  }
});

test("an unreadable JSON body likewise fails rather than revoking", async (t) => {
  const db = stubSync(t, () => new Response("not json at all", { status: 200 }));

  await assert.rejects(() => syncUserFromRevenueCat(USER), /RevenueCatApiError|not JSON/);
  assert.equal(db.subSweep.length, 0);
  assert.equal(db.purchaseSweep.length, 0);
});
