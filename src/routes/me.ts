import { Router } from "express";
import { prisma } from "../lib/prisma";
import { toPublicUser } from "../lib/user";
import { notFound } from "../lib/http-error";
import { requireAuth } from "../middleware/auth";
import { asyncHandler } from "../middleware/async-handler";

export const meRouter = Router();

meRouter.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
    });
    if (!user) {
      throw notFound("User not found");
    }
    res.json({ user: toPublicUser(user) });
  }),
);
