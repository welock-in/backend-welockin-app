import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test, type TestContext } from "node:test";
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { authRouter } from "./auth";
import { errorHandler } from "../middleware/error";
import { env } from "../lib/env";
import { prisma } from "../lib/prisma";
import { hashPassword } from "../lib/password";
import { hasDesktopLifetime } from "../lib/desktop-lifetime";

const app = express().use(express.json()).use("/api/auth", authRouter).use(errorHandler);
const USER_ID = "507f1f77bcf86cd799439011";
const EMAIL = "desktop-offer@example.com";
const PASSWORD = "test-password-123";
type Row = Record<string, any>;

// Fail locally before Prisma can connect if a route ever adds an unstubbed read
// or write. Assert attempts too: a best-effort catch must not hide a regression.
const unexpectedDatabaseCalls: string[] = [];
prisma.$use(async (params) => {
  unexpectedDatabaseCalls.push(`${params.model}.${params.action}`);
  throw new Error("This suite never connects to a database");
});

function stubMethod(
  t: TestContext,
  target: object,
  name: string,
  implementation: (...args: any[]) => any,
): any[][] {
  const methods = target as Row;
  const original = methods[name];
  const calls: any[][] = [];
  methods[name] = (...args: any[]) => {
    calls.push(args);
    return implementation(...args);
  };
  t.after(() => { methods[name] = original; });
  return calls;
}

function setEnv(t: TestContext, patch: Row): void {
  const config = env as Row;
  const before = Object.fromEntries(Object.keys(patch).map((key) => [key, config[key]]));
  Object.assign(config, patch);
  t.after(() => { Object.assign(config, before); });
}

function setup(t: TestContext, enabled = true) {
  setEnv(t, {
    desktopLifetimeSignupEnabled: enabled,
    // Keep trials ON to prove lifetime signup skips the ledger rather than
    // accidentally relying on its normal production OFF setting.
    signupTrialEnabled: true,
    signupPayingDeviceBlock: false,
    deviceBindingEnforced: false,
    authRateLimitDisabled: true,
    resendApiKey: "test-mail-key",
  });
  unexpectedDatabaseCalls.length = 0;
  t.after(() => { assert.deepEqual(unexpectedDatabaseCalls, []); });

  const users: Row[] = [];
  const creates = stubMethod(t, prisma.user, "create", async ({ data }) => {
    const user = { id: USER_ID, emailVerified: false, createdAt: new Date(), updatedAt: new Date(), ...data };
    users.push(user);
    return user;
  });
  stubMethod(t, prisma.user, "findUnique", async ({ where }) => users.find((user) => user.email === where.email) ?? null);
  const trialReads = stubMethod(t, prisma.trialClaim, "findFirst", async () => null);
  const trialCreates = stubMethod(t, prisma.trialClaim, "create", async ({ data }) => ({ id: "claim", ...data }));
  stubMethod(t, prisma.emailVerification, "updateMany", async () => ({ count: 0 }));
  const verificationCreates = stubMethod(t, prisma.emailVerification, "create", async ({ data }) => ({ id: "code", ...data }));

  const mails: Row[] = [];
  const networkAttempts: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    if (String(url) !== "https://api.resend.com/emails") {
      networkAttempts.push(String(url));
      throw new Error("Unexpected external request in desktop signup test");
    }
    mails.push(JSON.parse(String(init?.body)));
    return { ok: true, status: 200, json: async () => ({ id: "mail" }) };
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    assert.deepEqual(networkAttempts, []);
  });
  return { users, creates, trialReads, trialCreates, verificationCreates, mails };
}

function register(deviceId?: string, body: Row = {}) {
  const call = request(app).post("/api/auth/register");
  if (deviceId !== undefined) call.set("x-welockin-device-id", deviceId);
  return call.send({ email: EMAIL, password: PASSWORD, ...body });
}

function assertNoGlobalGrant(data: Row): void {
  assert.equal(data.plan, "trial");
  for (const field of ["isProCached", "compActive", "compedUntil", "trialEndsAt", "purchases", "subscriptions"]) {
    assert.equal(Object.hasOwn(data, field), false, `${field} must not grant global or paid access`);
  }
}

for (const deviceId of ["win-machine", "win-unidentified", "mac-platform", "mac-fallback"]) {
  test(`signup offer persists desktop lifetime atomically for ${deviceId}`, async (t) => {
    const state = setup(t);
    const before = Date.now();
    const res = await register(deviceId);

    assert.equal(res.status, 201);
    assert.ok(res.body.token);
    assert.equal(res.body.user.passwordHash, undefined);
    assert.equal(state.creates.length, 1);
    const data = state.creates[0][0].data;
    assert.ok(data.desktopLifetimeGrantedAt instanceof Date);
    assert.ok(data.desktopLifetimeGrantedAt.getTime() >= before);
    assert.ok(data.desktopLifetimeGrantedAt.getTime() <= Date.now());
    assert.equal(res.body.user.desktopLifetimeGrantedAt, data.desktopLifetimeGrantedAt.toISOString());
    assertNoGlobalGrant(data);
    assert.equal(state.trialReads.length, 0);
    assert.equal(state.trialCreates.length, 0);
    assert.equal(state.verificationCreates.length, 1);
    assert.equal(state.mails.length, 1);
  });
}

