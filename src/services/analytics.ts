import { prisma } from "../lib/prisma";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface AnalyticsSummary {
  focusedSecondsWeek: number;
  sessionsCount: number;
  dayStreak: number;
  totalSessions: number;
}

/** Local YYYY-MM-DD key for grouping events by calendar day. */
function dayKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export async function computeSummary(
  userId: string,
  now: Date = new Date(),
): Promise<AnalyticsSummary> {
  const weekAgo = new Date(now.getTime() - 7 * DAY_MS);

  const [weekEvents, totalSessions, completedEvents] = await Promise.all([
    // Events started in the last 7 days — drive week focus + session count.
    prisma.focusEvent.findMany({
      where: { userId, startedAt: { gte: weekAgo } },
      select: { startedAt: true, endedAt: true },
    }),
    prisma.focusEvent.count({ where: { userId } }),
    // Completed events — drive the day streak.
    prisma.focusEvent.findMany({
      where: { userId, completed: true },
      select: { startedAt: true },
    }),
  ]);

  const focusedSecondsWeek = weekEvents.reduce((sum, e) => {
    const seconds = Math.max(
      0,
      Math.floor((e.endedAt.getTime() - e.startedAt.getTime()) / 1000),
    );
    return sum + seconds;
  }, 0);

  const dayStreak = computeDayStreak(
    completedEvents.map((e) => e.startedAt),
    now,
  );

  return {
    focusedSecondsWeek,
    sessionsCount: weekEvents.length,
    dayStreak,
    totalSessions,
  };
}

/**
 * Consecutive days (up to and including today) that each have >= 1 completed
 * event. If today has none but yesterday does, the streak is 0 (it has been
 * broken today). Uses local calendar days.
 */
export function computeDayStreak(startedAts: Date[], now: Date): number {
  if (startedAts.length === 0) return 0;

  const daysWithEvents = new Set(startedAts.map(dayKey));

  let streak = 0;
  const cursor = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  // Walk backwards from today while each day has an event.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (daysWithEvents.has(dayKey(cursor))) {
      streak += 1;
      cursor.setDate(cursor.getDate() - 1);
    } else {
      break;
    }
  }
  return streak;
}
