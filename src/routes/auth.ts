import { Router } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { signToken } from "../lib/jwt";
import { toPublicUser } from "../lib/user";
import { badRequest, conflict, deviceAlreadyClaimed, unauthorized } from "../lib/http-error";
import { asyncHandler } from "../middleware/async-handler";
import { appleAuthSchema, loginSchema, registerSchema } from "../validation/schemas";
import { env } from "../lib/env";
import { hashPassword, verifyPassword } from "../lib/password";
import { clientIp, consumeRateLimit } from "../lib/rate-limit";
import { findBlockingClaimOwner, parseFingerprint } from "../lib/fingerprint";
import { sendVerificationCode } from "./auth-email";
import {
  canAutoLinkAppleAccount,
  getVerifiedAppleEmail,
  verifyAppleIdentityToken,
} from "../lib/apple";
import { deterministicObjectId } from "../lib/deterministic-id";
import { readDeviceId } from "../lib/device";
import { claimTrialOnSignup } from "../lib/trial-claim";

const isDuplicateKey = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";

export const authRouter = Router();

authRouter.post(
  "/register",
  asyncHandler(async (req, res) => {
    const { email, password } = registerSchema.parse(req.body);

    // Keyed on the address as well as the IP: a per-IP limit alone is defeated
    // by any proxy pool, and a per-address one is what stops the same target
    // being hammered from many of them.
    await consumeRateLimit(`register:ip:${clientIp(req)}`, 10, 60 * 60 * 1000);
    await consumeRateLimit(`register:email:${email}`, 5, 60 * 60 * 1000);

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      throw conflict("An account with this email already exists");
    }

    // One account per machine, when asked for. Note what this is NOT: the
    // anti-farm guarantee does not live here and needs no flag — a second
    // account on a claimed machine SHARES the existing claim below and so gets
    // no second trial whatever this is set to. This only decides whether to
    // refuse outright, and it is behind a switch because its false positives
    // are real people on shared or resold computers.
    const fingerprint = parseFingerprint(req);
    if (env.deviceBindingEnforced && fingerprint.signals.length > 0) {
      const owner = await findBlockingClaimOwner(fingerprint.signals);
      if (owner) throw deviceAlreadyClaimed();
    }

    const passwordHash = await hashPassword(password);

    // NO trial is stamped on the ACCOUNT any more. Registration used to hand out
    // fourteen days, which made a trial exactly as cheap as an email address —
    // and `DELETE /api/me` frees the address again, so even the same one could go
    // round forever. The window is claimed per MACHINE now, against a ledger that
    // outlives the account.
    const user = await prisma.user.create({
      data: {
        email,
        passwordHash,
        plan: "trial",
      },
    });

    // Claimed HERE as well as from `POST /api/entitlement/trial`, because no
    // shipped client knows about that endpoint yet: leaving the claim to it alone
    // would mean every account created by a current build resolved `expired` from
    // its first second. Best-effort — a ledger write must never cost someone the
    // account they just made.
    await claimTrialOnSignup(user.id, readDeviceId(req), {
      signals: fingerprint.signals,
      // Only ever passed as an explicit false by a client that LOOKED for its
      // hardware id and failed — see ClaimOptions. Absent stays absent.
      ...(fingerprint.signals.length > 0 ? { hardwareBacked: fingerprint.hardwareBacked } : {}),
    });

    // Send the verification code inline, so the client does not need a second
    // round trip before it can show the code screen. Never throws.
    await sendVerificationCode(user.id, user.email);

    const token = signToken({ sub: user.id, email: user.email });
    res.status(201).json({ token, user: toPublicUser(user) });
  }),
);

authRouter.post(
  "/login",
  asyncHandler(async (req, res) => {
    const { email, password } = loginSchema.parse(req.body);

    // Both keys, for opposite attacks: per-address stops a single account being
    // ground through a password list, per-IP stops one host spraying one common
    // password across many addresses. Either alone leaves the other wide open.
    await consumeRateLimit(`login:email:${email}`, 10, 15 * 60 * 1000);
    await consumeRateLimit(`login:ip:${clientIp(req)}`, 50, 15 * 60 * 1000);

    const user = await prisma.user.findUnique({ where: { email } });
    // A social-only account has no passwordHash → reject password login.
    if (!user || !user.passwordHash) {
      throw unauthorized("Invalid email or password");
    }

    const ok = await verifyPassword(password, user.passwordHash);
    if (!ok) {
      throw unauthorized("Invalid email or password");
    }

    const token = signToken({ sub: user.id, email: user.email });
    res.json({ token, user: toPublicUser(user) });
  }),
);

