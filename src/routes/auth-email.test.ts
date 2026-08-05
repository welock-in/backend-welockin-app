import assert from "node:assert/strict";
import { test } from "node:test";
import { type Request as ExpressRequest } from "express";
import request from "supertest";
import { createApp } from "../app";
import { signToken } from "../lib/jwt";
import { prisma } from "../lib/prisma";
import { env } from "../lib/env";
import { hashCode, hashResetToken } from "../lib/tokens";
import {
  FINGERPRINT_HEADER,
  fingerprintHash,
  matchClaimByFingerprint,
  parseFingerprint,
} from "../lib/fingerprint";

/*
 * Email verification, password reset, and the machine binding that decides
 * whether a second account may be made on a computer that already has one.
 *
 * Three of these tests are the only thing standing between a shipped guarantee
 * and a plausible refactor that quietly removes it, so they are worth naming:
 *
 *  - the attempt counter is bumped with `{ increment: 1 }`, and a
 *    read-modify-write would let five parallel guesses spend one attempt;
 *  - a reset token is claimed by a CONDITIONAL updateMany, and a findFirst +
 *    update would let two simultaneous consumptions both win;
 *  - expiry is enforced by the `where` clause, not by a sweeper, so the fakes
 *    below apply only the filters the route actually sends. Drop one from the
 *    route and the matching test goes red rather than silently passing.
 *
 * There is no test database — the house pattern is to monkey-patch the Prisma
 * methods per test and restore them in `t.after`, exactly as entitlement.test.ts
 * does. The fakes here go one step further than "record the call" wherever the
 * behaviour under test IS the query: a stub that ignored `consumedAt: null`
 * would let every single-use test pass against a route that reuses tokens.
 */

// Rate limiting is off for the whole FILE, not per test: several tests below
// deliberately hammer one route, and `consumeRateLimit` fails OPEN on a database
// error, so leaving it on would not fail them — it would just bury the real
// assertions under `[rate-limit] counter unavailable` noise. Nothing here tests
// the limiter itself, so nothing is lost. Read at call time, so mutating the
// imported object is what works (process.env is read once, at module load).
(env as { authRateLimitDisabled: boolean }).authRateLimitDisabled = true;

import { stubNoSubscriptions } from "./test-helpers";

stubNoSubscriptions();

const app = createApp();

const USER_ID = "507f1f77bcf86cd799439011";
const OWNER_ID = "507f1f77bcf86cd799439022";
const USER_EMAIL = "user@example.com";
const auth = { authorization: `Bearer ${signToken({ sub: USER_ID, email: USER_EMAIL })}` };

type Ctx = { after: (fn: () => void) => void };

