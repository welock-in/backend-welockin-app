import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { test, type TestContext } from "node:test";
import request from "supertest";
import { createApp } from "../app";
import { env } from "../lib/env";
import { prisma } from "../lib/prisma";
import { signToken } from "../lib/jwt";
import { stubNoBillingHolds, stubNoSubscriptions } from "./test-helpers";

// All persistence and provider calls are replaced; these tests never use a real
// account, signing key, database, payment provider or email service.
stubNoBillingHolds();
stubNoSubscriptions();
const keys = generateKeyPairSync("ed25519");
env.entitlementSigningKey = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
env.authRateLimitDisabled = true;
env.entitlementEnforced = true;
env.lemonSqueezyApiKey = "fixture-key";
env.lemonSqueezyStoreId = "fixture-store";
env.lemonSqueezyVariantMonthly = "fixture-monthly";
env.lemonSqueezyVariantYearly = "fixture-yearly";
env.lemonSqueezyVariantId = "fixture-lifetime";

const app = createApp();
const USER_ID = "507f1f77bcf86cd799439011";
const auth = { authorization: `Bearer ${signToken({ sub: USER_ID, email: "user@example.com" })}` };
const device = (id: string) => ({ "x-welockin-device-id": id });
const MOBILE = "8e5278be-b93e-4c98-a2d8-944427c5ac1f";

// Prisma's delegates are proxies, not ordinary methods with descriptors.
function stub(t: TestContext, target: any, name: string, implementation: (...args: any[]) => any) {
  const original = target[name];
  let callCount = 0;
  target[name] = (...args: any[]) => {
    callCount++;
    return implementation(...args);
  };
  t.after(() => { target[name] = original; });
  return { callCount: () => callCount };
}

function fixture(t: TestContext, override: Record<string, unknown> = {}) {
  const user: Record<string, any> = {
    id: USER_ID, email: "user@example.com", emailVerified: true,
    passwordChangedAt: null, trialEndsAt: null, compActive: false,
    compedUntil: null, accessRevoked: false,
    desktopLifetimeGrantedAt: new Date("2026-09-20T00:00:00Z"),
    ...override,
  };
  stub(t, prisma.user, "findUnique", async () => user);
  const cache = stub(t, prisma.user, "update", async (args: any) => {
    Object.assign(user, args.data);
    return user;
  });
  stub(t, prisma.purchase, "findMany", async () => []);
  stub(t, prisma.trialClaim, "findFirst", async () => null);
  const provider = stub(t, globalThis, "fetch", async () => {
    throw new Error("A complimentary desktop account must not call a provider");
  });
  return { user, cache, provider };
}

function readReceipt(token: string) {
  const [body, sig] = token.split(".");
  const bytes = Buffer.from(body, "base64url");
  assert.equal(verify(null, bytes, keys.publicKey, Buffer.from(sig, "base64url")), true);
  return JSON.parse(bytes.toString("utf8"));
}

for (const id of ["win-fixture", "mac-fixture", "win-unidentified"]) {
  test(`${id}: permanent access with a signed receipt and no billing`, async (t) => {
    const { user, provider } = fixture(t, { trialEndsAt: new Date("2020-01-01T00:00:00Z") });
    const res = await request(app).get("/api/entitlement").set(auth).set(device(id));
    assert.equal(res.status, 200);
    assert.equal(res.body.isPro, true);
    assert.equal(res.body.status, "active");
    assert.equal(res.body.plan, "lifetime");
    assert.equal(res.body.trialEndsAt, null);
    assert.equal(res.body.validUntil, null);
    assert.equal(res.body.billingProvider, "NONE");
    assert.equal(res.body.billingUrl, null);
    assert.equal(res.body.manageableSubscription, null);
    assert.equal(res.body.willRenew, null);
    assert.equal(res.body.canStartTrial, false);
    assert.equal(res.body.enforced, true);
    for (const offer of Object.values(res.body.purchaseEligibility) as any[]) {
      assert.equal(offer.canPurchase, false);
      assert.equal(offer.reasonCode, "LIFETIME_ALREADY_OWNED");
    }
    const receipt = readReceipt(res.body.receipt);
    assert.equal(receipt.isPro, true);
    assert.equal(receipt.deviceId, id);
    assert.equal(receipt.trialEndsAt, null);
    assert.equal(Date.parse(receipt.expiresAt) - Date.parse(receipt.serverTime), 30 * 86_400_000);
    assert.equal(user.isProCached, false, "desktop-only access never enters the shared cache");
    assert.equal(user.plan, "expired");
    assert.equal(provider.callCount(), 0);
  });
}

