import { Router } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/auth";
import { asyncHandler } from "../middleware/async-handler";
import { deterministicObjectId } from "../lib/deterministic-id";
import { sessionHeartbeatSchema, sessionEndSchema } from "../validation/schemas";

export const sessionsRouter = Router();

/**
 * Live-session heartbeat. A client posts this on session start and roughly every
 * 5 minutes while a focus session runs. There is one LiveSession row PER session
 * (a device runs up to two at once — a manual "Start Focus" plus a scheduled one),
 * keyed by a deterministic id from (user, device, session), so the admin console
 * sees each concurrent focus as its own row.
 *
 * The response carries `forceEnd`: when an admin has requested a force-stop for
 * this session, the client must end the session (overriding a hard lock) and
 * then call `/end`. Returns `forceEnd: false` in the normal case. Because rows
 * are per-session, a force-end is scoped to exactly one session by construction —
 * a fresh session is a distinct row and can never inherit a stale flag.
 */
sessionsRouter.post(
  "/heartbeat",
  requireAuth,
  asyncHandler(async (req, res) => {
    const input = sessionHeartbeatSchema.parse(req.body);
    const userId = req.user!.id;
    const now = new Date();
    const endsAt =
      input.remainSeconds > 0 ? new Date(now.getTime() + input.remainSeconds * 1000) : null;

    const id = deterministicObjectId("live-session", userId, input.deviceId, input.sessionId);

    const existing = await prisma.liveSession.findUnique({ where: { id } });

    const data = {
      deviceName: input.deviceName,
      platform: input.platform,
      name: input.name,
      phase: input.phase,
      hardLock: input.hardLock,
      totalSeconds: input.totalSeconds,
      remainSeconds: input.remainSeconds,
      killedTotal: input.killedTotal,
      appsCount: input.appsCount,
      sitesCount: input.sitesCount,
      originEventId: input.originEventId,
      startedAt: input.startedAt,
      endsAt,
      lastHeartbeatAt: now,
    };

    try {
      await prisma.liveSession.upsert({
        where: { id },
        // `update` never touches `forceEnd`: an admin-set flag persists across beats
        // until the client obeys it. `create` leaves it at its schema default.
        update: data,
        create: { id, userId, deviceId: input.deviceId, sessionId: input.sessionId, ...data },
      });
    } catch (err) {
      // Mongo has no native upsert — Prisma emulates it as find-then-write, so two
      // concurrent first beats for the same deterministic id both try to create and
      // one hits a P2002 duplicate key. The row now exists → apply this beat as a
      // plain update instead of surfacing a spurious 409 to the client.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        await prisma.liveSession.update({ where: { id }, data });
      } else {
        throw err;
      }
    }

    res.json({ forceEnd: existing?.forceEnd ?? false });
  }),
);

/**
 * End a live session (called on stop / completion). Pass `sessionId` to end that
 * one session; omit it to end ALL of the device's live sessions (e.g. a clean
 * shutdown that clears whatever was running).
 */
sessionsRouter.post(
  "/end",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { deviceId, sessionId } = sessionEndSchema.parse(req.body);
    const result = await prisma.liveSession.deleteMany({
      where: { userId: req.user!.id, deviceId, ...(sessionId ? { sessionId } : {}) },
    });
    res.json({ ended: result.count });
  }),
);
