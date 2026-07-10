import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import type { FocusEventInput } from "../validation/schemas";
import { deterministicObjectId } from "../lib/deterministic-id";

// Idempotent FocusEvent ingestion. Mobile clients may retry after an uncertain
// network response, so the same event (identified by `clientEventId`) can arrive
// more than once — we must store it only ONCE. Events without a
// clientEventId (e.g. the desktop's existing /sync/push payload) are inserted
// as before, so PC behaviour is unchanged.

function toData(userId: string, e: FocusEventInput) {
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
  };
}

const isDuplicateKey = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";

export interface IngestResult {
  event: Prisma.FocusEventGetPayload<object>;
  deduped: boolean;
}

/** Insert one FocusEvent, deduplicating on (userId, clientEventId) when present. */
export async function upsertFocusEvent(userId: string, e: FocusEventInput): Promise<IngestResult> {
  if (!e.clientEventId) {
    const event = await prisma.focusEvent.create({ data: toData(userId, e) });
    return { event, deduped: false };
  }

  const existing = await prisma.focusEvent.findFirst({
    where: { userId, clientEventId: e.clientEventId },
  });
  if (existing) return { event: existing, deduped: true };

  // Use Mongo's always-unique _id as the idempotency boundary. This remains
  // atomic across concurrent Vercel instances and needs no nullable unique index.
  const id = deterministicObjectId("focus-event", userId, e.clientEventId);

  try {
    const event = await prisma.focusEvent.create({ data: { id, ...toData(userId, e) } });
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