test("the same granted account remains unpaid on mobile, including the billing alias", async (t) => {
  fixture(t);
  await request(app).get("/api/entitlement").set(auth).set(device("mac-fixture")).expect(200);
  for (const path of ["/api/entitlement", "/api/billing/entitlement"]) {
    for (const id of [MOBILE, "ios-device", "ipados-device", "android-device", ""]) {
      const res = await request(app).get(path).set(auth).set(device(id));
      assert.equal(res.status, 200);
      assert.equal(res.body.isPro, false, `${path} / ${id}`);
      assert.equal(res.body.plan, null);
      assert.equal(readReceipt(res.body.receipt).isPro, false);
      assert.equal(res.body.purchaseEligibility.lifetime.canPurchase, true);
    }
  }
});

test("turning the signup offer off preserves previously granted lifetime on both desktops", async (t) => {
  fixture(t);
  const settings = stub(t, prisma.signupLifetimeSettings, "findUnique", async () => {
    throw new Error("Issued gifts must not depend on the current signup offer");
  });
  for (const id of ["mac-another-computer", "win-another-computer"]) {
    const res = await request(app).get("/api/entitlement").set(auth).set(device(id));
    assert.equal(res.status, 200);
    assert.equal(res.body.plan, "lifetime");
    assert.equal(res.body.isPro, true);
  }
  assert.equal(settings.callCount(), 0);
});

test("an existing account is never granted lifetime merely by signing in on desktop", async (t) => {
  const { user } = fixture(t, { desktopLifetimeGrantedAt: null });
  const res = await request(app).get("/api/entitlement").set(auth).set(device("win-fixture"));
  assert.equal(res.status, 200);
  assert.equal(res.body.isPro, false);
  assert.equal(res.body.plan, null);
  assert.equal(user.desktopLifetimeGrantedAt, null);
});

test("admin revocation still outranks a promotional lifetime", async (t) => {
  fixture(t, { accessRevoked: true });
  const res = await request(app).get("/api/entitlement").set(auth).set(device("win-fixture"));
  assert.equal(res.status, 200);
  assert.equal(res.body.isPro, false);
  assert.equal(res.body.status, "revoked");
  assert.equal(res.body.plan, null);
  assert.equal(readReceipt(res.body.receipt).isPro, false);
});

test("subscription status and checkout agree: no paid plan for a granted desktop", async (t) => {
  const { provider } = fixture(t);
  const subscription = await request(app).get("/api/subscription").set(auth).set(device("mac-fixture"));
  assert.equal(subscription.status, 200);
  assert.equal(subscription.body.subscription, null);
  for (const plan of ["monthly", "yearly", "lifetime"]) {
    assert.equal(subscription.body.purchaseEligibility[plan].canPurchase, false);
    const res = await request(app).post("/api/checkout").set(auth).set(device("mac-fixture")).send({ plan });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, "LIFETIME_ALREADY_OWNED");
  }
  assert.equal(provider.callCount(), 0);
});

test("a real paid lifetime continues to grant on mobile", async (t) => {
  fixture(t);
  stub(t, prisma.purchase, "findMany", async () => [{ provider: "revenuecat", isRefunded: false }]);
  stub(t, prisma.purchase, "findFirst", async () => ({ id: "paid", provider: "revenuecat" }));
  const res = await request(app).get("/api/billing/entitlement").set(auth).set(device(MOBILE));
  assert.equal(res.status, 200);
  assert.equal(res.body.isPro, true);
  assert.equal(res.body.plan, "lifetime");
  assert.equal(res.body.billingProvider, "APPLE");
});

