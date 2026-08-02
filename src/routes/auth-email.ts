import { Router } from "express";
import { prisma } from "../lib/prisma";
import { env } from "../lib/env";
import { asyncHandler } from "../middleware/async-handler";
import { requireAuth } from "../middleware/auth";
import {
  accountGone,
  resetTokenInvalid,
  verificationAttemptsExhausted,
  verificationCodeInvalid,
} from "../lib/http-error";
import { generateCode, generateResetToken, hashCode, hashResetToken, safeEqualHex } from "../lib/tokens";
import { hashPassword } from "../lib/password";
import { sendEmailVerificationCode, sendPasswordResetLink } from "../lib/resend";
import { clientIp, consumeRateLimit } from "../lib/rate-limit";
import { passwordResetRequestSchema, passwordResetSchema, verifyEmailSchema } from "../validation/schemas";

/**
 * Proving you can read your own inbox, and getting back in when you cannot
 * remember your password.
 *
 * Mounted on /api/auth alongside `authRouter`. Split into its own file because
 * the two flows share a set of rules that are easy to break one at a time and
 * that read better stated once:
 *
 *  * The verification routes are AUTHENTICATED. Registration already returns a
 *    token, so the client has one — and requiring it removes the entire
 *    unauthenticated brute-force class: guessing a code needs the victim's JWT
 *    first, at which point the code is the least of their problems.
 *  * The reset routes are public and therefore answer IDENTICALLY whether or
 *    not the address exists. `POST /api/auth/register` already leaks existence
 *    through its 409; that is one oracle too many, not a licence for a second.
 *  * Expiry is enforced in the QUERY, never by a background job. Prisma cannot
 *    declare a MongoDB TTL index and Mongo's TTL sweeper is best-effort — the
 *    index built by scripts/auth-migrate.ts is housekeeping, the `where` clause
 *    is the guarantee.
 */
export const authEmailRouter = Router();

const minutes = (n: number) => n * 60 * 1000;

/** Issue a fresh code, retiring any still outstanding for this account. */
async function issueVerificationCode(userId: string, email: string): Promise<string> {
  const code = generateCode();

  // Retire the previous codes rather than leaving several live at once: N valid
  // codes mean N times the attempt budget against the same account.
  await prisma.emailVerification.updateMany({
    where: { userId, consumedAt: null },
    data: { consumedAt: new Date() },
  });

  await prisma.emailVerification.create({
    data: {
      userId,
      email,
      codeHash: hashCode(code),
      expiresAt: new Date(Date.now() + minutes(env.emailVerificationTtlMinutes)),
    },
  });

  return code;
}

/**
 * Mint and send a verification code. Exported so `POST /api/auth/register` can
 * do it inline, without a second round trip from the client.
 *
 * Never throws: registration must not fail because Resend hiccupped. The user
 * can always ask for another code, whereas a 500 on signup loses the account.
 */
export async function sendVerificationCode(userId: string, email: string): Promise<void> {
  try {
    const code = await issueVerificationCode(userId, email);
    const result = await sendEmailVerificationCode(email, code, env.emailVerificationTtlMinutes);
    if (!result.ok) {
      // Loud on purpose. A missing RESEND_API_KEY makes every send a silent
      // no-op, which looks exactly like success from the outside — and with
      // verification enforced, that is every new user locked out.
      console.error(
        `[auth] verification email not delivered to ${email}: ` +
          (result.skipped ? "RESEND_API_KEY not set" : (result.error ?? "unknown error")),
      );
    }
  } catch (e) {
    console.error("[auth] failed to issue a verification code", e);
  }
}

/**
 * Send another code.
 *
 * Two limits, because they stop different things: the per-minute one stops a
 * user hammering the button, the hourly one stops someone using an account they
 * control as a free mail cannon at an address they do not.
 */
authEmailRouter.post(
  "/verify-email/request",
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = req.user!.id;

    await consumeRateLimit(`verify-req:user:${userId}`, 1, minutes(1));
    await consumeRateLimit(`verify-req-hourly:user:${userId}`, 5, minutes(60));

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, emailVerified: true },
    });
    if (!user) throw accountGone();

    // Already done: say so and send nothing. Not an error — a second device
    // finishing the funnel lands here legitimately.
    if (user.emailVerified === true) {
      res.json({ ok: true, alreadyVerified: true, email: user.email });
      return;
    }

    await sendVerificationCode(user.id, user.email);
    res.json({
      ok: true,
      alreadyVerified: false,
      email: user.email,
      expiresInMinutes: env.emailVerificationTtlMinutes,
    });
  }),
);

