import { prisma } from "./prisma";
import { env } from "./env";

/**
 * RevenueCat — the iOS purchase path (StoreKit, via RevenueCat's plumbing).
 *
 * THE ONE DESIGN DECISION EVERYTHING BELOW FOLLOWS FROM: state comes from a
 * full re-fetch of the subscriber, never from a webhook payload. A RevenueCat
 * event says "something changed for this app_user_id"; what the subscriber's
 * state now IS is answered by GET /v1/subscribers, which returns everything.
 * That is what makes out-of-order and duplicate deliveries converge for free —
 * every event, whatever it says, ends in the same authoritative snapshot being
 * mirrored. It is the same shape as Lemon Squeezy's "mirror what arrived"
 * principle, one step stronger: we mirror what IS.
 *
 * The module is split the way lib/lemonsqueezy.ts is: `fetchSubscriber` talks
 * to the network, `projectSubscriber` is PURE (subscriber JSON in, write plan
 * out) so the revenue rules are testable without a server, and
 * `syncUserFromRevenueCat` is the thin I/O glue the webhook and the refresh
 * route both call — two activation paths writing the same rows the same way.
 */

export const RC_PROVIDER = "revenuecat";

/** The App Store subscription products, mirrored in the app. IMMUTABLE —
 *  Apple never lets a Product ID change after creation. */
export const RC_PRODUCT_MONTHLY = "in.welock.app.monthly";
export const RC_PRODUCT_YEARLY = "in.welock.app.yearly";
/**
 * The lifetime product — BOTH spellings, deliberately. The App Store Connect
 * product does not exist yet and the final id is still ambiguous between
 * `.life` and `.lifetime`, so both are recognised: whichever ships is honoured,
 * and the other simply never appears in a subscriber. Trim this to one entry
 * once ASC has made the decision permanent.
 */
export const RC_LIFETIME_PRODUCT_IDS = ["in.welock.app.life", "in.welock.app.lifetime"] as const;

export const RC_SUBSCRIPTION_PRODUCT_IDS = [RC_PRODUCT_MONTHLY, RC_PRODUCT_YEARLY] as const;

/** Every product id the webhook lets through its allow-list. */
export const RC_KNOWN_PRODUCT_IDS: readonly string[] = [
  ...RC_SUBSCRIPTION_PRODUCT_IDS,
  ...RC_LIFETIME_PRODUCT_IDS,
];

/* ── the subscriber, as RevenueCat describes it ─────────────────────────── */

/** The shape we rely on. Everything optional: this is someone else's payload. */
export type RcSubscriptionState = {
  expires_date?: string | null;
  purchase_date?: string | null;
  /** "normal" | "trial" | "intro" */
  period_type?: string;
  store?: string;
  is_sandbox?: boolean;
  unsubscribe_detected_at?: string | null;
  billing_issues_detected_at?: string | null;
  refunded_at?: string | null;
  grace_period_expires_date?: string | null;
};

export type RcNonSubscription = {
  id?: string;
  purchase_date?: string;
  store?: string;
  is_sandbox?: boolean;
  /** Not documented on this object today — read defensively if it ever appears. */
  refunded_at?: string | null;
  is_refunded?: boolean;
};

export type RcEntitlement = {
  expires_date?: string | null;
  purchase_date?: string | null;
  product_identifier?: string;
};

export type RcSubscriber = {
  subscriptions?: Record<string, RcSubscriptionState>;
  non_subscriptions?: Record<string, RcNonSubscription[]>;
  entitlements?: Record<string, RcEntitlement>;
  management_url?: string | null;
  original_app_user_id?: string;
};

/* ── talking to RevenueCat ──────────────────────────────────────────────── */

/**
 * "RevenueCat is down" and "RevenueCat refused us" are DIFFERENT failures from
 * "this subscriber has nothing", and the webhook's retry story depends on
 * telling them apart: an API failure must mark the event `failed` and answer
 * 500 so RevenueCat redelivers, while an empty subscriber is a fact to mirror.
 * A typed error is what lets the caller make that distinction without string
 * matching.
 */
export class RevenueCatApiError extends Error {
  constructor(
    message: string,
    /** HTTP status RevenueCat answered with, when there was an answer at all. */
    readonly status?: number,
  ) {
    super(message);
    this.name = "RevenueCatApiError";
  }
}

/**
 * Fetch the authoritative state of one subscriber.
 *
 * A 404 is answered as an EMPTY subscriber rather than an error, and that is a
 * judgement call worth writing down: RevenueCat creates subscribers on first
 * contact, so a genuinely unknown app_user_id is near-impossible — but if one
 * ever arrives, "this identity has no purchases" is exactly what an empty
 * subscriber means, and mirroring nothing is the correct, convergent outcome.
 * Treating it as a failure would park the event as `failed` forever over an
 * identity that will never have anything to say.
 *
 * Never logs or rethrows response bodies wholesale, and never echoes the
 * request (it carried the secret key).
 */
