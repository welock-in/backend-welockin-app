import { Router } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/auth";
import { asyncHandler } from "../middleware/async-handler";
import { pushTokenSchema } from "../validation/schemas";

export const notificationsRouter = Router();

/**
 * Register / refresh this device's push token (P0 — notification foundation).
 *
 * Idempotent on the token itself (`@unique`): re-registering the same token just
 * refreshes ownership + metadata. A token that moved to another account is
 * re-pointed to the caller (tokens are device-bound, not permanently user-bound).
 * Marks the token `valid` again — undoing any prior DeviceNotRegistered prune —
 * since the client just proved it is live by registering.
 */
notificationsRouter.post(
  "/token",
  requireAuth,
  asyncHandler(async (req, res) => {
    const input = pushTokenSchema.parse(req.body);
    const userId = req.user!.id;

    const data = {
      userId,
      deviceId: input.deviceId ?? null,
      platform: input.platform ?? null,
      tokenType: input.tokenType,
      appVersion: input.appVersion ?? null,
      valid: true,
      disabledReason: null,
      failureCount: 0,
      lastUsedAt: new Date(),
    };

    try {
      const pushToken = await prisma.pushToken.upsert({
        where: { token: input.token },
        update: data,
        create: { token: input.token, ...data },
      });
      res.json({ pushToken });
    } catch (err) {
      // Mongo upsert is emulated as find-then-write, so a concurrent first
      // registration of the same token can race us (P2002 on the unique token) —
      // return the winner idempotently instead of a 409.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        const existing = await prisma.pushToken.findUnique({ where: { token: input.token } });
        if (existing) {
          res.json({ pushToken: existing });
          return;
        }
      }
      throw err;
    }
  }),
);
