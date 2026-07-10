import { Router } from "express";
import bcrypt from "bcryptjs";
import { prisma } from "../lib/prisma";
import { signToken } from "../lib/jwt";
import { toPublicUser } from "../lib/user";
import { conflict, unauthorized } from "../lib/http-error";
import { asyncHandler } from "../middleware/async-handler";
import { appleAuthSchema, loginSchema, registerSchema } from "../validation/schemas";
import { verifyAppleIdentityToken } from "../lib/apple";

const TRIAL_DAYS = 14;
const BCRYPT_ROUNDS = 10;

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
    const trialEndsAt = new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000);

    const user = await prisma.user.create({
      data: {
        email,
        passwordHash,
        plan: "trial",
        trialEndsAt,
      },
    });

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
    const { identityToken, email: emailHint } = appleAuthSchema.parse(req.body);
    const identity = await verifyAppleIdentityToken(identityToken);

    const link = await prisma.authProvider.findUnique({
      where: { provider_providerUid: { provider: "apple", providerUid: identity.sub } },
      include: { user: true },
    });

    let user = link?.user ?? null;
    let created = false;

    if (!user) {
      // Not linked yet. If Apple gave an email that matches an existing account,
      // link Apple to it (merge). Otherwise create a fresh trial user.
      const email = identity.email ?? emailHint ?? null;
      const existing = email !== null ? await prisma.user.findUnique({ where: { email } }) : null;

      if (existing) {
        user = existing;
        await prisma.authProvider.create({
          data: { userId: existing.id, provider: "apple", providerUid: identity.sub },
        });
      } else {
        const trialEndsAt = new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000);
        user = await prisma.user.create({
          data: {
            ...(email !== null ? { email } : {}),
            plan: "trial",
            trialEndsAt,
            authProviders: { create: { provider: "apple", providerUid: identity.sub } },
          },
        });
        created = true;
      }
    }

    const token = signToken({ sub: user.id, email: user.email });
    res.status(created ? 201 : 200).json({ token, user: toPublicUser(user) });
  }),
);
