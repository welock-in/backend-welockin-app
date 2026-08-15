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
 * turns off renewal, but keeps it VALID until the end of the current access
 * period. Treating cancelled as "no access" takes the product away in the middle
 * of a period the customer is entitled to — and they are right to complain.
 * `expired` is the status that means gone.
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
/**
 * What an operator may be told when a cancellation does NOT cut access off now.
 *
 * The wording is exact on purpose. "Keeps access until the paid period ends" was
 * the obvious phrasing and it is not something we can assert: `active` is
 * produced by a 100% discount coupon, a free plan and a manual provider
 * adjustment just as readily as by a payment, and there is no payment ledger in
 * this codebase to check. Saying "paid" turns an unknown into a claim, in the
 * one place an operator is deciding what to tell a customer.
 *
 * Exported so the console shows THIS sentence rather than reinventing a
 * paraphrase that quietly reintroduces the claim.
 */
export const ACCESS_CONTINUES_MESSAGE =
  "The customer keeps access until the current access period ends.";

/**
 * The only case where an operator may promise access stopped at once — and the
 * only one the data supports. A trial buys no remaining period, so revoking it
 * ends access immediately; every other status keeps whatever period it has.
 */
export const ACCESS_REVOKED_NOW_MESSAGE =
  "Access ended immediately — a cancelled trial keeps no remaining period.";

/**
 * Where a cancellation has actually got to at the payment provider.
 *
 * Reconstructed, NOT stored — and that is a deliberate refusal to add a column.
 * The three states are already distinguishable from rows we keep:
 *
 *   · `none`         no outbox row exists. The provider answered synchronously
 *                    and there was never anything to owe. This is the 200 path.
 *   · `pending`      a cancel task is still owed, still inside its attempts.
 *   · `settled`      the drain got through; the provider has been told.
 *   · `dead_lettered` every attempt was spent and the provider never accepted.
 *
 * A stored "confirmed" flag would have to be written by three paths, survive a
 * late webhook, and be reconciled when the drain later succeeds — four ways to
 * be wrong about the one fact that decides whether we may bill someone twice.
 * The outbox already answers it, and the outbox is the thing that is true.
 */
export type CancellationState = "none" | "pending" | "settled" | "dead_lettered";

/**
 * Every answer the purchase decision can give, as a code the client branches on.
 *
 * ONE FLAT SET rather than "blocked" and "allowed" kept apart, because the two
 * eligible cases carry real information: `ELIGIBLE_WITH_TRIAL` is a first-time
 * buyer who will get the free days, `ELIGIBLE_WITHOUT_TRIAL` is someone who has
 * spent theirs. A paywall renders those differently, and inferring which from a
 * boolean plus a sentence is what this type exists to stop.
 */
export type EligibilityReason =
  | "ELIGIBLE_WITH_TRIAL"
  | "ELIGIBLE_WITHOUT_TRIAL"
  | "ACTIVE_SUBSCRIPTION"
  | "CANCELLED_ACCESS_REMAINING"
  | "CANCELLATION_PENDING"
  | "BILLING_SUPPORT_REQUIRED"
  | "LIFETIME_ALREADY_OWNED"
  | "CHECKOUT_RESUMABLE"
  | "CHECKOUT_IN_PROGRESS"
  | "CHECKOUT_STATE_UNCERTAIN";

/** The reasons that REFUSE. Kept as its own type so a block cannot be typoed. */
export type CheckoutBlockReason = Extract<
  EligibilityReason,
  | "ACTIVE_SUBSCRIPTION"
  | "CANCELLED_ACCESS_REMAINING"
  | "CANCELLATION_PENDING"
  | "BILLING_SUPPORT_REQUIRED"
  | "LIFETIME_ALREADY_OWNED"
  | "CHECKOUT_IN_PROGRESS"
  | "CHECKOUT_STATE_UNCERTAIN"
>;

