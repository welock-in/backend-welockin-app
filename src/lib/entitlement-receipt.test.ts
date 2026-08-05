import assert from "node:assert/strict";
import { test, before } from "node:test";
import { generateKeyPairSync, verify as edVerify } from "node:crypto";
import { env } from "./env";

/**
 * The receipt is the only thing an offline client is allowed to believe, so the
 * properties tested here are the paywall itself: what is inside the signature,
 * what the signature is over, and how long the client may go on believing it.
 *
 * An EPHEMERAL key pair, minted here. Deliberately not the deployed one — a test
 * that needed the production private key would either not run or be a reason to
 * put it somewhere a test can read.
 */
const { privateKey, publicKey } = generateKeyPairSync("ed25519");

let issueReceipt: typeof import("./entitlement-receipt").issueReceipt;

before(async () => {
  // Set BEFORE the module is first imported: it caches the parsed key on first
  // use, so a later assignment would be read only if nothing had signed yet.
  (env as any).entitlementSigningKey = privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString();
  ({ issueReceipt } = await import("./entitlement-receipt"));
});

const BASE = {
  userId: "507f1f77bcf86cd799439011",
  deviceId: "win-06dbff1c",
  status: "active",
  isPro: true,
  trialEndsAt: null,
  serverTime: new Date("2026-08-06T12:00:00.000Z"),
  enforced: true,
};

/** Split a receipt the way the Rust verifier does, and read the payload. */
function open(token: string) {
  const [payloadB64, sigB64] = token.split(".");
  const payload = Buffer.from(payloadB64, "base64url");
  return {
    payload,
    json: JSON.parse(payload.toString("utf8")) as Record<string, unknown>,
    signature: Buffer.from(sigB64, "base64url"),
  };
}

test("a receipt verifies against the public half of the signing key", () => {
  const token = issueReceipt(BASE)!;
  const { payload, signature } = open(token);

  assert.ok(edVerify(null, payload, publicKey, signature));
});

test("the signature covers the payload, so no field can be edited in flight", () => {
  const token = issueReceipt({ ...BASE, isPro: false, status: "expired" })!;
  const { json, signature } = open(token);

  // Promote the holder to a paying customer — the whole point of the exercise.
  const forged = Buffer.from(JSON.stringify({ ...json, isPro: true, status: "active" }), "utf8");

  assert.equal(edVerify(null, forged, publicKey, signature), false);
});

/**
 * `enforced` is the master switch for hard-gating. Outside the signature it
 * would be a kv row the user can set to false, which turns the paywall off
 * entirely — so its presence INSIDE the payload is a security property, not a
 * convenience.
 */
test("the enforcement switch travels inside the signature", () => {
  assert.equal(open(issueReceipt({ ...BASE, enforced: true })!).json.enforced, true);
  assert.equal(open(issueReceipt({ ...BASE, enforced: false })!).json.enforced, false);

  // And flipping it after the fact breaks the signature like any other field.
  const token = issueReceipt({ ...BASE, enforced: true })!;
  const { json, signature } = open(token);
  const forged = Buffer.from(JSON.stringify({ ...json, enforced: false }), "utf8");
  assert.equal(edVerify(null, forged, publicKey, signature), false);
});

/**
 * The signed byte order is the field order in `canonical`. A new field inserted
 * mid-list would change the bytes of every payload and invalidate every receipt
 * already cached in the field, so the order is pinned here on purpose: this
 * assertion is meant to fail when someone reorders it.
 */
test("the payload's field order is pinned", () => {
  const { json } = open(issueReceipt(BASE)!);

  assert.deepEqual(Object.keys(json), [
    "v",
    "userId",
    "deviceId",
    "status",
    "isPro",
    "trialEndsAt",
    "serverTime",
    "expiresAt",
    "nonce",
    "enforced",
  ]);
});

