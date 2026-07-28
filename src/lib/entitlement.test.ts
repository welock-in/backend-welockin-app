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