export async function fetchSubscriber(appUserId: string): Promise<RcSubscriber> {
  if (!env.revenuecatSecretApiKey) {
    throw new RevenueCatApiError("RevenueCat is not configured");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  let response: Response;
  try {
    response = await fetch(
      `${env.revenuecatApiBase}/v1/subscribers/${encodeURIComponent(appUserId)}`,
      {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${env.revenuecatSecretApiKey}`,
        },
        signal: controller.signal,
      },
    );
  } catch (e) {
    throw new RevenueCatApiError(
      `RevenueCat is unreachable: ${e instanceof Error ? e.message : "network error"}`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 404) return {};
  if (!response.ok) {
    throw new RevenueCatApiError(`RevenueCat answered HTTP ${response.status}`, response.status);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new RevenueCatApiError("RevenueCat answered a body that is not JSON", response.status);
  }
  // The v1 API wraps the object: { request_date, subscriber: {...} }. Parsed
  // defensively — a missing wrapper degrades to an empty subscriber, which
  // mirrors nothing rather than throwing inside the write loop.
  const subscriber = (body as { subscriber?: RcSubscriber } | null)?.subscriber;
  return subscriber && typeof subscriber === "object" ? subscriber : {};
}

/* ── the pure projection: subscriber JSON → write plan ──────────────────── */

/** A timestamp we cannot parse must become null, never an Invalid Date —
 *  Prisma throws on those, and a throw here turns a sync into a retry loop. */
function parseDate(value: unknown): Date | null {
  if (typeof value !== "string" || !value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** The later of the two ends: a grace period extends the paid window. */
function effectiveEnd(expires: Date | null, grace: Date | null): Date | null {
  if (expires && grace) return grace.getTime() > expires.getTime() ? grace : expires;
  return expires ?? grace;
}

export type RcSubscriptionWrite = {
  externalId: string;
  /** Everything except userId/provider/externalId — create and update share it,
   *  and ownership (userId) is decided at create only, like every other row. */
  data: {
    variantId: string;
    interval: string | null;
    status: string;
    validUntil: Date | null;
    trialEndsAt: Date | null;
    renewsAt: Date | null;
    willRenew: boolean;
    environment: string;
    entitlementId: string | null;
    periodType: string | null;
    unsubscribeDetectedAt: Date | null;
    billingIssueDetectedAt: Date | null;
    refundedAt: Date | null;
    revokedAt: Date | null;
    testMode: boolean | undefined;
    providerUpdatedAt: Date;
    appUserId: string;
    originalAppUserId: string | null;
  };
};

export type RcPurchaseWrite = {
  externalId: string;
  data: {
    store: string;
    productId: string;
    purchasedAt: Date;
    isRefunded: boolean;
    revokedAt: Date | null;
    environment: string;
    testMode: boolean | undefined;
  };
};

export type RcWritePlan = {
  subscriptions: RcSubscriptionWrite[];
  purchases: RcPurchaseWrite[];
  managementUrl: string | null;
};

/**
 * Map RevenueCat's per-subscription facts onto the status vocabulary the
 * resolver already reads (lib/subscription.ts) — Lemon Squeezy's words, since
 * that is what `subscriptionGrants` was built around.
 *
 * ⚠️ 'cancelled' IS NEVER WRITTEN, AND THAT IS THE MOST IMPORTANT LINE OF THIS
 * FILE. `subscriptionGrants` carries a rule made for Lemon Squeezy: status
 * 'cancelled' with a trialEndsAt still in the future grants NOTHING, because a
 * cancelled LS trial is genuinely over. Apple's semantics are the opposite —
 * turning off auto-renew (RevenueCat's `unsubscribe_detected_at`), even during
 * a trial, keeps access until `expires_date`; Apple has already promised the
 * customer that window and there is no way to end it early. Writing
 * 'cancelled' on an RC row would trip the LS rule and cut off every trialist
 * the moment they toggled auto-renew — so cancellation is expressed ONLY as
 * `willRenew: false`, and the status stays whatever the access truth is
 * (on_trial/active until the window ends, expired after).
 *
 * CANCELLATION ≠ EXPIRATION. The mapping, first match wins:
 *
 *   refunded            → 'expired' (+ refundedAt/revokedAt — access was taken
 *                          back, not merely run out)
 *   window already over → 'expired' (the window is expires_date, extended by
 *                          a later grace_period_expires_date)
 *   billing issue with a live grace period
 *                       → 'past_due' (validUntil = the grace end: the card
 *                          failed, Apple is retrying, access continues)
 *   period_type 'trial' → 'on_trial'
 *   otherwise           → 'active'
 */
export function statusForSubscription(
  sub: RcSubscriptionState,
  now: Date,
): {
  status: "expired" | "past_due" | "on_trial" | "active";
  validUntil: Date | null;
  refundedAt: Date | null;
} {
  const refundedAt = parseDate(sub.refunded_at);
  const expires = parseDate(sub.expires_date);
  const grace = parseDate(sub.grace_period_expires_date);
  const until = effectiveEnd(expires, grace);

  if (refundedAt) return { status: "expired", validUntil: until, refundedAt };
  if (until != null && until.getTime() <= now.getTime()) {
    return { status: "expired", validUntil: until, refundedAt: null };
  }
  if (parseDate(sub.billing_issues_detected_at) && grace && grace.getTime() > now.getTime()) {
    return { status: "past_due", validUntil: grace, refundedAt: null };
  }
  if (sub.period_type === "trial") return { status: "on_trial", validUntil: until, refundedAt: null };
  return { status: "active", validUntil: until, refundedAt: null };
}

/**
 * `testMode` for a row RevenueCat described.
 *
 * `true` when RevenueCat says sandbox, EXPLICITLY `false` when it says
 * production, and untouched when it says nothing. The explicit false is
 * deliberate and protects a real customer: a TestFlight tester who later BUYS
 * the same product lands on the same (userId, productId) row, and leaving the
 * old `testMode: true` in place would hide their paid subscription behind the
 * sandbox gate forever. `undefined` (field absent in the payload) writes
 * nothing, so a defensive fetch cannot flip a flag it knows nothing about.
 */
function testModeFor(isSandbox: boolean | undefined): boolean | undefined {
  if (isSandbox === true) return true;
  if (isSandbox === false) return false;
  return undefined;
}

/** Which entitlement (if any) names this product — informative, never gating. */
function entitlementFor(subscriber: RcSubscriber, productId: string): string | null {
  for (const [key, ent] of Object.entries(subscriber.entitlements ?? {})) {
    if (ent && ent.product_identifier === productId) return key;
  }
  return null;
}

/**
 * PURE: one subscriber snapshot → the exact rows to upsert. All the revenue
 * rules live here, where a test can exercise them without a network or a
 * database. Products we do not sell are ignored, never guessed at.
 */
export function projectSubscriber(userId: string, subscriber: RcSubscriber, now: Date): RcWritePlan {
  const subscriptions: RcSubscriptionWrite[] = [];
  const purchases: RcPurchaseWrite[] = [];

  for (const [productId, sub] of Object.entries(subscriber.subscriptions ?? {})) {
    if (!sub || typeof sub !== "object") continue;
    if (!(RC_SUBSCRIPTION_PRODUCT_IDS as readonly string[]).includes(productId)) continue;

    const { status, validUntil, refundedAt } = statusForSubscription(sub, now);
    // Auto-renew is ON until RevenueCat has detected otherwise. Never a reason
    // to change `status` — see statusForSubscription's warning.
    const willRenew = sub.unsubscribe_detected_at == null;

    subscriptions.push({
      // Keyed on (userId, productId) rather than a transaction id: the
      // subscriber endpoint states each product once, and a renewal must land
      // on the SAME row rather than minting a history of them.
      externalId: `${userId}:${productId}`,
      data: {
        variantId: productId,
        interval: productId === RC_PRODUCT_MONTHLY ? "monthly" : "yearly",
        status,
        validUntil,
        // Only while the trial is what is running: an old trial date on a row
        // that has long since converted is support noise at best, and it is
        // load-bearing to `subscriptionGrants`' cancelled-trial rule (which an
        // RC row can never trip, but why carry the bait).
        trialEndsAt: status === "on_trial" ? validUntil : null,
        // The next charge — only meaningful while one is actually coming.
        renewsAt: status === "active" && willRenew ? validUntil : null,
        willRenew,
        environment: sub.is_sandbox === true ? "sandbox" : "production",
        entitlementId: entitlementFor(subscriber, productId),
        periodType: typeof sub.period_type === "string" ? sub.period_type : null,
        unsubscribeDetectedAt: parseDate(sub.unsubscribe_detected_at),
        billingIssueDetectedAt: parseDate(sub.billing_issues_detected_at),
        refundedAt,
        // A refund is access taken BACK, not run out — the distinction support
        // needs when the customer writes in.
        revokedAt: refundedAt,
        testMode: testModeFor(sub.is_sandbox),
        // OUR fetch clock, not an upstream stamp: the row is only ever written
        // from a full re-fetch, so "when we last asked" is the ordering.
        providerUpdatedAt: now,
        appUserId: userId,
        originalAppUserId:
          typeof subscriber.original_app_user_id === "string"
            ? subscriber.original_app_user_id
            : null,
      },
    });
  }

  for (const [productId, entries] of Object.entries(subscriber.non_subscriptions ?? {})) {
    if (!(RC_LIFETIME_PRODUCT_IDS as readonly string[]).includes(productId)) continue;
    if (!Array.isArray(entries) || entries.length === 0) continue;
    // The LAST entry is the most recent purchase of this product; one row per
    // (user, product) mirrors the subscription key shape, so a re-buy after a
    // refund updates the same row back to granting.
    const latest = entries[entries.length - 1];
    if (!latest || typeof latest !== "object") continue;

    // The subscriber's non_subscriptions entry does not carry refund state in
    // the v1 API today; read it defensively if it ever appears, and fall back
    // to the entitlements object — a refunded lifetime disappears from there.
    // The fallback only fires when entitlements are ACTUALLY REPORTED (the
    // object is non-empty): inferring "refunded" from an absent object would
    // revoke every paying customer the day a defensive fetch came back thin,
    // and a wrongly-kept licence is recoverable where a wrongly-revoked
    // customer is a support ticket.
    // …and only when no live subscription of ours could be the thing
    // legitimately occupying the entitlement slot instead: an entitlement names
    // ONE product_identifier, so a customer holding both a live monthly and a
    // lifetime would show the monthly there — which says nothing about the
    // lifetime. The moment that subscription lapses, a genuinely refunded
    // lifetime stops being masked and the next sync records it. Convergent,
    // and every ambiguous state fails toward access.
    const refundedAt = parseDate(latest.refunded_at);
    const entitlementsReported = Object.keys(subscriber.entitlements ?? {}).length > 0;
    const liveSubElsewhere = Object.entries(subscriber.subscriptions ?? {}).some(
      ([pid, s]) =>
        (RC_SUBSCRIPTION_PRODUCT_IDS as readonly string[]).includes(pid) &&
        s != null &&
        typeof s === "object" &&
        statusForSubscription(s, now).status !== "expired",
    );
    const droppedFromEntitlements =
      entitlementsReported && entitlementFor(subscriber, productId) == null && !liveSubElsewhere;
    const isRefunded = latest.is_refunded === true || refundedAt != null || droppedFromEntitlements;

    purchases.push({
      externalId: `${userId}:${productId}`,
      data: {
        store: "app_store",
        productId,
        purchasedAt: parseDate(latest.purchase_date) ?? now,
        isRefunded,
        revokedAt: isRefunded ? (refundedAt ?? now) : null,
        environment: latest.is_sandbox === true ? "sandbox" : "production",
        testMode: testModeFor(latest.is_sandbox),
      },
    });
  }

  return {
    subscriptions,
    purchases,
    managementUrl:
      typeof subscriber.management_url === "string" && subscriber.management_url
        ? subscriber.management_url
        : null,
  };
}

/* ── the I/O glue both entry points share ───────────────────────────────── */

/**
 * Fetch → project → upsert. The ONE writer for RevenueCat state, shared by the
 * webhook and by POST /api/billing/revenuecat/refresh for the same reason the
 * Lemon Squeezy webhook and /confirm share `mirrorSubscriptionState`: two
 * activation paths writing the same rows must write them the same way.
 *
 * Last-writer-wins ON PURPOSE, where the Lemon Squeezy mirror needs a
 * staleness guard: LS events each carry a partial past, so an old retry could
 * resurrect a dead state — but every write here comes from a fresh fetch of
 * the CURRENT state, so the newest write is by definition the truest.
 *
 * `userId` appears only in `create`: ownership is decided once, and a later
 * sync can never MOVE a row to another account — same rule as every other
 * billing writer in this repo.
 */
export async function syncUserFromRevenueCat(userId: string): Promise<{ managementUrl: string | null }> {
  const subscriber = await fetchSubscriber(userId);
  const plan = projectSubscriber(userId, subscriber, new Date());

  for (const sub of plan.subscriptions) {
    await prisma.subscription.upsert({
      where: { provider_externalId: { provider: RC_PROVIDER, externalId: sub.externalId } },
      create: { userId, provider: RC_PROVIDER, externalId: sub.externalId, ...sub.data },
      update: sub.data,
    });
  }
  for (const purchase of plan.purchases) {
    await prisma.purchase.upsert({
      where: { provider_externalId: { provider: RC_PROVIDER, externalId: purchase.externalId } },
      create: { userId, provider: RC_PROVIDER, externalId: purchase.externalId, ...purchase.data },
      update: purchase.data,
    });
  }

  return { managementUrl: plan.managementUrl };
}
