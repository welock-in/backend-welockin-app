import { Router } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { requireAdmin } from "../middleware/admin-auth";
import { asyncHandler } from "../middleware/async-handler";
import { conflict, notFound } from "../lib/http-error";
import {
  sendNotificationSchema,
  notificationTemplateSchema,
  notificationTemplateUpdateSchema,
  notificationRuleSchema,
  notificationRuleUpdateSchema,
} from "../validation/schemas";
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

// ── templates (the content, {{variables}}) ─────────────────────────────────────

adminNotificationsRouter.get(
  "/templates",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const templates = await prisma.notificationTemplate.findMany({ orderBy: { createdAt: "desc" } });
    res.json({ templates });
  }),
);

adminNotificationsRouter.post(
  "/templates",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const input = notificationTemplateSchema.parse(req.body);
    try {
      const template = await prisma.notificationTemplate.create({
        data: {
          key: input.key,
          title: input.title,
          body: input.body,
          ...(input.data !== undefined ? { data: input.data as Prisma.InputJsonValue } : {}),
          ...(input.category !== undefined ? { category: input.category } : {}),
          ...(input.sound !== undefined ? { sound: input.sound } : {}),
          ...(input.active !== undefined ? { active: input.active } : {}),
        },
      });
      res.status(201).json({ template });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        throw conflict("A template with this key already exists");
      }
      throw err;
    }
  }),
);

adminNotificationsRouter.patch(
  "/templates/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const input = notificationTemplateUpdateSchema.parse(req.body);
    const data: Prisma.NotificationTemplateUpdateInput = {};
    if (input.title !== undefined) data.title = input.title;
    if (input.body !== undefined) data.body = input.body;
    if (input.data !== undefined) data.data = input.data as Prisma.InputJsonValue;
    if (input.category !== undefined) data.category = input.category;
    if (input.sound !== undefined) data.sound = input.sound;
    if (input.active !== undefined) data.active = input.active;
    try {
      const template = await prisma.notificationTemplate.update({ where: { id: req.params.id }, data });
      res.json({ template });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
        throw notFound("Template not found");
      }
      throw err;
    }
  }),
);

adminNotificationsRouter.delete(
  "/templates/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    await prisma.notificationTemplate.deleteMany({ where: { id: req.params.id } });
    res.json({ deleted: true });
  }),
);

// ── rules (the wiring: event + condition + audience + template) ─────────────────

adminNotificationsRouter.get(
  "/rules",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const rules = await prisma.notificationRule.findMany({
      orderBy: [{ priority: "desc" }, { createdAt: "desc" }],
    });
    res.json({ rules });
  }),
);

adminNotificationsRouter.post(
  "/rules",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const input = notificationRuleSchema.parse(req.body);
    const rule = await prisma.notificationRule.create({
      data: {
        name: input.name,
        event: input.event,
        templateKey: input.templateKey,
        audience: input.audience as Prisma.InputJsonValue,
        ...(input.condition !== undefined ? { condition: input.condition as Prisma.InputJsonValue } : {}),
        ...(input.dedupeKeyTemplate !== undefined ? { dedupeKeyTemplate: input.dedupeKeyTemplate } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
      },
    });
    res.status(201).json({ rule });
  }),
);

adminNotificationsRouter.patch(
  "/rules/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const input = notificationRuleUpdateSchema.parse(req.body);
    const data: Prisma.NotificationRuleUpdateInput = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.event !== undefined) data.event = input.event;
    if (input.templateKey !== undefined) data.templateKey = input.templateKey;
    if (input.audience !== undefined) data.audience = input.audience as Prisma.InputJsonValue;
    if (input.condition !== undefined) data.condition = input.condition as Prisma.InputJsonValue;
    if (input.dedupeKeyTemplate !== undefined) data.dedupeKeyTemplate = input.dedupeKeyTemplate;
    if (input.enabled !== undefined) data.enabled = input.enabled;
    if (input.priority !== undefined) data.priority = input.priority;
    try {
      const rule = await prisma.notificationRule.update({ where: { id: req.params.id }, data });
      res.json({ rule });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
        throw notFound("Rule not found");
      }
      throw err;
    }
  }),
);

adminNotificationsRouter.delete(
  "/rules/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    await prisma.notificationRule.deleteMany({ where: { id: req.params.id } });
    res.json({ deleted: true });
  }),
);
