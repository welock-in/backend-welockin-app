import { Router } from "express";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/auth";
import { asyncHandler } from "../middleware/async-handler";
import { deviceSchema } from "../validation/schemas";

export const devicesRouter = Router();

/**
 * Upserts a device by (userId, name). Refreshes lastSeenAt on every call so
 * the desktop app can register/heartbeat with a single endpoint.
 */
devicesRouter.post(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { name, platform } = deviceSchema.parse(req.body);
    const userId = req.user!.id;
    const now = new Date();

    const device = await prisma.device.upsert({
      where: { userId_name: { userId, name } },
      update: { platform, lastSeenAt: now },
      create: { userId, name, platform, lastSeenAt: now },
    });

    res.json({ device });
  }),
);
