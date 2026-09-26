import type { PrismaClient } from "@prisma/client";
import { focusDuration, focusDurationSelect } from "./focus-duration";

/** Paginated reads only. createdAt fixes the cohort; ingestion can continue.
 * Not a database snapshot: concurrent admin edits/deletions require another run.
 * Previous user totals reproduce the deployed Prisma predicate, not JS guesses. */
export async function auditFocusDurationImpact(db: Pick<PrismaClient, "focusEvent">, capturedAt = new Date()) {
  const result = { capturedAt: capturedAt.toISOString(), events: 0, affectedAdminEvents: 0,
    affectedUserEvents: 0, previousAdminSeconds: 0, previousUserSeconds: 0, correctedSeconds: 0,
    previousUserEvents: 0, correctedEvents: 0, quarantinedEvents: 0, unavailableEvents: 0,
    measuredEvents: 0, estimatedEvents: 0 };
  let cursor: string | undefined;
  for (;;) {
    const rows = await db.focusEvent.findMany({ take: 1000, orderBy: { id: "asc" },
      where: { createdAt: { lte: capturedAt } },
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { id: true, quarantined: true, ...focusDurationSelect } });
    if (!rows.length) break;
    const oldUserRows = await db.focusEvent.findMany({
      where: { id: { in: rows.map((row) => row.id) }, quarantined: { not: true } },
      select: { id: true },
    });
    const oldUserIds = new Set(oldUserRows.map((row) => row.id));
    for (const event of rows) {
      result.events++;
      const old = Math.max(0, Math.floor((event.endedAt.getTime() - event.startedAt.getTime()) / 1000));
      result.previousAdminSeconds += old;
      const wasCredited = oldUserIds.has(event.id);
      if (wasCredited) { result.previousUserSeconds += old; result.previousUserEvents++; }
      const duration = focusDuration(event);
      const credited = event.quarantined !== true;
      const seconds = credited ? duration.seconds : 0;
      result.correctedSeconds += seconds;
      if (old !== seconds || !credited) result.affectedAdminEvents++;
      if ((wasCredited ? old : 0) !== seconds || wasCredited !== credited) result.affectedUserEvents++;
      if (!credited) result.quarantinedEvents++;
      else {
        result.correctedEvents++;
        if (duration.basis === "measured") result.measuredEvents++;
        else if (duration.basis === "estimated") result.estimatedEvents++;
        else result.unavailableEvents++;
      }
    }
    cursor = rows[rows.length - 1].id;
  }
  return result;
}
