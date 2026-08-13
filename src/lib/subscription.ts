/**
 * Reading a Lemon Squeezy subscription — the one place that decides whether it
 * still grants access.
 *
 * WHY IT IS ITS OWN FILE. A subscription's status moves under you and its
 * validity date slides, so the question "does this grant access right now?" gets
 * asked from the resolver, the webhook, the admin console and eventually the
 * client. Answered in four places it will be answered four ways, and the one
 * that disagrees will be the one a customer hits.
 */

/** Lemon Squeezy's own vocabulary, stored verbatim. */
export const SUBSCRIPTION_STATUSES = [
  "on_trial",
  "active",
  "paused",
  "past_due",
  "unpaid",
  "cancelled",
  "expired",
] as const;

export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/**
 * Statuses that still grant access, subject to the date.
 *
 * `cancelled` IS in this list, and that is the whole reason this function
 * exists. Lemon Squeezy marks a subscription cancelled the moment the customer
 * turns off renewal, but keeps it VALID until the end of the period they already
 * paid for. Treating cancelled as "no access" takes the product away from
 * someone who has paid through the end of the month — and they are right to
 * complain. `expired` is the status that means gone.
 *
 * `paused` is here because Lemon Squeezy's own documentation says payment
 * collection is paused while the subscription stays active.
 *
 * `past_due` is here for a narrower reason: a renewal that failed is a card
 * problem, not a decision. Cutting access on the first failed charge punishes an
 * expired card, and the retries usually succeed. `unpaid` — every retry
 * exhausted — is where it stops.
 */
const GRANTING: readonly string[] = ["on_trial", "active", "paused", "past_due", "cancelled"];

export type SubscriptionLike = {
  status: string;
  validUntil: Date | null;
  /**
   * Needed only to tell a trial cancellation from a paid one — see the rule in
   * `subscriptionGrants`. Optional so callers that do not decide access (the
   * duplicate-purchase guards, the lifetime-buyer sweep) need not select it.
   */
  trialEndsAt?: Date | null;
};

/**
 * Does this subscription grant access at `now`?
 *
 * A null `validUntil` grants, deliberately. It means Lemon Squeezy sent us a
 * status without a date — which happens on some transitions — and the safe
 * reading of "active, end date unknown" is to keep serving the customer and let
 * the next webhook correct it. The alternative fails toward cutting off someone
 * who is paying, on nothing more than a missing field.
 *
 * THE ONE EXCEPTION: cancelling DURING a trial ends access immediately.
 *
 * `cancelled` is otherwise in the granting list because a paying customer keeps
 * what they paid for until the period runs out — that grace is bought. A trial
 * buys nothing: nobody has been charged, so there is no paid-through date to
 * honour, and "cancel the trial" plainly means "stop it", not "give me the rest
 * of it free". Lemon Squeezy's own default is to keep the trial running to its
 * end date, so this rule is ours and is applied here rather than being wished
 * for at the call sites.
 *
 * The test is deliberately narrow: the trial end must still be in the FUTURE.
 * A subscription that trialed, converted, ran for months and was then cancelled
 * has a trial end far in the past, and keeps its paid grace exactly as before.
 */
export function subscriptionGrants(sub: SubscriptionLike, now: Date): boolean {
  if (!GRANTING.includes(sub.status)) return false;
  if (
    sub.status === "cancelled" &&
    sub.trialEndsAt != null &&
    sub.trialEndsAt.getTime() > now.getTime()
  ) {
    return false;
  }
  if (sub.validUntil == null) return true;
  return sub.validUntil.getTime() > now.getTime();
}

/**
 * When access actually runs out, from the three dates Lemon Squeezy sends.
 *
 * ONE column is derived from them rather than the resolver picking at read time,
 * because picking between three dates in four places is how the three drift
 * apart. The order is the order of specificity:
 *
 *   ends_at      set only when the subscription is finishing — the hard stop.
 *   trial_ends_at while on trial, the date access would lapse without a payment.
 *   renews_at    otherwise, the next charge, which is also the end of what has
 *                been paid for.
 */
export function validUntilFrom(input: {
  status: string;
  endsAt: Date | null;
  trialEndsAt: Date | null;
  renewsAt: Date | null;
}): Date | null {
  if (input.endsAt) return input.endsAt;
  if (input.status === "on_trial" && input.trialEndsAt) return input.trialEndsAt;
  return input.renewsAt ?? null;
}

/** Which plan a variant is, for the UI and for support reading a row. */
export function intervalForVariant(variantId: string, monthly: string, yearly: string): string | null {
  if (variantId && variantId === monthly) return "monthly";
  if (variantId && variantId === yearly) return "yearly";
  return null;
}

/**
 * The inverse: a plan NAME to the variant id it maps to.
 *
 * THE SECURITY BOUNDARY, in one place. A caller names a plan; it can never name a
 * variant of its own choosing — not a €0 test variant, not another store's. What
 * is purchasable (or switchable-to) is fixed at deploy time. Checkout and
 * change-plan both go through here so the two can never disagree about what
 * "monthly" means, which is exactly the drift that rotates a price into the wrong
 * product. Returns "" for a plan whose id is unset — every caller must treat
 * that as "not configured", never as a valid variant.
 */
