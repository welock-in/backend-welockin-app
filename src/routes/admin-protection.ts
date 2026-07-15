import { Router } from "express";
import { prisma } from "../lib/prisma";
import { requireAdmin } from "../middleware/admin-auth";
import { asyncHandler } from "../middleware/async-handler";
import { notFound } from "../lib/http-error";
import {
  protectionEntrySchema,
  protectionEntryUpdateSchema,
  protectionImportSchema,
} from "../validation/schemas";

export const adminProtectionRouter = Router();

/** Normalize a value on write so the enforcer's matches are consistent. */
function normalizeValue(kind: string, value: string): string {
  let v = value.trim().toLowerCase();
  if (kind === "site") {
    v = v
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .split("/")[0]
      .split("?")[0]
      .split("#")[0]
      .trim();
  }
  return v;
}

// ── curated list CRUD ────────────────────────────────────────────────────────

adminProtectionRouter.get(
  "/",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const category = typeof req.query.category === "string" ? req.query.category : undefined;
    const kind = req.query.kind === "site" || req.query.kind === "app" ? req.query.kind : undefined;
    const search = typeof req.query.search === "string" ? req.query.search.trim() : undefined;
    const skip = req.query.skip ? Math.max(0, Number.parseInt(String(req.query.skip), 10) || 0) : 0;
    const takeRaw = req.query.take ? Number.parseInt(String(req.query.take), 10) : 100;
    const take = Math.min(Math.max(Number.isFinite(takeRaw) ? takeRaw : 100, 1), 500);

    const where = {
      ...(category ? { category } : {}),
      ...(kind ? { kind } : {}),
      ...(search ? { value: { contains: search, mode: "insensitive" as const } } : {}),
    };
    const [total, entries] = await Promise.all([
      prisma.protectionEntry.count({ where }),
      prisma.protectionEntry.findMany({
        where,
        orderBy: [{ category: "asc" }, { value: "asc" }],
        skip,
        take,
      }),
    ]);
    res.json({ entries, total, skip, take });
  }),
);

adminProtectionRouter.post(
  "/",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const input = protectionEntrySchema.parse(req.body);
    const value = normalizeValue(input.kind, input.value);
    const entry = await prisma.protectionEntry.upsert({
      where: { kind_value: { kind: input.kind, value } },
      update: {
        category: input.category,
        ...(input.label !== undefined ? { label: input.label } : {}),
        ...(input.platform !== undefined ? { platform: input.platform } : {}),
        ...(input.active !== undefined ? { active: input.active } : {}),
        source: "admin",
      },
      create: {
        category: input.category,
        kind: input.kind,
        value,
        label: input.label ?? null,
        platform: input.platform ?? "all",
        active: input.active ?? true,
        source: "admin",
      },
    });
    res.json({ entry });
  }),
);

/** Bulk paste: add many values to one category/kind at once. */
adminProtectionRouter.post(
  "/import",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { category, kind, values } = protectionImportSchema.parse(req.body);
    let added = 0;
    let updated = 0;
    const seen = new Set<string>();
    for (const raw of values) {
      const value = normalizeValue(kind, raw);
      if (!value || seen.has(value)) continue;
      seen.add(value);
      const existing = await prisma.protectionEntry.findUnique({
        where: { kind_value: { kind, value } },
      });
      await prisma.protectionEntry.upsert({
        where: { kind_value: { kind, value } },
        update: { category, active: true, source: "admin" },
        create: { category, kind, value, active: true, platform: "all", source: "admin" },
      });
      if (existing) updated += 1;
      else added += 1;
    }
    res.json({ added, updated, submitted: values.length });
  }),
);

adminProtectionRouter.patch(
  "/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const input = protectionEntryUpdateSchema.parse(req.body);
    const existing = await prisma.protectionEntry.findUnique({ where: { id: req.params.id } });
    if (!existing) throw notFound("Entry not found");
    const entry = await prisma.protectionEntry.update({
      where: { id: req.params.id },
      data: {
        ...(input.category !== undefined ? { category: input.category } : {}),
        ...(input.label !== undefined ? { label: input.label } : {}),
        ...(input.platform !== undefined ? { platform: input.platform } : {}),
        ...(input.active !== undefined ? { active: input.active } : {}),
      },
    });
    res.json({ entry });
  }),
);

adminProtectionRouter.delete(
  "/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const result = await prisma.protectionEntry.deleteMany({ where: { id: req.params.id } });
    if (result.count === 0) throw notFound("Entry not found");
    res.json({ deleted: true });
  }),
);

// ── active protection (per-user locks) ───────────────────────────────────────

/** Every account with protection ON — email, method, the OTP (partner) and the
 * lock-until (dated). The OTP is shown so an admin can support/override. */
adminProtectionRouter.get(
  "/active",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const locks = await prisma.protectionLock.findMany({
      where: { active: true },
      orderBy: { updatedAt: "desc" },
      include: { user: { select: { email: true, status: true } } },
    });
    res.json({ locks, count: locks.length });
  }),
);

/** Force a user's protection OFF (admin override — meant for dated locks the user
 * otherwise can't turn off). Clears the OTP too. */
adminProtectionRouter.post(
  "/active/:id/disable",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const existing = await prisma.protectionLock.findUnique({ where: { id: req.params.id } });
    if (!existing) throw notFound("Protection lock not found");
    const lock = await prisma.protectionLock.update({
      where: { id: req.params.id },
      data: { active: false, otp: null },
    });
    res.json({ lock });
  }),
);
