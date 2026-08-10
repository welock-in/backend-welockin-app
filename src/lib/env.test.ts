import assert from "node:assert/strict";
import { test } from "node:test";
import { checkPaymentConfig, checkVariantGate } from "./env";

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

/*
 * The production dashboard carries two historical names — LEMON_API_KEY and
 * LEMONSQUEEZY_VARIANT_LIFETIME. The code accepts them as aliases because one
 * line here is cheaper than a dashboard rename plus the outage window when the
 * rename is forgotten. These tests pin both directions: the alias works, and
 * the canonical name WINS when both are set.
 */
test("the Lemon Squeezy env aliases are read, and the canonical names win", async () => {
  const before = {
    canonicalKey: process.env.LEMONSQUEEZY_API_KEY,
    aliasKey: process.env.LEMON_API_KEY,
    canonicalVariant: process.env.LEMONSQUEEZY_VARIANT_ID,
    aliasVariant: process.env.LEMONSQUEEZY_VARIANT_LIFETIME,
  };
  const half = {
    secret: process.env.LEMONSQUEEZY_WEBHOOK_SECRET,
    store: process.env.LEMONSQUEEZY_STORE_ID,
  };
  try {
    // The boot-time "all four or none" guard throws on a half-configured store,
    // so the two fields this test is NOT about must be present too.
    process.env.LEMONSQUEEZY_WEBHOOK_SECRET = "whsec-x";
    process.env.LEMONSQUEEZY_STORE_ID = "364783";
    delete process.env.LEMONSQUEEZY_API_KEY;
    process.env.LEMON_API_KEY = "alias-key";
    delete process.env.LEMONSQUEEZY_VARIANT_ID;
    process.env.LEMONSQUEEZY_VARIANT_LIFETIME = "1960881";
    const aliased = await import(`./env?alias=${Date.now()}`);
    assert.equal(aliased.env.lemonSqueezyApiKey, "alias-key");
    assert.equal(aliased.env.lemonSqueezyVariantId, "1960881");

    process.env.LEMONSQUEEZY_API_KEY = "canonical-key";
    process.env.LEMONSQUEEZY_VARIANT_ID = "111";
    const both = await import(`./env?both=${Date.now()}`);
    assert.equal(both.env.lemonSqueezyApiKey, "canonical-key");
    assert.equal(both.env.lemonSqueezyVariantId, "111");
  } finally {
    for (const [k, v] of Object.entries({
      LEMONSQUEEZY_API_KEY: before.canonicalKey,
      LEMON_API_KEY: before.aliasKey,
      LEMONSQUEEZY_VARIANT_ID: before.canonicalVariant,
      LEMONSQUEEZY_VARIANT_LIFETIME: before.aliasVariant,
      LEMONSQUEEZY_WEBHOOK_SECRET: half.secret,
      LEMONSQUEEZY_STORE_ID: half.store,
    })) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

/*
 * The account allow-lists. A list like this OPENS a door — sandbox rows that
 * would otherwise grant nothing — so the parsing rule is that anything which is
 * not an account id is DROPPED, never kept hopefully: a typo that silently
 * matched nobody would be indistinguishable from a working entry until someone
 * complained they were still locked out.
 */
import { parseAccountIdList } from "./env";

const ID_A = "507f1f77bcf86cd799439011";
const ID_B = "507f1f77bcf86cd799439022";

test("an unset or empty list opens nothing", () => {
  assert.deepEqual(parseAccountIdList(undefined, "X"), []);
  assert.deepEqual(parseAccountIdList("", "X"), []);
  assert.deepEqual(parseAccountIdList("  , ,, ", "X"), []);
});

test("a CSV of account ids survives whitespace and case", () => {
  assert.deepEqual(parseAccountIdList(` ${ID_A} , ${ID_B}`, "X"), [ID_A, ID_B]);
  assert.deepEqual(parseAccountIdList(ID_A.toUpperCase(), "X"), [ID_A.toUpperCase()]);
});

test("anything that is not an account id is dropped, and the rest still works", () => {
  // An email, a RevenueCat anonymous id, a truncated id: each would match no
  // user anyway, and a malformed id reaching Prisma is a P2023 throw.
  assert.deepEqual(
    parseAccountIdList(`me@example.com,${ID_A},$RCAnonymousID:87c6,${ID_B.slice(0, 20)}`, "X"),
    [ID_A],
  );
});

/* ── the variant allowlist's boot check ──────────────────────────────────
 *
 * This is the one setting here whose misconfiguration is INVISIBLE and expensive
 * in the wrong direction. Every other missing value makes something refuse
 * loudly; a variant id missing from the allowlist makes a paying subscriber
 * silently stop being one, and the only symptom is a support ticket weeks later.
 *
 * The way it happens is routine rather than exotic: a price change in Lemon
 * Squeezy mints a NEW variant id, existing subscribers stay on the OLD one, and
 * the deploy that updates the environment cuts every one of them off at once.
 */

const GATE = {
  lemonSqueezyVariantId: "1960881",
  lemonSqueezyVariantMonthly: "1986433",
  lemonSqueezyVariantYearly: "1986420",
  lemonSqueezyVariantsGranting: [] as string[],
};

test("an unconfigured deploy reports the gate OFF rather than silently refusing", () => {
  const v = checkVariantGate({
    lemonSqueezyVariantId: "",
    lemonSqueezyVariantMonthly: "",
    lemonSqueezyVariantYearly: "",
    lemonSqueezyVariantsGranting: [],
  });

  assert.equal(v.armed, false);
  assert.deepEqual(v.granting, []);
  assert.equal(v.problems.length, 0, "not configured is not an error — a lifetime-only deploy is valid");
  assert.ok(
    v.notes.some((n) => n.includes("ANY subscription")),
    "but 'every variant grants' is too surprising to leave unsaid",
  );
});

test("an armed gate names exactly which ids grant", () => {
  const v = checkVariantGate({ ...GATE, lemonSqueezyVariantsGranting: ["1700000"] });

  assert.equal(v.armed, true);
  assert.deepEqual(v.granting.sort(), ["1700000", "1960881", "1986420", "1986433"]);
  assert.equal(v.problems.length, 0);
  assert.ok(
    v.notes.some((n) => n.includes("1700000") && n.includes("ARMED")),
    "the boot log has to be readable as an answer to 'what grants right now'",
  );
});

test("a non-numeric variant id is a problem, not a silently dead entry", () => {
  // A product id, a name or a stray quote would sit in the list matching nothing
  // — which looks exactly like a correctly configured allowlist right up until
  // someone's access disappears.
  const v = checkVariantGate({ ...GATE, lemonSqueezyVariantsGranting: ["prod_abc", "1700000"] });

  assert.equal(v.problems.length, 1);
  assert.match(v.problems[0], /prod_abc/);
});

test("a malformed primary variant id is caught too", () => {
  const v = checkVariantGate({ ...GATE, lemonSqueezyVariantMonthly: '"1986433"' });

  assert.equal(v.problems.length, 1);
  assert.match(v.problems[0], /LEMONSQUEEZY_VARIANT_MONTHLY/);
});

test("a duplicate is noted but never refused", () => {
  const v = checkVariantGate({ ...GATE, lemonSqueezyVariantsGranting: ["1986433"] });

  assert.equal(v.problems.length, 0, "listing an id twice is harmless");
  assert.deepEqual(v.granting.sort(), ["1960881", "1986420", "1986433"], "and deduplicated");
  assert.ok(v.notes.some((n) => n.includes("more than once")));
});