/** Consume a code. */
authEmailRouter.post(
  "/verify-email",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { code } = verifyEmailSchema.parse(req.body);
    const userId = req.user!.id;

    // A ceiling on guesses ACROSS codes. The per-code counter below caps five
    // tries at one code; without this, "request a new code, try five, repeat"
    // would turn a six-digit space into a budget an attacker sets themselves.
    await consumeRateLimit(`verify-try:user:${userId}`, 20, minutes(60));

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, emailVerified: true },
    });
    if (!user) throw accountGone();
    if (user.emailVerified === true) {
      // `email` on every branch, like the success path below and like
      // /verify-email/request — a client that reads it off the response must not
      // have to care which branch it landed on.
      res.json({ ok: true, alreadyVerified: true, email: user.email });
      return;
    }

    const record = await prisma.emailVerification.findFirst({
      where: { userId, consumedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: "desc" },
    });
    if (!record) throw verificationCodeInvalid();

    if (record.attempts >= env.emailVerificationMaxAttempts) {
      throw verificationAttemptsExhausted();
    }

    if (!safeEqualHex(hashCode(code), record.codeHash)) {
      // ATOMIC. A read-modify-write would let N parallel guesses all read the
      // same count and all write count+1, spending one attempt for N tries —
      // the same reasoning as the partner-OTP counter.
      const { attempts } = await prisma.emailVerification.update({
        where: { id: record.id },
        data: { attempts: { increment: 1 } },
        select: { attempts: true },
      });
      if (attempts >= env.emailVerificationMaxAttempts) {
        // Kill the code outright, so an exhausted one cannot later be guessed
        // by someone who obtains it another way.
        await prisma.emailVerification.update({
          where: { id: record.id },
          data: { consumedAt: new Date() },
        });
        throw verificationAttemptsExhausted();
      }
      throw verificationCodeInvalid();
    }

    // The address the code was SENT to is the one that gets verified. If the
    // account's address moved since, this code proves nothing about the new one.
    if (record.email !== user.email) throw verificationCodeInvalid();

    const now = new Date();
    await prisma.$transaction([
      prisma.emailVerification.update({
        where: { id: record.id },
        data: { consumedAt: now },
      }),
      prisma.user.update({
        where: { id: user.id },
        data: { emailVerified: true, emailVerifiedAt: now },
      }),
    ]);

    res.json({ ok: true, alreadyVerified: false, email: user.email });
  }),
);

/**
 * Ask for a reset link.
 *
 * ALWAYS 200 with the same body, whatever the address. Three things have to
 * hold for that to be true rather than merely intended:
 *  - the same status and body on every branch;
 *  - the response written BEFORE the mail is sent, so "account exists" is not
 *    readable as several hundred extra milliseconds;
 *  - the rate limit keyed on the address as well as the IP, so the 429 cannot
 *    be used to tell known addresses from unknown ones either.
 */
authEmailRouter.post(
  "/password/reset-request",
  asyncHandler(async (req, res) => {
    const { email } = passwordResetRequestSchema.parse(req.body);
    const ip = clientIp(req);

    await consumeRateLimit(`reset-req:ip:${ip}`, 10, minutes(60));
    await consumeRateLimit(`reset-req:email:${email}`, 3, minutes(60));

    res.json({ ok: true });

    // Everything past here is invisible to the caller by construction.
    void (async () => {
      try {
        const user = await prisma.user.findUnique({
          where: { email },
          select: { id: true, email: true, passwordHash: true },
        });
        // No account, or a social-only one. Setting a password on an account
        // that never had one would quietly convert it into a password account —
        // a way to take over anyone whose provider email is known.
        if (!user || !user.passwordHash) return;

        const token = generateResetToken();
        await prisma.passwordReset.create({
          data: {
            userId: user.id,
            email: user.email,
            tokenHash: hashResetToken(token),
            expiresAt: new Date(Date.now() + minutes(env.passwordResetTtlMinutes)),
            requestIp: ip,
          },
        });

        const url = `${env.publicSiteUrl}/reset-password?token=${encodeURIComponent(token)}`;
        const result = await sendPasswordResetLink(user.email, url, env.passwordResetTtlMinutes);
        if (!result.ok) {
          console.error(
            `[auth] reset email not delivered to ${user.email}: ` +
              (result.skipped ? "RESEND_API_KEY not set" : (result.error ?? "unknown error")),
          );
        }
      } catch (e) {
        console.error("[auth] password reset request failed after responding", e);
      }
    })();
  }),
);

/** Consume a reset link and set the new password. */
authEmailRouter.post(
  "/password/reset",
  asyncHandler(async (req, res) => {
    const { token, password } = passwordResetSchema.parse(req.body);

    await consumeRateLimit(`reset-consume:ip:${clientIp(req)}`, 20, minutes(60));

    const tokenHash = hashResetToken(token);
    const now = new Date();

    // Single-use, enforced by a CONDITIONAL write rather than read-then-write.
    // Two requests arriving with the same token both pass a findFirst; only one
    // can win this, because the unique index on tokenHash serialises them.
    const claimed = await prisma.passwordReset.updateMany({
      where: { tokenHash, consumedAt: null, expiresAt: { gt: now } },
      data: { consumedAt: now },
    });
    // Expired, already used, or never existed — one answer for all three.
    if (claimed.count !== 1) throw resetTokenInvalid();

    const record = await prisma.passwordReset.findUnique({
      where: { tokenHash },
      select: { userId: true },
    });
    if (!record) throw resetTokenInvalid();

    await prisma.user.update({
      where: { id: record.userId },
      data: {
        passwordHash: await hashPassword(password),
        // Ends every session that predates this moment — see
        // requireVerifiedAccount. A reset whose whole point is locking someone
        // out must not leave them signed in.
        passwordChangedAt: now,
      },
    });

    // Any other outstanding link for this account is now void: the person who
    // just proved control gets to invalidate requests they did not make.
    await prisma.passwordReset.updateMany({
      where: { userId: record.userId, consumedAt: null },
      data: { consumedAt: now },
    });

    res.json({ ok: true });
  }),
);
