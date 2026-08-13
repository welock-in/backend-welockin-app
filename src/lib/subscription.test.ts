import assert from "node:assert/strict";
import { describe, it, test, type TestContext } from "node:test";
import {
  isCurrentTrial,
  isLiveUnpaidTrial,
  subscriptionGrants,
  validUntilFrom,
} from "./subscription";
import { env } from "./env";

/** Patch env for one test, restored afterwards. */
function setEnv(t: TestContext, patch: Record<string, unknown>) {
  const before: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    before[k] = (env as any)[k];
    (env as any)[k] = v;
  }
  t.after(() => {
    for (const [k, v] of Object.entries(before)) (env as any)[k] = v;
  });
}

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
test("a cancelled subscription still grants until the current access period ends", () => {
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
 * A missing date must not cut off a paying customer — some transitions arrive
 * without one, and the safe reading of "active, end unknown" is to keep serving
 * and let the next webhook correct it.
 *
 * But only while a next webhook is still plausible. Granting outright made
 * incomplete data the most valuable state in the system: one status with a
 * missing date and the row was a permanent licence nothing ever revisited. The
 * grace is therefore measured from the last time we heard about the row.
 */
const DAY = 24 * 60 * 60 * 1000;

test("a granting status with no date grants for a bounded grace, not for ever", () => {
  const heardYesterday = new Date(NOW.getTime() - DAY);
  assert.equal(
    subscriptionGrants(
      { status: "active", validUntil: null, providerUpdatedAt: heardYesterday },
      NOW,
    ),
    true,
    "a transition we heard about yesterday is still in flight — keep serving",
  );

  const heardLastMonth = new Date(NOW.getTime() - 30 * DAY);
  assert.equal(
    subscriptionGrants(
      { status: "active", validUntil: null, providerUpdatedAt: heardLastMonth },
      NOW,
    ),
    false,
    "a row nobody has mentioned in a month is not a subscription, it is a leak",
  );

  // But an ended subscription with no date is still ended.
  assert.equal(
    subscriptionGrants(
      { status: "expired", validUntil: null, providerUpdatedAt: heardYesterday },
      NOW,
    ),
    false,
  );
});

/*
 * THE BYPASS THIS ANCHOR CLOSES. The grace was first measured from Prisma's
 * `@updatedAt` — OUR write time — and `GET /subscription/portal` writes the row
 * to cache a fresh URL. The account holder could therefore hold a dateless row
 * open indefinitely by pressing a button, which is the eternal grant the rule
 * exists to stop, reachable from the UI.
 */
test("the grace is measured from the PROVIDER's clock, not from our last write", () => {
  const heardLastMonth = new Date(NOW.getTime() - 30 * DAY);

  assert.equal(
    subscriptionGrants(
      {
        status: "active",
        validUntil: null,
        providerUpdatedAt: heardLastMonth,
        // Whatever touched the row a second ago — a portal refresh, a backfill.
        createdAt: heardLastMonth,
      },
      NOW,
    ),
    false,
    "our own writes must not be able to renew someone's access",
  );
});

test("a row predating the provider clock falls back to its creation date", () => {
  // Legacy rows have no providerUpdatedAt. createdAt is immutable, so it bounds
  // them without being something a request can move.
  assert.equal(
    subscriptionGrants(
      { status: "active", validUntil: null, providerUpdatedAt: null, createdAt: new Date(NOW.getTime() - DAY) },
      NOW,
    ),
    true,
  );
  assert.equal(
    subscriptionGrants(
      { status: "active", validUntil: null, providerUpdatedAt: null, createdAt: new Date(NOW.getTime() - 30 * DAY) },
      NOW,
    ),
    false,
  );
});

test("with neither an end date nor a last-heard date, nothing is granted", () => {
  assert.equal(
    subscriptionGrants({ status: "active", validUntil: null } as never, NOW),
    false,
    "an unboundable grant is the eternal right this rule exists to stop",
  );
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

/*
 * The SANDBOX gate, per account.
 *
 * `REVENUECAT_ALLOW_SANDBOX=true` is the right switch for a staging deploy
 * talking to a staging database, and there is none here — one Vercel project,
 * one Atlas database. On that shape the flag does not mean "let the testers
 * in", it means "let any Apple ID mint free lifetimes against production", so
 * the deploy names the testers by account id instead. Everything the rest of
 * the system does is unchanged: the rows are still written, and this still only
 * decides whether they are READ.
 */
import { hideTestRowsFor, revenuecatSandboxAllows } from "./subscription";

const TESTER = "507f1f77bcf86cd799439011";
const STRANGER = "507f1f77bcf86cd799439022";
const SHUT = { revenuecatAllowSandbox: false, revenuecatSandboxAllowedUserIds: [] as string[] };

test("with no list and no flag, NOBODY's sandbox rows grant", () => {
  assert.equal(revenuecatSandboxAllows(TESTER, SHUT), false);
  assert.equal(revenuecatSandboxAllows(STRANGER, SHUT), false);
});

test("the list opens exactly the accounts it names, and no other", () => {
  const gate = { ...SHUT, revenuecatSandboxAllowedUserIds: [TESTER] };
  assert.equal(revenuecatSandboxAllows(TESTER, gate), true);
  assert.equal(
    revenuecatSandboxAllows(STRANGER, gate),
    false,
    "naming one tester must never open the sandbox for the whole user base",
  );
});

test("the deploy-wide flag still outranks the list — for the day a staging deploy exists", () => {
  const gate = { revenuecatAllowSandbox: true, revenuecatSandboxAllowedUserIds: [] as string[] };
  assert.equal(revenuecatSandboxAllows(STRANGER, gate), true);
});

test("the per-account filter opens the sandbox for the tester and for nobody else", () => {
  const gate = {
    lemonSqueezyAllowTestMode: false,
    revenuecatAllowSandbox: false,
    revenuecatSandboxAllowedUserIds: [TESTER],
  };
  assert.deepEqual(hideTestRowsFor(TESTER, gate), {
    OR: [{ NOT: { testMode: true } }, { provider: "revenuecat" }],
  });
  assert.deepEqual(hideTestRowsFor(STRANGER, gate), {
    OR: [{ NOT: { testMode: true } }],
  });
});

test("an allow-listed tester does NOT thereby reopen Lemon Squeezy test mode", () => {
  // The isolation the per-provider gate exists for, now with a second key: an
  // iOS tester's account must not resurrect desktop test orders as a side effect.
  assert.deepEqual(
    hideTestRowsFor(TESTER, {
      lemonSqueezyAllowTestMode: false,
      revenuecatAllowSandbox: false,
      revenuecatSandboxAllowedUserIds: [TESTER],
    }),
    { OR: [{ NOT: { testMode: true } }, { provider: "revenuecat" }] },
  );
});

test("a PRODUCTION row is visible to everyone, listed or not — the gate only ever adds", () => {
  // The guarantee behind "turning test mode off deletes nothing": the shut gate
  // is one clause, `NOT testMode`, which every real purchase satisfies. Closing
  // it can only ever remove test rows from a READ.
  for (const gate of [
    { lemonSqueezyAllowTestMode: false, revenuecatAllowSandbox: false, revenuecatSandboxAllowedUserIds: [] },
    { lemonSqueezyAllowTestMode: false, revenuecatAllowSandbox: false, revenuecatSandboxAllowedUserIds: [TESTER] },
    { lemonSqueezyAllowTestMode: true, revenuecatAllowSandbox: true, revenuecatSandboxAllowedUserIds: [TESTER] },
  ]) {
    const or = (hideTestRowsFor(TESTER, gate) as { OR: Record<string, any>[] }).OR;
    assert.deepEqual(or[0], { NOT: { testMode: true } }, "the production clause is never removed");
    assert.ok(or.length >= 1);
  }
});

/* ── …and no resume gives it back ───────────────────────────────────────────
 *
 * THE HOLE THIS CLOSES, which was free access on repeat. Reading the rule off
 * `status` alone meant it lasted exactly as long as the status did: cancel the
 * trial, open the Lemon Squeezy customer portal, press Resume. LS puts the row
 * back to `on_trial` with the SAME trial_ends_at and takes no payment, the
 * webhook mirrors it, and the row grants again — as often as you like.
 *
 * The tombstone makes the cancellation a fact about the TRIAL rather than a
 * description of the current status, so nothing arriving later can undo it.
 */
test("a cancelled trial stays dead even when Lemon Squeezy resumes it", () => {
  const now = new Date();
  const inThreeDays = new Date(now.getTime() + 3 * 86_400_000);
  const cancelledAnHourAgo = new Date(now.getTime() - 3_600_000);

  assert.equal(
    subscriptionGrants(
      {
        // What the portal's Resume button produces: back on trial, nothing paid.
        status: "on_trial",
        validUntil: inThreeDays,
        trialEndsAt: inThreeDays,
        trialCancelledAt: cancelledAnHourAgo,
        updatedAt: now,
      },
      now,
    ),
    false,
    "resuming a refused trial must not hand back the days it had left",
  );

  assert.equal(
    subscriptionGrants(
      { status: "active", validUntil: inThreeDays, trialEndsAt: inThreeDays, trialCancelledAt: cancelledAnHourAgo, updatedAt: now },
      now,
    ),
    false,
    "nor does relabelling it active, while the trial window is still running",
  );
});

/*
 * The other direction, and the one that would be a support ticket: the tombstone
 * must stop mattering once the trial window is over. Someone who cancelled a
 * trial, thought better of it and actually PAID has bought a real period, and
 * refusing them would be charging for nothing.
 */
test("the tombstone expires with the trial window, so a later payment grants", () => {
  const now = new Date();
  const lastMonth = new Date(now.getTime() - 30 * 86_400_000);
  const nextMonth = new Date(now.getTime() + 30 * 86_400_000);

  assert.equal(
    subscriptionGrants(
      {
        status: "active",
        validUntil: nextMonth,
        trialEndsAt: lastMonth,
        trialCancelledAt: lastMonth,
        updatedAt: now,
      },
      now,
    ),
    true,
    "they are paying now; what they did during the trial is finished business",
  );
});

/* ── Only what we actually sell ──────────────────────────────────────────
 *
 * The store check was the only gate: any subscription bought in our Lemon
 * Squeezy store granted full Pro, whatever variant it was for. A discounted
 * tier, a grandfathered plan or a pay-what-you-want variant would each have
 * been a full licence at its own price.
 *
 * Turning that into a check is only safe because it refuses ONLY what it
 * positively knows we do not sell — the three cases below are the ones that
 * would otherwise cut off a paying customer, and each of them grants.
 */
const LIVE = {
  validUntil: LATER,
  trialEndsAt: null,
  trialCancelledAt: null,
  providerUpdatedAt: NOW,
  createdAt: NOW,
};

test("a variant we do not sell does not grant, whatever its status says", (t) => {
  setEnv(t, {
    lemonSqueezyVariantMonthly: "1986433",
    lemonSqueezyVariantYearly: "1986420",
    lemonSqueezyVariantId: "1960881",
    lemonSqueezyVariantsGranting: [],
  });

  assert.equal(subscriptionGrants({ ...LIVE, status: "active", variantId: "999999" }, NOW), false);
  assert.equal(subscriptionGrants({ ...LIVE, status: "on_trial", variantId: "999999" }, NOW), false);
  // And the ones we do sell are untouched.
  assert.equal(subscriptionGrants({ ...LIVE, status: "active", variantId: "1986433" }, NOW), true);
  assert.equal(subscriptionGrants({ ...LIVE, status: "active", variantId: "1986420" }, NOW), true);
  // The LIFETIME variant is deliberately absent from the subscription allowlist:
  // it is not a subscription, so no legitimate subscription can carry it.
  assert.equal(subscriptionGrants({ ...LIVE, status: "active", variantId: "1960881" }, NOW), false);
});

/*
 * THE LOCKOUT THIS AVOIDS, and it is the routine configuration rather than an
 * exotic one: a deploy that sells the lifetime licence and has not filled in the
 * subscription ids. env.ts documents that as legitimate. Arming the gate on the
 * lifetime id meant an allowlist of exactly one value no subscription can match
 * — every monthly and yearly subscriber revoked at once, silently.
 */
test("a lifetime-only deploy does not revoke every subscriber", (t) => {
  setEnv(t, {
    lemonSqueezyVariantId: "1960881",
    lemonSqueezyVariantMonthly: "",
    lemonSqueezyVariantYearly: "",
    lemonSqueezyVariantsGranting: [],
  });

  assert.equal(
    subscriptionGrants({ ...LIVE, status: "active", variantId: "1986433" }, NOW),
    true,
    "no subscription plans are configured, so the gate must be off",
  );
});

test("a retired variant keeps granting once it is listed", (t) => {
  // What a price change actually looks like: Lemon Squeezy mints a NEW variant
  // id and every existing subscriber stays on the old one. Without this list the
  // deploy that updates the environment cuts all of them off at once.
  setEnv(t, {
    lemonSqueezyVariantMonthly: "1986433",
    lemonSqueezyVariantYearly: "1986420",
    lemonSqueezyVariantId: "1960881",
    lemonSqueezyVariantsGranting: ["1700000"],
  });

  assert.equal(subscriptionGrants({ ...LIVE, status: "active", variantId: "1700000" }, NOW), true);
});

test("the gate is off entirely when no variants are configured", (t) => {
  // A lifetime-only deploy, or one mid-setup. Refusing everything here would be
  // a paywall switched on by an empty environment variable.
  setEnv(t, {
    lemonSqueezyVariantMonthly: "",
    lemonSqueezyVariantYearly: "",
    lemonSqueezyVariantId: "",
    lemonSqueezyVariantsGranting: [],
  });

  assert.equal(subscriptionGrants({ ...LIVE, status: "active", variantId: "999999" }, NOW), true);
});

test("a payload that never named a variant is not refused over it", (t) => {
  setEnv(t, {
    lemonSqueezyVariantMonthly: "1986433",
    lemonSqueezyVariantYearly: "1986420",
    lemonSqueezyVariantId: "1960881",
    lemonSqueezyVariantsGranting: [],
  });

  assert.equal(
    subscriptionGrants({ ...LIVE, status: "active", variantId: "" }, NOW),
    true,
    "a gap in what LS told us is not evidence of anything",
  );
});

/* ── Paused: the two modes are opposites ─────────────────────────────────
 *
 * `paused` was granting unconditionally, on the reading that Lemon Squeezy keeps
 * a paused subscription "active". Half true: `pause.mode` decides. `free` means
 * stop charging me but let me keep using it; `void` suspends the subscription.
 * Granting for both handed the product to everyone in the second group — and
 * with no end date on a paused row, indefinitely.
 */
test("paused in 'void' mode suspends access; 'free' mode keeps it", () => {
  const base = {
    validUntil: LATER,
    trialEndsAt: null,
    trialCancelledAt: null,
    providerUpdatedAt: NOW,
    createdAt: NOW,
    variantId: "",
  };

  assert.equal(subscriptionGrants({ ...base, status: "paused", pauseMode: "void" }, NOW), false);
  assert.equal(subscriptionGrants({ ...base, status: "paused", pauseMode: "free" }, NOW), true);
  assert.equal(
    subscriptionGrants({ ...base, status: "paused", pauseMode: null }, NOW),
    true,
    "an unknown mode is a gap in what we were told — and every row written before this column has one",
  );
  assert.equal(
    subscriptionGrants({ ...base, status: "active", pauseMode: "void" }, NOW),
    true,
    "a stale pause mode on a subscription that is no longer paused decides nothing",
  );
});

/**
 * What the status can and cannot tell us.
 *
 * These seven rows are the ones that got confused. The trap is `active`: it does
 * NOT prove money was collected — a 100% discount coupon, a free plan and a
 * manual provider adjustment all produce exactly the same string. Nothing here
 * claims a customer paid, because nothing here can: that answer lives in the
 * payment records, not in a subscription status. The only claim these predicates
 * make is whether Lemon Squeezy says a trial is running right now.
 */
describe("trial classification", () => {
  const now = new Date("2026-08-11T12:00:00.000Z");
  const future = new Date("2026-08-14T12:00:00.000Z");
  const past = new Date("2026-08-08T12:00:00.000Z");

  const cases: Array<{
    name: string;
    sub: { status: string; trialEndsAt: Date | null; trialCancelledAt: Date | null };
    isTrial: boolean;
    isLive: boolean;
  }> = [
    {
      name: "on_trial, future end, no tombstone — the live trial",
      sub: { status: "on_trial", trialEndsAt: future, trialCancelledAt: null },
      isTrial: true,
      isLive: true,
    },
    {
      name: "on_trial, future end, ALREADY tombstoned — still a trial, nothing left to revoke",
      sub: { status: "on_trial", trialEndsAt: future, trialCancelledAt: past },
      isTrial: true, // a retry must not reclassify it
      isLive: false, // but must not write a second timestamp
    },
    {
      name: "active with a future trial_ends_at — converted early, the date is stale",
      sub: { status: "active", trialEndsAt: future, trialCancelledAt: null },
      isTrial: false,
      isLive: false,
    },
    {
      name: "active on a 100% discount — active, and NOT evidence of a payment",
      sub: { status: "active", trialEndsAt: null, trialCancelledAt: null },
      isTrial: false,
      isLive: false,
    },
    {
      name: "on_trial whose window has already closed",
      sub: { status: "on_trial", trialEndsAt: past, trialCancelledAt: null },
      isTrial: false,
      isLive: false,
    },
    {
      name: "cancelled, tombstoned — the trial that was stopped",
      sub: { status: "cancelled", trialEndsAt: future, trialCancelledAt: past },
      isTrial: false,
      isLive: false,
    },
    {
      name: "cancelled subscription that never was a trial",
      sub: { status: "cancelled", trialEndsAt: null, trialCancelledAt: null },
      isTrial: false,
      isLive: false,
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      assert.equal(isCurrentTrial(c.sub, now), c.isTrial, "isCurrentTrial");
      assert.equal(isLiveUnpaidTrial(c.sub, now), c.isLive, "isLiveUnpaidTrial");
    });
  }

  it("a tombstone changes what is left to do, never what the row IS", () => {
    const running = { status: "on_trial", trialEndsAt: future, trialCancelledAt: null };
    const revoked = { ...running, trialCancelledAt: past };
    assert.equal(isCurrentTrial(running, now), isCurrentTrial(revoked, now));
    assert.notEqual(isLiveUnpaidTrial(running, now), isLiveUnpaidTrial(revoked, now));
  });
});
