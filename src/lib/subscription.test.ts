import assert from "node:assert/strict";
import { test } from "node:test";
import { subscriptionGrants, validUntilFrom } from "./subscription";

/**
 * The one question a subscription has to answer — does it grant access RIGHT
 * NOW — and the two ways of getting it wrong that cost real money.
 */

const NOW = new Date("2026-08-04T12:00:00.000Z");
const LATER = new Date("2026-09-01T00:00:00.000Z");
const EARLIER = new Date("2026-07-01T00:00:00.000Z");

/*
 * The expensive mistake. Lemon Squeezy marks a subscription cancelled the moment
 * the customer turns off renewal, and keeps it VALID until the end of the period
 * they already paid for. Reading `cancelled` as "no access" takes the product
 * away from someone who has paid through the end of the month.
 */
test("a cancelled subscription still grants until the paid period ends", () => {
  assert.equal(subscriptionGrants({ status: "cancelled", validUntil: LATER }, NOW), true);
  assert.equal(subscriptionGrants({ status: "cancelled", validUntil: EARLIER }, NOW), false);
});

test("on_trial and active grant; expired and unpaid never do", () => {
  assert.equal(subscriptionGrants({ status: "on_trial", validUntil: LATER }, NOW), true);
  assert.equal(subscriptionGrants({ status: "active", validUntil: LATER }, NOW), true);
  // Expired is the status that means gone — the date cannot rescue it.
  assert.equal(subscriptionGrants({ status: "expired", validUntil: LATER }, NOW), false);
  // Every retry exhausted. This is where a failing card finally stops.
  assert.equal(subscriptionGrants({ status: "unpaid", validUntil: LATER }, NOW), false);
});

/*
 * A failed renewal is a card problem, not a decision. Cutting access on the
 * first failed charge punishes an expired card, and the retries usually succeed.
 */
test("past_due keeps access while the retries run; paused keeps it too", () => {
  assert.equal(subscriptionGrants({ status: "past_due", validUntil: LATER }, NOW), true);
  assert.equal(subscriptionGrants({ status: "paused", validUntil: LATER }, NOW), true);
});

/*
 * A missing date must not cut off a paying customer. Some transitions arrive
 * without one, and the safe reading of "active, end unknown" is to keep serving
 * and let the next webhook correct it.
 */
test("a granting status with no date grants, rather than failing closed on a missing field", () => {
  assert.equal(subscriptionGrants({ status: "active", validUntil: null }, NOW), true);
  // But an ended subscription with no date is still ended.
  assert.equal(subscriptionGrants({ status: "expired", validUntil: null }, NOW), false);
});

test("an unknown status never grants", () => {
  assert.equal(subscriptionGrants({ status: "something_new", validUntil: LATER }, NOW), false);
});

/* ── which date is THE date ──────────────────────────────────────────── */

test("ends_at wins — it is the hard stop", () => {
  const at = validUntilFrom({
    status: "cancelled",
    endsAt: EARLIER,
    trialEndsAt: LATER,
    renewsAt: LATER,
  });
  assert.equal(at?.toISOString(), EARLIER.toISOString());
});

test("on trial, the trial's end is the date; otherwise the next renewal is", () => {
  assert.equal(
    validUntilFrom({ status: "on_trial", endsAt: null, trialEndsAt: EARLIER, renewsAt: LATER })?.toISOString(),
    EARLIER.toISOString(),
  );
  assert.equal(
    validUntilFrom({ status: "active", endsAt: null, trialEndsAt: EARLIER, renewsAt: LATER })?.toISOString(),
    LATER.toISOString(),
  );
});

test("no dates at all yields null, which grants — see subscriptionGrants", () => {
  assert.equal(validUntilFrom({ status: "active", endsAt: null, trialEndsAt: null, renewsAt: null }), null);
});

/* ── Cancelling DURING a trial ends access at once ──────────────────────────
 *
 * `cancelled` normally still grants: a paying customer keeps the period they
 * bought. A trial buys nothing, so there is no grace to honour — and "cancel my
 * trial" plainly means stop it, not hand me the rest of it free.
 */

test("a subscription cancelled while its trial is still running grants nothing", () => {
  const now = new Date();
  const inThreeDays = new Date(now.getTime() + 3 * 86_400_000);
  assert.equal(
    subscriptionGrants(
      { status: "cancelled", validUntil: inThreeDays, trialEndsAt: inThreeDays },
      now,
    ),
    false,
    "cancelling a trial takes access away immediately",
  );
});

test("a PAID subscription cancelled after its trial keeps its grace period", () => {
  const now = new Date();
  const lastMonth = new Date(now.getTime() - 30 * 86_400_000);
  const inTenDays = new Date(now.getTime() + 10 * 86_400_000);
  assert.equal(
    subscriptionGrants(
      // Trialed long ago, converted, paid, and has now cancelled.
      { status: "cancelled", validUntil: inTenDays, trialEndsAt: lastMonth },
      now,
    ),
    true,
    "they paid through this date — taking it away would be theft",
  );
});

test("a cancelled row with no trial date at all still grants (the old behaviour)", () => {
  const now = new Date();
  const inTenDays = new Date(now.getTime() + 10 * 86_400_000);
  assert.equal(subscriptionGrants({ status: "cancelled", validUntil: inTenDays }, now), true);
});

test("an ACTIVE trial is untouched by the rule — only cancelling ends it", () => {
  const now = new Date();
  const inThreeDays = new Date(now.getTime() + 3 * 86_400_000);
  assert.equal(
    subscriptionGrants(
      { status: "on_trial", validUntil: inThreeDays, trialEndsAt: inThreeDays },
      now,
    ),
    true,
  );
});

/*
 * The per-provider test-row gate. One fragment feeds every billing read, and
 * the property that matters is ISOLATION: opening one provider's test world
 * must never open the other's — REVENUECAT_ALLOW_SANDBOX is how TestFlight
 * testers get access on staging, and it must not also resurrect Lemon Squeezy
 * test orders (or vice versa).
 */
import { hideTestRows } from "./subscription";

test("with every flag off, only the NOT-test clause remains (absent still reads as real)", () => {
  assert.deepEqual(hideTestRows({ lemonSqueezy: false, revenuecat: false }), {
    OR: [{ NOT: { testMode: true } }],
  });
});

test("each flag opens ONLY its own provider's test rows", () => {
  assert.deepEqual(hideTestRows({ lemonSqueezy: true, revenuecat: false }), {
    OR: [{ NOT: { testMode: true } }, { provider: "lemonsqueezy" }],
  });
  assert.deepEqual(hideTestRows({ lemonSqueezy: false, revenuecat: true }), {
    OR: [{ NOT: { testMode: true } }, { provider: "revenuecat" }],
  });
});

test("both flags open both — and STILL nothing beyond those two providers", () => {
  assert.deepEqual(hideTestRows({ lemonSqueezy: true, revenuecat: true }), {
    OR: [
      { NOT: { testMode: true } },
      { provider: "lemonsqueezy" },
      { provider: "revenuecat" },
    ],
  });
});
