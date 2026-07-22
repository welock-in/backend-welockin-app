import { Router } from "express";
import { Prisma, type Break } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/auth";
import { requireAttest } from "../middleware/attest";
import { readDeviceId } from "../lib/device";
import { asyncHandler } from "../middleware/async-handler";
import { createBreakSchema } from "../validation/schemas";

export const breaksRouter = Router();

const DAILY_BREAK_BUDGET_MIN = 120; // per-user daily break budget (minutes)
const DAY_MS = 24 * 60 * 60 * 1000;

function breakDto(b: Break, remainingMin?: number) {
  return {
    id: b.id,
    endsAt: b.endsAt.toISOString(),
    durationSeconds: b.durationSeconds,
    quarantined: b.quarantined ?? false,
    ...(remainingMin !== undefined
      ? { remainingMinutes: Math.max(0, Math.round(remainingMin)) }
      : {}),
  };
}

/**
 * Grant a break. Server-authoritative quota (keyed userId, server clock): the
 * client enforces breaks locally/offline, and this endpoint reconciles — an
 * over-budget break is recorded `quarantined` (server veto, excluded from stats)
 * but STILL returns an authoritative `endsAt`, so offline enforcement is never
 * blocked. Idempotent on (userId, clientBreakId).
 */
breaksRouter.post(
  "/",
  requireAuth,
  requireAttest,
  asyncHandler(async (req, res) => {
    const { breakLen, clientBreakId, deviceId } = createBreakSchema.parse(req.body);
    const userId = req.user!.id;
    const now = new Date();

    if (clientBreakId) {
      const prior = await prisma.break.findFirst({ where: { userId, clientBreakId } });
      if (prior) {
        res.json(breakDto(prior));
        return;
      }
    }

    // Sum today's credited (non-quarantined) break minutes.
    const since = new Date(now.getTime() - DAY_MS);
    const todays = await prisma.break.findMany({
      where: { userId, startedAt: { gte: since }, quarantined: { not: true } },
      select: { durationSeconds: true },
    });
    const usedMin = todays.reduce((s, b) => s + b.durationSeconds / 60, 0);
    const quarantined = usedMin + breakLen > DAILY_BREAK_BUDGET_MIN;

    const durationSeconds = breakLen * 60;
    const endsAt = new Date(now.getTime() + durationSeconds * 1000);
    try {
      const created = await prisma.break.create({
        data: {
          userId,
          // Body first, then the X-WeLockIn-Device-Id header (this used to read
          // req.device, populated by the retired binding middleware).
          // `|| undefined`, not `??`: readDeviceId returns "" when absent, and an
          // empty-string deviceId would be worse than none at all.
          deviceId: deviceId ?? (readDeviceId(req) || undefined),
          clientBreakId,
          durationSeconds,
          startedAt: now,
          endsAt,
          quarantined,
        },
      });
      res.status(201).json(breakDto(created, DAILY_BREAK_BUDGET_MIN - usedMin));
    } catch (err) {
      // Concurrent retry with the same clientBreakId raced us — return the winner's
      // authoritative grant instead of a 409 (never block offline enforcement).
      const raced =
        err instanceof Prisma.PrismaClientKnownRequestError &&
        (err.code === "P2002" || err.code === "P2034");
      if (raced && clientBreakId) {
        const prior = await prisma.break.findFirst({ where: { userId, clientBreakId } });
        if (prior) {
          res.json(breakDto(prior));
          return;
        }
      }
      throw err;
    }
  }),
);
