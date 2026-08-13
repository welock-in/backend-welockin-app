import test from "node:test";
import assert from "node:assert/strict";
import { env } from "./env";
import { subscriptionGrants, type SubscriptionLike } from "./subscription";

/*
 * The variant allowlist is a LEMON SQUEEZY concept, and this file pins the one
 * property nothing else pins: ARMING it must not judge RevenueCat rows.
 *
 * The RevenueCat sync writes Apple product ids ("in.welock.app.monthly") into
 * `variantId` — ids that can never legitimately appear in
 * LEMONSQUEEZY_VARIANTS_GRANTING (the boot check rejects non-numeric entries).
 * Without the provider escape, the first deploy with both providers configured
 * revokes every paying Apple subscriber at once, and the suite stays green
 * because every other test runs with the gate disarmed.
 */

const NOW = new Date("2030-06-15T12:00:00Z");
const IN_A_MONTH = new Date("2030-07-15T12:00:00Z");

function row(overrides: Partial<SubscriptionLike>): SubscriptionLike {
  return {
    status: "active",
    validUntil: IN_A_MONTH,
    variantId: "999999",
    pauseMode: null,
    trialEndsAt: null,
    trialCancelledAt: null,
    providerUpdatedAt: NOW,
    createdAt: NOW,
    ...overrides,
  };
}

function armGate<T>(fn: () => T): T {
  const saved = {
    monthly: env.lemonSqueezyVariantMonthly,
    yearly: env.lemonSqueezyVariantYearly,
    granting: env.lemonSqueezyVariantsGranting,
  };
  env.lemonSqueezyVariantMonthly = "1986433";
  env.lemonSqueezyVariantYearly = "1986420";
  env.lemonSqueezyVariantsGranting = [];
  try {
    return fn();
  } finally {
    env.lemonSqueezyVariantMonthly = saved.monthly;
    env.lemonSqueezyVariantYearly = saved.yearly;
    env.lemonSqueezyVariantsGranting = saved.granting;
  }
}

test("an ARMED allowlist still grants a RevenueCat row carrying an Apple product id", () => {
  armGate(() => {
    assert.equal(
      subscriptionGrants(
        row({ provider: "revenuecat", variantId: "in.welock.app.monthly" }),
        NOW,
      ),
      true,
      "the Lemon Squeezy allowlist must never judge an Apple subscription",
    );
  });
});

test("the same armed allowlist still refuses a Lemon Squeezy row on a retired variant", () => {
  armGate(() => {
    assert.equal(
      subscriptionGrants(row({ provider: "lemonsqueezy", variantId: "1700000" }), NOW),
      false,
      "scoping the gate per provider must not blunt it for the store it protects",
    );
  });
});

test("a row with no provider is judged as Lemon Squeezy — the historical callers", () => {
  armGate(() => {
    assert.equal(
      subscriptionGrants(row({ variantId: "1700000" }), NOW),
      false,
      "absent provider defaults to the gated store, never to a bypass",
    );
    assert.equal(
      subscriptionGrants(row({ variantId: "1986433" }), NOW),
      true,
      "and a sellable variant still grants",
    );
  });
});

test("with the gate disarmed, provider changes nothing (both grant)", () => {
  assert.equal(
    subscriptionGrants(row({ provider: "revenuecat", variantId: "in.welock.app.yearly" }), NOW),
    true,
  );
  assert.equal(subscriptionGrants(row({ variantId: "whatever" }), NOW), true);
});
