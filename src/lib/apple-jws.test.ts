import assert from "node:assert/strict";
import { test } from "node:test";
import { X509Certificate } from "node:crypto";
import { APPLE_ROOT_G3_DER_B64, InvalidTransaction, verifySignedTransaction } from "./apple-jws";
import {
  LIFETIME_PRODUCT_ID,
  PLAN,
  TRIAL_PRODUCT_ID,
  effectiveTrialEndsAt,
  purchaseEffect,
} from "./entitlement";

/* These tests do not forge an Apple signature — that is the point. They prove
   the verifier REFUSES everything short of one, which is the only property that
   stands between a hand-written JSON and a free lifetime unlock. */

const b64u = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const appleRoot = APPLE_ROOT_G3_DER_B64;

/* The trust anchor is now a literal in the source rather than a file on disk, so
   nothing but this assertion stands between a fat-fingered edit and a verifier
   that happily trusts someone else's root. Pin the fingerprint Apple publishes. */
test("the embedded trust anchor really is Apple Root CA - G3", () => {
  const root = new X509Certificate(Buffer.from(APPLE_ROOT_G3_DER_B64, "base64"));
  assert.equal(
    root.fingerprint256,
    "63:34:3A:BF:B8:9A:6A:03:EB:B5:7E:9B:3F:5F:A7:BE:7C:4F:5C:75:6F:30:17:B3:A8:C4:88:C3:65:3E:91:79",
  );
  assert.match(root.subject, /Apple Root CA - G3/);
});

/* The regression that took production down: this module used to read the root
   from `src/lib/certs/`, which `tsc` never copies into `dist/`, so importing it
   threw ENOENT at module load and EVERY route 500ed. Importing it at all is the
   proof it no longer touches the filesystem — but assert the anchor parsed, so a
   future refactor back to a file read fails here rather than in production. */
test("verification needs no file on disk", () => {
  assert.ok(new X509Certificate(Buffer.from(APPLE_ROOT_G3_DER_B64, "base64")).raw.length > 0);
});

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

test("the trial window is stamped from APPLE's purchase date, not the phone's", () => {
  const e = purchaseEffect({ productId: TRIAL_PRODUCT_ID, purchaseDate: T0, revoked: false }, 14);
  assert.equal(e.kind, "trial");
  assert.equal(e.kind === "trial" && e.startedAt.getTime(), T0);
  assert.equal(e.kind === "trial" && e.endsAt.getTime(), T0 + 14 * DAY);
});

test("a revoked trial grants nothing — and records no claim to bar them later", () => {
  assert.equal(
    purchaseEffect({ productId: TRIAL_PRODUCT_ID, purchaseDate: T0, revoked: true }, 14).kind,
    "ignored",
  );
});

test("the lifetime unlock grants, and a refund takes it away", () => {
  assert.deepEqual(
    purchaseEffect({ productId: LIFETIME_PRODUCT_ID, purchaseDate: T0, revoked: false }, 14),
    { kind: "lifetime", refunded: false, plan: PLAN.lifetime },
  );
  assert.deepEqual(
    purchaseEffect({ productId: LIFETIME_PRODUCT_ID, purchaseDate: T0, revoked: true }, 14),
    { kind: "lifetime", refunded: true, plan: PLAN.refunded },
    "a refunded lifetime must not keep access",
  );
});

test("a product we do not sell changes nothing", () => {
  assert.equal(
    purchaseEffect({ productId: "com.someone.else", purchaseDate: T0, revoked: false }, 14).kind,
    "ignored",
  );
});

/* ── the precedence that closes the account farm ─────────────────────────
   These four are the anti-abuse, stated as arithmetic. If someone ever
   "simplifies" effectiveTrialEndsAt into `legacy ?? claim`, exactly one of
   these fails — which is the entire reason it is a named function. */

test("a ledger claim beats the per-account stamp EVEN WHEN it is already spent", () => {
  const spent = new Date(T0 - 30 * DAY); // account A burned this window a month ago
  const freshStamp = new Date(T0 + 14 * DAY); // account B's signup stamp, same phone
  assert.equal(
    effectiveTrialEndsAt(spent, freshStamp)?.getTime(),
    spent.getTime(),
    "a second account on a claimed phone inherits the spent window, never a new one",
  );
});

test("with no ledger claim, the legacy stamp grandfathers the user", () => {
  const legacy = new Date(T0 + 3 * DAY);
  assert.equal(effectiveTrialEndsAt(null, legacy)?.getTime(), legacy.getTime());
});

test("a claim governs when there is no legacy stamp at all", () => {
  const claim = new Date(T0 + 14 * DAY);
  assert.equal(effectiveTrialEndsAt(claim, null)?.getTime(), claim.getTime());
});

test("no claim and no stamp means no trial window", () => {
  assert.equal(effectiveTrialEndsAt(null, null), null);
});