/** What happens to the trial if this plan is bought right now. */
export type TrialMode = "eligible" | "skip" | "none";

export type PurchasePlan = "monthly" | "yearly" | "lifetime";

export type PlanEligibility = {
  canPurchase: boolean;
  reasonCode: EligibilityReason;
  trialMode: TrialMode;
  /** Days of trial this plan would grant — 0 unless `trialMode` is "eligible". */
  trialDays: number;
  /**
   * WHICH store's row is in the way, when the refusal is about something the
   * account already holds (`ACTIVE_SUBSCRIPTION` / `LIFETIME_ALREADY_OWNED`).
   *
   * The client's next sentence depends on it: an Apple subscription is managed
   * on the iPhone and this server can neither cancel nor change it, so "go to
   * Change plan" — the right advice for a Lemon Squeezy row — is a dead end.
   * Optional and best-effort: absent when the caller could not say (an old
   * fixture, a row written before providers were recorded), and the client
   * falls back to its provider-less copy.
   */
  blockingProvider?: "lemonsqueezy" | "revenuecat";
  /**
   * When the outstanding acquisition stops holding this plan back, ISO 8601.
   *
   * Present only on the plans an in-flight checkout affects — the resumable one
   * and the ones it blocks. It is the ONE thing the client could not work out
   * for itself: it can see WHICH plan is resumable from the code, but not until
   * when, and without that the only honest thing it could say was "try again
   * later", which is how the dead end started.
   *
   * A date, and nothing else. No URL, no intent token, no provider id — those
   * come from `POST /api/checkout`, which at least requires the caller to have
   * asked.
   */
  blockedUntil?: string;
};

/** Prose for humans; the client branches on the code, never on this. */
export const ELIGIBILITY_MESSAGES: Record<EligibilityReason, string> = {
  ELIGIBLE_WITH_TRIAL: "Start your free trial.",
  ELIGIBLE_WITHOUT_TRIAL: "Your free trial has been used — this plan starts right away.",
  ACTIVE_SUBSCRIPTION: "You already have an active subscription.",
  CANCELLED_ACCESS_REMAINING:
    "Your subscription is cancelled but still running until the end of the current " +
    "access period. Resume it or change plan instead of buying a second one.",
  CANCELLATION_PENDING:
    "Your cancellation is still being confirmed with the payment provider. " +
    "Refresh in a moment — buying now could bill you twice.",
  BILLING_SUPPORT_REQUIRED:
    "We could not confirm your cancellation with the payment provider. " +
    "Contact support before buying again so you are not billed twice.",
  LIFETIME_ALREADY_OWNED: "You already own the lifetime licence.",
  CHECKOUT_RESUMABLE: "You have a payment page open for this plan — finish it here.",
  // NEVER "finish or cancel it first": there is no cancelling. Lemon Squeezy
  // publishes no way to invalidate a checkout once created, so the product
  // cannot offer the action that sentence demanded, and the customer was left
  // with a screen asking them to do something impossible. What IS true is that
  // the other plan is still payable and the hold lifts on its own.
  CHECKOUT_IN_PROGRESS:
    "Another plan already has a payment page open. Continue that one, or choose " +
    "a different plan once it expires.",
  CHECKOUT_STATE_UNCERTAIN:
    "A previous checkout could not be confirmed with the payment provider. " +
    "Please wait a few minutes or contact support.",
};

/**
 * Which refusal wins when an account carries several subscription rows.
 *
 * Most severe first. An account with an abandoned cancellation AND a live
 * subscription must hear about the abandoned one: "contact support" is
 * actionable, "you already have a subscription" sends them to a Change plan
 * button that will not help.
 */
const BLOCK_SEVERITY: readonly CheckoutBlockReason[] = [
  "CHECKOUT_STATE_UNCERTAIN",
  "CHECKOUT_IN_PROGRESS",
  "BILLING_SUPPORT_REQUIRED",
  "CANCELLATION_PENDING",
  "ACTIVE_SUBSCRIPTION",
  "CANCELLED_ACCESS_REMAINING",
];

