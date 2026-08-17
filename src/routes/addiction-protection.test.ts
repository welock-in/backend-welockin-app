import assert from "node:assert/strict";
import { test } from "node:test";
import request from "supertest";
import { createApp } from "../app";
import { signToken } from "../lib/jwt";
import { prisma } from "../lib/prisma";
import { env } from "../lib/env";
import { stubAccountGuard, TEST_USER_ID, TEST_USER_EMAIL } from "./test-helpers";

/*
 * What these tests pin is the MOUNT, not the lock logic: /api/addiction-
 * protection sits behind the account guard (see app.ts). The router's own
 * requireAuth is a stateless signature check, so before the guard a deleted
 * account's JWT could keep reading the list and driving the lock for up to
 * thirty days.
 *
 * Plus the OTP mail limits. /lock and /resend both hand a caller-supplied
 * address to `sendOtpEmail`; the tests at the bottom pin that the two dimensions
 * exist, that the per-recipient one is SHARED between the routes, and that a 429
 * costs neither a mail nor a half-applied lock.
 */

// Rate limiting off for the FILE (the flag is read at call time); the tests that
// are ABOUT the limiter turn it back on and stub the throttle table.
(env as { authRateLimitDisabled: boolean }).authRateLimitDisabled = true;

const app = createApp();
stubAccountGuard();
const auth = {
  authorization: `Bearer ${signToken({ sub: TEST_USER_ID, email: TEST_USER_EMAIL })}`,
};

type Ctx = { after: (fn: () => void) => void };

function stubMethod(
  t: Ctx,
  target: Record<string, any>,
  name: string,
  implementation: (...args: any[]) => any,
) {
  const original = target[name];
  target[name] = implementation;
  t.after(() => {
    target[name] = original;
  });
}

/** Pin an env flag for one test and put it back. Flags are read at call time. */
function setEnv(t: Ctx, patch: Record<string, unknown>) {
  const before: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    before[k] = (env as any)[k];
    (env as any)[k] = v;
  }
  t.after(() => {
    for (const [k, v] of Object.entries(before)) (env as any)[k] = v;
  });
}

type Row = Record<string, any>;

/**
 * AuthThrottle, honouring the filters `consumeRateLimit` actually sends: the
 * conditional `updateMany` bumps only a row whose window is still open, the
 * `upsert` opens one, and the `findUnique` reads the count back. Same fake as
 * contact.test.ts — the returned array IS the store, so a test can read which
 * keys were consumed and how far.
 */
function fakeThrottle(t: Ctx, seed: Row[] = []) {
  const store: Row[] = seed.map((r) => ({ count: 0, windowStartedAt: new Date(), ...r }));

  stubMethod(t, prisma.authThrottle as any, "updateMany", async (args: any) => {
    const w = args?.where ?? {};
    let matches = store.filter((r) => r.key === w.key);
    if (w.windowStartedAt?.gt) {
      matches = matches.filter(
        (r) => r.windowStartedAt.getTime() > w.windowStartedAt.gt.getTime(),
      );
    }
    for (const row of matches) row.count += args.data.count.increment;
    return { count: matches.length };
  });

  stubMethod(t, prisma.authThrottle as any, "upsert", async (args: any) => {
    const existing = store.find((r) => r.key === args.where.key);
    if (existing) {
      Object.assign(existing, args.update);
      return { ...existing };
    }
    const row = { ...args.create };
    store.push(row);
    return { ...row };
  });

  stubMethod(t, prisma.authThrottle as any, "findUnique", async (args: any) => {
    const row = store.find((r) => r.key === args.where.key);
    return row ? { ...row } : null;
  });

  return store;
}

/**
 * The mailer, intercepted at the only seam that exists (see the long note in
 * contact.test.ts): `send()` reads `env.resendApiKey` at call time and then
 * calls the global `fetch`, so a key plus a fetch swap captures the wire bytes —
 * strictly more than a stub of `sendOtpEmail` would see.
 */
type SentMail = { to: string; subject: string; text: string };

function mailbox(t: Ctx): SentMail[] {
  const sent: SentMail[] = [];
  const beforeKey = env.resendApiKey;
  (env as { resendApiKey: string }).resendApiKey = "test-resend-key";
  const originalFetch = globalThis.fetch;

  (globalThis as any).fetch = async (_url: unknown, init: { body: string }) => {
    const body = JSON.parse(init.body) as { to: string[]; subject: string; text: string };
    sent.push({ to: body.to[0], subject: body.subject, text: body.text });
    return { ok: true, status: 200, json: async () => ({ id: "test-email-id" }) };
  };

  t.after(() => {
    (env as { resendApiKey: string }).resendApiKey = beforeKey;
    (globalThis as any).fetch = originalFetch;
  });
  return sent;
}

