import { createPrivateKey, sign as edSign } from "node:crypto";
import { randomBytes } from "node:crypto";
import { env } from "./env";

/**
 * The signed receipt: the only thing a client is allowed to believe when it
 * cannot reach us.
 *
 * WHY IT HAS TO BE SIGNED. The desktop app works offline by design — blocking is
 * local, no server involved — so any paywall has to survive the network being
 * gone. That means caching a verdict, and a verdict cached as plain JSON is
 * defeated by one `UPDATE kv SET value='{"isPro":true}'` in any SQLite browser.
 * Ten seconds, no skill. Signing it is what makes the cache worth writing.
 *
 * WHAT IT IS BOUND TO, and each of these closes something:
 *   userId    — a receipt cannot be moved to another account.
 *   deviceId  — nor to another machine, which is what stops one paid licence
 *               being copied across a classroom.
 *   expiresAt — an offline grace with no end IS the absence of a paywall: block
 *               app.connect.welock.in in the hosts file and you would be free for
 *               ever. Note the irony that this app edits that very file.
 *   nonce     — two receipts for the same state are not byte-identical, so one
 *               cannot be recognised and replayed by shape alone.
 *
 * WHAT IT IS NOT. It is not a capability the client may extend, reinterpret or
 * average with a previous one. It says what was true at `serverTime`, for how
 * long that may be assumed, and nothing else.
 *
 * FORMAT: `base64url(payload).base64url(signature)` — a detached Ed25519
 * signature over the exact payload bytes, in the same shape as a JWS without the
 * header negotiation, because there is exactly one algorithm here and no reason
 * to let a client choose it. Verifying it needs a public key and thirty lines.
 */

/** Bumped only if the payload shape changes in a way old clients cannot read. */
const RECEIPT_VERSION = 1;

const DAY_MS = 24 * 60 * 60 * 1000;

export type ReceiptInput = {
  userId: string;
  deviceId: string;
  status: string;
  isPro: boolean;
  trialEndsAt: Date | null;
  serverTime: Date;
  /**
   * ENTITLEMENT_ENFORCED. Inside the signature on purpose.
   *
   * It is the master switch that says whether the client may hard-gate, so a
   * client reading it from anywhere else reads it from somewhere the user can
   * edit — and `UPDATE kv SET value='false'` would turn the paywall off
   * completely. That is the exact attack the rest of this file exists to stop;
   * leaving the switch outside the envelope would have handed it back.
   */
  enforced: boolean;
};

/**
 * How long the client may go offline on this receipt.
 *
 * Deliberately asymmetric, because the two mistakes do not cost the same. Locking
 * out someone who paid costs a refund and a one-star review; letting an expired
 * trial run a few extra days costs a few days. So a lifetime licence gets a long
 * rope and a trial a short one.
 *
 * A trial receipt never outlives the trial itself: handing someone a seven-day
 * offline pass on the last day of their window would extend it by seven days.
 */
function ttlMs(status: string, isPro: boolean, trialEndsAt: Date | null, now: Date): number {
  if (!isPro) {
    // Locked. A short life so a licence bought five minutes from now is not
    // shut out until tomorrow — the client refreshes and the wall lifts.
    return 6 * 60 * 60 * 1000;
  }
  if (status === "trialing" && trialEndsAt) {
    const untilTrialEnds = trialEndsAt.getTime() - now.getTime();
    return Math.max(0, Math.min(7 * DAY_MS, untilTrialEnds));
  }
  // active / comped — a paid or granted licence.
  return 30 * DAY_MS;
}

/**
 * Canonical JSON: fixed key order, no whitespace.
 *
 * `JSON.stringify` on an object literal already emits insertion order, but
 * relying on that is how a signature silently stops matching after someone
 * reorders a field. The order is written out here so it is a decision rather
 * than an accident.
 */
function canonical(p: Record<string, unknown>): string {
  const order = [
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
  ];
  return JSON.stringify(Object.fromEntries(order.map((k) => [k, p[k] ?? null])));
}

let cachedKey: ReturnType<typeof createPrivateKey> | null = null;
let keyFailed = false;

function signingKey(): ReturnType<typeof createPrivateKey> | null {
  if (cachedKey) return cachedKey;
  if (keyFailed || !env.entitlementSigningKey) return null;
  try {
    // Accepts a PEM directly, or the same PEM base64-encoded — dashboards mangle
    // multi-line values often enough that supporting both is cheaper than
    // debugging why signing silently stopped.
    const raw = env.entitlementSigningKey.includes("BEGIN")
      ? env.entitlementSigningKey
      : Buffer.from(env.entitlementSigningKey, "base64").toString("utf8");
    cachedKey = createPrivateKey(raw);
    return cachedKey;
  } catch (e) {
    keyFailed = true;
    console.error("[receipt] ENTITLEMENT_SIGNING_KEY could not be read — receipts disabled", e);
    return null;
  }
}

/**
 * Sign a receipt, or return null when no key is configured.
 *
 * Null rather than throwing, and the client treats a missing receipt as "this
 * server does not issue them" rather than "you are locked out". That is what
 * makes the rollout safe: the field can appear on a deploy without every client
 * in the field having to understand it on the same day.
 */
export function issueReceipt(input: ReceiptInput): string | null {
  const key = signingKey();
  if (!key) return null;

  const now = input.serverTime;
  const payload = canonical({
    v: RECEIPT_VERSION,
    userId: input.userId,
    deviceId: input.deviceId,
    status: input.status,
    isPro: input.isPro,
    trialEndsAt: input.trialEndsAt ? input.trialEndsAt.toISOString() : null,
    serverTime: now.toISOString(),
    expiresAt: new Date(
      now.getTime() + ttlMs(input.status, input.isPro, input.trialEndsAt, now),
    ).toISOString(),
    nonce: randomBytes(9).toString("base64url"),
    // Appended AFTER nonce rather than inserted next to `isPro`, where it reads
    // more naturally: the order in `canonical` is the signed byte order, so
    // inserting mid-list would invalidate every receipt already in the field.
    // New fields go on the end, always.
    enforced: input.enforced,
  });

  try {
    // Ed25519 signs the message directly — no separate digest, and `null` for the
    // algorithm is how node's API expects that.
    const sig = edSign(null, Buffer.from(payload, "utf8"), key);
    return `${Buffer.from(payload, "utf8").toString("base64url")}.${sig.toString("base64url")}`;
  } catch (e) {
    console.error("[receipt] signing failed", e);
    return null;
  }
}

/** Whether this deploy can issue receipts at all — for the boot-time report. */
export const receiptsEnabled = (): boolean => signingKey() != null;