/**
 * A stored provider, normalised to the two words `blockingProvider` speaks.
 *
 * `app_store` folds into "revenuecat" because they are the same world for the
 * client's purposes — an Apple purchase, managed by Apple, whichever pipe
 * mirrored it. Anything unrecognised returns undefined and the field is simply
 * omitted: a guess here would send someone to the wrong store's manage page.
 */
function blockingProviderOf(
  provider: string | null | undefined,
): "lemonsqueezy" | "revenuecat" | undefined {
  if (provider === "lemonsqueezy") return "lemonsqueezy";
  if (provider === "revenuecat" || provider === "app_store") return "revenuecat";
  return undefined;
}

/**
 * Does THIS subscription row stand in the way of a new recurring purchase?
 *
 * A SEPARATE QUESTION FROM `subscriptionIsLive`, and the separation is the whole
 * point. That predicate answers six billing questions elsewhere — can this trial
 * be converted, which row does the portal link to, what can be cancelled, what
 * can be changed, which subscriptions must be auto-cancelled when a lifetime
 * licence lands — and every one of them means "can Lemon Squeezy still charge
 * this?". None of them is "may this person buy". Widening it would change all six.
 *
 * THE ORDER OF THE FIRST TWO CHECKS IS LOAD-BEARING. A row Lemon Squeezy has
 * finished with blocks nothing, no matter what our own bookkeeping still says
 * about it: an outbox task left over from an old, long-expired subscription is
 * our problem, not a reason to refuse someone's money. Testing the outbox first
 * let a stale task on a dead row lock an entire account out of buying.
 *
 * THE TOMBSTONE ALONE IS NOT ENOUGH to unlock buying, which is the subtle half.
 * It means "this trial's access is revoked locally". It does NOT mean "Lemon
 * Squeezy accepted the cancellation" — on the queued path we write it before the
 * provider has been reached at all. Selling a second subscription while the first
 * is still cancellable-but-not-cancelled is how someone pays twice.
 */
export function blocksNewRecurringCheckout(
  sub: { status: string; trialCancelledAt: Date | null },
  cancellation: CancellationState,
): CheckoutBlockReason | null {
  // Lemon Squeezy is done with this row. Nothing about it can double-bill.
  if (!subscriptionIsLive(sub)) return null;

  // Owed or abandoned work at the provider outranks everything below: until the
  // cancellation is accepted, a second subscription can double-bill.
  if (cancellation === "dead_lettered") return "BILLING_SUPPORT_REQUIRED";
  if (cancellation === "pending") return "CANCELLATION_PENDING";

  // A revoked trial with nothing owed IS a confirmed cancellation — whether the
  // provider answered 200 synchronously (no task was ever created) or the drain
  // settled it later. Neither waits on a webhook.
  if (sub.trialCancelledAt != null) return null;

  // A PAID subscription the customer cancelled, running out its remaining
  // period. Its own code, not `ACTIVE_SUBSCRIPTION`: the actions that help are
  // Resume and Change plan, which is a different screen from "you already have
  // one". Blocking is the existing policy, kept deliberately — quietly selling
  // a second subscription here produces a "charged twice" ticket. Only a trial
  // gets the fast path above, because a trial keeps no period worth protecting.
  if (sub.status === "cancelled") return "CANCELLED_ACCESS_REMAINING";

  return "ACTIVE_SUBSCRIPTION";
}

