/**
 * The entitlement resolver — the single authority on a user's EFFECTIVE access.
 *
 * `computeEntitlement` is a PURE function of the current rows + the server clock,
 * so the webhook path and the refresh path converge regardless of arrival order
 * (CRDT-like). Precedence (first match wins):
 *
 *   revoked (admin) > active purchase > admin comp > active device-trial >
 *   refunded > expired
 *
 * The route layer (src/routes/entitlement.ts) reads the rows, calls this, and
 * writes the denormalized cache back onto User. Keep this file free of I/O so it
 * stays unit-testable.
 */

import type { PlanEligibility, PurchasePlan } from "./subscription";

/*
 * Trial length used to live here as `TRIAL_DAYS`, read by `POST /api/auth/*` to
 * stamp `User.trialEndsAt` at account creation. It moved to `env.trialDays`
 * along with the thing it measures: a trial is now claimed by a MACHINE, and its
 * length is snapshotted onto the `TrialClaim` at claim time so that changing the
 * product's offer never moves the end date of a window someone is inside.
 *
 * A client never computes when a trial ends. It asks.
 */

/**
 * The App Store products, mirrored in the app's src/services/purchase.ts.
 * IMMUTABLE — Apple never lets a Product ID change after creation.
 *
 * THE LIFETIME ID IS `in.welock.app.life`, AND IT IS FINAL. It was written
 * `.lifetime` here while App Store Connect had no product yet and the spelling
 * was still open. The decision is made; the old spelling is DELETED rather than
 * kept as an alias, because no purchase of it exists anywhere in the world —
 * so the only thing recognising it could ever do is admit a product we do not
 * sell. Do not reintroduce it "for compatibility": there is nothing to be
 * compatible with.
 */
export const LIFETIME_PRODUCT_ID = "in.welock.app.life";
export const TRIAL_PRODUCT_ID = "in.welock.app.trial14";

/**
 * The allow-list of the legacy StoreKit-JWS route (`POST /api/purchases`):
 * every Apple product a signed transaction may name. Anything else is
 * TRANSACTION_UNKNOWN_PRODUCT — a valid Apple signature proves where a
 * transaction came from, never that it is for something we sell.
 *
 * A named predicate rather than two comparisons inside the route, so the rule
 * can be exercised without forging Apple's signature (which is precisely what
 * the verifier exists to make impossible).
 */
export function isSellableProductId(productId: string): boolean {
  return productId === TRIAL_PRODUCT_ID || productId === LIFETIME_PRODUCT_ID;
}

/**
 * Legacy plan WORDS, kept only because `purchaseEffect` still names its verdict
 * with them (and a test pins that contract). They are NOT what `User.plan`
 * holds any more: that column carries the resolver's own status vocabulary —
 * "trialing" | "active" | "expired" | "refunded" | "comped" | "revoked" —
 * written by its ONE writer, `resolveAndCache` (routes/entitlement.ts), as a
 * denormalized cache for the admin console and `GET /api/me`. Never the
 * authority: every access decision comes from the `Purchase`/`Subscription`
 * rows and the `TrialClaim` ledger. Do not gate on it, and do not write it
 * anywhere else — a mirror with two writers is worse than no mirror.
 */
export const PLAN = {
  trial: "trial",
  lifetime: "lifetime",
  refunded: "refunded",
} as const;

/** `Purchase.provider` / `Purchase.store` for anything bought through StoreKit.
 *  `@@unique([provider, externalId])` is what makes a replayed transaction a
 *  no-op, so these strings are part of the idempotency key — never change them. */
export const APP_STORE = "app_store";

export type EntitlementStatus =
  | "trialing"
  | "active"
  | "expired"
  | "refunded"
  | "comped"
  | "revoked";

/**
 * The two billing worlds a customer can live in, plus "neither". The client's
 * vocabulary, not the database's: rows spell providers "lemonsqueezy" /
 * "revenuecat" / "app_store", and the view collapses them to the question the
 * UI actually asks — is your money with Apple, or with our web storefront?
 */
export type BillingProvider = "APPLE" | "LEMON_SQUEEZY" | "NONE";

