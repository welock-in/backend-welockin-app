import assert from "node:assert/strict";
import { test } from "node:test";
import { computeEntitlement, type EntitlementInputs } from "./entitlement";

const NOW = new Date("2026-07-19T10:00:00.000Z");
const FUTURE = new Date("2026-08-02T10:00:00.000Z");
const PAST = new Date("2026-07-01T10:00:00.000Z");

function base(overrides: Partial<EntitlementInputs> = {}): EntitlementInputs {
  return {
    now: NOW,
    hasActivePurchase: false,
    hasRefundedPurchase: false,
    compActive: false,
    accessRevoked: false,
    trialEndsAt: null,
    hasTrialClaim: false,
    trialDurationDays: 14,
    productId: "in.welock.app.premium.lifetime",
    ...overrides,
  };
}

test("the master switch is echoed and never changes the resolved status", () => {
  // ENTITLEMENT_ENFORCED only tells the client whether it may hard-gate; the server
  // always reports the true status. Same inputs → same status either way.
  const off = computeEntitlement(base({ trialEndsAt: FUTURE, hasTrialClaim: true }));
  const on = computeEntitlement(
    base({ trialEndsAt: FUTURE, hasTrialClaim: true, enforced: true }),
  );
  assert.equal(off.enforced, false); // absent ⇒ false, never undefined on the wire
  assert.equal(on.enforced, true);
  assert.equal(on.status, off.status);
  assert.equal(on.isPro, off.isPro);
});

test("fresh device with no claim can start a trial", () => {
  const v = computeEntitlement(base());
  assert.equal(v.status, "expired");
  assert.equal(v.isPro, false);
  assert.equal(v.canStartTrial, true);
  assert.equal(v.trialEndsAt, null);
  assert.equal(v.serverTime, NOW.toISOString());
});

test("active device trial → trialing + isPro, cannot start another", () => {
  const v = computeEntitlement(base({ trialEndsAt: FUTURE, hasTrialClaim: true }));
  assert.equal(v.status, "trialing");
  assert.equal(v.isPro, true);
  assert.equal(v.canStartTrial, false);
  assert.equal(v.trialEndsAt, FUTURE.toISOString());
});

test("elapsed device trial → expired (claim consumed, no fresh trial)", () => {
  const v = computeEntitlement(base({ trialEndsAt: PAST, hasTrialClaim: true }));
  assert.equal(v.status, "expired");
  assert.equal(v.isPro, false);
  assert.equal(v.canStartTrial, false); // THE anti-abuse invariant
});

test("purchase beats an elapsed trial", () => {
  const v = computeEntitlement(base({ hasActivePurchase: true, trialEndsAt: PAST, hasTrialClaim: true }));
  assert.equal(v.status, "active");
  assert.equal(v.isPro, true);
});

test("admin comp grants access without a purchase", () => {
  const v = computeEntitlement(base({ compActive: true }));
  assert.equal(v.status, "comped");
  assert.equal(v.isPro, true);
  assert.equal(v.canStartTrial, false);
});

test("revoke overrides everything, even an active purchase", () => {
  const v = computeEntitlement(base({ accessRevoked: true, hasActivePurchase: true, compActive: true }));
  assert.equal(v.status, "revoked");
  assert.equal(v.isPro, false);
  assert.equal(v.canStartTrial, false);
});

test("refunded (no active purchase) → refunded, locked, no fresh trial", () => {
  const v = computeEntitlement(base({ hasRefundedPurchase: true }));
  assert.equal(v.status, "refunded");
  assert.equal(v.isPro, false);
  assert.equal(v.canStartTrial, false);
});

test("precedence: active purchase beats comp beats trial", () => {
  const v = computeEntitlement(
    base({ hasActivePurchase: true, compActive: true, trialEndsAt: FUTURE, hasTrialClaim: true }),
  );
  assert.equal(v.status, "active");
});

/* ── purchaseEffect: the Apple subscriptions ─────────────────────────────── */

// Imported lazily here so the block above keeps its original imports untouched.
import {
  MONTHLY_PRODUCT_ID,
  YEARLY_PRODUCT_ID,
  purchaseEffect,
} from "./entitlement";

const T0 = Date.parse("2026-08-01T10:00:00.000Z");
const T3D = Date.parse("2026-08-04T10:00:00.000Z");
const T1Y = Date.parse("2027-08-01T10:00:00.000Z");

test("monthly transaction under an introductory offer → on_trial until expiresDate", () => {
  const e = purchaseEffect(
    { productId: MONTHLY_PRODUCT_ID, purchaseDate: T0, revoked: false, expiresDate: T3D, offerType: 1 },
    14,
  );
  assert.deepEqual(e, {
    kind: "subscription",
    interval: "monthly",
    status: "on_trial",
    validUntil: new Date(T3D),
  });
});

test("yearly renewal (no offer) → active until expiresDate", () => {
  const e = purchaseEffect(
    { productId: YEARLY_PRODUCT_ID, purchaseDate: T0, revoked: false, expiresDate: T1Y },
    14,
  );
  assert.deepEqual(e, {
    kind: "subscription",
    interval: "yearly",
    status: "active",
    validUntil: new Date(T1Y),
  });
});

test("a revoked subscription is expired even though its period is still ahead", () => {
  // A refund arrives as a replay of the same transaction with revocationDate set.
  // Its expiresDate may be months away; access must stop anyway — `expired` is
  // the one status subscriptionGrants never grants on, whatever the date.
  const e = purchaseEffect(
    { productId: YEARLY_PRODUCT_ID, purchaseDate: T0, revoked: true, expiresDate: T1Y },
    14,
  );
  assert.equal(e.kind, "subscription");
  assert.equal((e as { status: string }).status, "expired");
});

test("a subscription with no expiresDate carries a null window (grants until corrected)", () => {
  // Should not happen on a real Apple payload, but the shape is optional — and
  // lib/subscription.ts already decides null validUntil grants, pending the next
  // replay. The effect must pass that decision through, not invent a date.
  const e = purchaseEffect(
    { productId: MONTHLY_PRODUCT_ID, purchaseDate: T0, revoked: false },
    14,
  );
  assert.equal(e.kind, "subscription");
  assert.equal((e as { validUntil: Date | null }).validUntil, null);
});

test("an active Apple subscription resolves active/isPro; on trial resolves trialing", () => {
  const active = computeEntitlement(base({ hasActiveSubscription: true }));
  assert.equal(active.status, "active");
  assert.equal(active.isPro, true);
  assert.equal(active.canStartTrial, false);

  const trialing = computeEntitlement(
    base({ hasActiveSubscription: true, subscriptionOnTrial: true }),
  );
  assert.equal(trialing.status, "trialing");
  assert.equal(trialing.isPro, true);
});
