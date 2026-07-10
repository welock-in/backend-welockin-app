import { Router } from "express";
import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/auth";
import { asyncHandler } from "../middleware/async-handler";
import { syncPushSchema } from "../validation/schemas";
import { upsertFocusEvents } from "../services/focus-events";
import { shouldReplaceSnapshot } from "../services/sync-policy";

export const syncRouter = Router();

/**
 * Last-write-wins push of the desktop's local state. Upserts the user's single
 * SyncSnapshot (bumping revision), then appends any FocusEvents supplied.
 */
syncRouter.post(
  "/push",
  requireAuth,
  asyncHandler(async (req, res) => {
    const input = syncPushSchema.parse(req.body);
    const { blocklists, sessions, schedules, events } = input;
    const userId = req.user!.id;

    let snapshot = await prisma.syncSnapshot.findUnique({ where: { userId } });
    if (shouldReplaceSnapshot(input)) {
      // Guaranteed by syncPushSchema when this branch is selected.
      const blocklistsJson = blocklists as unknown as Prisma.InputJsonValue;
      const sessionsJson = sessions as unknown as Prisma.InputJsonValue;
      const schedulesJson =
        schedules === undefined ? undefined : (schedules as unknown as Prisma.InputJsonValue);

      snapshot = await prisma.syncSnapshot.upsert({
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
    }

    // Idempotent per event: the mobile app replays its offline queue, so we
    // dedup on clientEventId. Desktop events (no clientEventId) insert as before.
    if (events && events.length > 0) {
      await upsertFocusEvents(userId, events);
    }

    res.json({ revision: snapshot?.revision ?? 0, updatedAt: snapshot?.updatedAt ?? null });
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