const PARTNER = "partner@example.com";
const RECIPIENT_KEY = `protect-otp:to:${PARTNER}`;

/** A lock row shaped like the one /lock writes, echoed back by the upsert. */
function stubLockWrites(t: Ctx) {
  const writes: any[] = [];
  stubMethod(t, prisma.protectionLock as any, "upsert", async (args: any) => {
    writes.push(args);
    return { userId: TEST_USER_ID, ...args.create };
  });
  stubMethod(t, prisma.protectionLock as any, "update", async (args: any) => {
    writes.push(args);
    return { userId: TEST_USER_ID, ...args.data };
  });
  return writes;
}

test("a token whose account was deleted gets the machine-readable 404, not a status", async (t) => {
  // Per-test stub wins over the file-wide guard default and is restored after.
  stubMethod(t, prisma.user as any, "findUnique", async () => null);

  const res = await request(app).get("/api/addiction-protection/status").set(auth);

  assert.equal(res.status, 404);
  assert.equal(res.body.code, "ACCOUNT_NOT_FOUND");
  assert.equal("active" in res.body, false, "no lock state for a ghost");
});

test("a live account still reads its lock status through the guard", async (t) => {
  stubMethod(t, prisma.protectionLock as any, "findUnique", async () => null);

  const res = await request(app).get("/api/addiction-protection/status").set(auth);

  assert.equal(res.status, 200);
  assert.equal(res.body.userId, TEST_USER_ID);
  assert.equal(res.body.active, false);
});

test("no token at all is still the plain 401, before any account read", async () => {
  const res = await request(app).get("/api/addiction-protection/status");

  assert.equal(res.status, 401);
});

/* ── the OTP mail limits ──────────────────────────────────────────────────── */

test("the partner lock mails the code and charges both the user and the recipient", async (t) => {
  setEnv(t, { authRateLimitDisabled: false });
  const throttle = fakeThrottle(t);
  const mail = mailbox(t);
  const writes = stubLockWrites(t);

  const res = await request(app)
    .post("/api/addiction-protection/lock")
    .set(auth)
    .send({ method: "partner", categories: ["porn"], partnerContact: PARTNER });

  assert.equal(res.status, 200);
  assert.equal(res.body.active, true);
  assert.equal(res.body.partnerContact, PARTNER);
  assert.equal(res.body.emailed, "sent");
  assert.equal(mail.length, 1);
  assert.equal(mail[0].to, PARTNER);

  // The state is CONSISTENT: the code sitting on the row is the code the partner
  // is holding. A lock whose OTP nobody was mailed is an unopenable lock.
  const otp = writes[0].create.otp as string;
  assert.match(otp, /^[0-9]{6}$/);
  assert.ok(mail[0].text.includes(otp), "the partner receives the code that was stored");
  assert.equal(writes[0].create.active, true);

  const keys = throttle.map((r) => r.key);
  assert.ok(keys.includes(`protect-lock:user:${TEST_USER_ID}`), "the per-user leg is counted");
  assert.ok(keys.includes(RECIPIENT_KEY), "the per-recipient leg is counted");
});

test("the sixth lock inside the hour is a 429 — no mail, and no write either", async (t) => {
  setEnv(t, { authRateLimitDisabled: false });
  fakeThrottle(t, [{ key: `protect-lock:user:${TEST_USER_ID}`, count: 5 }]);
  const mail = mailbox(t);
  const writes = stubLockWrites(t);

  const res = await request(app)
    .post("/api/addiction-protection/lock")
    .set(auth)
    .send({ method: "partner", categories: [], partnerContact: PARTNER });

  assert.equal(res.status, 429);
  assert.equal(mail.length, 0);
  assert.equal(writes.length, 0, "the per-user cap is consumed before any DB work");
});

/*
 * The ordering that the whole fix turns on. Had the upsert run first, a 429 on
 * the recipient leg would leave protection ON carrying a fresh OTP that nobody
 * was ever mailed — and /resend throttled on this same shared key, so no way
 * back out. A 429 has to mean nothing happened.
 */
test("a recipient already at the cap stops /lock BEFORE the lock is applied", async (t) => {
  setEnv(t, { authRateLimitDisabled: false });
  fakeThrottle(t, [{ key: RECIPIENT_KEY, count: 5 }]);
  const mail = mailbox(t);
  const writes = stubLockWrites(t);

  const res = await request(app)
    .post("/api/addiction-protection/lock")
    .set(auth)
    .send({ method: "partner", categories: [], partnerContact: PARTNER });

  assert.equal(res.status, 429);
  assert.equal(mail.length, 0, "a throttled recipient must not still cost a send");
  assert.equal(writes.length, 0, "no half-applied lock behind the 429");
});

