import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import type { FocusEventInput, FocusEventV2Input } from "../validation/schemas";
import { HttpError } from "../lib/http-error";
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

function assertCompatibleV2(stored: IngestResult["event"], input: FocusEventV2Input): void {
  const expected = { ...toData(stored.userId, input, false), eventVersion: 2, actualSeconds: input.actualSeconds };
  for (const key of ["name", "plannedSeconds", "completed", "hardLock", "killedTotal", "deviceId", "platform",
    "clientEventId", "emergencyUsed", "eventVersion", "actualSeconds"] as const) {
    if (stored[key] !== expected[key]) throw new HttpError(409, "Event identity already contains different data", {
      code: "FOCUS_EVENT_CONFLICT", details: { clientEventId: input.clientEventId },
    });
  }
  if (stored.startedAt.getTime() !== input.startedAt.getTime() || stored.endedAt.getTime() !== input.endedAt.getTime()) {
    throw new HttpError(409, "Event identity already contains different dates", {
      code: "FOCUS_EVENT_CONFLICT", details: { clientEventId: input.clientEventId },
    });
  }
}

/** v2 does not acknowledge a lossy v1 copy, or mutate a prior quarantine verdict. */
export async function upsertFocusEventsV2(userId: string, events: FocusEventV2Input[]) {
  // Preflight the whole validated lot before writing. A concurrent collision or
  // interrupted write is still safe: deterministic IDs and replay check content.
  const existing = await prisma.focusEvent.findMany({ where: { userId,
    clientEventId: { in: events.map((event) => event.clientEventId) } } });
  const inputs = new Map(events.map((event) => [event.clientEventId, event]));
  const byId = new Map<string, IngestResult["event"]>();
  // Check every historical row, including legacy duplicates with a random _id.
  // A Map constructed first could hide an incompatible copy behind another row.
  for (const saved of existing) {
    const input = inputs.get(saved.clientEventId!);
    if (input) {
      assertCompatibleV2(saved, input);
      byId.set(input.clientEventId, saved);
    }
  }
  const results = [];
  for (const input of events) {
    let saved = byId.get(input.clientEventId);
    let status: "stored" | "deduped" = "deduped";
    if (!saved) {
      const id = deterministicObjectId("focus-event", userId, input.clientEventId);
      const quarantined = await shouldQuarantine(userId, input);
      try {
        saved = await prisma.focusEvent.create({ data: { id, ...toData(userId, input, quarantined),
          eventVersion: 2, actualSeconds: input.actualSeconds } });
        status = "stored";
      } catch (error) {
        if (!isDuplicateKey(error)) throw error;
        saved = await prisma.focusEvent.findUnique({ where: { id } }) ?? undefined;
        if (!saved) throw error;
        assertCompatibleV2(saved, input);
      }
    }
    byId.set(input.clientEventId, saved);
    results.push({ clientEventId: input.clientEventId, status, credited: saved.quarantined !== true });
  }
  return { eventVersion: 2 as const, results };
}
