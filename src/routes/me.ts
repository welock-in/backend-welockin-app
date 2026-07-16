import { Router } from "express";
import { Prisma } from "@prisma/client";
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

// Self-serve account deletion — required by Google Play (User Data policy) and
// Apple. Removes the account and every record keyed to it. Idempotent: a second
// call after the user row is gone still returns 204. Related collections are
// deleted explicitly (MongoDB has no real FK cascade; Prisma's onDelete only
// covers models with a back-relation, and we want a hard guarantee).
meRouter.delete(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = req.user!.id;
    const del = (model: { deleteMany: (a: { where: { userId: string } }) => Promise<unknown> }) =>
      model.deleteMany({ where: { userId } }).catch(() => undefined);

    await Promise.all([
      del(prisma.focusEvent),
      del(prisma.device),
      del(prisma.deviceTransfer),
      del(prisma.liveSession),
      del(prisma.authProvider),
      del(prisma.syncSnapshot),
      del(prisma.break),
      del(prisma.vote),
    ]);
    // Feature requests authored by the user (authorId, not userId).
    await prisma.featureRequest.deleteMany({ where: { authorId: userId } }).catch(() => undefined);

    // The account row itself is the deletion that MUST succeed — do NOT swallow a
    // real failure (returning 204 while the account and its credentials survive is
    // both a lie to the user and an App/Play data-deletion compliance gap). Only a
    // P2025 "already gone" (an idempotent repeat) counts as success.
    try {
      await prisma.user.delete({ where: { id: userId } });
    } catch (err) {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025")) {
        throw err;
      }
    }

    res.status(204).end();
  }),
);