/**
 * A stored provider string → the world it belongs to, or null when we cannot
 * say. ONE mapping, shared by every field that speaks the client's vocabulary
 * (`billingProvider`, `manageableSubscription.provider`), because two copies of
 * "app_store means Apple" is one copy too many.
 *
 * `app_store` and `revenuecat` both map to APPLE: they are two pipes for the
 * same store — the legacy StoreKit-JWS route and the RevenueCat mirror — and
 * the client can act identically on either (send the customer to Apple).
 */
export function billingProviderFor(
  provider: string | null | undefined,
): "APPLE" | "LEMON_SQUEEZY" | null {
  if (provider === "app_store" || provider === "revenuecat") return "APPLE";
  if (provider === "lemonsqueezy") return "LEMON_SQUEEZY";
  return null;
}

/** The exact wire shape of `GET /api/entitlement`. */
export interface EntitlementView {
  status: EntitlementStatus;
  isPro: boolean;
  trialEndsAt: string | null; // ISO, server clock — or null if no device trial
  serverTime: string; // ISO — the client MUST anchor its countdown to this, not Date.now()
  trialDurationDays: number;
  productId: string;
  canStartTrial: boolean;
  /**
   * ENTITLEMENT_ENFORCED, echoed verbatim. The server ALWAYS reports the true
   * status above; this is the master switch that tells the client whether it may
   * hard-gate on it yet. Echoing it is the switch's only server-side effect — if
   * nothing published it, flipping the env var would do nothing at all.
   */
  enforced: boolean;
  /**
   * The signed, self-contained, time-bounded copy of everything above.
   *
   * Null when the deploy has no signing key. A client MUST treat null as "no
   * receipt available" and fall back to the fields above — never as a refusal,
   * or a deploy without the key would lock out everyone at once.
   *
   * It is what a client caches for offline use: the plain fields are advice a
   * patched binary can rewrite, this is the part it cannot.
   */
  receipt?: string | null;
  /**
   * WHICH plan grants, for the client's plan-aware copy: "lifetime" outranks a
   * subscription's interval, and null means the access (if any) comes from
   * something planless — a comp, a machine trial — or from a subscription row
   * whose interval we never learned. Optional so the field can appear on a
   * deploy before every client understands it; a client MUST treat absence
   * and null the same way.
   */
  plan?: "monthly" | "yearly" | "lifetime" | null;
  /**
   * The end of the period the GRANTING subscription has paid for (ISO), or
   * null when nothing time-bounded grants — a lifetime has no end, and a
   * machine trial's window is already `trialEndsAt`. The client renders "renews
   * on" / "access until" from this, never computes it.
   */
  validUntil?: string | null;
  /**
   * Where this account should be sent to deal with money, or null when we do
   * not know and the client should offer the plan picker instead.
   *
   * Lemon Squeezy mints a per-customer portal URL and refreshes it on every
   * webhook (it is signed with an expiry). For anyone who already has a card on
   * file it IS the right page — paying early, changing plan, updating the card
   * and cancelling all live there, and none of them are a new checkout. Sending
   * a trialing subscriber to a fresh checkout instead would sell them a SECOND
   * subscription.
   *
   * Unsigned, unlike the receipt, and that is fine: it is a destination, not a
   * verdict. The worst a tampered value does is send its own owner somewhere
   * useless.
   */
  billingUrl?: string | null;
  /**
   * Has this account EVER held access — a purchase, a subscription, or a trial
   * window that was actually claimed?
   *
   * Only the paywall's copy reads it, and only to avoid a lie. Someone who has
   * just finished signing up has no plan, so the same `expired` status that
   * describes a lapsed customer also describes them — and telling a brand-new
   * user "your access has ended" is both false and the worst possible first
   * sentence. False in the other direction is merely a missed nuance, which is
   * why this defaults to false when we cannot tell.
   */
  everHadAccess?: boolean;
  /**
   * WHOSE money grants the access, in the client's two-world vocabulary: the
   * granting lifetime Purchase's provider first (a lifetime outranks any
   * subscription, mirroring the resolver's own precedence), else the granting
   * subscription's, else "NONE" — which is also what a comp or a machine trial
   * reports, because no store is billing them.
   *
   * ALL of the fields from here down are optional and additive: absence means
   * "a deploy from before this existed", and a client MUST behave exactly as it
   * did pre-feature when they are missing.
   */
  billingProvider?: BillingProvider;
  /**
   * The live RECURRING subscription and where it gets managed — REGARDLESS of
   * whether it is the thing granting access. The case that makes "regardless"
   * load-bearing: a lifetime owner whose old monthly plan is still renewing
   * (spec N2). The lifetime grants, so no granting-subscription field would
   * ever mention the monthly — yet it is the one thing on the account that
   * still takes money every month, and hiding it is how someone pays for a
   * product they already own for ever.
   *
   * `managementUrl` is the row's stored portal link: Lemon Squeezy's last-known
   * signed URL (possibly expired — GET /api/subscription/portal fetches a fresh
   * one), or the RevenueCat management_url the sync persists (Apple's page,
   * unsigned, does not expire). Null when we have no link; the row itself is
   * still reported so the client can at least SAY a subscription exists.
   */
  manageableSubscription?: {
    provider: "APPLE" | "LEMON_SQUEEZY";
    managementUrl: string | null;
  } | null;
  /**
   * Will the entitlement-driving subscription charge again? False is the N13
   * state — cancelled-but-still-active, "stays on until {date}, then stops" —
   * which is exactly the sentence the client needs this field to render. Null
   * when no recurring subscription is granting (lifetime, comp, trial, or
   * nothing): there is no renewal to have an opinion about.
   *
   * RevenueCat rows carry the answer as a column (auto-renew state); Lemon
   * Squeezy expresses the same fact as status "cancelled"/"expired" — its
   * webhook mirrors `cancelled` INTO the status, so the status is the truth.
   */
  willRenew?: boolean | null;
  /**
   * The same per-plan verdicts GET /api/subscription serves, from the same
   * inputs (lib/eligibility-io.ts) — so the paywall a client draws from its
   * cached entitlement can never advertise a purchase the checkout refuses.
   */
  purchaseEligibility?: Record<PurchasePlan, PlanEligibility>;
}