function stubMethod(
  t: Ctx,
  target: Record<string, any>,
  name: string,
  implementation: (...args: any[]) => any,
) {
  const original = target[name];
  const calls: any[][] = [];
  target[name] = (...args: any[]) => {
    calls.push(args);
    return implementation(...args);
  };
  t.after(() => {
    target[name] = original;
  });
  return calls;
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

const minutesFromNow = (n: number) => new Date(Date.now() + n * 60 * 1000);
const tick = () => new Promise((resolve) => setImmediate(resolve));

/** Let fire-and-forget tails (the reset-request route responds first) finish. */
async function settle(rounds = 30): Promise<void> {
  for (let i = 0; i < rounds; i++) await tick();
}

async function until(predicate: () => boolean, rounds = 200): Promise<boolean> {
  for (let i = 0; i < rounds; i++) {
    if (predicate()) return true;
    await tick();
  }
  return predicate();
}

/**
 * A rendezvous for the concurrency tests.
 *
 * Without it, "fire N requests with Promise.all" proves nothing: the runtime is
 * free to run them one after another, and a read-modify-write would pass. This
 * holds the first N callers inside the read so they demonstrably share one
 * snapshot. The timeout is a deadlock guard only — if it ever fires, the test
 * degrades to sequential and still passes for a correct implementation.
 */
function barrier(n: number) {
  let arrived = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const timeout = new Promise<void>((resolve) => {
    setTimeout(resolve, 1000).unref();
  });
  return async () => {
    arrived += 1;
    if (arrived >= n) {
      release();
      return;
    }
    await Promise.race([gate, timeout]);
  };
}

/**
 * The mailer, intercepted at the only seam that exists.
 *
 * `lib/resend.ts` exports `sendEmailVerificationCode` / `sendPasswordResetLink`
 * as `export function` declarations, and the runner (tsx/esbuild) compiles those
 * into getter-only, NON-CONFIGURABLE properties on the module namespace:
 * assignment is a silent no-op and `Object.defineProperty` throws
 * "Cannot redefine property". So the module cannot be patched from a test
 * without changing implementation code.
 *
 * It does not need to be. `send()` reads `env.resendApiKey` at call time and
 * then calls the global `fetch`, so setting a key and swapping `fetch` captures
 * the exact bytes the mailer would have put on the wire — subject, recipient and
 * body — which is strictly more than a function stub would have seen.
 */
type SentMail = { to: string; subject: string; html: string; text: string };

function mailbox(t: Ctx): SentMail[] {
  const sent: SentMail[] = [];
  const beforeKey = env.resendApiKey;
  (env as { resendApiKey: string }).resendApiKey = "test-resend-key";
  const originalFetch = globalThis.fetch;

  (globalThis as any).fetch = async (_url: unknown, init: { body: string }) => {
    const body = JSON.parse(init.body) as {
      to: string[];
      subject: string;
      html: string;
      text: string;
    };
    sent.push({ to: body.to[0], subject: body.subject, html: body.html, text: body.text });
    return { ok: true, status: 200, json: async () => ({ id: "test-email-id" }) };
  };

  t.after(() => {
    (env as { resendApiKey: string }).resendApiKey = beforeKey;
    (globalThis as any).fetch = originalFetch;
  });
  return sent;
}

/* ── the fakes ────────────────────────────────────────────────────────────── */

type Row = Record<string, any>;

/**
 * Every fake returns a COPY, because a database round trip does.
 *
 * Handing back the live object instead would be a subtly different runtime: the
 * route would observe writes made by other in-flight requests through a
 * reference it read seconds earlier, which real Prisma never does. The atomicity
 * test is the one that notices — with live references every racer reads the
 * final counter and they all report the same outcome.
 */
const copy = <T extends Row>(row: T | null | undefined): T | null =>
  row ? ({ ...row } as T) : null;

function fakeUsers(t: Ctx, seed: Row[]) {
  const store: Row[] = seed.map((r) => ({ emailVerified: false, passwordChangedAt: null, ...r }));

  stubMethod(t, prisma.user as any, "findUnique", async (args: any) => {
    const w = args?.where ?? {};
    return copy(
      store.find(
        (r) =>
          (w.id !== undefined && r.id === w.id) || (w.email !== undefined && r.email === w.email),
      ),
    );
  });

  const updates = stubMethod(t, prisma.user as any, "update", async (args: any) => {
    const row = store.find((r) => r.id === args.where.id);
    if (row) Object.assign(row, args.data);
    return copy(row) ?? {};
  });

  const creates = stubMethod(t, prisma.user as any, "create", async (args: any) => {
    const row = {
      id: `507f1f77bcf86cd7994390${30 + store.length}`,
      plan: "trial",
      emailVerified: false,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...args.data,
    };
    store.push(row);
    return copy(row);
  });

  return { store, updates, creates };
}

/**
 * EmailVerification, honouring the `where` clause rather than ignoring it.
 *
 * `consumedAt: null` and `expiresAt: { gt: … }` are applied ONLY when the route
 * actually sends them, which is the point: delete either filter from the route
 * and a test here fails instead of a consumed or expired code quietly working.
 * `attempts: { increment: 1 }` is honoured as an increment, so a route rewritten
 * to compute `attempts + 1` in JavaScript loses the parallel guesses.
 */
function fakeVerifications(t: Ctx, seed: Row[] = [], opts: { gate?: () => Promise<void> } = {}) {
  const store: Row[] = seed.map((r, i) => ({
    id: `ev-${i}`,
    attempts: 0,
    consumedAt: null,
    createdAt: new Date(2026, 0, 1 + i),
    ...r,
  }));

  const applyData = (row: Row, data: Row) => {
    for (const [key, value] of Object.entries(data)) {
      if (value && typeof value === "object" && "increment" in value) {
        row[key] = (row[key] ?? 0) + (value as { increment: number }).increment;
      } else {
        row[key] = value;
      }
    }
  };

  stubMethod(t, prisma.emailVerification as any, "findFirst", async (args: any) => {
    if (opts.gate) await opts.gate();
    const w = args?.where ?? {};
    let matches = store.filter((r) => r.userId === w.userId);
    if (w.consumedAt === null) matches = matches.filter((r) => r.consumedAt === null);
    if (w.expiresAt?.gt) {
      matches = matches.filter((r) => r.expiresAt.getTime() > w.expiresAt.gt.getTime());
    }
    matches.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return copy(matches[0]);
  });

  // Deliberately synchronous between read and write, like a single database
  // statement. Anything that awaited in here would hide the very race the
  // atomicity test exists to catch.
  const updates = stubMethod(t, prisma.emailVerification as any, "update", async (args: any) => {
    const row = store.find((r) => r.id === args.where.id);
    if (!row) return null;
    applyData(row, args.data);
    return copy(row);
  });

  const updateManys = stubMethod(
    t,
    prisma.emailVerification as any,
    "updateMany",
    async (args: any) => {
      const w = args?.where ?? {};
      let matches = store.filter((r) => r.userId === w.userId);
      if (w.consumedAt === null) matches = matches.filter((r) => r.consumedAt === null);
      for (const row of matches) applyData(row, args.data);
      return { count: matches.length };
    },
  );

  const creates = stubMethod(t, prisma.emailVerification as any, "create", async (args: any) => {
    const row = {
      id: `ev-${store.length}`,
      attempts: 0,
      consumedAt: null,
      createdAt: new Date(),
      ...args.data,
    };
    store.push(row);
    return copy(row);
  });

  // The route wraps "consume the code" + "mark the user verified" in one
  // `$transaction([...])`. The array is built eagerly, so by the time this runs
  // both stubs have already been called; awaiting them is all that is left.
  stubMethod(t, prisma as any, "$transaction", async (ops: any[]) => Promise.all(ops));

  return { store, updates, updateManys, creates };
}

/**
 * PasswordReset. `updateMany` is the single-use lock, so it applies every
 * condition the route sends and mutates SYNCHRONOUSLY — two callers cannot
 * interleave inside it, which is exactly what a conditional write buys and what
 * a findFirst + update would give away.
 */
function fakeResets(t: Ctx, seed: Row[] = [], opts: { gate?: () => Promise<void> } = {}) {
  const store: Row[] = seed.map((r, i) => ({
    id: `pr-${i}`,
    consumedAt: null,
    createdAt: new Date(2026, 0, 1 + i),
    ...r,
  }));

  const creates = stubMethod(t, prisma.passwordReset as any, "create", async (args: any) => {
    const row = { id: `pr-${store.length}`, consumedAt: null, createdAt: new Date(), ...args.data };
    store.push(row);
    return copy(row);
  });

  const updateManys = stubMethod(
    t,
    prisma.passwordReset as any,
    "updateMany",
    async (args: any) => {
      if (opts.gate) await opts.gate();
      const w = args?.where ?? {};
      let matches = store.slice();
      if (w.tokenHash !== undefined) matches = matches.filter((r) => r.tokenHash === w.tokenHash);
      if (w.userId !== undefined) matches = matches.filter((r) => r.userId === w.userId);
      if (w.consumedAt === null) matches = matches.filter((r) => r.consumedAt === null);
      if (w.expiresAt?.gt) {
        matches = matches.filter((r) => r.expiresAt.getTime() > w.expiresAt.gt.getTime());
      }
      for (const row of matches) Object.assign(row, args.data);
      return { count: matches.length };
    },
  );

  stubMethod(t, prisma.passwordReset as any, "findUnique", async (args: any) => {
    if (opts.gate) await opts.gate();
    return copy(store.find((r) => r.tokenHash === args.where.tokenHash));
  });

  stubMethod(t, prisma.passwordReset as any, "findFirst", async (args: any) => {
    if (opts.gate) await opts.gate();
    const w = args?.where ?? {};
    let matches = store.slice();
    if (w.tokenHash !== undefined) matches = matches.filter((r) => r.tokenHash === w.tokenHash);
    if (w.consumedAt === null) matches = matches.filter((r) => r.consumedAt === null);
    return copy(matches[0]);
  });

  return { store, creates, updateManys };
}

/** DeviceSignal, matching on (kind, hash) the way the real index does. */
function fakeDeviceSignals(t: Ctx, seed: Row[] = []) {
  const store: Row[] = seed.map((r, i) => ({
    id: `sig-${i}`,
    firstSeenAt: new Date(2026, 0, 1 + i),
    lastSeenAt: new Date(2026, 0, 1 + i),
    ...r,
  }));

  stubMethod(t, prisma.deviceSignal as any, "findMany", async (args: any) => {
    const or: Row[] = args?.where?.OR ?? [];
    const matches = store.filter((row) =>
      or.some((c) => c.kind === row.kind && c.hash === row.hash),
    );
    matches.sort((a, b) => a.firstSeenAt.getTime() - b.firstSeenAt.getTime());
    return matches.map((r) => ({ claimId: r.claimId, kind: r.kind }));
  });

  stubMethod(t, prisma.deviceSignal as any, "upsert", async (args: any) => {
    const { claimId, kind, hash } = args.where.claimId_kind_hash;
    const existing = store.find((r) => r.claimId === claimId && r.kind === kind && r.hash === hash);
    if (existing) {
      Object.assign(existing, args.update);
      return existing;
    }
    const row = { id: `sig-${store.length}`, ...args.create };
    store.push(row);
    return row;
  });

  return store;
}

function fakeClaims(t: Ctx, seed: Row[] = []) {
  const store: Row[] = seed.map((r, i) => ({
    id: `claim-${i}`,
    createdAt: new Date(2026, 0, 1 + i),
    trialDays: env.trialDays,
    ...r,
  }));

  stubMethod(t, prisma.trialClaim as any, "findUnique", async (args: any) =>
    copy(store.find((r) => r.id === args.where.id)),
  );
  stubMethod(t, prisma.trialClaim as any, "findFirst", async (args: any) => {
    const or: Row[] = args?.where?.OR ?? [];
    const matches = store.filter((row) =>
      or.some(
        (c) =>
          (c.deviceIdHash !== undefined && row.deviceIdHash === c.deviceIdHash) ||
          (c.firstUserId !== undefined && row.firstUserId === c.firstUserId) ||
          (c.idfvHash !== undefined && row.idfvHash === c.idfvHash),
      ),
    );
    matches.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    return copy(matches[0]);
  });
  const creates = stubMethod(t, prisma.trialClaim as any, "create", async (args: any) => {
    const row = { id: `claim-${store.length}`, createdAt: new Date(), ...args.data };
    store.push(row);
    return copy(row);
  });
  stubMethod(t, prisma.trialClaim as any, "update", async (args: any) =>
    copy(store.find((r) => r.id === args.where.id)),
  );

  return { store, creates };
}

/* ── the machine ──────────────────────────────────────────────────────────── */

/** One computer's self-declared hardware. */
const MACHINE = {
  mg: "8d4a1f22-77c9-4e0e-9c2d-2b0f9a11c333",
  vs: "9C4F2AB1",
  macs: ["a4bb6d112233", "d8f2ca445566"],
};

const fpHeader = (payload: Record<string, unknown>) =>
  Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");

const fp = (payload: Record<string, unknown>) => ({ [FINGERPRINT_HEADER]: fpHeader(payload) });

/** The signals a claim on MACHINE would have recorded. */
const machineSignals = (claimId: string) => [
  { claimId, kind: "mguid", hash: fingerprintHash("mguid", MACHINE.mg) },
  { claimId, kind: "vol", hash: fingerprintHash("vol", MACHINE.vs) },
  { claimId, kind: "mac", hash: fingerprintHash("mac", MACHINE.macs[0]) },
];

const fakeRequest = (headerValue?: string, body?: unknown) =>
  ({
    header: (name: string) => (name === FINGERPRINT_HEADER ? headerValue : undefined),
    body,
  }) as unknown as ExpressRequest;

/* ════════════════════════════════════════════════════════════════════════════
 * EMAIL VERIFICATION
 * ══════════════════════════════════════════════════════════════════════════ */

/*
 * The regression test for the two clients already in the field. The Windows Rust
 * client deserialises the register response into a struct with a non-optional
 * `token`, so a missing field is a hard failure rather than a degraded signup;
 * the Expo client reads `body.token` unconditionally. Adding a verification step
 * to registration is exactly the change that tempts someone to answer
 * `{ ok: true, needsVerification: true }` instead.
 */
test("registration still returns BOTH token and user, so the shipped clients keep parsing it", async (t) => {
  fakeUsers(t, []);
  fakeVerifications(t, []);
  const mail = mailbox(t);

  const res = await request(app)
    .post("/api/auth/register")
    .send({ email: "fresh@example.com", password: "hunter2hunter2" });

  assert.equal(res.status, 201);
  assert.equal(typeof res.body.token, "string", "the Rust client hard-fails without `token`");
  assert.ok(res.body.token.length > 0);
  assert.ok(res.body.user, "and the Expo client reads `user` from the same response");
  assert.equal(res.body.user.email, "fresh@example.com");
  assert.equal(res.body.user.passwordHash, undefined, "never the hash");
  assert.equal(mail.length, 1, "the code goes out inline, with no second round trip");
});

test("a correct code sets emailVerified and stamps emailVerifiedAt", async (t) => {
  const CODE = "123456";
  const { updates } = fakeUsers(t, [{ id: USER_ID, email: USER_EMAIL, emailVerified: false }]);
  const { store } = fakeVerifications(t, [
    {
      userId: USER_ID,
      email: USER_EMAIL,
      codeHash: hashCode(CODE),
      expiresAt: minutesFromNow(10),
    },
  ]);

  const res = await request(app).post("/api/auth/verify-email").set(auth).send({ code: CODE });

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.alreadyVerified, false);
  assert.equal(updates.length, 1);
  assert.equal(updates[0][0].data.emailVerified, true);
  assert.ok(updates[0][0].data.emailVerifiedAt instanceof Date, "and stamps WHEN");
  assert.ok(store[0].consumedAt, "the code is spent");
});

