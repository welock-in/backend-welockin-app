import assert from "node:assert/strict";
import { test } from "node:test";
import { checkPaymentConfig } from "./env";

/*
 * The failure this guard exists for is not a crash — it is a customer being
 * charged and getting nothing, which no amount of downstream code can undo. It
 * happens whenever the checkout half of the storefront is configured and the
 * webhook half is not: the payment page mints fine, and every delivery that comes
 * back is rejected as unsigned.
 *
 * The fix is to switch the storefront OFF, not to refuse to boot. An unusable
 * storefront that will not open a checkout takes no money, so there is nothing
 * left to lose — whereas dying at boot would take focus sessions, notifications
 * and blocking down with it, trading a real outage for a hypothetical refund.
 */

const FULL = {
  lemonSqueezyApiKey: "key",
  lemonSqueezyWebhookSecret: "whsec",
  lemonSqueezyStoreId: "364783",
  lemonSqueezyVariantId: "1960881",
  entitlementEnforced: false,
};

const NONE = {
  lemonSqueezyApiKey: "",
  lemonSqueezyWebhookSecret: "",
  lemonSqueezyStoreId: "",
  lemonSqueezyVariantId: "",
  entitlementEnforced: false,
};

test("a fully configured storefront has nothing to say", () => {
  const v = checkPaymentConfig(FULL);
  assert.equal(v.degraded, false);
  assert.equal(v.enforcementSuppressed, false);
  assert.deepEqual(v.problems, []);
});

/*
 * Selling nothing is a legitimate state — a self-hosted or pre-launch deploy.
 * It is not a problem to report, because nothing about it is wrong.
 */
test("a deploy that sells nothing is silent, not degraded", () => {
  const v = checkPaymentConfig(NONE);
  assert.equal(v.degraded, false);
  assert.deepEqual(v.problems, []);
});

test("any single missing variable degrades the whole storefront", () => {
  for (const missing of [
    "lemonSqueezyApiKey",
    "lemonSqueezyWebhookSecret",
    "lemonSqueezyStoreId",
    "lemonSqueezyVariantId",
  ] as const) {
    const v = checkPaymentConfig({ ...FULL, [missing]: "" });
    assert.equal(v.degraded, true, `omitting ${missing} must disable purchasing`);
  }
});

test("the report names the missing variable, so the fix needs no code read", () => {
  const v = checkPaymentConfig({ ...FULL, lemonSqueezyWebhookSecret: "" });
  assert.match(v.problems.join(" "), /LEMONSQUEEZY_WEBHOOK_SECRET/);
  assert.match(v.problems.join(" "), /DISABLED/);
});

/*
 * The exact shape that loses money: everything needed to TAKE a payment, and
 * nothing needed to HEAR about it.
 */
test("checkout-capable but webhook-deaf is the case this exists for", () => {
  const v = checkPaymentConfig({ ...FULL, lemonSqueezyWebhookSecret: "" });
  assert.equal(v.degraded, true, "purchasing must be off before it can charge anyone");
});

/*
 * Enforcement turns `expired` into a locked app. Shipping that without a
 * storefront gives every expired account a dead end: a paywall, a Buy button, and
 * a backend that answers 400 to every attempt to use it. Dropping the enforcement
 * is the only failure mode here that harms nobody.
 */
test("enforcement without a storefront is forced off, never shipped", () => {
  const v = checkPaymentConfig({ ...NONE, entitlementEnforced: true });
  assert.equal(v.enforcementSuppressed, true);
  assert.match(v.problems.join(" "), /forced OFF/);
});

test("enforcement on a half-configured storefront is forced off too", () => {
  const v = checkPaymentConfig({ ...FULL, lemonSqueezyStoreId: "", entitlementEnforced: true });
  assert.equal(v.degraded, true);
  assert.equal(v.enforcementSuppressed, true);
});

test("enforcement with a working storefront is exactly what shipping looks like", () => {
  const v = checkPaymentConfig({ ...FULL, entitlementEnforced: true });
  assert.equal(v.enforcementSuppressed, false);
  assert.deepEqual(v.problems, []);
});