for (const deviceId of ["win-machine", "mac-platform"]) {
  test(`ending the offer keeps the previous signup and trial behavior for ${deviceId}`, async (t) => {
    const state = setup(t, false);
    const res = await register(deviceId);

    assert.equal(res.status, 201);
    const data = state.creates[0][0].data;
    assert.equal(Object.hasOwn(data, "desktopLifetimeGrantedAt"), false);
    assertNoGlobalGrant(data);
    assert.equal(state.trialCreates.length, 1);
  });
}

for (const deviceId of ["ios-phone", "android-phone", "unknown-device", "win-", undefined]) {
  test(`signup never grants desktop lifetime for ${deviceId ?? "an absent device id"}`, async (t) => {
    const state = setup(t);
    const res = await register(deviceId);

    assert.equal(res.status, 201);
    const data = state.creates[0][0].data;
    assert.equal(Object.hasOwn(data, "desktopLifetimeGrantedAt"), false);
    assertNoGlobalGrant(data);
    assert.equal(state.trialCreates.length, deviceId ? 1 : 0);
  });
}

test("registration honors the existing body fallback and gives the header precedence", async (t) => {
  const state = setup(t);
  const desktop = await register(undefined, { deviceId: "mac-body" });
  assert.equal(desktop.status, 201);
  assert.ok(state.creates[0][0].data.desktopLifetimeGrantedAt instanceof Date);

  const mobile = await register("ios-phone", { email: "mobile@example.com", deviceId: "win-body" });
  assert.equal(mobile.status, 201);
  assert.equal(Object.hasOwn(state.creates[1][0].data, "desktopLifetimeGrantedAt"), false);
});

test("desktop login cannot upgrade a pre-existing account", async (t) => {
  const state = setup(t);
  state.users.push({ id: USER_ID, email: EMAIL, passwordHash: await hashPassword(PASSWORD), plan: "expired" });
  const res = await request(app).post("/api/auth/login").set("x-welockin-device-id", "win-machine")
    .send({ email: EMAIL, password: PASSWORD });

  assert.equal(res.status, 200);
  assert.equal(res.body.user.desktopLifetimeGrantedAt, undefined);
  assert.equal(res.body.user.plan, "expired");
  assert.equal(state.creates.length, 0);
  assert.equal(state.trialCreates.length, 0);
});

test("turning off the offer preserves grants already issued", async (t) => {
  const state = setup(t);
  assert.equal((await register("win-machine")).status, 201);
  (env as Row).desktopLifetimeSignupEnabled = false;

  assert.equal(hasDesktopLifetime(state.users[0], "mac-other-computer"), true);
  assert.equal(hasDesktopLifetime(state.users[0], "ios-phone"), false);
  const res = await request(app).post("/api/auth/login").set("x-welockin-device-id", "mac-other-computer")
    .send({ email: EMAIL, password: PASSWORD });
  assert.equal(res.status, 200);
  assert.equal(res.body.user.desktopLifetimeGrantedAt, state.users[0].desktopLifetimeGrantedAt.toISOString());
  assert.equal(state.creates.length, 1);
});

test("new mobile Sign in with Apple accounts retain their existing trial behavior", async (t) => {
  const state = setup(t);
  stubMethod(t, prisma.authProvider, "findUnique", async () => null);
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = "desktop-offer-apple-test";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    if (String(url) === "https://appleid.apple.com/auth/keys") {
      return { ok: true, status: 200, json: async () => ({ keys: [{ ...keys.publicKey.export({ format: "jwk" }), kid, use: "sig", alg: "RS256" }] }) };
    }
    return originalFetch(url as Parameters<typeof fetch>[0], init);
  }) as typeof fetch;
  const identityToken = jwt.sign({ email: EMAIL, email_verified: "true" }, keys.privateKey, {
    algorithm: "RS256", keyid: kid, issuer: "https://appleid.apple.com",
    audience: env.appleBundleId, subject: "new-mobile-apple-user", expiresIn: "1h",
  });
  const res = await request(app).post("/api/auth/apple").set("x-welockin-device-id", "ios-phone").send({ identityToken });

  assert.equal(res.status, 201);
  assert.equal(Object.hasOwn(state.creates[0][0].data, "desktopLifetimeGrantedAt"), false);
  assertNoGlobalGrant(state.creates[0][0].data);
  assert.equal(state.trialCreates.length, 1);
});