/*
 * Five guesses is the whole budget for one code, and the sixth request proves the
 * budget cannot be refunded by simply knowing the answer: the row is consumed on
 * exhaustion, so a code obtained afterwards by other means is already dead.
 */
test("five wrong codes exhaust the attempt cap, and the code is dead even to a correct guess", async (t) => {
  setEnv(t, { emailVerificationMaxAttempts: 5 });
  const CODE = "123456";
  const { updates } = fakeUsers(t, [{ id: USER_ID, email: USER_EMAIL, emailVerified: false }]);
  const { store } = fakeVerifications(t, [
    {
      userId: USER_ID,
      email: USER_EMAIL,
      codeHash: hashCode(CODE),
      expiresAt: minutesFromNow(10),
    },
  ]);

  const answers = [];
  for (let i = 0; i < 5; i++) {
    answers.push(await request(app).post("/api/auth/verify-email").set(auth).send({ code: "000000" }));
  }

  for (let i = 0; i < 4; i++) {
    assert.equal(answers[i].status, 400);
    assert.equal(answers[i].body.code, "VERIFICATION_CODE_INVALID", `guess ${i + 1} is just wrong`);
  }
  assert.equal(answers[4].status, 400);
  assert.equal(
    answers[4].body.code,
    "VERIFICATION_ATTEMPTS_EXHAUSTED",
    "the fifth says request a new code, not try again",
  );
  assert.equal(store[0].attempts, 5);
  assert.ok(store[0].consumedAt, "an exhausted code is retired, not merely counted");

  const sixth = await request(app).post("/api/auth/verify-email").set(auth).send({ code: CODE });

  assert.equal(sixth.status, 400, "the RIGHT code no longer works — the row was consumed");
  assert.equal(sixth.body.code, "VERIFICATION_CODE_INVALID");
  assert.equal(updates.length, 0, "and nothing was ever marked verified");
});