test("two receipts for the same state are not byte-identical", () => {
  const a = issueReceipt(BASE)!;
  const b = issueReceipt(BASE)!;

  assert.notEqual(a, b, "without a nonce a receipt could be recognised by shape and replayed");
  assert.notEqual(open(a).json.nonce, open(b).json.nonce);
});

test("a receipt is bound to one account and one machine", () => {
  const { json } = open(issueReceipt(BASE)!);

  assert.equal(json.userId, BASE.userId);
  assert.equal(json.deviceId, BASE.deviceId);
});

// --- How long a client may stay offline on one ---------------------------------

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const ttl = (token: string) => {
  const { json } = open(token);
  return Date.parse(json.expiresAt as string) - Date.parse(json.serverTime as string);
};

test("a paid licence gets a long offline rope, a lock a short one", () => {
  // Asymmetric on purpose: locking out someone who paid costs a refund and a
  // one-star review; an expired trial running a few more hours costs hours.
  assert.equal(ttl(issueReceipt({ ...BASE, status: "active", isPro: true })!), 30 * DAY);
  assert.equal(ttl(issueReceipt({ ...BASE, status: "comped", isPro: true })!), 30 * DAY);
  assert.equal(ttl(issueReceipt({ ...BASE, status: "expired", isPro: false })!), 6 * HOUR);
  assert.equal(ttl(issueReceipt({ ...BASE, status: "revoked", isPro: false })!), 6 * HOUR);
});

/**
 * The one that would quietly give the product away: an offline pass handed out
 * on the last day of a trial must not outlive the trial it describes, or every
 * trial silently becomes a week longer than advertised.
 */
test("a trial receipt never outlives the trial", () => {
  const now = BASE.serverTime;
  const twoDaysLeft = new Date(now.getTime() + 2 * DAY);
  const yearLeft = new Date(now.getTime() + 365 * DAY);

  assert.equal(
    ttl(issueReceipt({ ...BASE, status: "trialing", isPro: true, trialEndsAt: twoDaysLeft })!),
    2 * DAY,
  );
  // And a long trial is still capped at the offline maximum.
  assert.equal(
    ttl(issueReceipt({ ...BASE, status: "trialing", isPro: true, trialEndsAt: yearLeft })!),
    7 * DAY,
  );
});

test("a trial that has already ended grants no offline time at all", () => {
  const past = new Date(BASE.serverTime.getTime() - DAY);

  assert.equal(
    ttl(issueReceipt({ ...BASE, status: "trialing", isPro: true, trialEndsAt: past })!),
    0,
  );
});

/**
 * Null means "this deploy does not issue receipts", and the client falls back to
 * the unsigned fields. It must never be an error, or the day the key is missing
 * from an environment is the day every client is locked out at once.
 */
test("no key means no receipt, not a thrown error", async () => {
  const before = env.entitlementSigningKey;
  (env as any).entitlementSigningKey = "";
  try {
    // A fresh module instance, so the cached key from the other tests is gone.
    const fresh = await import(`./entitlement-receipt?nokey=${Date.now()}`);
    assert.equal(fresh.issueReceipt(BASE), null);
    assert.equal(fresh.receiptsEnabled(), false);
  } finally {
    (env as any).entitlementSigningKey = before;
  }
});

test("an unreadable key disables receipts instead of crashing the route", async () => {
  const before = env.entitlementSigningKey;
  (env as any).entitlementSigningKey = "not a key, and not base64 of one either";
  const errors: unknown[][] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => errors.push(args);
  try {
    const fresh = await import(`./entitlement-receipt?badkey=${Date.now()}`);
    assert.equal(fresh.issueReceipt(BASE), null);
    // Silence here would be the worst outcome: receipts stop, nothing says why.
    assert.ok(errors.some((a) => String(a[0]).includes("ENTITLEMENT_SIGNING_KEY")));
  } finally {
    console.error = realError;
    (env as any).entitlementSigningKey = before;
  }
});
