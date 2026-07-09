import { Router } from "express";
import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/auth";
import { asyncHandler } from "../middleware/async-handler";
import { syncPushSchema } from "../validation/schemas";

export const syncRouter = Router();

/**
 * Last-write-wins push of the desktop's local state. Upserts the user's single
 * SyncSnapshot (bumping revision), then appends any FocusEvents supplied.
 */
syncRouter.post(
  "/push",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { blocklists, sessions, schedules, events } = syncPushSchema.parse(req.body);
    const userId = req.user!.id;

    // Cast the validated arrays to Prisma's JSON input type.
    const blocklistsJson = blocklists as unknown as Prisma.InputJsonValue;
    const sessionsJson = sessions as unknown as Prisma.InputJsonValue;
    // Only overwrite the stored schedule plan when the client actually sent one.
    // A client that omits `schedules` (e.g. the mobile app reporting a focus
    // event) must leave the desktop's plan untouched.
    const schedulesJson =
      schedules === undefined ? undefined : (schedules as unknown as Prisma.InputJsonValue);

    const snapshot = await prisma.syncSnapshot.upsert({
      where: { userId },
      update: {
        blocklists: blocklistsJson,
        sessions: sessionsJson,
        ...(schedulesJson === undefined ? {} : { schedules: schedulesJson }),
        revision: { increment: 1 },
      },
      create: {
        userId,
        blocklists: blocklistsJson,
        sessions: sessionsJson,
        schedules: schedulesJson ?? [],
        revision: 1,
      },
    });

    if (events && events.length > 0) {
      await prisma.focusEvent.createMany({
        data: events.map((e) => ({
          userId,
          name: e.name,
          startedAt: e.startedAt,
          endedAt: e.endedAt,
          plannedSeconds: e.plannedSeconds,
          completed: e.completed,
          hardLock: e.hardLock,
          killedTotal: e.killedTotal,
        })),
      });
    }

    res.json({ revision: snapshot.revision, updatedAt: snapshot.updatedAt });
  }),
);

/**
 * Pull the user's stored snapshot. Returns empty arrays + revision 0 when the
 * user has never pushed.
 */
syncRouter.get(
  "/pull",
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = req.user!.id;
    const snapshot = await prisma.syncSnapshot.findUnique({
      where: { userId },
    });

    if (!snapshot) {
      res.json({
        blocklists: [],
        sessions: [],
        schedules: [],
        revision: 0,
        updatedAt: null,
      });
      return;
    }

    res.json({
      blocklists: snapshot.blocklists,
      sessions: snapshot.sessions,
      // `schedules` is optional in the schema and null on snapshots that predate
      // it — normalize to an empty array for clients.
      schedules: snapshot.schedules ?? [],
      revision: snapshot.revision,
      updatedAt: snapshot.updatedAt,
    });
  }),
);
