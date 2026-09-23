import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import request from "supertest";
import { startMongo, stopMongo, runId } from "./harness";

// Real, disposable replica-set checks. No production connection or provider call.
let prisma: any;
let app: any;
let adminAuth: Record<string, string>;
let signToken: (payload: { sub: string; email: string }) => string;
let hashCode: (value: string) => string;
let failAudit = false;
let failVerification = false;
let verificationBarrier: (() => Promise<void>) | null = null;
let originalFetch: typeof fetch;
let externalRequests = 0;

before(async () => {
  const uri = await startMongo();
  assert.match(uri, /^mongodb:\/\/127\.0\.0\.1:/, "tests must only reach the disposable local database");
  process.env.AUTH_RATE_LIMIT_DISABLED = "true";
  process.env.ADMIN_USERNAME = "signup-qa";
  process.env.ADMIN_PASSWORD = "signup-qa-only";
  process.env.SIGNUP_TRIAL_ENABLED = "false";
  process.env.SIGNUP_PAYING_DEVICE_BLOCK = "false";
  process.env.DEVICE_BINDING_ENFORCED = "false";
  process.env.RESEND_API_KEY = ""; // issue codes in Mongo without sending email
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { externalRequests++; throw new Error("External network is forbidden in this suite"); }) as typeof fetch;
  const [p, a, admin, jwt, tokens] = await Promise.all([
    import("../../src/lib/prisma"), import("../../src/app"), import("../../src/lib/admin-jwt"),
    import("../../src/lib/jwt"), import("../../src/lib/tokens"),
  ]);
  prisma = p.prisma;
  app = a.createApp();
  signToken = jwt.signToken;
  hashCode = tokens.hashCode;
  adminAuth = { authorization: `Bearer ${admin.signAdminToken("signup-qa")}` };
  prisma.$use(async (params: any, next: any) => {
    if (failAudit && params.model === "AdminAuditLog" && params.action === "create") throw new Error("Injected audit failure");
    if (failVerification && params.model === "User" && params.action === "updateMany") throw new Error("Injected verification failure");
    const result = await next(params);
    if (verificationBarrier && params.model === "EmailVerification" && params.action === "findFirst") await verificationBarrier();
    return result;
  });
});

after(async () => {
  if (originalFetch) globalThis.fetch = originalFetch;
  await prisma?.$disconnect();
  await stopMongo();
});

const patch = (body: object) => request(app).patch("/api/admin/signup-lifetime").set(adminAuth).send(body);
let seq = 0;
async function account(data: object = {}) {
  const user = await prisma.user.create({ data: { email: `${runId}-${++seq}@example.test`, ...data } });
  const code = await prisma.emailVerification.create({ data: {
    userId: user.id, email: user.email, codeHash: hashCode("123456"),
    expiresAt: new Date(Date.now() + 60_000), consumedAt: null,
  } });
  return { user, code, auth: { authorization: `Bearer ${signToken({ sub: user.id, email: user.email })}` } };
}

test("missing singleton reads OFF, partial concurrent upserts preserve both switches and audit rows", async () => {
  const absent = await request(app).get("/api/admin/signup-lifetime").set(adminAuth);
  assert.equal(absent.status, 200);
  assert.deepEqual(absent.body.settings, { iosSignupLifetimeEnabled: false, desktopSignupLifetimeEnabled: false,
    updatedAt: null, updatedBy: null });
  assert.equal(await prisma.signupLifetimeSettings.count(), 0);
  const writes = await Promise.all([patch({ iosSignupLifetimeEnabled: true }), patch({ desktopSignupLifetimeEnabled: true })]);
  for (const res of writes) assert.equal(res.status, 200, JSON.stringify(res.body));
  const saved = await prisma.signupLifetimeSettings.findUnique({ where: { id: "signup-lifetime" } });
  assert.equal(saved.iosSignupLifetimeEnabled, true);
  assert.equal(saved.desktopSignupLifetimeEnabled, true);
  assert.equal(await prisma.signupLifetimeSettings.count(), 1);
  assert.equal(await prisma.adminAuditLog.count({ where: { action: "signup_lifetime_settings" } }), 2);
});

