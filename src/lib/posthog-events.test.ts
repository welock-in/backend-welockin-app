import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ALL_EVENTS,
  ANALYTICS_CONFIG_DEFAULT,
  CLIENT_EVENTS,
  ENVIRONMENTS,
  EVENT_REGISTRY_FINGERPRINT,
  FORBIDDEN_PROPERTY_NAMES,
  FORBIDDEN_PROPERTY_SUBSTRINGS,
  SERVER_EVENTS,
  SURFACES,
  baseProperties,
  fnv1a,
  forbiddenPropertyKeys,
  installCohort,
  isValidEventName,
  parseAnalyticsConfig,
  registryFingerprint,
  shouldEmitFor,
} from "./posthog-events";

/**
 * The shared analytics contract between this backend and the three apps.
 *
 * THE INVARIANT THIS FILE DEFENDS, above all the others: the four copies of the
 * registry stay identical. The fingerprint tests below are the mechanism — they
 * are the reason an event name cannot be added to one repository alone. The
 * three sibling test files (ios/scripts/test-analytics-events.mjs,
 * windows/src/lib/analytics-events.test.ts and its macos twin) run the SAME
 * assertions against their own copy, so whichever repo you edit first is the one
 * that turns red.
 */

/* ── the fingerprint — what keeps four repositories in step ─────────────── */

test("the baked fingerprint matches the list in this repository", () => {
  // If this fails you either added an event without updating the constant, or
  // updated the constant without the other three repos. Both are the bug.
  assert.equal(registryFingerprint(ALL_EVENTS), EVENT_REGISTRY_FINGERPRINT);
});

test("the fingerprint ignores order but not membership", () => {
  const base = registryFingerprint(ALL_EVENTS);
  assert.equal(registryFingerprint([...ALL_EVENTS].reverse()), base);
  assert.notEqual(registryFingerprint([...ALL_EVENTS, "a_new_event"]), base);
  assert.notEqual(registryFingerprint(ALL_EVENTS.slice(1)), base);
});

test("fnv1a is stable, 8 hex chars, and sensitive to one character", () => {
  assert.match(fnv1a("purchase_completed"), /^[0-9a-f]{8}$/);
  assert.equal(fnv1a("purchase_completed"), fnv1a("purchase_completed"));
  assert.notEqual(fnv1a("purchase_completed"), fnv1a("purchase_completes"));
  assert.equal(fnv1a(""), "811c9dc5"); // the FNV offset basis, unmixed
});

/* ── the names themselves ───────────────────────────────────────────────── */

test("every name is snake_case ascii", () => {
  for (const name of ALL_EVENTS) assert.ok(isValidEventName(name), `bad event name: ${name}`);
  // A typo is not an error anywhere in PostHog — it is a brand new event that
  // nobody will ever open. This is the only place it can be caught.
  assert.equal(isValidEventName("Purchase_Completed"), false);
  assert.equal(isValidEventName("purchase completed"), false);
  assert.equal(isValidEventName("purchase-completed"), false);
  assert.equal(isValidEventName("2_purchase"), false);
  assert.equal(isValidEventName(""), false);
});

test("no duplicates, and client and server never share a name", () => {
  assert.equal(new Set(ALL_EVENTS).size, ALL_EVENTS.length);
  const server = new Set<string>(SERVER_EVENTS);
  for (const name of CLIENT_EVENTS) assert.ok(!server.has(name), `${name} is declared on both sides`);
});

test("this side owns the money, and the clients own none of it", () => {
  // Rule of the whole design: revenue comes from the webhook handlers only. A
  // client closes its paywall on the store's word alone, before this server has
  // agreed, and a purchase later attributed to another account (restoreConflict)
  // would leave a revenue event with no counter-event.
  assert.deepEqual([...SERVER_EVENTS], [
    "purchase_completed",
    "subscription_state_changed",
    "checkout_confirmed",
    "checkout_abandoned",
  ]);
  const clientNames = CLIENT_EVENTS.join(" ");
  assert.ok(!clientNames.includes("revenue"));
  assert.ok(!clientNames.includes("subscription_started"));
});

