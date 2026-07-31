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

/**
 * Trial length, in days. THE source of truth: `POST /api/auth/*` stamps
 * `User.trialEndsAt` with it at account creation, and `GET /api/entitlement`
 * reports it. The mobile client mirrors it in `src/lib/onboarding.ts` for the
 * paywall copy ONLY — a client never computes when a trial ends, it asks.
 */
export const TRIAL_DAYS = 14;

/** The App Store product the paywall sells. Not yet wired to StoreKit. */
export const LIFETIME_PRODUCT_ID = "in.welock.app.lifetime";

export type EntitlementStatus =
  | "trialing"
  | "active"
  | "expired"
  | "refunded"
  | "comped"
  | "revoked";

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
}

export interface EntitlementInputs {
  now: Date;
  hasActivePurchase: boolean; // a non-refunded Purchase exists
  hasRefundedPurchase: boolean; // a refunded Purchase exists
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
    !input.hasActivePurchase;

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
