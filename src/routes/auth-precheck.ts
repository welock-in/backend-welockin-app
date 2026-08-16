import { Router } from "express";
import { env } from "../lib/env";
import { ledgerHash } from "../lib/hash";
import { maskEmail } from "../lib/user";
import { readDeviceId, isReliableDeviceId } from "../lib/device";
import { parseFingerprint } from "../lib/fingerprint";
import { findPayingAccountForDevice } from "../lib/precheck";
import { verifyToken } from "../lib/jwt";
import { clientIp, consumeRateLimit } from "../lib/rate-limit";
import { asyncHandler } from "../middleware/async-handler";
import { precheckSchema } from "../validation/schemas";

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
 * `payingAccount.blocksSignup` says which of the two S1/N4 stories the client
 * should tell: true — an APPLE-billed purchase is bound to this phone, show the
 * blocking interstitial (the signup gates would 409 the same signup) — or
 * false, the paying account is web-billed (Lemon Squeezy), worth mentioning
 * ("plan started on PC") but never a reason to refuse a signup on this phone.
 */
export const authPrecheckRouter = Router();

authPrecheckRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const { idfv } = precheckSchema.parse(req.body ?? {});

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
      // The SAME computation as the signup gates in routes/auth.ts, so
      // `blocksSignup` below predicts exactly what a register attempt would
      // meet: only an Apple-billed binding blocks a signup on this phone.
      blockingProviders: ["APPLE"],
      env,
    });

    const paying = result.payingAccount;
    res.json({
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
              // Would the server-side signup gates refuse a NEW account on
              // this device over this binding (SIGNUP_PAYING_DEVICE_BLOCK
              // on)? True only for an Apple-billed account — see the header.
              // False means informational only: mention the plan, never show
              // the blocking interstitial.
              blocksSignup: result.blocking,
              // False for every anonymous caller — "is it mine?" is exactly
              // the question an unauthenticated stranger must not get answered
              // beyond the mask.
              isCurrentUser: callerId != null && callerId === paying.userId,
            }
          : null,
      },
      serverTime: new Date().toISOString(),
    });
  }),
);