test("an audit write failure really rolls back the settings document", async () => {
  const before = await prisma.signupLifetimeSettings.findUnique({ where: { id: "signup-lifetime" } });
  failAudit = true;
  try {
    const res = await patch({ iosSignupLifetimeEnabled: false });
    assert.equal(res.status, 503);
  } finally { failAudit = false; }
  const after = await prisma.signupLifetimeSettings.findUnique({ where: { id: "signup-lifetime" } });
  assert.deepEqual(after, before);
});

test("legacy optional fields remain readable and cannot acquire a grant during verification", async () => {
  const entry = await account();
  await prisma.user.update({ where: { id: entry.user.id }, data: { emailVerified: { unset: true } } });
  const res = await request(app).post("/api/auth/verify-email").set(entry.auth).send({ code: "123456" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const user = await prisma.user.findUnique({ where: { id: entry.user.id } });
  assert.equal(user.emailVerified, true);
  assert.equal(user.signupLifetimeOffer, null);
  assert.equal(user.iosLifetimeGrantedAt, null);
  assert.equal(user.desktopLifetimeGrantedAt, null);
});

test("reservation activation is atomic with verification and rolls back with code consumption", async () => {
  const entry = await account({ signupPlatform: "ios", signupLifetimeOffer: "ios" });
  assert.equal((await patch({ iosSignupLifetimeEnabled: false })).status, 200);
  failVerification = true;
  try {
    const failed = await request(app).post("/api/auth/verify-email").set(entry.auth).send({ code: "123456" });
    assert.equal(failed.status, 500);
  } finally { failVerification = false; }
  const untouched = await prisma.user.findUnique({ where: { id: entry.user.id } });
  assert.equal(untouched.emailVerified, false);
  assert.equal(untouched.iosLifetimeGrantedAt, null);
  assert.equal((await prisma.emailVerification.findUnique({ where: { id: entry.code.id } })).consumedAt, null);
  const good = await request(app).post("/api/auth/verify-email").set(entry.auth).send({ code: "123456" });
  assert.equal(good.status, 200);
  const verified = await prisma.user.findUnique({ where: { id: entry.user.id } });
  assert.ok(verified.iosLifetimeGrantedAt instanceof Date);
  assert.deepEqual(verified.iosLifetimeGrantedAt, verified.emailVerifiedAt);
  assert.equal(verified.desktopLifetimeGrantedAt, null);
});

test("concurrent verification commits once and replay preserves the saved lifetime timestamp", async () => {
  const entry = await account({ signupPlatform: "windows", signupLifetimeOffer: "desktop" });
  let arrivals = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  verificationBarrier = async () => { if (++arrivals === 2) release(); await gate; };
  let responses: any[];
  try {
    responses = await Promise.all([1, 2].map(() => request(app).post("/api/auth/verify-email").set(entry.auth).send({ code: "123456" })));
  } finally { verificationBarrier = null; }
  for (const res of responses!) assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(responses!.filter((res) => !res.body.alreadyVerified).length, 1);
  const before = await prisma.user.findUnique({ where: { id: entry.user.id } });
  assert.ok(before.desktopLifetimeGrantedAt instanceof Date);
  assert.deepEqual(before.desktopLifetimeGrantedAt, before.emailVerifiedAt);
  const replay = await request(app).post("/api/auth/verify-email").set(entry.auth).send({ code: "000000" });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.alreadyVerified, true);
  const after = await prisma.user.findUnique({ where: { id: entry.user.id } });
  assert.deepEqual(after.desktopLifetimeGrantedAt, before.desktopLifetimeGrantedAt);
});

test("real signup snapshots OFF/ON, verifies after a toggle and grants only the reserved scope without payment", { timeout: 30_000 }, async () => {
  const password = "signup-lifetime-qa-password";
  const contexts = {
    ios: { "x-welockin-platform": "ios", "x-welockin-device-id": `opaque-${runId}` },
    windows: { "x-welockin-platform": "windows", "x-welockin-device-id": `win-${runId}` },
    macos: { "x-welockin-platform": "macos", "x-welockin-device-id": `mac-${runId}` },
  };

  async function register(platform: keyof typeof contexts) {
    const email = `${runId}-registration-${++seq}@example.test`;
    const res = await request(app).post("/api/auth/register").set(contexts[platform]).send({ email, password });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.ok(res.body.token);
    const user = await prisma.user.findUnique({ where: { id: res.body.user.id } });
    assert.equal(user.emailVerified, false);
    assert.equal(user.signupPlatform, platform);
    assert.equal(user.iosLifetimeGrantedAt, null);
    assert.equal(user.desktopLifetimeGrantedAt, null);
    // Exercise the real issued row, replacing only the random hash locally.
    const code = await prisma.emailVerification.findFirst({ where: { userId: user.id }, orderBy: { createdAt: "desc" } });
    assert.ok(code);
    assert.equal(code.consumedAt, null);
    await prisma.emailVerification.update({ where: { id: code.id }, data: { codeHash: hashCode("123456") } });
    return { user, platform, auth: { authorization: `Bearer ${res.body.token}` } };
  }

  assert.equal((await patch({ iosSignupLifetimeEnabled: false, desktopSignupLifetimeEnabled: false })).status, 200);
  const offSignup = await register("ios");
  assert.equal(offSignup.user.signupLifetimeOffer, null);

  assert.equal((await patch({ iosSignupLifetimeEnabled: true, desktopSignupLifetimeEnabled: true })).status, 200);
  // OFF at creation remains OFF even though today's switches are now ON.
  const offVerified = await request(app).post("/api/auth/verify-email").set(offSignup.auth).send({ code: "123456" });
  assert.equal(offVerified.status, 200);
  const offAccess = await request(app).get("/api/entitlement").set(offSignup.auth).set(contexts.ios);
  assert.equal(offAccess.status, 200);
  assert.equal(offAccess.body.isPro, false);
  assert.equal(offAccess.body.complimentaryLifetime, null);
  assert.equal((await prisma.user.findUnique({ where: { id: offSignup.user.id } })).iosLifetimeGrantedAt, null);

  const reserved = [];
  for (const platform of ["ios", "windows", "macos"] as const) {
    const entry = await register(platform);
    assert.equal(entry.user.signupLifetimeOffer, platform === "ios" ? "ios" : "desktop");
    const pending = await request(app).get("/api/entitlement").set(entry.auth).set(contexts[platform]);
    assert.equal(pending.status, 200);
    assert.equal(pending.body.isPro, false, "a reservation cannot open the paywall before verification");
    reserved.push(entry);
  }

  assert.equal((await patch({ iosSignupLifetimeEnabled: false, desktopSignupLifetimeEnabled: false })).status, 200);
  for (const entry of reserved) {
    const verified = await request(app).post("/api/auth/verify-email").set(entry.auth).send({ code: "123456" });
    assert.equal(verified.status, 200);
    assert.equal(verified.body.alreadyVerified, false);
    const saved = await prisma.user.findUnique({ where: { id: entry.user.id } });
    const grantField = entry.platform === "ios" ? "iosLifetimeGrantedAt" : "desktopLifetimeGrantedAt";
    assert.ok(saved[grantField] instanceof Date);

    for (const platform of ["ios", "windows", "macos"] as const) {
      const access = await request(app).get("/api/entitlement").set(entry.auth).set(contexts[platform]);
      const shouldGrant = (platform === "ios") === (entry.platform === "ios");
      assert.equal(access.status, 200);
      assert.equal(access.body.isPro, shouldGrant, `${entry.platform} signup used on ${platform}`);
      assert.equal(access.body.plan, shouldGrant ? "lifetime" : null);
      assert.equal(access.body.complimentaryLifetime, shouldGrant ? (entry.platform === "ios" ? "ios" : "desktop") : null);
      if (shouldGrant) {
        assert.equal(access.body.validUntil, null);
        assert.equal(access.body.purchaseEligibility.lifetime.canPurchase, false);
        assert.equal(access.body.billingProvider, "NONE");
      }
    }

    const login = await request(app).post("/api/auth/login").set(contexts[entry.platform])
      .send({ email: entry.user.email, password });
    assert.equal(login.status, 200);
    assert.equal(login.body.user[grantField], saved[grantField].toISOString());
    const replay = await request(app).post("/api/auth/verify-email")
      .set({ authorization: `Bearer ${login.body.token}` }).send({ code: "000000" });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.alreadyVerified, true);
    const stable = await prisma.user.findUnique({ where: { id: entry.user.id } });
    assert.deepEqual(stable[grantField], saved[grantField]);
    assert.equal(stable.signupLifetimeOffer, entry.user.signupLifetimeOffer);
  }
  assert.equal(await prisma.purchase.count(), 0);
  assert.equal(await prisma.subscription.count(), 0);
  assert.equal(await prisma.trialClaim.count(), 0);
  assert.equal(externalRequests, 0, "neither email nor payment providers were contacted");
});