/*
 * The one that fails if `{ increment: 1 }` becomes a read-modify-write.
 *
 * All five requests are held inside the read so they demonstrably share one
 * snapshot of `attempts`. Computed in JavaScript, all five would write 0 + 1 and
 * the budget would buy five guesses for the price of one — repeat that and a
 * six-digit code is brute-forced by an attacker who sets their own limit.
 */
test("five CONCURRENT wrong codes each cost an attempt — the counter is atomic", async (t) => {
  setEnv(t, { emailVerificationMaxAttempts: 5 });
  fakeUsers(t, [{ id: USER_ID, email: USER_EMAIL, emailVerified: false }]);
  const { store } = fakeVerifications(
    t,
    [
      {
        userId: USER_ID,
        email: USER_EMAIL,
        codeHash: hashCode("123456"),
        expiresAt: minutesFromNow(10),
      },
    ],
    { gate: barrier(5) },
  );

  const answers = await Promise.all(
    Array.from({ length: 5 }, () =>
      request(app).post("/api/auth/verify-email").set(auth).send({ code: "000000" }),
    ),
  );

  assert.equal(store[0].attempts, 5, "five parallel guesses cost five attempts, not one");
  assert.equal(
    answers.filter((r) => r.body.code === "VERIFICATION_ATTEMPTS_EXHAUSTED").length,
    1,
    "exactly one of them is the one that spends the last attempt",
  );
  assert.ok(store[0].consumedAt);
});

/*
 * Mongo's TTL monitor is best-effort and runs about once a minute, and Prisma
 * cannot declare a TTL index at all — so a row whose `expiresAt` has passed is
 * routinely still there. If the guarantee lived in the sweeper rather than in the
 * `where` clause, that row would still verify an account.
 */
test("an expired code is refused by the QUERY, while its row is still sitting in the table", async (t) => {
  const CODE = "123456";
  const { updates } = fakeUsers(t, [{ id: USER_ID, email: USER_EMAIL, emailVerified: false }]);
  const { store } = fakeVerifications(t, [
    {
      userId: USER_ID,
      email: USER_EMAIL,
      codeHash: hashCode(CODE),
      expiresAt: minutesFromNow(-1),
    },
  ]);

  const res = await request(app).post("/api/auth/verify-email").set(auth).send({ code: CODE });

  assert.equal(res.status, 400);
  assert.equal(res.body.code, "VERIFICATION_CODE_INVALID");
  assert.equal(store.length, 1, "no sweeper ran — the row is exactly where it was");
  assert.equal(store[0].consumedAt, null);
  assert.equal(updates.length, 0);
});

/*
 * `EmailVerification.email` is snapshotted at issue time for this: otherwise a
 * code mailed to the OLD address would verify the NEW one, which proves the user
 * can read an inbox they no longer claim — and "verified" would mean nothing
 * about the address the account actually uses.
 */
test("a code issued for the old address does not verify the account after the address changed", async (t) => {
  const CODE = "123456";
  const { updates } = fakeUsers(t, [
    { id: USER_ID, email: "new@example.com", emailVerified: false },
  ]);
  const { store } = fakeVerifications(t, [
    {
      userId: USER_ID,
      email: "old@example.com",
      codeHash: hashCode(CODE),
      expiresAt: minutesFromNow(10),
    },
  ]);

  const res = await request(app).post("/api/auth/verify-email").set(auth).send({ code: CODE });

  assert.equal(res.status, 400);
  assert.equal(res.body.code, "VERIFICATION_CODE_INVALID");
  assert.equal(updates.length, 0, "new@example.com was never proved");
  assert.equal(store[0].consumedAt, null);
});

