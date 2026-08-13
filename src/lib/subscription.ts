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
import { env } from "./env";

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

/**
 * Every input the access decision reads — and every one of them REQUIRED.
 *
 * They were optional, which was a quiet hole rather than a convenience: a caller
 * whose Prisma `select` omitted `trialEndsAt` did not fail, it silently skipped
 * the trial-cancellation rule and granted. A security rule that switches itself
 * off when someone forgets a column is not a rule.
 *
 * Required, the compiler enumerates the call sites for us and a missing column
 * is a build error instead of a customer keeping access they cancelled. The cost
 * is a few extra fields in a few selects; the alternative is silence.
 */
export type SubscriptionLike = {
  status: string;
  validUntil: Date | null;
  /**
   * Which store this row mirrors. OPTIONAL, unlike every other field, because
   * the historical callers are all Lemon Squeezy-scoped queries and that is the
   * default: absent means "lemonsqueezy". Callers that read MIXED rows (the
   * entitlement resolver) must select and pass it, or the Lemon Squeezy variant
   * allowlist below would judge Apple product ids it can never contain.
   */
  provider?: string;
  /** Which plan was bought — checked against what we actually sell. */
  variantId: string;
  /** "void" | "free" while paused — they mean opposite things for access. */
  pauseMode: string | null;
  /** Tells a trial cancellation from a paid one — see the rule below. */
  trialEndsAt: Date | null;
  /**
   * Set once when a trial was cancelled, never cleared. What makes that
   * cancellation survive a resume — see the rule below.
   */
  trialCancelledAt: Date | null;
  /**
   * Lemon Squeezy's own `updated_at` for the last event we applied — i.e. when we
   * last actually HEARD FROM THE PROVIDER. Only consulted when `validUntil` is
   * missing, where it bounds the grace.
   *
   * Deliberately not Prisma's `updatedAt`, which was the first version of this
   * and was a bypass: `@updatedAt` is OUR write time, and any authenticated
   * endpoint that touches the row for its own reasons — `GET /subscription/portal`
   * caches a fresh URL there — would bump it. The account holder could then hold a
   * dateless row open for ever by pressing a button, which is precisely the
   * eternal grant this rule exists to close.
   */
  providerUpdatedAt: Date | null;
  /**
   * Immutable fallback for rows written before `providerUpdatedAt` existed. Also
   * not something a request can move, which is the property that matters.
   */
  createdAt: Date;
};

/**
 * How long a subscription may grant while we have no end date for it.
 *
 * Long enough to cover a transition Lemon Squeezy has not finished telling us
 * about, short enough that an abandoned row stops being a licence.
 */
const INCOMPLETE_GRACE_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * Is this a variant we actually sell a subscription for?
 *
 * The gate reads the environment here rather than taking the ids as an argument,
 * and that is the whole point: it cannot be switched off by a call site that
 * forgets to pass them. The same reason every field on `SubscriptionLike` is
 * required — a rule with an opt-out is not a rule.
 *
 * It refuses only what it POSITIVELY knows we do not sell. Nothing configured,
 * or a payload that never told us the variant, both grant: those are gaps in our
 * knowledge, and cutting off a paying customer over a gap in our knowledge is
 * the failure this codebase keeps choosing not to make.
 */
export function variantIsSellable(variantId: string): boolean {
  if (!variantId) return true; // LS did not say — not something to refuse over
  // SUBSCRIPTION variants only. The lifetime id is deliberately NOT in this list
  // even though it is a variant we sell: it is not a subscription, so it can
  // never legitimately appear here — and including it armed the gate on a
  // configuration `env.ts` documents as perfectly normal. A lifetime-only deploy
  // (VARIANT_ID set, MONTHLY and YEARLY empty) would have had an allowlist of
  // exactly one id that no subscription can match, and revoked every monthly and
  // yearly subscriber at once. The gate must arm on the ids that describe the
  // thing it is judging, or "partially configured" becomes "everyone is cut off".
  const sellable = [
    env.lemonSqueezyVariantMonthly,
    env.lemonSqueezyVariantYearly,
    ...env.lemonSqueezyVariantsGranting,
  ]
    .map((v) => v.trim())
    .filter(Boolean);
  if (sellable.length === 0) return true; // no subscription plans configured — gate off
  return sellable.includes(variantId.trim());
}

/**
 * When this subscription's grant actually runs out — the boundary, not the rope.
 *
 * `validUntil` when we have it; otherwise the end of the incomplete-data grace,
 * because a row with no end date does NOT grant for ever (see below) and the
 * offline receipt must be clipped to the same instant the server would stop.
 * Returning null here for a dateless row is what let a receipt hand out thirty
 * days while the server's own answer expired in three.
 *
 * Null means genuinely unbounded, which no subscription ever is.
 */
