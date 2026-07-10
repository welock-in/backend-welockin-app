import { Router } from "express";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/auth";
import { asyncHandler } from "../middleware/async-handler";
import { deviceSchema } from "../validation/schemas";
import { deterministicObjectId } from "../lib/deterministic-id";
import { legacyNameOnlyDeviceWhere } from "../services/device-identity";

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
      // First preserve rows written by an earlier version of this route.
      const existing = await prisma.device.findFirst({ where: { userId, deviceId } });
      if (existing) {
        device = await prisma.device.update({
          where: { id: existing.id },
          data: { name, ...meta },
        });
      } else {
        // Upgrade a legacy name-only row instead of creating a conflicting copy.
        const legacy = await prisma.device.findFirst({
          where: legacyNameOnlyDeviceWhere(userId, name),
        });
        if (legacy) {
          device = await prisma.device.update({
            where: { id: legacy.id },
            data: { name, deviceId, ...meta },
          });
        } else {
          const id = deterministicObjectId("device", userId, deviceId);
          device = await prisma.device.upsert({
            where: { id },
            update: { name, deviceId, ...meta },
            create: { id, userId, name, deviceId, ...meta },
          });
        }
      }
    } else {
      // Legacy name-only path. Existing random-id rows are retained; fresh rows
      // get a deterministic id so concurrent heartbeats still converge.
      const existing = await prisma.device.findFirst({ where: { userId, name } });
      if (existing) {
        device = await prisma.device.update({ where: { id: existing.id }, data: meta });
      } else {
        const id = deterministicObjectId("legacy-device", userId, name);
        device = await prisma.device.upsert({
          where: { id },
          update: meta,
          create: { id, userId, name, ...meta },
        });
      }
    }

    res.json({ device });
  }),
);