/**
 * The whole paywall, decided server-side, plan by plan.
 *
 * ONE FUNCTION FOR TWO CALLERS, and that is the point of it existing at all.
 * `GET /api/subscription` renders the paywall from this, and `POST /api/checkout`
 * enforces it from the same call — so the API cannot advertise "you may buy
 * yearly" and then refuse it for a reason the screen never mentioned. A single
 * account-wide verdict could not express this: a customer on a live monthly plan
 * may not buy yearly (Change plan is the route) yet may buy lifetime, and one
 * `canPurchase` boolean has to be wrong about one of them.
 *
 * LIFETIME IS DELIBERATELY NOT GATED BY THE RECURRING RULES. It is not a
 * subscription, so it cannot become a second one, and the webhook cancels any
 * live subscription through the outbox when a lifetime order lands — the saga
 * that already exists. That means lifetime stays purchasable during a pending or
 * dead-lettered recurring cancellation. It is safe for the reason above and NOT
 * by accident: it never touches `blocksNewRecurringCheckout`.
 */
export function planEligibility(input: {
  subs: ReadonlyArray<{
    externalId: string;
    status: string;
    trialCancelledAt: Date | null;
    /** Which store's row — absent means "lemonsqueezy", like SubscriptionLike. */
    provider?: string;
  }>;
  cancellations: ReadonlyMap<string, CancellationState>;
  ownsLifetime: boolean;
  /** Which store sold the lifetime, when `ownsLifetime` — for `blockingProvider`. */
  lifetimeProvider?: string | null;
  deviceHadTrial: boolean;
  trialDays: { monthly: number; yearly: number };
  /**
   * The account's outstanding acquisition, if it has one. Null when nothing is
   * in flight — an expired one counts as nothing, see `outstandingAcquisition`.
   */
  outstanding?: { plan: string; state: string; resumable: boolean; expiresAt?: string } | null;
}): Record<PurchasePlan, PlanEligibility> {
  const blocked = (): { reason: CheckoutBlockReason; row?: { provider?: string } } | null => {
    // The FIRST row per reason wins the attribution: rows arrive most recently
    // updated first, so a tie goes to the one the customer touched last.
    const hits = new Map<CheckoutBlockReason, { provider?: string }>();
    for (const sub of input.subs) {
      const reason = blocksNewRecurringCheckout(
        sub,
        input.cancellations.get(sub.externalId) ?? "none",
      );
      if (reason && !hits.has(reason)) hits.set(reason, sub);
    }
    const reason = BLOCK_SEVERITY.find((r) => hits.has(r));
    return reason ? { reason, row: hits.get(reason) } : null;
  };

  const refuse = (
    reasonCode: CheckoutBlockReason,
    blockingProvider?: "lemonsqueezy" | "revenuecat",
  ): PlanEligibility => ({
    canPurchase: false,
    reasonCode,
    trialMode: "none",
    trialDays: 0,
    ...(blockingProvider ? { blockingProvider } : {}),
  });

  if (input.ownsLifetime) {
    const owned = refuse("LIFETIME_ALREADY_OWNED", blockingProviderOf(input.lifetimeProvider));
    return { monthly: owned, yearly: owned, lifetime: owned };
  }

  // AN OUTSTANDING CHECKOUT OUTRANKS EVERY OTHER ANSWER, lifetime included.
  //
  // Lifetime is exempt from the recurring rules because it cannot become a
  // second subscription — but it can absolutely become a second PAYMENT, and a
  // customer holding a payable monthly link who is also handed a payable
  // lifetime link is the exact failure this whole mechanism exists to stop. So
  // this gate is the one place all three plans are treated identically.
  const held = input.outstanding;
  if (held) {
    if (held.state === "uncertain") {
      // We do not know whether a payable link exists, so we may not create one.
      const until = held.expiresAt;
      const unknown = {
        ...refuse("CHECKOUT_STATE_UNCERTAIN"),
        ...(until ? { blockedUntil: until } : {}),
      };
      return { monthly: unknown, yearly: unknown, lifetime: unknown };
    }
    const until = held.expiresAt;
    const busy = { ...refuse("CHECKOUT_IN_PROGRESS"), ...(until ? { blockedUntil: until } : {}) };
    const resume: PlanEligibility = {
      // TRUE, and deliberately: pressing Buy again returns the SAME link rather
      // than minting a second. The screen offers "finish paying", not "buy".
      canPurchase: true,
      reasonCode: "CHECKOUT_RESUMABLE",
      trialMode: "none",
      trialDays: 0,
    };
    const forPlan = (plan: PurchasePlan): PlanEligibility =>
      held.resumable && held.plan === plan ? resume : busy;
    return {
      monthly: forPlan("monthly"),
      yearly: forPlan("yearly"),
      lifetime: forPlan("lifetime"),
    };
  }

  const lifetime: PlanEligibility = {
    canPurchase: true,
    reasonCode: "ELIGIBLE_WITHOUT_TRIAL",
    trialMode: "none",
    trialDays: 0,
  };

  const block = blocked();
  if (block) {
    // The provider is named only on ACTIVE_SUBSCRIPTION — the one refusal whose
    // remedy differs by store (an Apple plan cannot be changed from here). The
    // checkout-hold and outbox refusals are about OUR bookkeeping, not a row
    // the customer can act on at either store.
    const refusal = refuse(
      block.reason,
      block.reason === "ACTIVE_SUBSCRIPTION"
        ? blockingProviderOf(block.row?.provider ?? "lemonsqueezy")
        : undefined,
    );
    return { monthly: refusal, yearly: refusal, lifetime };
  }

  // The account leg and the device leg, exactly as the checkout computes them:
  // ANY subscription row means the trial is spent, and so does a claim from this
  // machine. Kept here so the paywall and the checkout cannot disagree.
  const spent = input.subs.length > 0 || input.deviceHadTrial;
  const recurring = (days: number): PlanEligibility =>
    spent
      ? { canPurchase: true, reasonCode: "ELIGIBLE_WITHOUT_TRIAL", trialMode: "skip", trialDays: 0 }
      : {
          canPurchase: true,
          reasonCode: "ELIGIBLE_WITH_TRIAL",
          trialMode: "eligible",
          trialDays: days,
        };

  return {
    monthly: recurring(input.trialDays.monthly),
    yearly: recurring(input.trialDays.yearly),
    lifetime,
  };
}