test("an existing recurring subscription stays visible and manageable beside the desktop gift", async (t) => {
  fixture(t);
  stub(t, prisma.subscription, "findMany", async () => [{
    externalId: "existing-sub", provider: "lemonsqueezy", variantId: "fixture-monthly",
    status: "active", interval: "monthly", validUntil: new Date(Date.now() + 86_400_000),
    trialEndsAt: null, trialCancelledAt: null, pauseMode: null,
    providerUpdatedAt: new Date(), createdAt: new Date(), updatedAt: new Date(),
    customerPortalUrl: "https://example.com/existing-subscription", updatePaymentUrl: null,
  }]);
  const res = await request(app).get("/api/entitlement").set(auth).set(device("mac-fixture"));
  assert.equal(res.status, 200);
  assert.equal(res.body.plan, "lifetime");
  assert.equal(res.body.validUntil, null);
  assert.equal(res.body.manageableSubscription.provider, "LEMON_SQUEEZY");
  assert.equal(res.body.manageableSubscription.managementUrl, "https://example.com/existing-subscription");
  const mobile = await request(app).get("/api/entitlement").set(auth).set(device(MOBILE));
  assert.equal(mobile.body.plan, "monthly");
  assert.equal(mobile.body.billingProvider, "LEMON_SQUEEZY");
});

const iosGift = {
  desktopLifetimeGrantedAt: null,
  iosLifetimeGrantedAt: new Date("2026-09-23T00:00:00Z"),
};
const iosContext = (platform = "ios", id = MOBILE) => ({
  ...device(id), "x-welockin-platform": platform,
});

test("explicit desktop context and legacy ids resolve the same desktop gift", async (t) => {
  fixture(t);
  for (const platform of ["windows", "macos"]) {
    const res = await request(app).get("/api/entitlement").set(auth).set(iosContext(platform));
    assert.equal(res.status, 200);
    assert.equal(res.body.complimentaryLifetime, "desktop");
    assert.equal(res.body.plan, "lifetime");
  }
});

for (const platform of ["ios", "ipados"]) {
  test(`${platform}: a verified gift opens both entitlement routes without payment or global cache leakage`, async (t) => {
    const { user, provider } = fixture(t, iosGift);
    for (const path of ["/api/entitlement", "/api/billing/entitlement"]) {
      const res = await request(app).get(path).set(auth).set(iosContext(platform));
      assert.equal(res.status, 200);
      assert.equal(res.body.plan, "lifetime");
      assert.equal(res.body.isPro, true);
      assert.equal(res.body.complimentaryLifetime, "ios");
      assert.equal(res.body.hasApplePurchaseAccess, false);
      assert.equal(res.body.billingProvider, "NONE");
      assert.equal(res.body.validUntil, null);
      assert.equal(res.body.purchaseEligibility.lifetime.canPurchase, false);
      const receipt = readReceipt(res.body.receipt);
      assert.equal(receipt.isPro, true);
      assert.equal(receipt.deviceId, MOBILE);
      assert.equal(receipt.trialEndsAt, null);
    }
    assert.equal(user.isProCached, false);
    assert.equal(provider.callCount(), 0);
  });
}

test("an iOS gift does not leak to desktop, Android, missing context or a different account", async (t) => {
  const { user } = fixture(t, { ...iosGift, signupPlatform: "ios" });
  for (const headers of [device(MOBILE), iosContext("android"), iosContext("unknown"),
    iosContext("ios", ""), iosContext("ios", "win-fixture"), iosContext("ios", "mac-fixture")]) {
    const res = await request(app).get("/api/entitlement").set(auth).set(headers);
    assert.equal(res.status, 200);
    assert.equal(res.body.isPro, false);
    assert.equal(res.body.complimentaryLifetime, null);
    assert.equal(res.body.purchaseEligibility.lifetime.canPurchase, true);
  }
  user.iosLifetimeGrantedAt = null;
  const other = await request(app).get("/api/entitlement").set(auth).set(iosContext());
  assert.equal(other.body.isPro, false);
});