/*
 * A second device finishing the funnel lands here legitimately, so this is an ok
 * — not an error. Sending anyway would mail a code for an account that can no
 * longer use one, which is both noise and a free mail cannon.
 */
test("asking for a code on an already-verified account is ok, and sends nothing", async (t) => {
  fakeUsers(t, [{ id: USER_ID, email: USER_EMAIL, emailVerified: true }]);
  const { creates } = fakeVerifications(t, []);
  const mail = mailbox(t);

  const res = await request(app).post("/api/auth/verify-email/request").set(auth).send({});

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.alreadyVerified, true);
  assert.equal(mail.length, 0, "no email");
  assert.equal(creates.length, 0, "and no code minted to go stale");
});

/*
 * Both verification routes answer `email` on EVERY branch. The
 * already-verified early return used to omit it while the success path and
 * /verify-email/request both carried it, so a client reading `body.email` — to
 * render "verified j***@gmail.com" — got `undefined` on the one branch a second
 * device finishing the funnel actually lands on.
 */
test("every verify-email branch carries `email`, including the already-verified one", async (t) => {
  fakeUsers(t, [{ id: USER_ID, email: USER_EMAIL, emailVerified: true }]);
  fakeVerifications(t, []);

  const consume = await request(app)
    .post("/api/auth/verify-email")
    .set(auth)
    .send({ code: "123456" });
  const requested = await request(app).post("/api/auth/verify-email/request").set(auth).send({});

  assert.equal(consume.status, 200);
  assert.equal(consume.body.alreadyVerified, true);
  assert.equal(consume.body.email, USER_EMAIL, "the early return must not drop the address");
  assert.equal(requested.body.email, USER_EMAIL, "the sibling route has always carried it");
});

/* ════════════════════════════════════════════════════════════════════════════
 * PASSWORD RESET
 * ══════════════════════════════════════════════════════════════════════════ */

/*
 * `POST /api/auth/register` already leaks account existence through its 409.
 * That is one oracle too many, not a licence for a second — and a reset endpoint
 * that answers differently for a known address hands anyone a way to test a
 * breach dump against this user base.
 */
test("a reset request for a known and an unknown address are byte-identical", async (t) => {
  fakeUsers(t, [{ id: USER_ID, email: "known@example.com", passwordHash: "$2a$10$hash" }]);
  fakeResets(t, []);
  mailbox(t);

  const known = await request(app)
    .post("/api/auth/password/reset-request")
    .send({ email: "known@example.com" });
  const unknown = await request(app)
    .post("/api/auth/password/reset-request")
    .send({ email: "nobody@example.com" });

  assert.equal(known.status, 200);
  assert.equal(known.status, unknown.status);
  assert.equal(known.text, unknown.text, "same bytes, not merely the same shape");
  await settle();
});

/*
 * An Apple-only account has no `passwordHash`. Handing it a reset link would let
 * anyone who knows the provider email SET a password on it — converting a social
 * account into a password account and taking it over without ever touching Apple.
 */
test("an Apple-only account gets the same 200 and no reset row is ever created", async (t) => {
  fakeUsers(t, [{ id: USER_ID, email: "apple@example.com", passwordHash: null }]);
  const { creates } = fakeResets(t, []);
  const mail = mailbox(t);

  const res = await request(app)
    .post("/api/auth/password/reset-request")
    .send({ email: "apple@example.com" });

  assert.equal(res.status, 200);
  await settle();
  assert.equal(creates.length, 0, "no token to set a password with");
  assert.equal(mail.length, 0, "and no link to click");
});

test("a reset token works exactly once", async (t) => {
  const TOKEN = "a".repeat(43);
  fakeUsers(t, [{ id: USER_ID, email: USER_EMAIL, passwordHash: "$2a$10$hash" }]);
  fakeResets(t, [
    {
      userId: USER_ID,
      email: USER_EMAIL,
      tokenHash: hashResetToken(TOKEN),
      expiresAt: minutesFromNow(60),
    },
  ]);

  const first = await request(app)
    .post("/api/auth/password/reset")
    .send({ token: TOKEN, password: "newpassword123" });
  const second = await request(app)
    .post("/api/auth/password/reset")
    .send({ token: TOKEN, password: "anotherpassword123" });

  assert.equal(first.status, 200);
  assert.equal(second.status, 400);
  assert.equal(second.body.code, "RESET_TOKEN_INVALID");
});

/*
 * The one that fails if the conditional `updateMany` becomes findFirst + update.
 *
 * Both requests are held until both have arrived, so they genuinely contend. A
 * check-then-act would let both pass the read and both set a password — which is
 * how a link forwarded, quoted or prefetched twice stops being single-use.
 */
test("two SIMULTANEOUS consumptions of one token yield exactly one winner", async (t) => {
  const TOKEN = "b".repeat(43);
  fakeUsers(t, [{ id: USER_ID, email: USER_EMAIL, passwordHash: "$2a$10$hash" }]);
  fakeResets(
    t,
    [
      {
        userId: USER_ID,
        email: USER_EMAIL,
        tokenHash: hashResetToken(TOKEN),
        expiresAt: minutesFromNow(60),
      },
    ],
    { gate: barrier(2) },
  );

  const answers = await Promise.all([
    request(app).post("/api/auth/password/reset").send({ token: TOKEN, password: "newpassword123" }),
    request(app).post("/api/auth/password/reset").send({ token: TOKEN, password: "otherpassword123" }),
  ]);

  const statuses = answers.map((r) => r.status).sort();
  assert.deepEqual(statuses, [200, 400], "one wins, one is told the link is spent");
  assert.equal(
    answers.find((r) => r.status === 400)!.body.code,
    "RESET_TOKEN_INVALID",
    "and the loser learns nothing about why",
  );
});

/*
 * Telling these three apart would tell an attacker holding a guessed token which
 * guesses are real, and telling a stranger that an address has an outstanding
 * reset is itself an account-existence oracle.
 */
