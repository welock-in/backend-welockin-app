import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import type { FocusEventInput } from "../validation/schemas";
import { DEVICE_GRACE_MS } from "../middleware/bound-device";

// Idempotent FocusEvent ingestion. The mobile app is offline-first and replays
// its queue on reconnect, so the same event (identified by `clientEventId`) can
// arrive more than once — we must store it only ONCE. Events without a
// clientEventId (e.g. the desktop's existing /sync/push payload) are inserted
// as before, so PC behaviour is unchanged.

function toData(userId: string, e: FocusEventInput, quarantined: boolean) {
  return {
    userId,
    name: e.name,
    startedAt: e.startedAt,
    endedAt: e.endedAt,
    plannedSeconds: e.plannedSeconds,
    completed: e.completed,
    hardLock: e.hardLock,
    killedTotal: e.killedTotal,
    platform: e.platform,
    clientEventId: e.clientEventId,
    emergencyUsed: e.emergencyUsed,
    deviceId: e.deviceId,
    quarantined,
  };
}

const isDuplicateKey = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";

/**
 * Decide whether an event should be quarantined (kept for audit, excluded from
 * stats). An event counts when it comes from the user's active phone — or from a
 * phone that was superseded only just before the session ended (grace window), so
 * credit legitimately earned right before a rebind isn't destroyed.
 * Events with no deviceId (legacy / desktop /sync/push) are never quarantined.
 */
async function shouldQuarantine(userId: string, e: FocusEventInput): Promise<boolean> {
  if (!e.deviceId) return false;
  const device = await prisma.device.findFirst({ where: { userId, deviceId: e.deviceId } });
  if (!device) return true; // unknown device → not credited
  const status = device.status ?? "active";
  if (status === "active") return false;
  if (status === "superseded" && device.supersededAt) {
    // Count sessions that ended around the time this phone was still active.
    if (e.endedAt.getTime() <= device.supersededAt.getTime() + DEVICE_GRACE_MS) return false;
  }
  return true; // superseded (stale) / revoked → quarantine
}

export interface IngestResult {
  event: Prisma.FocusEventGetPayload<object>;
  deduped: boolean;
}

/** Insert one FocusEvent, deduplicating on (userId, clientEventId) when present. */
export async function upsertFocusEvent(userId: string, e: FocusEventInput): Promise<IngestResult> {
  if (!e.clientEventId) {
    const quarantined = await shouldQuarantine(userId, e);
    const event = await prisma.focusEvent.create({ data: toData(userId, e, quarantined) });
    return { event, deduped: false };
  }

  const existing = await prisma.focusEvent.findFirst({
    where: { userId, clientEventId: e.clientEventId },
  });
  if (existing) return { event: existing, deduped: true };

  const quarantined = await shouldQuarantine(userId, e);
  try {
    const event = await prisma.focusEvent.create({ data: toData(userId, e, quarantined) });
    return { event, deduped: false };
  } catch (err) {
    // Race: a concurrent replay inserted it first. With the optional partial
    // unique index (see README) this surfaces as P2002 — re-read and dedup.
    if (isDuplicateKey(err)) {
      const raced = await prisma.focusEvent.findFirst({
        where: { userId, clientEventId: e.clientEventId },
      });
      if (raced) return { event: raced, deduped: true };
    }
    throw err;
  }
}

/** Ingest a batch (used by /sync/push). Idempotent per event. */
export async function upsertFocusEvents(userId: string, events: FocusEventInput[]): Promise<void> {
  for (const e of events) {
    await upsertFocusEvent(userId, e);
  }
}
