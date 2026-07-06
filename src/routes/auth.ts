import { Router } from "express";
import bcrypt from "bcryptjs";
import { prisma } from "../lib/prisma";
import { signToken } from "../lib/jwt";
import { toPublicUser } from "../lib/user";
import { conflict, unauthorized } from "../lib/http-error";
import { asyncHandler } from "../middleware/async-handler";
import { loginSchema, registerSchema } from "../validation/schemas";

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
    if (!user) {
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