export interface EntitlementInputs {
  now: Date;
  hasActivePurchase: boolean; // a non-refunded Purchase exists (the LIFETIME leg)
  hasRefundedPurchase: boolean; // a refunded Purchase exists
  /**
   * A Lemon Squeezy subscription that still grants — see lib/subscription.ts,
   * which is the only place that decides what "still grants" means.
   *
   * Separate from `hasActivePurchase` because the two are different shapes, not
   * two names for one thing: a purchase is a fact that happened once, a
   * subscription is a state that moves. Merging them at the input would hide
   * which one a customer actually has, exactly when support needs to know.
   */
  hasActiveSubscription: boolean;
  /** On trial with Lemon Squeezy, so the UI can say so rather than "active". */
  subscriptionOnTrial: boolean;
  compActive: boolean; // caller pre-computes: compActive && (compedUntil == null || compedUntil > now)
  accessRevoked: boolean; // admin hard kill
  trialEndsAt: Date | null; // from the device's TrialClaim (null if none)
  hasTrialClaim: boolean; // a TrialClaim exists for this device
  trialDurationDays: number;
  productId: string;
  enforced?: boolean; // ENTITLEMENT_ENFORCED — echoed only, never affects the status
}

export function computeEntitlement(input: EntitlementInputs): EntitlementView {
  const trialActive =
    input.trialEndsAt != null && input.trialEndsAt.getTime() > input.now.getTime();

  let status: EntitlementStatus;
  let isPro: boolean;
  if (input.accessRevoked) {
    status = "revoked";
    isPro = false;
  } else if (input.hasActivePurchase) {
    status = "active";
    isPro = true;
  } else if (input.hasActiveSubscription) {
    // Ranked immediately after the lifetime purchase and BEFORE the comp: someone
    // who is paying us every month should read as a customer, not as a charity
    // case, and support looking at the row should see the money.
    //
    // `trialing` when Lemon Squeezy says on_trial, because the client draws a
    // countdown from it — and a paying customer shown a trial countdown is a
    // support ticket.
    status = input.subscriptionOnTrial ? "trialing" : "active";
    isPro = true;
  } else if (input.compActive) {
    status = "comped";
    isPro = true;
  } else if (trialActive) {
    status = "trialing";
    isPro = true;
  } else if (input.hasRefundedPurchase) {
    status = "refunded";
    isPro = false;
  } else {
    status = "expired";
    isPro = false;
  }

  // A device may start a trial only if it has never claimed one and the user has
  // no other access/refund history (a refunded or revoked user can't farm a fresh
  // trial by clearing their claim).
  const canStartTrial =
    !input.hasTrialClaim &&
    !isPro &&
    !input.accessRevoked &&
    !input.hasRefundedPurchase &&
    !input.hasActivePurchase &&
    // Someone who has ever subscribed does not also get the machine's free
    // window: the subscription's OWN trial is the one they were offered.
    !input.hasActiveSubscription;

  return {
    status,
    isPro,
    trialEndsAt: input.trialEndsAt ? input.trialEndsAt.toISOString() : null,
    serverTime: input.now.toISOString(),
    trialDurationDays: input.trialDurationDays,
    productId: input.productId,
    canStartTrial,
    enforced: input.enforced === true,
  };
}