test("both halves of the desktop checkout ratio exist", () => {
  // checkout_started is emitted by the app, checkout_confirmed by the Lemon
  // Squeezy webhook here. Their ratio is the number this registry exists for,
  // and it is only computable because both spellings come from one file.
  assert.ok(CLIENT_EVENTS.includes("checkout_started"));
  assert.ok(SERVER_EVENTS.includes("checkout_confirmed"));
  // Started and never confirmed. Emitted by cron, because the absence of an
  // event is not an event.
  assert.ok(SERVER_EVENTS.includes("checkout_abandoned"));
});

/* ── the anonymity contract ─────────────────────────────────────────────── */

test("the obvious leaks are caught", () => {
  assert.deepEqual(forbiddenPropertyKeys({ provider: "lemonsqueezy", plan: "yearly" }), []);
  assert.deepEqual(forbiddenPropertyKeys({ email: "a@b.c" }), ["email"]);
  assert.deepEqual(forbiddenPropertyKeys({ customer_email: "a@b.c" }), ["customer_email"]);
  assert.deepEqual(forbiddenPropertyKeys({ display_name: "Hedi" }), ["display_name"]);
  assert.deepEqual(forbiddenPropertyKeys({ age: 24 }), ["age"]);
  assert.deepEqual(forbiddenPropertyKeys({ checkout_url: "https://…" }), ["checkout_url"]);
});

test("maskEmail output is still an email as far as this guard is concerned", () => {
  // billing.ts has maskEmail() for showing a hint to a client. Masked or not,
  // it is derived from an address and has no business in an event payload.
  assert.deepEqual(forbiddenPropertyKeys({ masked_email: "h***@epfl.ch" }), ["masked_email"]);
});

test("matching is case-insensitive and reports every offender", () => {
  assert.deepEqual(forbiddenPropertyKeys({ Email: "a@b.c" }), ["Email"]);
  assert.deepEqual(forbiddenPropertyKeys({ email: "a", age: 1, plan: "yearly" }).sort(), [
    "age",
    "email",
  ]);
});

test("the revenue payload this server will actually send is legal", () => {
  // The shape agreed for subscription_state_changed. Note what is NOT here: no
  // customer email, no order URL, no store receipt.
  assert.deepEqual(
    forbiddenPropertyKeys({
      provider: "lemonsqueezy",
      plan: "yearly",
      interval: "year",
      revenue_usd: 22.92,
      amount_native: 19.99,
      currency: "EUR",
      is_gross: true,
      is_trial_conversion: false,
      test_mode: false,
      environment: "prod",
      ls_event: "subscription_payment_success",
      $insert_id: "lemonsqueezy:9090213",
    }),
    [],
  );
});

test("the lists are non-empty — an empty denylist would pass everything", () => {
  assert.ok(FORBIDDEN_PROPERTY_SUBSTRINGS.length > 0);
  assert.ok(FORBIDDEN_PROPERTY_NAMES.length > 0);
});

/* ── super-properties ───────────────────────────────────────────────────── */

test("baseProperties fills every field, with no undefined", () => {
  const props = baseProperties({
    surface: "ios",
    environment: "prod",
    appVersion: "1.4.2",
    funnelVersion: "phone_v6",
    locale: "fr-FR",
    firstLaunch: new Date("2026-08-17T22:30:00Z"),
  });
  assert.deepEqual(props, {
    surface: "ios",
    environment: "prod",
    app_version: "1.4.2",
    funnel_version: "phone_v6",
    locale: "fr-FR",
    install_cohort: "2026-08-17",
    is_staff: false,
  });
  for (const [key, value] of Object.entries(props)) {
    assert.notEqual(value, undefined, `${key} is undefined`);
  }
});

test("a missing app version is named, not nulled", () => {
  const base = { surface: "ios", environment: "dev", funnelVersion: "v" } as const;
  assert.equal(baseProperties({ ...base, appVersion: null }).app_version, "unknown");
  assert.equal(baseProperties({ ...base, appVersion: "" }).app_version, "unknown");
});

