/**
 * The ONE place the purchase-eligibility INPUTS are assembled.
 *
 * `planEligibility` (lib/subscription.ts) is already the one DECISION shared by
 * the paywall and the checkout — but each caller used to assemble its inputs by
 * hand, and the copies drifted exactly the way copies do: `GET /api/subscription`
 * read Lemon Squeezy rows only, so an Apple subscriber was told monthly was
 * purchasable and then 409'd at checkout, which reads all providers. A shared
 * rule fed different facts is not a shared rule.
 *
 * So the reads live here, once:
 *
 *   · every Subscription row, ALL providers, under the caller's test-row gate,
 *     with the full `SubscriptionLike` select — a missing column silently
 *     disables a security rule, see lib/subscription.ts;
 *   · the non-refunded lifetime Purchase (any provider), WITH its provider so a
 *     refusal can say which store already owns this account;
 *   · the device leg of the one-trial rule — this machine's TrialClaim, keyed
 *     only on a device id we may trust (`isReliableDeviceId` fails OPEN: an
 *     unidentifiable machine falls back to the account leg, never a refusal);
 *   · how far each row's cancellation got at the provider (the outbox);
 *   · the account's outstanding checkout, if one is still holding the lock.
 *
 * `purchaseEligibilityFrom` then feeds them to `planEligibility` with the
 * deploy's trial-day configuration, so POST /api/checkout, GET /api/subscription
 * and the entitlement resolver cannot disagree about who may buy what.
 */
import { prisma } from "./prisma";
import { env } from "./env";
import { ledgerHash } from "./hash";
import { isReliableDeviceId } from "./device";
import { cancellationStates } from "./billing-tasks";
import { outstandingAcquisition, type IntentRow } from "./checkout-intent";
import {
  hideTestRowsFor,
  planEligibility,
  type CancellationState,
  type PlanEligibility,
  type PurchasePlan,
} from "./subscription";

/**
 * Every column any consumer reads off a subscription row — the union of the
 * three call sites' historical selects, kept as ONE constant so a rule that
 * needs a new column adds it for everyone at once.
 *
 * The `SubscriptionLike` fields are all here and all load-bearing (provider
 * included: this is a MIXED-provider query, and without it the Lemon Squeezy
 * variant allowlist would judge Apple product ids it can never contain). The
 * rest are what the display surfaces render: `interval`/`renewsAt`/`endsAt` for
 * GET /api/subscription, `willRenew` and the portal URLs for the entitlement
 * view's provider-aware fields.
 */
export const ELIGIBILITY_SUBSCRIPTION_SELECT = {
  externalId: true,
  status: true,
  interval: true,
  validUntil: true,
  trialEndsAt: true,
  renewsAt: true,
  endsAt: true,
  trialCancelledAt: true,
  pauseMode: true,
  provider: true,
  variantId: true,
  providerUpdatedAt: true,
  createdAt: true,
  updatedAt: true,
  willRenew: true,
  customerPortalUrl: true,
  updatePaymentUrl: true,
} as const;

/** One subscription row as this module hands it out. */
export type EligibilitySubscription = {
  externalId: string;
  status: string;
  interval: string | null;
  validUntil: Date | null;
  trialEndsAt: Date | null;
  renewsAt: Date | null;
  endsAt: Date | null;
  trialCancelledAt: Date | null;
  pauseMode: string | null;
  provider: string;
  variantId: string;
  providerUpdatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  willRenew: boolean | null;
  customerPortalUrl: string | null;
  updatePaymentUrl: string | null;
};

export type EligibilityInputs = {
  /** All providers' rows, most recently updated first. */
  subs: EligibilitySubscription[];
  /** The non-refunded lifetime, if one exists — with WHICH store sold it. */
  ownedLifetime: { id: string; provider: string } | null;
  /** This machine's trial claim — null when the device id was unusable. */
  deviceClaim: { id: string } | null;
  /** Per-row: how far a cancellation got at the provider (the outbox). */
  cancellations: Map<string, CancellationState>;
  /** The acquisition still holding this account's lock, if any. */
  outstanding: IntentRow | null;
};

/**
 * Read everything `planEligibility` needs about one account, exactly once.
 *
 * Takes the RAW device id (as `readDeviceId` returns it) and applies the
 * reliability gate itself, so no caller can accidentally key the per-machine
 * ledger on the shared "unidentified" fallback — one machine would burn the
 * trial for every unidentifiable machine in the world.
 */
export async function loadEligibilityInputs(
  userId: string,
  rawDeviceId: string,
): Promise<EligibilityInputs> {
  const deviceId = isReliableDeviceId(rawDeviceId) ? rawDeviceId : "";

  const [subs, ownedLifetime] = await Promise.all([
    prisma.subscription.findMany({
      // Test rows stop existing for eligibility the moment their provider's
      // test mode is shut — the same gate every other billing read applies.
      where: { userId, ...hideTestRowsFor(userId, env) },
      select: ELIGIBILITY_SUBSCRIPTION_SELECT,
      orderBy: { updatedAt: "desc" },
    }),
    // A refunded purchase is not ownership: that customer may buy again.
    prisma.purchase.findFirst({
      where: { userId, isRefunded: false, ...hideTestRowsFor(userId, env) },
      select: { id: true, provider: true },
    }),
  ]);

  const [cancellations, deviceClaim, outstanding] = await Promise.all([
    cancellationStates(subs.map((sub) => sub.externalId)),
    deviceId
      ? prisma.trialClaim.findUnique({
          where: { deviceIdHash: ledgerHash(deviceId) },
          select: { id: true },
        })
      : Promise.resolve(null),
    outstandingAcquisition(userId),
  ]);

  return { subs, ownedLifetime, deviceClaim, cancellations, outstanding };
}

/**
 * The whole paywall, from the inputs above — the one wrapping of
 * `planEligibility` every serving surface uses, so the trial-day configuration
 * and the outstanding-checkout mapping cannot fork per route either.
 */
export function purchaseEligibilityFrom(
  io: EligibilityInputs,
): Record<PurchasePlan, PlanEligibility> {
  return planEligibility({
    subs: io.subs,
    cancellations: io.cancellations,
    ownsLifetime: io.ownedLifetime != null,
    lifetimeProvider: io.ownedLifetime?.provider ?? null,
    deviceHadTrial: io.deviceClaim != null,
    trialDays: {
      monthly: env.lemonSqueezyTrialDaysMonthly,
      yearly: env.lemonSqueezyTrialDaysYearly,
    },
    outstanding: io.outstanding
      ? {
          plan: io.outstanding.plan,
          state: io.outstanding.state,
          resumable: io.outstanding.state === "ready" && io.outstanding.checkoutUrl != null,
          expiresAt: io.outstanding.expiresAt.toISOString(),
        }
      : null,
  });
}
