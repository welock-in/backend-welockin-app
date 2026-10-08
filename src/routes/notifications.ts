import { Router } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/auth";
import { asyncHandler } from "../middleware/async-handler";
import { pushTokenSchema } from "../validation/schemas";
import { z } from "zod";
import { getMotivationSettings, saveMotivationChoices, saveMotivationContext } from "../services/motivation/service";
import { validTimeZone } from "../services/motivation/schedule";

export const notificationsRouter = Router();

const motivationContextSchema = z.object({
  timeZone: z.string().min(1).max(100).refine(validTimeZone, "Invalid IANA timezone"),
  language: z.enum(["en", "fr"]),
});
const motivationChoicesSchema = z.object({
  enabled: z.boolean().optional(),
  weekdays: z.array(z.number().int().min(0).max(6)).max(7)
    .refine((days) => new Set(days).size === days.length, "Duplicate weekday").optional(),
}).refine((value) => value.enabled !== undefined || value.weekdays !== undefined, "No change supplied");

notificationsRouter.get("/motivation", requireAuth, asyncHandler(async (req, res) => {
  res.json(await getMotivationSettings(req.user!.id));
}));

notificationsRouter.put("/motivation/context", requireAuth, asyncHandler(async (req, res) => {
  const input = motivationContextSchema.parse(req.body);
  res.json(await saveMotivationContext(req.user!.id, input.timeZone, input.language));
}));

notificationsRouter.patch("/motivation", requireAuth, asyncHandler(async (req, res) => {
  const input = motivationChoicesSchema.parse(req.body);
  res.json(await saveMotivationChoices(req.user!.id, input));
}));


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
    async function retirePreviousTokens(registeredAt: Date) {
      if (!input.deviceId) return;
      await prisma.pushToken.updateMany({
        // Overlapping rotations must not each disable the other's newer token.
        // Equal timestamps are kept rather than risking zero live registrations.
        where: { userId, deviceId: input.deviceId, tokenType: input.tokenType, token: { not: input.token }, valid: true, updatedAt: { lt: registeredAt } },
        data: { valid: false, disabledReason: "TokenReplaced" },
      });
    }

    try {
      const pushToken = await prisma.pushToken.upsert({
        where: { token: input.token },
        update: data,
        create: { token: input.token, ...data },
      });
      await retirePreviousTokens(pushToken.updatedAt);
      res.json({ pushToken });
    } catch (err) {
      // Mongo upsert is emulated as find-then-write, so a concurrent first
      // registration of the same token can race us (P2002 on the unique token) —
      // return the winner idempotently instead of a 409.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        const pushToken = await prisma.pushToken.update({ where: { token: input.token }, data });
        await retirePreviousTokens(pushToken.updatedAt);
        res.json({ pushToken });
        return;
      }
      throw err;
    }
  }),
);
