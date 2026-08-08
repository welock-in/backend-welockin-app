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
};

/**
 * Does this subscription grant access at `now`?
 *
 * A null `validUntil` grants, deliberately. It means Lemon Squeezy sent us a
 * status without a date — which happens on some transitions — and the safe
 * reading of "active, end date unknown" is to keep serving the customer and let
 * the next webhook correct it. The alternative fails toward cutting off someone
 * who is paying, on nothing more than a missing field.
 */
export function subscriptionGrants(sub: SubscriptionLike, now: Date): boolean {
  if (!GRANTING.includes(sub.status)) return false;
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
 * Three places read billing rows to decide something — the entitlement
 * resolver, and the checkout's two "you already have this" guards — and all
 * three must agree about whether a test purchase counts. One fragment, so they
 * cannot drift into a state where a row grants access but does not block a
 * second purchase of it.
 *
 * While ALLOW_TEST_MODE is ON this is EMPTY, deliberately: a test purchase is
 * the thing being tested, and hiding it would make the test prove nothing. The
 * moment the flag goes off, every test row stops existing as far as access and
 * checkout are concerned — which is what makes the switch to a live key safe
 * without a database migration.
 *
 * `NOT: { testMode: true }` rather than `testMode: false`, because on MongoDB a
 * column added after launch is ABSENT on older documents, not false — and
 * `testMode: false` would silently exclude every row written before this
 * existed, i.e. every real customer we already have.
 */
export function hideTestRows(allowTestMode: boolean): Record<string, unknown> {
  return allowTestMode ? {} : { NOT: { testMode: true } };
}