/**
 * Is this subscription CURRENTLY inside a provider trial?
 *
 * The only claim this makes — and the only one the status can support — is that
 * Lemon Squeezy says a trial is running right now. It deliberately says nothing
 * about payment history: `active` does NOT prove money was collected (a 100%
 * discount, a free plan or a manual provider adjustment all produce `active`),
 * and there is no payment ledger here to ask. Anyone needing "has this customer
 * ever paid?" must build that from Purchase/payment records, not from a status.
 *
 * Independent of the tombstone on purpose — see `isLiveUnpaidTrial`. A retry
 * after a first cancellation must still recognise the row AS a trial, or it
 * would reclassify it as a non-trial and report that nothing was revoked.
 */
export function isCurrentTrial(
  sub: { status: string; trialEndsAt: Date | null },
  now: Date = new Date(),
): boolean {
  if (sub.status !== "on_trial") return false;
  return sub.trialEndsAt != null && sub.trialEndsAt.getTime() > now.getTime();
}

/**
 * A trial that is running AND has not yet been cancelled — i.e. one there is
 * still something to revoke for.
 *
 * The tombstone check is what makes the write set-once. Cancelling a trial ends
 * access at once (a trial buys no grace, nobody was charged for it), and this is
 * the single definition of "which rows that applies to" — three writers had
 * three different ones, and the admin path's was the dates alone, which would
 * have tombstoned a customer whose subscription had already left `on_trial`.
 */
export function isLiveUnpaidTrial(
  sub: { status: string; trialEndsAt: Date | null; trialCancelledAt: Date | null },
  now: Date = new Date(),
): boolean {
  return isCurrentTrial(sub, now) && sub.trialCancelledAt == null;
}

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
