import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { InvalidTransaction, verifySignedTransaction } from "./apple-jws";
import { LIFETIME_PRODUCT_ID, PLAN, TRIAL_PRODUCT_ID, purchaseEffect } from "./entitlement";

/* These tests do not forge an Apple signature — that is the point. They prove
   the verifier REFUSES everything short of one, which is the only property that
   stands between a hand-written JSON and a free lifetime unlock. */

const b64u = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const appleRoot = readFileSync(join(__dirname, "certs", "AppleRootCA-G3.cer")).toString("base64");

const jws = (header: unknown, payload: unknown = {}, sig = "AAAA") =>
  `${b64u(header)}.${b64u(payload)}.${sig}`;

test("a malformed token is refused", () => {
  for (const bad of ["", "abc", "a.b", "a.b.c.d"]) {
    assert.throws(() => verifySignedTransaction(bad), InvalidTransaction, bad);
  }
});

test("alg:none — the classic JWT forgery — is refused", () => {
  assert.throws(
    () => verifySignedTransaction(jws({ alg: "none", x5c: [appleRoot, appleRoot, appleRoot] })),
    /Unexpected algorithm/,
  );
});

test("an HMAC alg is refused, since the 'key' would be public data", () => {
  assert.throws(
    () => verifySignedTransaction(jws({ alg: "HS256", x5c: [appleRoot, appleRoot, appleRoot] })),
    /Unexpected algorithm/,
  );
});

test("a token with no certificate chain is refused", () => {
  assert.throws(() => verifySignedTransaction(jws({ alg: "ES256" })), /Missing certificate chain/);
  assert.throws(
    () => verifySignedTransaction(jws({ alg: "ES256", x5c: [appleRoot] })),
    /Missing certificate chain/,
  );
});

test("a chain that does not end at Apple's root is refused", () => {
  // The attacker controls every certificate they send, so this is THE guard:
  // a perfectly self-consistent chain signed by an attacker's own root must die.
  const notApple =
    "MIIBkTCB+wIJAKZ0dQFPBQFLMAoGCCqGSM49BAMCMBExDzANBgNVBAMMBmZvcmdlZDAeFw0yMDAxMDEwMDAwMDBaFw0zMDAxMDEwMDAwMDBaMBExDzANBgNVBAMMBmZvcmdlZDBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABGJ1p8k0YQY7Xk0Uu5Uu8+8p6cQ0Y8bBqK5r6H8f4h1yQ0v3v0Zq7XZ5x1TnD3Kx1t6qJ7oW9wX0Zk8k5Y3o1owCgYIKoZIzj0EAwIDSAAwRQIhAO";
  assert.throws(
    () => verifySignedTransaction(jws({ alg: "ES256", x5c: [notApple, notApple, notApple] })),
    InvalidTransaction,
  );
});

test("Apple's real root, but a signature that is not Apple's, is refused", () => {
  // The chain terminates correctly and every certificate parses; only the
  // signature over the payload is wrong. This is what a replayed-and-edited
  // transaction looks like.
  assert.throws(
    () =>
      verifySignedTransaction(
        jws(
          { alg: "ES256", x5c: [appleRoot, appleRoot, appleRoot] },
          { transactionId: "1", bundleId: "in.welock.app", productId: LIFETIME_PRODUCT_ID, purchaseDate: 1 },
        ),
      ),
    InvalidTransaction,
  );
});

/* ── the revenue rules, tested without any signature at all ─────────────── */

const DAY = 86_400_000;
const T0 = Date.parse("2026-07-01T00:00:00.000Z");
const empty = { plan: "trial", trialEndsAt: null };

test("the trial is stamped from APPLE's purchase date, not the phone's", () => {
  const e = purchaseEffect({ productId: TRIAL_PRODUCT_ID, purchaseDate: T0, revoked: false }, empty, 14);
  assert.equal(e.trialEndsAt?.getTime(), T0 + 14 * DAY);
});

test("replaying the trial transaction buys no extra day", () => {
  const already = { plan: "trial", trialEndsAt: new Date(T0 + 3 * DAY) };
  assert.deepEqual(
    purchaseEffect({ productId: TRIAL_PRODUCT_ID, purchaseDate: T0 + 90 * DAY, revoked: false }, already, 14),
    {},
    "create-only: an existing window is never moved",
  );
});

test("a revoked trial grants nothing", () => {
  assert.deepEqual(
    purchaseEffect({ productId: TRIAL_PRODUCT_ID, purchaseDate: T0, revoked: true }, empty, 14),
    {},
  );
});

test("the lifetime unlock sets the plan, and a refund takes it away", () => {
  assert.deepEqual(
    purchaseEffect({ productId: LIFETIME_PRODUCT_ID, purchaseDate: T0, revoked: false }, empty, 14),
    { plan: PLAN.lifetime },
  );
  assert.deepEqual(
    purchaseEffect(
      { productId: LIFETIME_PRODUCT_ID, purchaseDate: T0, revoked: true },
      { plan: PLAN.lifetime, trialEndsAt: null },
      14,
    ),
    { plan: PLAN.refunded },
    "a refunded lifetime must not keep access",
  );
});

test("a product we do not sell changes nothing", () => {
  assert.deepEqual(
    purchaseEffect({ productId: "com.someone.else", purchaseDate: T0, revoked: false }, empty, 14),
    {},
  );
});