test("an unverified account or a reserved offer alone never supplies iOS lifetime", async (t) => {
  const { user } = fixture(t, { ...iosGift, emailVerified: false });
  let res = await request(app).get("/api/entitlement").set(auth).set(iosContext());
  assert.equal(res.body.isPro, false);
  Object.assign(user, { emailVerified: true, iosLifetimeGrantedAt: null, signupLifetimeOffer: "ios" });
  res = await request(app).get("/api/entitlement").set(auth).set(iosContext());
  assert.equal(res.body.isPro, false);
});

test("iOS gift eligibility also blocks unnecessary checkout and subscription offers", async (t) => {
  const { provider } = fixture(t, iosGift);
  const sub = await request(app).get("/api/subscription").set(auth).set(iosContext());
  assert.equal(sub.status, 200);
  for (const plan of ["monthly", "yearly", "lifetime"]) {
    assert.equal(sub.body.purchaseEligibility[plan].canPurchase, false);
    const res = await request(app).post("/api/checkout").set(auth).set(iosContext()).send({ plan });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, "LIFETIME_ALREADY_OWNED");
  }
  assert.equal(provider.callCount(), 0);
});

test("an iOS gift survives a refunded Apple purchase but supplies no restore proof", async (t) => {
  fixture(t, iosGift);
  stub(t, prisma.purchase, "findMany", async () => [{ provider: "revenuecat", isRefunded: true }]);
  const res = await request(app).get("/api/entitlement").set(auth).set(iosContext());
  assert.equal(res.body.isPro, true);
  assert.equal(res.body.hasApplePurchaseAccess, false);
  assert.equal(res.body.complimentaryLifetime, "ios");
});

test("a real Apple purchase supplies restore proof independently of the gift", async (t) => {
  const { user } = fixture(t, iosGift);
  stub(t, prisma.purchase, "findMany", async () => [{ provider: "app_store", isRefunded: false }]);
  stub(t, prisma.purchase, "findFirst", async () => ({ id: "paid", provider: "app_store" }));
  let res = await request(app).get("/api/entitlement").set(auth).set(iosContext());
  assert.equal(res.body.isPro, true);
  assert.equal(res.body.hasApplePurchaseAccess, true);
  assert.equal(res.body.billingProvider, "APPLE");
  user.accessRevoked = true;
  res = await request(app).get("/api/entitlement").set(auth).set(iosContext());
  assert.equal(res.body.isPro, false);
  assert.equal(res.body.hasApplePurchaseAccess, false);
  assert.equal(res.body.complimentaryLifetime, null);
  assert.equal(readReceipt(res.body.receipt).isPro, false);
});

test("an Apple subscription stays manageable and proves paid access beside an iOS gift", async (t) => {
  fixture(t, iosGift);
  stub(t, prisma.subscription, "findMany", async () => [{
    externalId: "apple-sub", provider: "revenuecat", variantId: "app.welockin.pro.monthly",
    status: "active", interval: "monthly", validUntil: new Date(Date.now() + 86_400_000),
    trialEndsAt: null, trialCancelledAt: null, pauseMode: null, willRenew: true,
    providerUpdatedAt: new Date(), createdAt: new Date(), updatedAt: new Date(),
    customerPortalUrl: "https://apps.apple.com/account/subscriptions", updatePaymentUrl: null,
  }]);
  const res = await request(app).get("/api/entitlement").set(auth).set(iosContext());
  assert.equal(res.body.plan, "lifetime");
  assert.equal(res.body.validUntil, null);
  assert.equal(res.body.hasApplePurchaseAccess, true);
  assert.equal(res.body.manageableSubscription.provider, "APPLE");
  assert.equal(res.body.manageableSubscription.managementUrl, "https://apps.apple.com/account/subscriptions");
});
