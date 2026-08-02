import type { NextFunction, Request, Response } from "express";
import { verifyToken } from "../lib/jwt";
import { prisma } from "../lib/prisma";
import { env } from "../lib/env";
import { accountGone, emailNotVerified, unauthorized } from "../lib/http-error";
import { asyncHandler } from "./async-handler";

export interface AuthUser {
  id: string;
  email: string;
  /** `iat` in seconds, or null when the token did not carry one. */
  tokenIssuedAt: number | null;
}

// Augment Express's Request so `req.user` is typed everywhere.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

/**
 * Requires a valid `Authorization: Bearer <jwt>` header. On success attaches
 * `req.user`. On failure passes an HttpError(401) to the error handler.
 */
export function requireAuth(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const header = req.header("authorization") ?? "";
  const [scheme, token] = header.split(" ");

  if (scheme !== "Bearer" || !token) {
    return next(unauthorized("Missing or malformed Authorization header"));
  }

  try {
    const payload = verifyToken(token);
    req.user = { id: payload.sub, email: payload.email, tokenIssuedAt: payload.iat };
    next();
  } catch {
    next(unauthorized("Invalid or expired token"));
  }
}

/**
 * The account behind the token is real, current, and allowed to use the app.
 *
 * Deliberately SEPARATE from `requireAuth` rather than folded into it. This one
 * costs a database read on every request it guards, and `requireAuth` protects
 * routes — health-adjacent things, the verification routes themselves — where
 * that read would be pure overhead or an outright deadlock (an unverified user
 * must still be able to reach "send me a code").
 *
 * Three checks, in the order their failures matter:
 *
 *  1. The account still exists. Stateless tokens outlive deleted rows.
 *  2. The token predates the last password change. This is what makes a reset
 *     actually end other sessions — without it, someone resetting a stolen
 *     password leaves the thief signed in for up to thirty more days.
 *     Null-tolerant on purpose: every account that predates `passwordChangedAt`
 *     reads null, and treating null as "changed at the epoch" would sign out the
 *     entire user base on deploy.
 *  3. The address has been verified — behind `EMAIL_VERIFICATION_ENFORCED`,
 *     which stays off until every client (Windows, macOS, mobile) can render a
 *     code screen in response to the 403. A client that cannot handle it just
 *     shows its user an error they have no way to act on.
 */
function accountGuard(opts: { requireVerified: boolean }) {
  return asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
    const auth = req.user;
    if (!auth) return next(unauthorized());

    const user = await prisma.user.findUnique({
      where: { id: auth.id },
      select: { id: true, email: true, emailVerified: true, passwordChangedAt: true },
    });
    if (!user) return next(accountGone());

    if (user.passwordChangedAt && auth.tokenIssuedAt !== null) {
      // `iat` has second precision while the column has milliseconds, so a token
      // minted in the same second as the change would otherwise look stale. The
      // one-second grace costs nothing: the attacker's token is minutes or days
      // old, not one second.
      const changedAtSec = Math.floor(user.passwordChangedAt.getTime() / 1000);
      if (auth.tokenIssuedAt < changedAtSec - 1) {
        return next(unauthorized("Your password changed — sign in again"));
      }
    }

    if (opts.requireVerified && env.emailVerificationEnforced && user.emailVerified !== true) {
      return next(emailNotVerified(user.email));
    }

    next();
  });
}

/**
 * The token still represents a live session for an account that exists.
 *
 * Applied to EVERY authenticated router, including the ones an unverified user
 * must still reach — a password reset has to end other sessions everywhere, not
 * only where verification happens to be required.
 */
export const requireCurrentSession = accountGuard({ requireVerified: false });

/**
 * The above, plus a proved email address.
 *
 * Deliberately NOT applied to three places, and each exclusion is load-bearing:
 *
 *  * `/api/auth/*` — the routes that SEND and consume the code. Gating them
 *    would make verification the thing you need in order to verify.
 *  * `/api/entitlement` — the client must always be able to read why it is
 *    locked. A paywall that cannot fetch its own reason is a blank screen.
 *  * `/api/onboarding` — the signup funnel pushes its answers immediately after
 *    creating the account and BEFORE the code screen, so gating it would break
 *    registration itself.
 *
 * Everything else is "using the app", and behind `EMAIL_VERIFICATION_ENFORCED`.
 */
export const requireVerifiedAccount = accountGuard({ requireVerified: true });
