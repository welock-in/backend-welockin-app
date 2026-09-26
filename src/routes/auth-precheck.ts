import { Router } from "express";
import { env } from "../lib/env";
import { ledgerHash } from "../lib/hash";
import { maskEmail } from "../lib/user";
import { readDeviceId, isReliableDeviceId } from "../lib/device";
import { parseFingerprint } from "../lib/fingerprint";
import {
  findOwnerOfAppleTransaction,
  findPayingAccountForDevice,
  type AppleTxVerdict,
} from "../lib/precheck";
import { verifyToken } from "../lib/jwt";
import { clientIp, consumeRateLimit } from "../lib/rate-limit";
import { asyncHandler } from "../middleware/async-handler";
import { precheckSchema } from "../validation/schemas";
import { readClientPlatform, reserveSignupLifetimeOffer } from "../lib/signup-lifetime";

/**
 * `POST /api/auth/precheck` — "does this phone already have a paying account?"
 * (spec S1/N4 + L1/N6.)
 *
 * UNAUTHENTICATED BY DESIGN: its whole reason to exist is to run BEFORE signup,
 * so the iOS client can interrupt with "this phone already has a paying account
 * — {maskedEmail}" before an account or a verification email exists (S1/N4),
 * and so a signed-in account without a plan can render the "bound elsewhere"
 * paywall variant instead of selling a second subscription (L1/N6).
 *
 * A bearer token is still READ when present — it is what makes `isCurrentUser`
 * answerable — but an absent, expired or garbage one simply means "anonymous".
 * A precheck must never fail as a session problem: it runs exactly when there
 * is no session.
 *
 * WHAT IT NEVER RETURNS: the raw email, the account id, or anything keyed on an
 * email the CALLER supplied (the schema has no email field — see its comment).
 * The response describes the device in the caller's hand, masked, and nothing
 * else.
 *
 * `payingAccount.blocksSignup` describes the Apple binding, independently of
 * today's signup offer: true — an APPLE-billed purchase is bound to this phone — or
 * false, the paying account is web-billed (Lemon Squeezy), worth mentioning
 * ("plan started on PC") but never a reason to refuse a signup on this phone.
 * The top-level `signupLifetimeOffer` lets a NEW iOS signup continue under an
 * iOS gift without clearing binding facts needed by paid checkout or restore.
 * It is informational here; /register and fresh /apple re-read it at creation.
 *
 * THE APPLE-TRANSACTION LEG (V1). The body may carry StoreKit's
 * `appleOriginalTransactionId`, and the AppleTxOwner registry — which,
 * unlike Device rows, survives account deletion — is consulted with it:
 *
 *   owner alive  → that owner IS the payingAccount, outranking every
 *                  device-leg candidate, blocksSignup: true. The Apple ID
 *                  already funds an account; sign into it, or create the new
 *                  account from a computer.
 *   owner gone   → `device.appleTxOrphaned: true` (wire-additive): the Apple
 *                  ID demonstrably paid but nobody is left to name. The client
 *                  blocks with "this Apple ID already has a WeLockIn
 *                  subscription; create your account from a computer or
 *                  contact support."
 *   no row       → unchanged behaviour.
 *
 * ANTI-ENUMERATION: accepting the transaction id in an unauthenticated body is
 * deliberate and acceptable — StoreKit hands original_transaction_id only to a
 * device signed into the Apple ID that owns the purchase, so it is
 * device-local knowledge, not something a stranger can guess per-victim; the
 * ids are opaque, the endpoint is rate-limited like every precheck call, and
 * the answer is masked exactly like the device leg's.
 *
 * ENFORCEMENT NOTE: /register and fresh /apple waive only the paying-device
 * gate when they reserve an iOS gift. They carry no StoreKit context, so the
 * precheck's client-side interstitial still handles the transaction leg when
 * there is no iOS offer. Neither flow changes ownership of an Apple purchase.
 */
export const authPrecheckRouter = Router();

authPrecheckRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const { idfv, appleOriginalTransactionId } = precheckSchema.parse(req.body ?? {});

    // Both keys, like every sensitive limit here: per-IP stops one host
    // sweeping many devices, per-device stops a proxy pool grinding one
    // device. The device key is the LEDGER HASH, never the raw id — throttle
    // rows should not be a plaintext device registry. The shared "unidentified"
    // sink is not counted as a device: one broken machine must not consume a
    // window every other broken machine then hits.
    await consumeRateLimit(`precheck:ip:${clientIp(req)}`, 30, 15 * 60 * 1000);
    const rawDeviceId = readDeviceId(req);
    if (isReliableDeviceId(rawDeviceId)) {
      await consumeRateLimit(`precheck:device:${ledgerHash(rawDeviceId)}`, 30, 15 * 60 * 1000);
    }
    const signupLifetimeOffer = await reserveSignupLifetimeOffer(readClientPlatform(req));

    // OPTIONAL auth — the same verification `requireAuth` performs, minus the
    // refusal. Only a VALID token names a caller; anything else is anonymous,
    // silently, because this endpoint's callers legitimately have no session.
    let callerId: string | null = null;
    const [scheme, token] = (req.header("authorization") ?? "").split(" ");
    if (scheme === "Bearer" && token) {
      try {
        callerId = verifyToken(token).sub;
      } catch {
        // Anonymous, not an error.
      }
    }

    const fingerprint = parseFingerprint(req);
    const result = await findPayingAccountForDevice({
      deviceId: rawDeviceId,
      idfv,
      signals: fingerprint.signals,
      // Keep the Apple binding verdict intact even when an iOS gift permits
      // signup. Paid paywalls and restore still need these ownership facts.
      blockingProviders: ["APPLE"],
      env,
    });

    // The Apple-transaction leg — consulted only when the phone could name a
    // transaction, and layered ON TOP of the device leg: an owner outranks
    // every device candidate, an orphan adds its flag without displacing one.
    let appleTx: AppleTxVerdict = { kind: "none" };
    if (appleOriginalTransactionId) {
      appleTx = await findOwnerOfAppleTransaction(appleOriginalTransactionId);
    }

    const paying = appleTx.kind === "owner" ? appleTx.account : result.payingAccount;
    const blocking = appleTx.kind === "owner" ? true : result.blocking;
    res.json({
      signupLifetimeOffer,
      device: {
        known: result.deviceKnown,
        payingAccount: paying
          ? {
              // Masked HERE, at the edge: lib/precheck.ts hands back the raw
              // address for the signup gates' comparison, and this is the one
              // place it crosses to an unauthenticated caller.
              maskedEmail: maskEmail(paying.email),
              billingProvider: paying.billingProvider,
              loginMethods: paying.loginMethods,
              // Apple binding fact; the separate signup offer may waive the
              // signup interstitial, never purchase/restore ownership checks.
              blocksSignup: blocking,
              // False for every anonymous caller — "is it mine?" is exactly
              // the question an unauthenticated stranger must not get answered
              // beyond the mask.
              isCurrentUser: callerId != null && callerId === paying.userId,
            }
          : null,
        // Wire-additive, and only ever present as `true`: the Apple ID behind
        // the supplied transaction id paid for an account that no longer
        // exists. Keep this fact even when an iOS signup offer is available.
        ...(appleTx.kind === "orphaned" ? { appleTxOrphaned: true } : {}),
      },
      serverTime: new Date().toISOString(),
    });
  }),
);
