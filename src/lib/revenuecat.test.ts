import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RC_LIFETIME_PRODUCT_IDS,
  RC_PRODUCT_MONTHLY,
  RC_PRODUCT_YEARLY,
  projectSubscriber,
  statusForSubscription,
  type RcSubscriber,
  type RcSubscriptionState,
} from "./revenuecat";
import { subscriptionGrants } from "./subscription";

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

test("BOTH lifetime spellings mint a Purchase — the ASC id is still ambiguous", () => {
  for (const productId of RC_LIFETIME_PRODUCT_IDS) {
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
    assert.equal(plan.purchases.length, 1, `${productId} must be recognised`);
    const purchase = plan.purchases[0];
    assert.equal(purchase.externalId, `${USER}:${productId}`);
    assert.equal(purchase.data.store, "app_store");
    assert.equal(purchase.data.isRefunded, false);
    assert.equal(purchase.data.purchasedAt.toISOString(), PAST);
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
  const productId = RC_LIFETIME_PRODUCT_IDS[1];
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