/* ── what a verified purchase changes ────────────────────────── */

const DAY_MS = 24 * 60 * 60 * 1000;

export type PurchaseFacts = {
  productId: string;
  /** Apple's clock, ms epoch. Never the phone's. */
  purchaseDate: number;
  revoked: boolean;
};

export type PurchaseEffect =
  /** The lifetime unlock. Recorded as a `Purchase` row; `refunded` mirrors Apple's
   *  revocation, and the resolver ranks an active purchase above a refunded one. */
  | { kind: "lifetime"; refunded: boolean; plan: string }
  /** The Tier-0 trial. Becomes a `TrialClaim`; the window comes from APPLE's
   *  purchase date, so a phone with a wound-forward clock gains nothing. */
  | { kind: "trial"; startedAt: Date; endsAt: Date }
  /** A product we do not sell, or a revoked trial — record nothing at all. */
  | { kind: "ignored" };

/**
 * The ONLY place that decides what a verified transaction means. Pure, so the
 * rules that protect revenue are testable without forging an Apple signature.
 *
 * Note what is NOT here any more: "create-only". That rule used to live in this
 * function as `current.trialEndsAt != null` — a check-then-act that two
 * concurrent requests could both pass. It is now enforced by the unique indexes
 * on `TrialClaim.appleOriginalTxHash` and `TrialClaim.deviceIdHash`, which the
 * database applies atomically. A replayed transaction hits a duplicate key and is
 * dropped; it can never buy a second window.
 */
export function purchaseEffect(facts: PurchaseFacts, trialDays: number): PurchaseEffect {
  if (facts.productId === LIFETIME_PRODUCT_ID) {
    return {
      kind: "lifetime",
      refunded: facts.revoked,
      plan: facts.revoked ? PLAN.refunded : PLAN.lifetime,
    };
  }
  if (facts.productId !== TRIAL_PRODUCT_ID) return { kind: "ignored" };
  // A refunded/revoked trial grants nothing — and must not create a claim either,
  // or the user would be barred from the trial they never actually got.
  if (facts.revoked) return { kind: "ignored" };
  return {
    kind: "trial",
    startedAt: new Date(facts.purchaseDate),
    endsAt: new Date(facts.purchaseDate + trialDays * DAY_MS),
  };
}

/**
 * Which trial window governs — and this is the hinge the whole anti-abuse turns on.
 *
 * `User.trialEndsAt` is stamped at REGISTRATION (auth.ts), so it is a trial per
 * ACCOUNT: sign out, register another email, and it hands over 14 fresh days for
 * ever. The ledger exists precisely to close that. So the precedence is:
 *
 *   · a ledger claim reachable from this device or this account WINS, even when
 *     it is long elapsed — that is what makes a second account on the same phone
 *     inherit the first one's spent window instead of minting a new one;
 *   · only when the ledger has never heard of this device or this account do we
 *     fall back to the legacy stamp, which grandfathers everyone who signed up
 *     before the ledger existed.
 *
 * Reversing those two lines silently reopens the farm, which is why this is a
 * named function with a test rather than a `??` buried in the route.
 */
export function effectiveTrialEndsAt(
  claimEndsAt: Date | null,
  legacyTrialEndsAt: Date | null,
): Date | null {
  return claimEndsAt ?? legacyTrialEndsAt;
}