test("install_cohort is UTC, so it does not shift with the device", () => {
  assert.equal(installCohort(new Date("2026-08-17T23:30:00Z")), "2026-08-17");
  assert.equal(installCohort(new Date("2026-08-18T00:30:00Z")), "2026-08-18");
  assert.equal(installCohort(new Date("2026-01-05T12:00:00Z")), "2026-01-05");
});

test("the surfaces and environments are the four apps and the five build kinds", () => {
  assert.deepEqual([...SURFACES], ["ios", "windows", "macos", "landing"]);
  // 'sandbox' matters here specifically: RevenueCat webhooks arrive with
  // environment SANDBOX and are deliberately processed, isolation happening at
  // read time. Without this property they enter production conversion rates.
  assert.deepEqual([...ENVIRONMENTS], ["dev", "sandbox", "testflight", "qa", "prod"]);
});

/* ── kill switch and sampling ───────────────────────────────────────────── */

test("a missing or malformed config fails OPEN", () => {
  // An analytics switch is not a security control, and this is the one place in
  // the repo where fail-open is right: the fail-CLOSED rule guards secrets
  // (CRON_SECRET, the Lemon Squeezy webhook signature), not measurement.
  assert.deepEqual(parseAnalyticsConfig(undefined), ANALYTICS_CONFIG_DEFAULT);
  assert.deepEqual(parseAnalyticsConfig(null), ANALYTICS_CONFIG_DEFAULT);
  assert.deepEqual(parseAnalyticsConfig("nope"), ANALYTICS_CONFIG_DEFAULT);
  assert.deepEqual(parseAnalyticsConfig({}), ANALYTICS_CONFIG_DEFAULT);
  assert.deepEqual(
    parseAnalyticsConfig({ enabled: "yes", sampleRate: "half" }),
    ANALYTICS_CONFIG_DEFAULT,
  );
});

test("a well-formed config is honoured, and the rate is clamped", () => {
  assert.deepEqual(parseAnalyticsConfig({ enabled: false, sampleRate: 0.25 }), {
    enabled: false,
    sampleRate: 0.25,
  });
  assert.deepEqual(parseAnalyticsConfig({ enabled: true, sampleRate: 4 }), {
    enabled: true,
    sampleRate: 1,
  });
  assert.deepEqual(parseAnalyticsConfig({ enabled: true, sampleRate: -1 }), {
    enabled: true,
    sampleRate: 0,
  });
  assert.deepEqual(parseAnalyticsConfig({ enabled: true, sampleRate: NaN }), {
    enabled: true,
    sampleRate: 1,
  });
});

test("disabled means disabled, whatever the rate", () => {
  assert.equal(shouldEmitFor({ enabled: false, sampleRate: 1 }, "anyone"), false);
  assert.equal(shouldEmitFor({ enabled: true, sampleRate: 0 }, "anyone"), false);
  assert.equal(shouldEmitFor({ enabled: true, sampleRate: 1 }, "anyone"), true);
});

test("sampling is per PERSON and stable — client and server agree on who", () => {
  // Both sides run this same function on the same distinct_id, so a person the
  // apps do not report for is also a person this server does not report for.
  // A per-event roll would split a funnel across the boundary.
  const config = { enabled: true, sampleRate: 0.5 };
  const verdict = shouldEmitFor(config, "user-abc");
  for (let i = 0; i < 50; i++) assert.equal(shouldEmitFor(config, "user-abc"), verdict);
});

test("sampling actually splits the population, roughly at the rate asked", () => {
  const keys = Array.from({ length: 4000 }, (_, i) => `user-${i}`);
  const kept = keys.filter((k) => shouldEmitFor({ enabled: true, sampleRate: 0.25 }, k)).length;
  // Wide bounds on purpose: this asserts "it buckets", not "it is uniform".
  assert.ok(kept > 800 && kept < 1200, `expected ~1000 of 4000, got ${kept}`);
});

test("raising the rate keeps everyone it already kept", () => {
  for (let i = 0; i < 500; i++) {
    const key = `user-${i}`;
    if (shouldEmitFor({ enabled: true, sampleRate: 0.2 }, key)) {
      assert.ok(
        shouldEmitFor({ enabled: true, sampleRate: 0.6 }, key),
        `${key} was dropped by a HIGHER rate`,
      );
    }
  }
});
