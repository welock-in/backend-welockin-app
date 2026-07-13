import { Router } from "express";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/auth";
import { asyncHandler } from "../middleware/async-handler";
import { sessionHeartbeatSchema, sessionEndSchema } from "../validation/schemas";

export const sessionsRouter = Router();

/**
 * Live-session heartbeat. A client posts this on session start and roughly every
 * 5 minutes while a focus session runs. Upserts the single LiveSession row for
 * this (user, device) so the admin console can see who is focusing right now.
 *
 * The response carries `forceEnd`: when an admin has requested a force-stop for
 * this session, the client must end the session (overriding a hard lock) and
 * then call `/end`. Returns `forceEnd: false` in the normal case.
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

    const existing = await prisma.liveSession.findUnique({
      where: { userId_deviceId: { userId, deviceId: input.deviceId } },
    });

    // A force-end targets ONE specific running session. The live row is keyed by
    // (user, device) and reused across a device's sessions, so bind the flag to
    // the session identity (startedAt): if this beat is a *different* session than
    // the one that was force-ended, the flag is stale and must be cleared, or a
    // brand-new (possibly hard-locked) session would inherit someone else's
    // force-end. Only a beat from the SAME session (same startedAt) honours it.
    const sameSession =
      !!existing && existing.startedAt.getTime() === input.startedAt.getTime();
    const effectiveForceEnd = sameSession ? existing!.forceEnd : false;

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

    await prisma.liveSession.upsert({
      where: { userId_deviceId: { userId, deviceId: input.deviceId } },
      // Reset a stale flag on a new session; never resurrect it on create.
      update: { ...data, ...(sameSession ? {} : { forceEnd: false }) },
      create: { userId, deviceId: input.deviceId, ...data },
    });

    // Surface a pending admin force-end only to the session it targeted.
    res.json({ forceEnd: effectiveForceEnd });
  }),
);

/** End the live session for this device (called on stop / completion). */
sessionsRouter.post(
  "/end",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { deviceId } = sessionEndSchema.parse(req.body);
    const result = await prisma.liveSession.deleteMany({
      where: { userId: req.user!.id, deviceId },
    });
    res.json({ ended: result.count });
  }),
);