test("expired, unknown and already-consumed tokens answer identically", async (t) => {
  const EXPIRED = "c".repeat(43);
  const CONSUMED = "d".repeat(43);
  const UNKNOWN = "e".repeat(43);
  fakeUsers(t, [{ id: USER_ID, email: USER_EMAIL, passwordHash: "$2a$10$hash" }]);
  fakeResets(t, [
    {
      userId: USER_ID,
      email: USER_EMAIL,
      tokenHash: hashResetToken(EXPIRED),
      expiresAt: minutesFromNow(-1),
    },
    {
      userId: USER_ID,
      email: USER_EMAIL,
      tokenHash: hashResetToken(CONSUMED),
      expiresAt: minutesFromNow(60),
      consumedAt: new Date(),
    },
  ]);

  const answers = await Promise.all(
    [EXPIRED, CONSUMED, UNKNOWN].map((token) =>
      request(app).post("/api/auth/password/reset").send({ token, password: "newpassword123" }),
    ),
  );

  for (const res of answers) {
    assert.equal(res.status, 400);
    assert.equal(res.body.code, "RESET_TOKEN_INVALID");
  }
  assert.equal(answers[0].text, answers[1].text);
  assert.equal(answers[1].text, answers[2].text, "one answer for all three, down to the bytes");
});

/*
 * A reset that accepted a weaker password than registration would be a downgrade
 * path around the rule rather than a second opinion about it.
 */
test("a 7-character password is refused by reset with the same rule as registration", async (t) => {
  fakeUsers(t, []);
  fakeResets(t, []);
  fakeVerifications(t, []);

  const reset = await request(app)
    .post("/api/auth/password/reset")
    .send({ token: "f".repeat(43), password: "short77" });
  const register = await request(app)
    .post("/api/auth/register")
    .send({ email: "seven@example.com", password: "short77" });

  assert.equal(reset.status, 400);
  assert.equal(register.status, 400);
  assert.match(reset.body.error, /at least 8 characters/);
  assert.equal(reset.body.error, register.body.error, "one rule, stated once");
});

/*
 * A reset whose whole point is locking someone out must not leave them signed in,
 * and must not leave a second link they did not ask for lying live in an inbox.
 */
test("a successful reset stamps passwordChangedAt and voids every other outstanding link", async (t) => {
  const TOKEN = "g".repeat(43);
  const { updates } = fakeUsers(t, [
    { id: USER_ID, email: USER_EMAIL, passwordHash: "$2a$10$hash" },
  ]);
  const { store } = fakeResets(t, [
    {
      userId: USER_ID,
      email: USER_EMAIL,
      tokenHash: hashResetToken(TOKEN),
      expiresAt: minutesFromNow(60),
    },
    {
      userId: USER_ID,
      email: USER_EMAIL,
      tokenHash: hashResetToken("h".repeat(43)),
      expiresAt: minutesFromNow(60),
    },
  ]);

  const res = await request(app)
    .post("/api/auth/password/reset")
    .send({ token: TOKEN, password: "newpassword123" });

  assert.equal(res.status, 200);
  assert.equal(updates.length, 1);
  const written = updates[0][0].data;
  assert.ok(written.passwordChangedAt instanceof Date, "the session cut-off is stamped");
  assert.ok(
    typeof written.passwordHash === "string" && written.passwordHash.startsWith("$2"),
    "and a real bcrypt hash is stored, never the plaintext",
  );
  assert.ok(store[0].consumedAt, "the link just used is spent");
  assert.ok(store[1].consumedAt, "and so is the other one nobody asked for");
});

/*
 * The classic way this exact email becomes an account-takeover primitive: behind
 * a permissive proxy `Host` is attacker-controlled, and a link built from it is
 * mailed to the victim by us, from our domain, looking entirely legitimate.
 */
