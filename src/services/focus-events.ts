import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import type { FocusEventInput } from "../validation/schemas";
import { deterministicObjectId } from "../lib/deterministic-id";

// Idempotent FocusEvent ingestion. Mobile clients may retry after an uncertain
// network response, so the same event (identified by `clientEventId`) can arrive
// more than once — we must store it only ONCE. Events without a
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
    deviceId: e.deviceId,
    platform: e.platform,
    clientEventId: e.clientEventId,
    emergencyUsed: e.emergencyUsed,
    quarantined,
  };
}

const isDuplicateKey = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";

/**
 * Decide whether an event should be quarantined (kept for audit, excluded from
 * stats). An event counts when it comes from a device that is actually on the
 * account; one citing a deviceId with no Device row is not credited.
 *
 * This used to also quarantine events from a superseded/revoked phone, with a
 * grace window so credit earned just before a handover survived. Device statuses
 * no longer exist (there is no binding to supersede anything), so existence is
 * the whole test. Events with no deviceId (desktop /sync/push) stay uncredited-by
 * -default = false, i.e. they count, exactly as before.
 */
async function shouldQuarantine(userId: string, e: FocusEventInput): Promise<boolean> {
  if (!e.deviceId) return false;
  const device = await prisma.device.findFirst({ where: { userId, deviceId: e.deviceId } });
  return device == null; // unknown device → not credited
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
  // Deterministic _id → atomic idempotency across serverless instances (no nullable
  // unique index needed); still carries the quarantine flag.
  const id = deterministicObjectId("focus-event", userId, e.clientEventId);

  try {
    const event = await prisma.focusEvent.create({ data: { id, ...toData(userId, e, quarantined) } });
    return { event, deduped: false };
  } catch (err) {
    // Race: a concurrent replay inserted the same deterministic _id first.
    // Mongo surfaces that primary-key collision as P2002 — re-read and dedup.
    if (isDuplicateKey(err)) {
      const raced =
        (await prisma.focusEvent.findUnique({ where: { id } })) ??
        (await prisma.focusEvent.findFirst({
          where: { userId, clientEventId: e.clientEventId },
        }));
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
