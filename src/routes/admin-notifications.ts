import { Router } from "express";
import { prisma } from "../lib/prisma";
import { requireAdmin } from "../middleware/admin-auth";
import { asyncHandler } from "../middleware/async-handler";
import { sendNotificationSchema } from "../validation/schemas";
import { resolveAudience } from "../services/notifications/audience";
import { deliver } from "../services/notifications/deliver";

export const adminNotificationsRouter = Router();

/**
 * Send an ad-hoc push to an audience. Reuses the shared engine primitives
 * (resolveAudience + deliver), so an admin broadcast and a rule-triggered send
 * behave identically (same Expo send, delivery log, and dead-token pruning).
 */
adminNotificationsRouter.post(
  "/send",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const input = sendNotificationSchema.parse(req.body);
    const targets = await resolveAudience(
      input.audience.mode === "user"
        ? { mode: "user", userId: input.audience.userId }
        : { mode: "all" },
      { userId: input.audience.userId ?? "" },
    );
    const summary = await deliver(
      targets,
      { title: input.title, body: input.body, data: input.data },
      { source: "admin" },
    );
    res.json({ audience: input.audience.mode, ...summary });
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
