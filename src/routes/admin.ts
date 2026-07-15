import { Router } from "express";
import crypto from "node:crypto";
import { prisma } from "../lib/prisma";
import { env } from "../lib/env";
import { asyncHandler } from "../middleware/async-handler";
import { requireAdmin } from "../middleware/admin-auth";
import { signAdminToken } from "../lib/admin-jwt";
import { toPublicUser } from "../lib/user";
import { notFound, unauthorized, HttpError } from "../lib/http-error";
import { adminLoginSchema, adminSetPlanSchema } from "../validation/schemas";
import {
  overview,
  usersList,
  computeUserStats,
  liveSessionWhere,
} from "../services/admin-stats";

export const adminRouter = Router();

/** Constant-time-ish string compare (length may leak, acceptable for creds). */
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// ── auth ─────────────────────────────────────────────────────────────────────

/** Exchange env-configured admin credentials for a short-lived admin JWT. */
adminRouter.post(
  "/login",
  asyncHandler(async (req, res) => {
    if (!env.adminPassword) {
      // No password configured → admin console is disabled (never allow blank).
      throw new HttpError(503, "Admin console is not configured");
    }
    const { username, password } = adminLoginSchema.parse(req.body);
    const ok =
      safeEqual(username, env.adminUsername) && safeEqual(password, env.adminPassword);
    if (!ok) {
      throw unauthorized("Invalid credentials");
    }
    const token = signAdminToken(env.adminUsername);
    res.json({ token, username: env.adminUsername });
  }),
);

adminRouter.get(
  "/me",
  requireAdmin,
  asyncHandler(async (req, res) => {
    res.json({ username: req.admin!.username });
  }),
);

// ── dashboard ────────────────────────────────────────────────────────────────

adminRouter.get(
  "/overview",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    res.json(await overview());
  }),
);

/** Every focus session happening right now (fresh heartbeat), with its owner. */
adminRouter.get(
  "/live-sessions",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const rows = await prisma.liveSession.findMany({
      where: liveSessionWhere(),
      orderBy: { lastHeartbeatAt: "desc" },
      include: { user: { select: { email: true, plan: true, status: true } } },
    });
    res.json({ sessions: rows, count: rows.length });
  }),
);

// ── users ────────────────────────────────────────────────────────────────────

adminRouter.get(
  "/users",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const search = typeof req.query.search === "string" ? req.query.search : undefined;
    const skip = req.query.skip ? Number.parseInt(String(req.query.skip), 10) : 0;
    const take = req.query.take ? Number.parseInt(String(req.query.take), 10) : 25;
    const sortBy = req.query.sortBy === "email" ? "email" : "createdAt";
    const sortDir = req.query.sortDir === "asc" ? "asc" : "desc";
    res.json(
      await usersList({
        search,
        skip: Number.isFinite(skip) ? skip : 0,
        take: Number.isFinite(take) ? take : 25,
        sortBy,
        sortDir,
      }),
    );
  }),
);

/** Full profile: identity, devices, stat pack, synced plan data, live session. */
adminRouter.get(
  "/users/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) throw notFound("User not found");

    const [devices, snapshot, live, recentEvents, stats] = await Promise.all([
      prisma.device.findMany({ where: { userId: id }, orderBy: { lastSeenAt: "desc" } }),
      prisma.syncSnapshot.findUnique({ where: { userId: id } }),
      prisma.liveSession.findMany({
        where: { userId: id, ...liveSessionWhere() },
        orderBy: { lastHeartbeatAt: "desc" },
      }),
      prisma.focusEvent.findMany({
        where: { userId: id },
        orderBy: { startedAt: "desc" },
        take: 25,
      }),
      computeUserStats(id),
    ]);

    res.json({
      user: toPublicUser(user),
      devices,
      stats,
      snapshot: snapshot
        ? {
            blocklists: snapshot.blocklists,
            sessions: snapshot.sessions,
            schedules: snapshot.schedules ?? [],
            revision: snapshot.revision,
            updatedAt: snapshot.updatedAt,
          }
        : null,
      liveSessions: live,
      recentEvents,
    });
  }),
);

/** Paginated focus-event history for a user. */
adminRouter.get(
  "/users/:id/events",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    const skipRaw = req.query.skip ? Number.parseInt(String(req.query.skip), 10) : 0;
    // Clamp to >= 0: a negative skip is finite, so it would otherwise reach Prisma
    // and throw a PrismaClientValidationError (no `code` → uncaught 500).
    const skip = Math.max(Number.isFinite(skipRaw) ? skipRaw : 0, 0);
    const takeRaw = req.query.take ? Number.parseInt(String(req.query.take), 10) : 50;
    const take = Math.min(Math.max(Number.isFinite(takeRaw) ? takeRaw : 50, 1), 200);

    const [total, events] = await Promise.all([
      prisma.focusEvent.count({ where: { userId: id } }),
      prisma.focusEvent.findMany({
        where: { userId: id },
        orderBy: { startedAt: "desc" },
        skip,
        take,
      }),
    ]);
    res.json({ events, total, skip, take });
  }),
);

// ── moderation (write) ───────────────────────────────────────────────────────

adminRouter.post(
  "/users/:id/suspend",
  requireAdmin,
  asyncHandler(async (req, res) => {
    await getUserOr404(req.params.id);
    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: { status: "suspended" },
    });
    res.json({ user: toPublicUser(user) });
  }),
);

adminRouter.post(
  "/users/:id/unsuspend",
  requireAdmin,
  asyncHandler(async (req, res) => {
    await getUserOr404(req.params.id);
    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: { status: "active" },
    });
    res.json({ user: toPublicUser(user) });
  }),
);

adminRouter.post(
  "/users/:id/plan",
  requireAdmin,
  asyncHandler(async (req, res) => {
    await getUserOr404(req.params.id);
    const { plan } = adminSetPlanSchema.parse(req.body);
    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: { plan },
    });
    res.json({ user: toPublicUser(user) });
  }),
);

adminRouter.delete(
  "/users/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    await getUserOr404(req.params.id);
    // Relations (devices, focusEvents, snapshot, authProviders, liveSessions)
    // all cascade on delete in the schema.
    await prisma.user.delete({ where: { id: req.params.id } });
    res.json({ deleted: true });
  }),
);

/** Request a force-stop of a live session; the client ends it on its next beat. */
adminRouter.post(
  "/live-sessions/:id/force-end",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const row = await prisma.liveSession.findUnique({ where: { id: req.params.id } });
    if (!row) throw notFound("Live session not found");
    const updated = await prisma.liveSession.update({
      where: { id: req.params.id },
      data: { forceEnd: true },
    });
    res.json({ liveSession: updated });
  }),
);

/** Remove a live-session row outright (e.g. a stale ghost the client never cleared). */
adminRouter.delete(
  "/live-sessions/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const result = await prisma.liveSession.deleteMany({ where: { id: req.params.id } });
    if (result.count === 0) throw notFound("Live session not found");
    res.json({ deleted: true });
  }),
);

async function getUserOr404(id: string) {
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) throw notFound("User not found");
  return user;
}