export function subscriptionGrantsUntil(sub: SubscriptionLike): Date | null {
  if (sub.validUntil) return sub.validUntil;
  const heard = sub.providerUpdatedAt ?? sub.createdAt;
  return heard ? new Date(heard.getTime() + INCOMPLETE_GRACE_MS) : null;
}

/**
 * Statuses where Lemon Squeezy may still take money, or where the row is still
 * something the customer can act on.
 *
 * SEPARATE FROM `subscriptionGrants`, and keeping them apart is load-bearing.
 * They answer different questions, and using the access predicate for both was a
 * real defect: once `subscriptionGrants` learned to refuse an unknown variant, a
 * cancelled trial or a void pause, every "do you already have a subscription?"
 * and "can you cancel this?" check inherited those refusals — so a customer whose
 * card Lemon Squeezy was still charging could be sold a SECOND subscription, and
 * could no longer cancel the first one from inside the app.
 *
 * Access is a question about entitlement. This is a question about billing.
 */
export function subscriptionIsLive(sub: { status: string }): boolean {
  return !["expired", "unpaid"].includes(sub.status);
}

/**
 * Does this subscription grant access at `now`?
 *
 * A null `validUntil` grants for a BOUNDED grace, not for ever. It means Lemon
 * Squeezy sent us a status without a date — which happens on some transitions —
 * and the safe reading of "active, end date unknown" is to keep serving the
 * customer and let the next webhook correct it, because failing the other way
 * cuts off someone who is paying on nothing more than a missing field.
 *
 * But "let the next webhook correct it" is only safe while a next webhook is
 * plausible. Granting outright made incomplete data the most valuable state in
 * the system: one status with a missing date, and the row is a permanent licence
 * that nothing ever revisits. So the grace runs from OUR last write to the row —
 * if we genuinely stop hearing about a subscription, it stops granting.
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
  // A real subscription, in our store, for something we do not sell. The store
  // is the only thing the webhook checked before, which made every variant in it
  // a full licence at whatever price that variant happened to carry.
  //
  // LEMON SQUEEZY ROWS ONLY. The allowlist is built from LEMONSQUEEZY_* ids, and
  // a RevenueCat row carries an Apple product id ("in.welock.app.monthly") that
  // could never legitimately appear in it — the moment the gate arms, judging
  // those rows here would cut off every paying Apple subscriber at once.
  // RevenueCat rows are vetted at WRITE time instead: the sync only mirrors the
  // expected entitlement, from the allowed app ids, under the sandbox policy.
  if ((sub.provider ?? "lemonsqueezy") === "lemonsqueezy" && !variantIsSellable(sub.variantId)) {
    return false;
  }
  // Paused, and paused to SUSPEND rather than to stop being charged. Lemon
  // Squeezy's two pause modes are opposites here: `free` means "keep using it,
  // we will not bill you", `void` means the subscription is suspended. Treating
  // `paused` as granting regardless handed the product to everyone in the second
  // group — and indefinitely, because a paused subscription has no end date to
  // run out. Only `void` is refused: an unknown mode is a gap in what we were
  // told, and rows written before this column existed all have one.
  if (sub.status === "paused" && sub.pauseMode === "void") return false;
  // Inside a trial window that was cancelled — by the tombstone (authoritative,
  // and immune to a later resume) or by the current status (for rows written
  // before the tombstone column existed).
  //
  // Reading the status ALONE was the hole: cancel the trial, press Resume in the
  // Lemon Squeezy portal, and the status returns to `on_trial` with no payment
  // taken. The tombstone makes the cancellation a fact about the trial instead
  // of a description of the status, so resuming cannot undo it.
  if (
    sub.trialEndsAt != null &&
    sub.trialEndsAt.getTime() > now.getTime() &&
    (sub.trialCancelledAt != null || sub.status === "cancelled")
  ) {
    return false;
  }
  if (sub.validUntil == null) {
    // A PAUSE has no end date by design, and that is not incomplete data — it is
    // a stable declared state. Running the grace over it would quietly cut off a
    // customer three days into a `free` pause, i.e. exactly the people the pause
    // rule above just decided to keep serving.
    if (sub.status === "paused") return true;
    // The type says this is always present; the runtime check is here because a
    // predicate that decides access should not throw a 500 on the hot boot path
    // if some future caller reaches it from JSON. With neither an end date nor a
    // last-heard-from date there is nothing to bound a grant with, and an
    // unboundable grant is exactly the eternal right this rule exists to stop.
    const heardFrom = (sub.providerUpdatedAt ?? sub.createdAt)?.getTime();
    if (heardFrom == null) return false;
    return heardFrom + INCOMPLETE_GRACE_MS > now.getTime();
  }
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