test("a dated lock spends nobody's inbox budget", async (t) => {
  setEnv(t, { authRateLimitDisabled: false });
  const throttle = fakeThrottle(t);
  const mail = mailbox(t);
  stubLockWrites(t);

  const res = await request(app)
    .post("/api/addiction-protection/lock")
    .set(auth)
    .send({ method: "date", categories: [], lockedUntil: "2030-01-01T00:00:00.000Z" });

  assert.equal(res.status, 200);
  assert.equal(mail.length, 0);
  assert.equal(
    throttle.filter((r) => r.key.startsWith("protect-otp:to:")).length,
    0,
    "no mail is owed, so no recipient is charged",
  );
});

test("/lock and /resend share ONE recipient budget, whatever the casing", async (t) => {
  setEnv(t, { authRateLimitDisabled: false });
  const throttle = fakeThrottle(t);
  mailbox(t);
  stubLockWrites(t);
  stubMethod(t, prisma.protectionLock as any, "findUnique", async () => ({
    userId: TEST_USER_ID,
    active: true,
    method: "partner",
    partnerContact: PARTNER,
  }));

  await request(app)
    .post("/api/addiction-protection/lock")
    .set(auth)
    // Mixed case on purpose: the key folds it, or one inbox gets two budgets.
    .send({ method: "partner", categories: [], partnerContact: "Partner@Example.COM" });
  await request(app).post("/api/addiction-protection/resend").set(auth).send({});

  const rows = throttle.filter((r) => r.key.startsWith("protect-otp:to:"));
  assert.equal(rows.length, 1, "one inbox, one budget — not one per route, not one per casing");
  assert.equal(rows[0].key, RECIPIENT_KEY);
  assert.equal(rows[0].count, 2, "both sends are charged to it");
});

test("a double-tapped Send-it-again is a 429 on the second tap, and mails once", async (t) => {
  setEnv(t, { authRateLimitDisabled: false });
  fakeThrottle(t);
  const mail = mailbox(t);
  stubLockWrites(t);
  stubMethod(t, prisma.protectionLock as any, "findUnique", async () => ({
    userId: TEST_USER_ID,
    active: true,
    method: "partner",
    partnerContact: PARTNER,
  }));

  const first = await request(app).post("/api/addiction-protection/resend").set(auth).send({});
  const second = await request(app).post("/api/addiction-protection/resend").set(auth).send({});

  assert.equal(first.status, 200);
  assert.equal(first.body.emailed, "sent");
  assert.equal(second.status, 429);
  assert.equal(mail.length, 1, "the per-minute cap is what a double-tap runs into");
});

test("the sixth resend inside the hour is a 429 even when the taps are spread out", async (t) => {
  setEnv(t, { authRateLimitDisabled: false });
  // The burst row is left empty on purpose, so it is the HOURLY leg under test.
  fakeThrottle(t, [{ key: `protect-resend:user:${TEST_USER_ID}`, count: 5 }]);
  const mail = mailbox(t);
  const writes = stubLockWrites(t);
  stubMethod(t, prisma.protectionLock as any, "findUnique", async () => ({
    userId: TEST_USER_ID,
    active: true,
    method: "partner",
    partnerContact: PARTNER,
  }));

  const res = await request(app).post("/api/addiction-protection/resend").set(auth).send({});

  assert.equal(res.status, 429);
  assert.equal(mail.length, 0);
  assert.equal(writes.length, 0, "the per-user legs run before the lock is even read");
});

test("a recipient at the cap stops /resend before the OTP is rotated", async (t) => {
  setEnv(t, { authRateLimitDisabled: false });
  fakeThrottle(t, [{ key: RECIPIENT_KEY, count: 5 }]);
  const mail = mailbox(t);
  const writes = stubLockWrites(t);
  stubMethod(t, prisma.protectionLock as any, "findUnique", async () => ({
    userId: TEST_USER_ID,
    active: true,
    method: "partner",
    partnerContact: PARTNER,
    otp: "123456",
  }));

  const res = await request(app).post("/api/addiction-protection/resend").set(auth).send({});

  assert.equal(res.status, 429);
  assert.equal(mail.length, 0);
  assert.equal(
    writes.length,
    0,
    "rotating first would kill the code the partner already holds and then refuse to send its replacement",
  );
});
