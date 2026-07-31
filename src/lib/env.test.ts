import assert from "node:assert/strict";
import { test } from "node:test";
import { checkPaymentConfig } from "./env";

/*
 * The failure this guard exists for is not a crash — it is a customer being
 * charged and getting nothing, which no amount of downstream code can undo. It
 * happens whenever the checkout half of the storefront is configured and the
 * webhook half is not: the payment page mints fine, and every delivery that comes
 * back is rejected as unsigned.
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

test("a fully configured storefront boots silently", () => {
  assert.equal(checkPaymentConfig(FULL), null);
});

/*
 * Selling nothing is a legitimate state — a self-hosted or pre-launch deploy.
 * Refusing to boot over it would take focus sessions, notifications and blocking
 * down with it, none of which have anything to do with payments.
 */
test("a deploy that sells nothing still boots, with a warning", () => {
  const warning = checkPaymentConfig(NONE);
  assert.match(String(warning), /not configured/);
});

test("a half-configured storefront refuses to boot, and names what is missing", () => {
  for (const missing of [
    "lemonSqueezyApiKey",
    "lemonSqueezyWebhookSecret",
    "lemonSqueezyStoreId",
    "lemonSqueezyVariantId",
  ] as const) {
    assert.throws(
      () => checkPaymentConfig({ ...FULL, [missing]: "" }),
      /half-configured/,
      `omitting ${missing} must be fatal`,
    );
  }
});

test("the error names the missing variable, so the fix does not need a code read", () => {
  assert.throws(
    () => checkPaymentConfig({ ...FULL, lemonSqueezyWebhookSecret: "" }),
    /LEMONSQUEEZY_WEBHOOK_SECRET/,
  );
});

/*
 * Enforcement turns `expired` into a locked app. Shipping that without a
 * storefront gives every expired account a dead end: a paywall, a Buy button, and
 * a backend that answers 400 to every attempt to use it.
 */
test("enforcement without a storefront is refused — a paywall with no way to pay", () => {
  assert.throws(
    () => checkPaymentConfig({ ...NONE, entitlementEnforced: true }),
    /no way to buy/,
  );
});

test("enforcement with a storefront is exactly what shipping looks like", () => {
  assert.equal(checkPaymentConfig({ ...FULL, entitlementEnforced: true }), null);
});
