import type { Prisma } from "@prisma/client";

// Mongo distinguishes null from an absent field. Keep all historical documents
// except an explicitly quarantined event, consistently on every statistics path.
export const creditableFocusWhere: Prisma.FocusEventWhereInput = {
  OR: [{ quarantined: false }, { quarantined: null }, { quarantined: { isSet: false } }],
};

export const focusDurationSelect = {
  startedAt: true, endedAt: true, plannedSeconds: true, actualSeconds: true, eventVersion: true,
} as const;

type DurationInput = {
  startedAt: Date; endedAt: Date; plannedSeconds?: number | null;
  eventVersion?: number | null; actualSeconds?: number | null;
};
export type DurationBasis = "measured" | "estimated" | "unavailable";

export function focusDuration(event: DurationInput): { seconds: number; basis: DurationBasis } {
  const wall = Math.floor((event.endedAt.getTime() - event.startedAt.getTime()) / 1000);
  const budget = event.plannedSeconds;
  if (!Number.isFinite(wall) || wall < 0 || !Number.isInteger(budget) || budget! < 0) {
    return { seconds: 0, basis: "unavailable" };
  }
  if (event.eventVersion === 2) {
    const actual = event.actualSeconds;
    return Number.isInteger(actual) && actual! >= 0 && actual! <= Math.min(budget!, wall)
      ? { seconds: actual!, basis: "measured" } : { seconds: 0, basis: "unavailable" };
  }
  if (event.eventVersion != null || budget === 0) return { seconds: 0, basis: "unavailable" };
  // Legacy pauses/extensions cannot be reconstructed. Keep raw rows intact.
  return { seconds: Math.min(wall, budget!), basis: "estimated" };
}

export function durationBreakdown(events: DurationInput[]) {
  const result = { measuredSeconds: 0, estimatedSeconds: 0, measuredEvents: 0, estimatedEvents: 0, unavailableEvents: 0 };
  for (const event of events) {
    const duration = focusDuration(event);
    if (duration.basis === "measured") { result.measuredSeconds += duration.seconds; result.measuredEvents++; }
    else if (duration.basis === "estimated") { result.estimatedSeconds += duration.seconds; result.estimatedEvents++; }
    else result.unavailableEvents++;
  }
  return result;
}

/** Raw admin history stays available for diagnosis; annotate, never rewrite it. */
export function focusEventDurationView<T extends DurationInput & { quarantined?: boolean | null }>(event: T) {
  const duration = focusDuration(event);
  return { ...event, credited: event.quarantined !== true,
    creditedSeconds: event.quarantined === true ? 0 : duration.seconds, durationBasis: duration.basis };
}
