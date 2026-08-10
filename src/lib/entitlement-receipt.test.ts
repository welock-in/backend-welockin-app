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
  accessNotAfter: null,
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
    ttl(
      issueReceipt({
        ...BASE,
        status: "trialing",
        isPro: true,
        trialEndsAt: twoDaysLeft,
        accessNotAfter: twoDaysLeft,
      })!,
    ),
    2 * DAY,
  );
  // And a long trial is still capped at the offline maximum.
  assert.equal(
    ttl(
      issueReceipt({
        ...BASE,
        status: "trialing",
        isPro: true,
        trialEndsAt: yearLeft,
        accessNotAfter: yearLeft,
      })!,
    ),
    7 * DAY,
  );
});

/*
 * A trial we could not put an end date on. It used to fall out of the trial
 * branch — which required a non-null date — and land on the PAID branch, so the
 * least trustworthy state in the system drew the longest offline pass in it.
 */
test("a trial with no known end still gets a trial's rope, not a purchase's", () => {
  assert.equal(
    ttl(
      issueReceipt({
        ...BASE,
        status: "trialing",
        isPro: true,
        trialEndsAt: null,
        accessNotAfter: null,
      })!,
    ),
    7 * DAY,
    "missing data must not promote a trial to a thirty-day licence",
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

/*
 * THE ONE THAT LOCKED OUT A CUSTOMER AT THE MOMENT THEY PAID.
 *
 * `status` and `trialEndsAt` come from different places: "trialing" can mean a
 * Lemon Squeezy trial, while trialEndsAt is the DEVICE ledger's date. For
 * anyone whose old device window had elapsed the subtraction went negative,
 * clamped to zero, and minted a receipt already expired when signed — stored,
 * read back as Stale, and enforced as a lock.
 *
 * It was patched with a six-hour FLOOR, which fixed the lockout and quietly
 * created a second bug in the other direction: a trial with one hour left also
 * got six. The floor is gone. What replaces it is separating the two dates, so
 * the countdown the UI draws can no longer shorten anything at all — only
 * `accessNotAfter`, read from whatever is actually granting, decides the end.
 */
test("a stale device date cannot shorten a receipt the subscription is paying for", () => {
  const now = BASE.serverTime;
  const staleDeviceTrial = new Date(now.getTime() - 90 * DAY);
  const realTrialEnd = new Date(now.getTime() + 3 * DAY);

  const lease = ttl(
    issueReceipt({
      ...BASE,
      status: "trialing",
      isPro: true,
      trialEndsAt: staleDeviceTrial,
      accessNotAfter: realTrialEnd,
    })!,
  );

  assert.equal(lease, 3 * DAY, "the granting window decides, not the ledger's leftovers");
  assert.ok(lease > 0, "a receipt that grants nothing is never the right answer to isPro");
});

// --- The offline lease may never outlive the thing that pays for it ------------
//
// `trialEndsAt` above is the UI's countdown date and nothing more. The instant
// access must actually STOP is a separate input, `accessNotAfter`, derived from
// whichever source is granting — a subscription's paid-up period, a trial's last
// day, a comp's expiry. Null is reserved for a lifetime licence, the only thing
// with no boundary.
//
// Keeping them apart is what lets both rules hold at once: a stale device date
// can no longer shorten a receipt (the incident above), and no receipt can
// outlive the window that grants it (the audit finding below).

test("an active subscription's offline lease stops when the paid period does", () => {
  const now = BASE.serverTime;
  const threeDays = new Date(now.getTime() + 3 * DAY);

  // Cancel-at-period-end is the case that pays for this: the customer keeps
  // access until the period ends, and a flat 30-day lease minted on their last
  // day hands them a free month after they stopped paying.
  assert.equal(
    ttl(issueReceipt({ ...BASE, status: "active", isPro: true, accessNotAfter: threeDays })!),
    3 * DAY,
  );
});

test("a trial shorter than the offline floor is not rounded up to it", () => {
  const now = BASE.serverTime;
  const oneHourLeft = new Date(now.getTime() + HOUR);

  // The floor used to win here — six hours of access on a trial with one hour
  // to run, i.e. every trial ending five hours late, unblockable and offline.
  assert.equal(
    ttl(
      issueReceipt({
        ...BASE,
        status: "trialing",
        isPro: true,
        trialEndsAt: oneHourLeft,
        accessNotAfter: oneHourLeft,
      })!,
    ),
    HOUR,
  );
});

test("a lifetime licence has no boundary, so it keeps the long rope", () => {
  assert.equal(
    ttl(issueReceipt({ ...BASE, status: "active", isPro: true, accessNotAfter: null })!),
    30 * DAY,
    "null is 'no boundary', not 'boundary of zero'",
  );
});

test("the boundary only ever shortens a lease, never extends one", () => {
  const now = BASE.serverTime;
  const farFuture = new Date(now.getTime() + 900 * DAY);

  assert.equal(
    ttl(issueReceipt({ ...BASE, status: "active", isPro: true, accessNotAfter: farFuture })!),
    30 * DAY,
    "a subscription renewing in three years still re-checks in thirty days",
  );
  assert.equal(
    ttl(
      issueReceipt({
        ...BASE,
        status: "expired",
        isPro: false,
        accessNotAfter: farFuture,
      })!,
    ),
    6 * HOUR,
    "and a boundary can never talk a LOCKED receipt into granting for longer",
  );
});
