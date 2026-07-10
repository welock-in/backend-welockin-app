import { Router } from "express";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/auth";
import { asyncHandler } from "../middleware/async-handler";
import { deviceSchema } from "../validation/schemas";

export const devicesRouter = Router();

/**
 * Register / heartbeat a device. Matches on the stable client `deviceId` when
 * provided (the real cross-platform identity key), and falls back to the legacy
 * (userId, name) upsert for old desktop clients that don't send a deviceId.
 * Refreshes lastSeenAt on every call.
 */
devicesRouter.post(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { name, platform, deviceId, model, osVersion, appVersion, pushToken } =
      deviceSchema.parse(req.body);
    const userId = req.user!.id;
    const now = new Date();

    // Only include optional columns that were actually sent (don't null them out).
    const meta = {
      platform,
      lastSeenAt: now,
      ...(model !== undefined ? { model } : {}),
      ...(osVersion !== undefined ? { osVersion } : {}),
      ...(appVersion !== undefined ? { appVersion } : {}),
      ...(pushToken !== undefined ? { pushToken } : {}),
    };

    let device;
    if (deviceId) {
      // Identity-based. No DB unique on (userId, deviceId) — see schema note — so
      // find-then-write. `name` is a mutable label here.
      const existing = await prisma.device.findFirst({ where: { userId, deviceId } });
      device = existing
        ? await prisma.device.update({ where: { id: existing.id }, data: { name, ...meta } })
        : await prisma.device.create({ data: { userId, name, deviceId, ...meta } });
    } else {
      // Legacy desktop path: upsert by (userId, name).
      device = await prisma.device.upsert({
        where: { userId_name: { userId, name } },
        update: meta,
        create: { userId, name, ...meta },
      });
    }

    res.json({ device });
  }),
);