/**
 * Sign in with Apple. Verifies the identityToken against Apple's public keys,
 * then find-or-creates the account by (provider "apple", providerUid = sub) and
 * returns a JWT in the same format as email/password login (so requireAuth and
 * all existing middleware just work).
 */
authRouter.post(
  "/apple",
  asyncHandler(async (req, res) => {
    const { identityToken } = appleAuthSchema.parse(req.body);
    const identity = await verifyAppleIdentityToken(identityToken);

    const link = await prisma.authProvider.findUnique({
      where: { provider_providerUid: { provider: "apple", providerUid: identity.sub } },
      include: { user: true },
    });

    let user = link?.user ?? null;
    let created = false;

    if (!user) {
      // A client-supplied email is never trusted for linking. Apple includes a
      // verified real or relay email on first consent; subsequent logins use the
      // provider link created here and no longer require the email claim.
      const email = getVerifiedAppleEmail(identity);
      if (!email) {
        throw badRequest("Apple must provide a verified email on first sign-in");
      }

      const providerId = deterministicObjectId("auth-provider", "apple", identity.sub);
      const existing = await prisma.user.findUnique({ where: { email } });

      try {
        if (existing) {
          // Password signup does not currently verify email ownership. Linking
          // Apple to such an account would enable account pre-hijacking: an
          // attacker could pre-register the victim's address and retain password
          // access after the victim signs in with Apple.
          if (!canAutoLinkAppleAccount(existing)) {
            throw conflict(
              "An account already uses this email; sign in to that account before linking Apple",
            );
          }
          await prisma.authProvider.create({
            data: {
              id: providerId,
              userId: existing.id,
              provider: "apple",
              providerUid: identity.sub,
            },
          });
          user = existing;
        } else {
          // Same as /register: no trial is stamped on the account. See the note there.
          user = await prisma.user.create({
            data: {
              email,
              emailVerified: true,
              plan: "trial",
              authProviders: {
                create: {
                  id: providerId,
                  provider: "apple",
                  providerUid: identity.sub,
                },
              },
            },
          });
          created = true;
        }
      } catch (err) {
        if (!isDuplicateKey(err)) throw err;

        // Concurrent first sign-ins converge on the deterministic provider _id
        // (and on the unique email for account creation). Re-read the winner.
        const racedLink = await prisma.authProvider.findFirst({
          where: { provider: "apple", providerUid: identity.sub },
          include: { user: true },
        });
        if (racedLink) {
          user = racedLink.user;
          created = false;
        } else {
          const racedUser = await prisma.user.findUnique({ where: { email } });
          if (!racedUser) throw err;
          if (!canAutoLinkAppleAccount(racedUser)) {
            throw conflict(
              "An account already uses this email; sign in to that account before linking Apple",
            );
          }
          try {
            await prisma.authProvider.create({
              data: {
                id: providerId,
                userId: racedUser.id,
                provider: "apple",
                providerUid: identity.sub,
              },
            });
          } catch (linkErr) {
            if (!isDuplicateKey(linkErr)) throw linkErr;
          }
          user = racedUser;
          created = false;
        }
      }
    }

    // Only a genuinely new account claims: signing in again, or linking Apple to
    // an existing account, must not look like a first run. `claimTrial` would
    // return the existing claim anyway — this just avoids the write.
    // Same signals as the password path. Without them an Apple signup writes a
    // claim with no DeviceSignal rows, so the machine is invisible to the
    // fingerprint matcher afterwards — a claim that cannot be matched is a claim
    // that cannot stop the next one.
    if (created) {
      const fp = parseFingerprint(req);
      await claimTrialOnSignup(user.id, readDeviceId(req), {
        signals: fp.signals,
        ...(fp.signals.length > 0 ? { hardwareBacked: fp.hardwareBacked } : {}),
      });
    }

    const token = signToken({ sub: user.id, email: user.email });
    res.status(created ? 201 : 200).json({ token, user: toPublicUser(user) });
  }),
);
