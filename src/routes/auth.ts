import { Router } from "express";
import bcrypt from "bcryptjs";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { signToken } from "../lib/jwt";
import { toPublicUser } from "../lib/user";
import { badRequest, conflict, unauthorized } from "../lib/http-error";
import { asyncHandler } from "../middleware/async-handler";
import { appleAuthSchema, loginSchema, registerSchema } from "../validation/schemas";
import {
  canAutoLinkAppleAccount,
  getVerifiedAppleEmail,
  verifyAppleIdentityToken,
} from "../lib/apple";
import { deterministicObjectId } from "../lib/deterministic-id";
import { readDeviceId } from "../lib/device";
import { claimTrialOnSignup } from "../lib/trial-claim";

const BCRYPT_ROUNDS = 10;

const isDuplicateKey = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";

export const authRouter = Router();

authRouter.post(
  "/register",
  asyncHandler(async (req, res) => {
    const { email, password } = registerSchema.parse(req.body);

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      throw conflict("An account with this email already exists");
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

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
    await claimTrialOnSignup(user.id, readDeviceId(req));

    const token = signToken({ sub: user.id, email: user.email });
    res.status(201).json({ token, user: toPublicUser(user) });
  }),
);

authRouter.post(
  "/login",
  asyncHandler(async (req, res) => {
    const { email, password } = loginSchema.parse(req.body);

    const user = await prisma.user.findUnique({ where: { email } });
    // A social-only account has no passwordHash → reject password login.
    if (!user || !user.passwordHash) {
      throw unauthorized("Invalid email or password");
    }

    const ok = await bcrypt.compare(password, user.passwordHash);
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
    if (created) await claimTrialOnSignup(user.id, readDeviceId(req));

    const token = signToken({ sub: user.id, email: user.email });
    res.status(created ? 201 : 200).json({ token, user: toPublicUser(user) });
  }),
);