test("a poisoned Host header cannot redirect the reset link away from PUBLIC_SITE_URL", async (t) => {
  fakeUsers(t, [{ id: USER_ID, email: USER_EMAIL, passwordHash: "$2a$10$hash" }]);
  fakeResets(t, []);
  const mail = mailbox(t);

  const res = await request(app)
    .post("/api/auth/password/reset-request")
    .set("Host", "evil.com")
    .set("X-Forwarded-Host", "evil.com")
    .send({ email: USER_EMAIL });

  assert.equal(res.status, 200);
  await until(() => mail.length > 0);
  assert.equal(mail.length, 1);

  const url = /https?:\/\/\S+\/reset-password\?token=[^\s"<]+/.exec(mail[0].text)?.[0];
  assert.ok(url, "the mail carries a link");
  assert.ok(
    url!.startsWith(`${env.publicSiteUrl}/reset-password?token=`),
    `link must come from PUBLIC_SITE_URL, got ${url}`,
  );
  assert.ok(!mail[0].text.includes("evil.com"), "and the attacker's host appears nowhere");
  assert.ok(!mail[0].html.includes("evil.com"));
});

/* ════════════════════════════════════════════════════════════════════════════
 * SESSION INVALIDATION + THE MOUNTING ITSELF
 * ══════════════════════════════════════════════════════════════════════════ */

/*
 * These now run against the REAL app. They used to need a minimal Express app of
 * their own, because `requireVerifiedAccount` was exported and mounted on
 * nothing — the middleware existed and reached no route, so every guarantee
 * below was inert in production while looking tested. It is mounted now (see
 * app.ts), so the synthetic app is gone and `/api/me` is the subject.
 *
 * `/api/me` is a good probe precisely because it makes its OWN user read after
 * the guard's: a 200 here means the request went all the way through the guard
 * into the handler, not merely past the middleware.
 */

/*
 * Without this check a reset does not actually end other sessions: these tokens
 * are stateless, carry no id and have no revocation list, so someone resetting a
 * STOLEN password would leave the thief signed in for up to thirty more days —
 * which is the one thing the person resetting is trying to stop.
 */
test("a JWT issued before passwordChangedAt is rejected on a real gated route", async (t) => {
  setEnv(t, { emailVerificationEnforced: false });
  fakeUsers(t, [
    {
      id: USER_ID,
      email: USER_EMAIL,
      emailVerified: true,
      // The token is minted now; the password moved an hour later.
      passwordChangedAt: minutesFromNow(60),
    },
  ]);

  const res = await request(app).get("/api/me").set(auth);

  assert.equal(res.status, 401);
  assert.match(res.body.error, /password changed/i);
  assert.equal(res.body.user, undefined, "and the handler never ran");
});

/*
 * Every account that predates this feature reads `passwordChangedAt` null.
 * Treating null as "changed at the epoch" would sign out the ENTIRE existing
 * user base the moment this deploys — a self-inflicted outage dressed as a
 * security improvement.
 */
test("a JWT for an account that has never changed its password is STILL VALID", async (t) => {
  setEnv(t, { emailVerificationEnforced: false });
  fakeUsers(t, [
    { id: USER_ID, email: USER_EMAIL, emailVerified: true, passwordChangedAt: null },
  ]);

  const res = await request(app).get("/api/me").set(auth);

  assert.equal(res.status, 200, "null must mean `never changed`, not `changed at the epoch`");
  assert.equal(res.body.user.id, USER_ID, "and the handler really ran");
});

/*
 * THE regression test for the bug this whole round came from: a middleware that
 * exists, is correct, is exported — and is reached by nothing. Every assertion
 * above about verification and session freshness was true of the function and
 * false of the API, which is the failure mode that unit-testing a middleware in
 * isolation cannot see. So this one asserts the WIRING: turn the flag on and a
 * gated route must actually refuse.
 */
test("with EMAIL_VERIFICATION_ENFORCED on, a gated route refuses an unverified account", async (t) => {
  setEnv(t, { emailVerificationEnforced: true });
  fakeUsers(t, [
    { id: USER_ID, email: USER_EMAIL, emailVerified: false, passwordChangedAt: null },
  ]);
  stubMethod(t, prisma.syncSnapshot as any, "findUnique", async () => null);

  const me = await request(app).get("/api/me").set(auth);
  const sync = await request(app).get("/api/sync/pull").set(auth);

  for (const [name, res] of [["/api/me", me], ["/api/sync", sync]] as const) {
    assert.equal(res.status, 403, `${name} must refuse`);
    assert.equal(res.body.code, "EMAIL_NOT_VERIFIED", name);
    assert.equal(
      res.body.email,
      USER_EMAIL,
      `${name} carries the address so the client can say where the code went`,
    );
  }
});

/*
 * The two deliberate exclusions, asserted in the same breath as the enforcement
 * above — because "gate everything" and "gate everything except these two" look
 * identical until someone checks, and both exclusions are load-bearing:
 *
 *  * the funnel pushes its answers immediately after account creation and BEFORE
 *    the code screen, so gating it would break registration itself;
 *  * a locked-out client must always be able to read WHY it is locked, or the
 *    paywall is a blank screen with no way forward.
 */
test("the same flag does NOT lock an unverified account out of entitlement or onboarding", async (t) => {
  setEnv(t, { emailVerificationEnforced: true });
  fakeUsers(t, [
    {
      id: USER_ID,
      email: USER_EMAIL,
      emailVerified: false,
      passwordChangedAt: null,
      trialEndsAt: null,
      compActive: false,
      compedUntil: null,
      accessRevoked: false,
    },
  ]);
  stubMethod(t, prisma.purchase as any, "findMany", async () => []);
  stubMethod(t, prisma.trialClaim as any, "findFirst", async () => null);
  stubMethod(t, prisma.onboardingProfile as any, "findUnique", async () => null);

  const entitlement = await request(app).get("/api/entitlement").set(auth);
  const onboarding = await request(app).get("/api/onboarding").set(auth);

  assert.equal(entitlement.status, 200, "a locked client must still be able to read why");
  assert.notEqual(entitlement.body.code, "EMAIL_NOT_VERIFIED");
  assert.ok(entitlement.body.status, "and it answers a real entitlement, not an empty 200");

  assert.equal(onboarding.status, 200, "the funnel runs BEFORE the code screen");
  assert.notEqual(onboarding.body.code, "EMAIL_NOT_VERIFIED");
});

/*
 * The session cut-off is NOT behind the verification flag — it is the half of
 * the guard that must hold even where verification is deliberately not required,
 * or a password reset would end other sessions everywhere except the two routes
 * an attacker can still reach.
 */
test("the session cut-off still applies on the routes that skip verification", async (t) => {
  setEnv(t, { emailVerificationEnforced: false });
  fakeUsers(t, [
    { id: USER_ID, email: USER_EMAIL, emailVerified: true, passwordChangedAt: minutesFromNow(60) },
  ]);

  const entitlement = await request(app).get("/api/entitlement").set(auth);
  const onboarding = await request(app).get("/api/onboarding").set(auth);

  assert.equal(entitlement.status, 401, "requireCurrentSession is still a current-session check");
  assert.equal(onboarding.status, 401);
});

/* ════════════════════════════════════════════════════════════════════════════
 * DEVICE BINDING
 * ══════════════════════════════════════════════════════════════════════════ */

test("with DEVICE_BINDING_ENFORCED on, a claimed machine whose owner still exists is refused", async (t) => {
  setEnv(t, { deviceBindingEnforced: true });
  fakeUsers(t, [{ id: OWNER_ID, email: "owner@example.com" }]);
  fakeVerifications(t, []);
  fakeDeviceSignals(t, machineSignals("claim-0"));
  fakeClaims(t, [{ firstUserId: OWNER_ID, endsAt: minutesFromNow(60 * 24) }]);

  const res = await request(app)
    .post("/api/auth/register")
    .set(fp({ mg: MACHINE.mg }))
    .send({ email: "second@example.com", password: "hunter2hunter2" });

  assert.equal(res.status, 409);
  assert.equal(res.body.code, "DEVICE_ALREADY_CLAIMED");
});

/*
 * The anti-farm guarantee needs NO flag. The 409 is only about refusing outright
 * — and it is behind a switch because its false positives are real people on a
 * shared family PC or a resold laptop. With it off the account is allowed, and
 * the machine's existing claim is what it lands on, so there is no second trial.
 */
test("with the flag OFF the same registration succeeds but shares the existing claim", async (t) => {
  setEnv(t, { deviceBindingEnforced: false });
  fakeUsers(t, [{ id: OWNER_ID, email: "owner@example.com" }]);
  fakeVerifications(t, []);
  fakeDeviceSignals(t, machineSignals("claim-0"));
  const { store, creates } = fakeClaims(t, [
    { firstUserId: OWNER_ID, endsAt: minutesFromNow(-60 * 24 * 30) },
  ]);
  mailbox(t);

  const res = await request(app)
    .post("/api/auth/register")
    .set(fp({ mg: MACHINE.mg }))
    // A NEW device id: app data was wiped, so only the hardware still recognises it.
    .set({ "x-welockin-device-id": "win-a-brand-new-device-id" })
    .send({ email: "second@example.com", password: "hunter2hunter2" });

  assert.equal(res.status, 201, "the account is allowed — only the trial is not");
  assert.equal(creates.length, 0, "no second claim");
  assert.equal(store.length, 1, "one machine, one window, whatever the flag says");
});

/*
 * `DELETE /api/me` hard-deletes the user row and nulls `firstUserId`; the claim
 * survives so the anti-farm guarantee holds either way. Refusing here would mean
 * deleting your account bricked your computer, with no way back but support.
 */
test("a claim whose owner deleted their account does not block registration", async (t) => {
  setEnv(t, { deviceBindingEnforced: true });
  fakeUsers(t, []);
  fakeVerifications(t, []);
  fakeDeviceSignals(t, machineSignals("claim-0"));
  fakeClaims(t, [{ firstUserId: null, endsAt: minutesFromNow(-60 * 24 * 30) }]);
  mailbox(t);

  const res = await request(app)
    .post("/api/auth/register")
    .set(fp({ mg: MACHINE.mg }))
    .send({ email: "again@example.com", password: "hunter2hunter2" });

  assert.equal(res.status, 201);
  assert.ok(res.body.token);
});

/* ── fingerprint matching rules (no HTTP) ─────────────────────────────────── */

/*
 * The owner asked to key "one account per machine" on the MAC address. A MAC
 * alone cannot carry that in EITHER direction: Windows randomises Wi-Fi MACs per
 * network by default and a USB dock walks its MAC between laptops. So the
 * honest user who unplugs a dock would look like a new machine while the
 * fraudster who spoofs one would look like an old machine — exactly backwards.
 */
test("a matching MachineGuid alone IS the same machine", async (t) => {
  fakeDeviceSignals(t, machineSignals("claim-0"));

  const { signals } = parseFingerprint(fakeRequest(fpHeader({ mg: MACHINE.mg })));
  assert.equal(signals.length, 1);
  assert.equal(await matchClaimByFingerprint(signals), "claim-0");
});

test("a matching MAC alone is NOT the same machine", async (t) => {
  fakeDeviceSignals(t, machineSignals("claim-0"));

  const { signals } = parseFingerprint(fakeRequest(fpHeader({ mac: [MACHINE.macs[0]] })));
  assert.equal(signals.length, 1);
  assert.equal(
    await matchClaimByFingerprint(signals),
    null,
    "a shared dock must not merge two colleagues into one machine",
  );
});

test("a matching volume serial alone is NOT the same machine", async (t) => {
  fakeDeviceSignals(t, machineSignals("claim-0"));

  const { signals } = parseFingerprint(fakeRequest(fpHeader({ vs: MACHINE.vs })));
  assert.equal(signals.length, 1);
  assert.equal(await matchClaimByFingerprint(signals), null);
});

/*
 * The leg that survives a MachineGuid reset — needing two signals is what stops
 * either weak one from concluding on its own.
 */
test("a volume serial together with one MAC IS the same machine", async (t) => {
  fakeDeviceSignals(t, machineSignals("claim-0"));

  const { signals } = parseFingerprint(
    fakeRequest(fpHeader({ vs: MACHINE.vs, mac: [MACHINE.macs[0]] })),
  );
  assert.equal(signals.length, 2);
  assert.equal(await matchClaimByFingerprint(signals), "claim-0");
});

/*
 * A client that garbles its own fingerprint is a machine we have never seen, not
 * a request to refuse — and certainly not a 500. The payload is entirely
 * self-declared, so every shape below is something an attacker can send.
 */
test("a malformed fingerprint yields zero signals instead of throwing", () => {
  const cases: Array<[string, string]> = [
    ["not base64url at all", "!!!!not-base64!!!!"],
    ["valid base64, not JSON", Buffer.from("hello there", "utf8").toString("base64url")],
    ["JSON that fails the schema", fpHeader({ mg: 12345 })],
    ["a MAC in the wrong shape", fpHeader({ mac: ["NOT-A-MAC"] })],
    ["an empty object", fpHeader({})],
    ["an empty header", ""],
  ];

  for (const [label, header] of cases) {
    const parsed = parseFingerprint(fakeRequest(header));
    assert.deepEqual(parsed.signals, [], label);
    assert.equal(parsed.hardwareBacked, false, label);
  }

  // And with no header and no body at all.
  assert.deepEqual(parseFingerprint(fakeRequest(undefined, undefined)).signals, []);
});

/*
 * `hardwareBacked` may only ever WEAKEN a claim, never strengthen one — so a
 * client asserting it without actually supplying a machine id gets nothing.
 */
test("hardwareBacked is only believed when a machine id actually accompanies it", () => {
  assert.equal(parseFingerprint(fakeRequest(fpHeader({ mg: MACHINE.mg, hw: true }))).hardwareBacked, true);
  assert.equal(
    parseFingerprint(fakeRequest(fpHeader({ vs: MACHINE.vs, hw: true }))).hardwareBacked,
    false,
    "claiming hardware backing without a MachineGuid buys nothing",
  );
});
