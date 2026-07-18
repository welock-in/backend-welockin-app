import { Router } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { requireAdmin } from "../middleware/admin-auth";
import { asyncHandler } from "../middleware/async-handler";
import { sendNotificationSchema } from "../validation/schemas";
import { sendExpoPush } from "../lib/expo-push";

export const adminNotificationsRouter = Router();

/**
 * Send an ad-hoc push to an audience (P1 — first real send). Resolves the valid
 * push tokens, sends via the Expo Push service, logs one NotificationDelivery per
 * recipient, and prunes tokens Expo reports as DeviceNotRegistered. This is the
 * imperative path; the data-driven rule engine (P2) will reuse the same send +
 * delivery-log primitives.
 */
adminNotificationsRouter.post(
  "/send",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const input = sendNotificationSchema.parse(req.body);

    const where =
      input.audience.mode === "user"
        ? { userId: input.audience.userId, valid: true }
        : { valid: true };
    const rows = await prisma.pushToken.findMany({ where, select: { token: true, userId: true } });

    if (rows.length === 0) {
      res.json({ audience: input.audience.mode, recipients: 0, sent: 0, failed: 0, invalid: 0, pruned: 0 });
      return;
    }

    const tokens = rows.map((r) => r.token);
    const ownerByToken = new Map(rows.map((r) => [r.token, r.userId]));
    const results = await sendExpoPush(tokens, { title: input.title, body: input.body, data: input.data });

    const dataJson = input.data as Prisma.InputJsonValue | undefined;
    await prisma.notificationDelivery.createMany({
      data: results.map((r) => ({
        userId: ownerByToken.get(r.token) ?? null,
        token: r.token,
        title: input.title,
        body: input.body,
        ...(dataJson !== undefined ? { data: dataJson } : {}),
        status: r.status,
        ticketId: r.ticketId ?? null,
        error: r.error ?? null,
        source: "admin",
      })),
    });

    // Expo says these tokens are gone → mark invalid so future sends skip them.
    const dead = results.filter((r) => r.errorCode === "DeviceNotRegistered").map((r) => r.token);
    if (dead.length > 0) {
      await prisma.pushToken.updateMany({
        where: { token: { in: dead } },
        data: { valid: false, disabledReason: "DeviceNotRegistered" },
      });
    }

    res.json({
      audience: input.audience.mode,
      recipients: results.length,
      sent: results.filter((r) => r.status === "sent").length,
      failed: results.filter((r) => r.status === "error").length,
      invalid: results.filter((r) => r.status === "invalid").length,
      pruned: dead.length,
    });
  }),
);

/** Recent deliveries (audit log for the admin panel). */
adminNotificationsRouter.get(
  "/deliveries",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const skip = req.query.skip ? Math.max(0, Number.parseInt(String(req.query.skip), 10) || 0) : 0;
    const takeRaw = req.query.take ? Number.parseInt(String(req.query.take), 10) : 50;
    const take = Math.min(Math.max(Number.isFinite(takeRaw) ? takeRaw : 50, 1), 200);
    const [deliveries, total] = await Promise.all([
      prisma.notificationDelivery.findMany({ orderBy: { createdAt: "desc" }, skip, take }),
      prisma.notificationDelivery.count(),
    ]);
    res.json({ deliveries, total, skip, take });
  }),
);