export function variantForPlan(
  plan: "monthly" | "yearly" | "lifetime",
  ids: { monthly: string; yearly: string; lifetime: string },
): string {
  return plan === "monthly" ? ids.monthly : plan === "yearly" ? ids.yearly : ids.lifetime;
}

/**
 * The Prisma `where` fragment that hides TEST-mode rows once test mode is shut.
 *
 * Several places read billing rows to decide something — the entitlement
 * resolver, and the checkout/subscription "you already have this" guards — and
 * all of them must agree about whether a test purchase counts. One fragment, so
 * they cannot drift into a state where a row grants access but does not block a
 * second purchase of it.
 *
 * PER PROVIDER, not one global switch, because the two test worlds are
 * unrelated: `lemonSqueezyAllowTestMode` opens Lemon Squeezy TEST-mode rows
 * (desktop), `revenuecatAllowSandbox` opens StoreKit SANDBOX rows (iOS,
 * TestFlight). A tester exercising one storefront must never quietly re-open
 * the other's free-licence tap — so a testMode row only counts when the flag
 * of ITS OWN provider says so, and the protection can never be lifted
 * globally by accident.
 *
 * While a provider's flag is ON its test rows are visible, deliberately: a
 * test purchase is the thing being tested, and hiding it would make the test
 * prove nothing. The moment the flag goes off, every test row of that provider
 * stops existing as far as access and checkout are concerned — which is what
 * makes the switch to live safe without a database migration.
 *
 * `NOT: { testMode: true }` rather than `testMode: false`, because on MongoDB a
 * column added after launch is ABSENT on older documents, not false — and
 * `testMode: false` would silently exclude every row written before this
 * existed, i.e. every real customer we already have.
 */
export function hideTestRows(allow: {
  lemonSqueezy: boolean;
  revenuecat: boolean;
}): Record<string, unknown> {
  return {
    OR: [
      { NOT: { testMode: true } },
      ...(allow.lemonSqueezy ? [{ provider: "lemonsqueezy" }] : []),
      ...(allow.revenuecat ? [{ provider: "revenuecat" }] : []),
    ],
  };
}

/**
 * May THIS account's StoreKit SANDBOX rows grant? The `revenuecat` half of
 * `hideTestRows`, decided per user rather than per deploy.
 *
 * WHY IT IS PER USER. `REVENUECAT_ALLOW_SANDBOX=true` is the right switch for a
 * staging deploy talking to a staging database — and there is no such deploy
 * here: one Vercel project, one Atlas database. On that shape the flag does not
 * mean "let the testers in", it means "let every Apple ID in the world mint
 * free lifetimes against production", because a StoreKit sandbox purchase costs
 * nothing, is signed by the same Apple chain as a real one, and arrives through
 * the same webhook. This gate is the only thing between the two.
 *
 * So the deploy names the testers instead, by account id, and everyone else is
 * refused BY DEFAULT — a missing or malformed list opens nothing (see
 * `parseAccountIdList`, which drops entries that are not account ids). The
 * blunt flag still wins when it is set, so the day a real staging environment
 * exists nothing here has to change.
 *
 * READ-time only, like the fragment it feeds: a sandbox row is written and kept
 * whatever this says, and removing an account from the list hides its test rows
 * again without deleting anything. Nothing about a PRODUCTION purchase is
 * affected in either direction — those rows are not testMode, so they are
 * visible through the `NOT` clause no matter who is listed.
 */
export function revenuecatSandboxAllows(
  userId: string,
  gate: {
    revenuecatAllowSandbox: boolean;
    revenuecatSandboxAllowedUserIds: readonly string[];
  },
): boolean {
  if (gate.revenuecatAllowSandbox) return true;
  return gate.revenuecatSandboxAllowedUserIds.includes(userId);
}

/**
 * The whole test-row filter for ONE account, resolved from the environment.
 *
 * Every billing read in the API is already scoped to a user, and each of them
 * used to spell the same two-flag object out in full. That duplication was
 * survivable while both halves were deploy-wide booleans and became a hazard
 * the moment one of them started depending on WHO is asking: eight copies of a
 * gate is eight chances for one of them to keep the old, wider answer.
 *
 * So there is one call — `where: { userId, ...hideTestRowsFor(userId, env) }` —
 * and the pure pieces above stay separately testable. Takes the environment as
 * an argument rather than importing it, exactly like `checkPaymentConfig`, so
 * this file remains a set of rules a test can drive directly.
 */
export function hideTestRowsFor(
  userId: string,
  gate: {
    lemonSqueezyAllowTestMode: boolean;
    revenuecatAllowSandbox: boolean;
    revenuecatSandboxAllowedUserIds: readonly string[];
  },
): Record<string, unknown> {
  return hideTestRows({
    lemonSqueezy: gate.lemonSqueezyAllowTestMode,
    revenuecat: revenuecatSandboxAllows(userId, gate),
  });
}
