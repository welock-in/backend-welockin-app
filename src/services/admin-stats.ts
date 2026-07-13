import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { env } from "../lib/env";
import { computeDayStreak } from "./analytics";

// Rich aggregations for the admin console. Kept separate from the per-user
// `analytics.ts` (which powers the desktop's own small summary) so the admin
// surface can evolve freely.

const DAY_MS = 24 * 60 * 60 * 1000;

function secondsBetween(a: Date, b: Date): number {
  return Math.max(0, Math.floor((b.getTime() - a.getTime()) / 1000));
}

function localDayKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** A live session is "current" only while it keeps beating; stale rows = ended. */
export function liveSessionWhere(now: Date = new Date()): Prisma.LiveSessionWhereInput {
  const cutoff = new Date(now.getTime() - env.liveSessionStaleSeconds * 1000);
  return { lastHeartbeatAt: { gte: cutoff } };
}

/** Longest run of consecutive local days that each have >= 1 completed event. */
export function computeLongestStreak(startedAts: Date[]): number {
  if (startedAts.length === 0) return 0;
  const days = [...new Set(startedAts.map(localDayKey))].sort();
  let longest = 1;
  let run = 1;
  for (let i = 1; i < days.length; i++) {
    const prev = new Date(days[i - 1] + "T00:00:00");
    const cur = new Date(days[i] + "T00:00:00");
    const gap = Math.round((cur.getTime() - prev.getTime()) / DAY_MS);
    if (gap === 1) {
      run += 1;
      longest = Math.max(longest, run);
    } else {
      run = 1;
    }
  }
  return longest;
}

export interface UserStats {
  totalSessions: number;
  completedSessions: number;
  abortedSessions: number;
  completionRate: number; // 0..1
  hardLockSessions: number;
  emergencyUsedCount: number;
  totalFocusSeconds: number;
  avgSessionSeconds: number;
  totalKilled: number;
  currentStreak: number;
  longestStreak: number;
  activeDays: number;
  sessionsLast7d: number;
  sessionsLast30d: number;
  focusSecondsLast7d: number;
  focusSecondsLast30d: number;
  firstSessionAt: string | null;
  lastSessionAt: string | null;
  sessionsByWeekday: number[]; // [Sun..Sat]
  focusByDay: { day: string; seconds: number; sessions: number }[]; // last 30 local days
  topSessionNames: { name: string; count: number }[];
}

/** Full per-user statistics pack, computed from that user's FocusEvent history. */
export async function computeUserStats(
  userId: string,
  now: Date = new Date(),
): Promise<UserStats> {
  const events = await prisma.focusEvent.findMany({
    where: { userId },
    select: {
      startedAt: true,
      endedAt: true,
      completed: true,
      hardLock: true,
      killedTotal: true,
      emergencyUsed: true,
      name: true,
    },
    orderBy: { startedAt: "asc" },
  });

  const total = events.length;
  const week = new Date(now.getTime() - 7 * DAY_MS);
  const month = new Date(now.getTime() - 30 * DAY_MS);

  let completed = 0;
  let hardLock = 0;
  let emergency = 0;
  let totalFocus = 0;
  let totalKilled = 0;
  let sessions7 = 0;
  let sessions30 = 0;
  let focus7 = 0;
  let focus30 = 0;
  const weekday = [0, 0, 0, 0, 0, 0, 0];
  const dayMap = new Map<string, { seconds: number; sessions: number }>();
  const nameMap = new Map<string, number>();
  const completedDays: Date[] = [];

  for (const e of events) {
    const secs = secondsBetween(e.startedAt, e.endedAt);
    totalFocus += secs;
    totalKilled += e.killedTotal ?? 0;
    if (e.completed) {
      completed += 1;
      completedDays.push(e.startedAt);
    }
    if (e.hardLock) hardLock += 1;
    if (e.emergencyUsed) emergency += 1;
    weekday[e.startedAt.getDay()] += 1;
    const key = localDayKey(e.startedAt);
    const bucket = dayMap.get(key) ?? { seconds: 0, sessions: 0 };
    bucket.seconds += secs;
    bucket.sessions += 1;
    dayMap.set(key, bucket);
    nameMap.set(e.name, (nameMap.get(e.name) ?? 0) + 1);
    if (e.startedAt >= week) {
      sessions7 += 1;
      focus7 += secs;
    }
    if (e.startedAt >= month) {
      sessions30 += 1;
      focus30 += secs;
    }
  }

  // Last 30 local CALENDAR days, oldest first, zero-filled. Step by calendar day
  // (cursor.setDate), not a fixed 24h offset, so a DST transition in the window
  // doesn't skip or double-count a local day.
  const dayKeys: string[] = [];
  const cursor = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  for (let i = 0; i < 30; i++) {
    dayKeys.push(localDayKey(cursor));
    cursor.setDate(cursor.getDate() - 1);
  }
  dayKeys.reverse();
  const focusByDay: UserStats["focusByDay"] = dayKeys.map((key) => {
    const bucket = dayMap.get(key) ?? { seconds: 0, sessions: 0 };
    return { day: key, seconds: bucket.seconds, sessions: bucket.sessions };
  });

  const topSessionNames = [...nameMap.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  return {
    totalSessions: total,
    completedSessions: completed,
    abortedSessions: total - completed,
    completionRate: total === 0 ? 0 : completed / total,
    hardLockSessions: hardLock,
    emergencyUsedCount: emergency,
    totalFocusSeconds: totalFocus,
    avgSessionSeconds: total === 0 ? 0 : Math.round(totalFocus / total),
    totalKilled,
    currentStreak: computeDayStreak(completedDays, now),
    longestStreak: computeLongestStreak(completedDays),
    activeDays: dayMap.size,
    sessionsLast7d: sessions7,
    sessionsLast30d: sessions30,
    focusSecondsLast7d: focus7,
    focusSecondsLast30d: focus30,
    firstSessionAt: events[0]?.startedAt.toISOString() ?? null,
    lastSessionAt: events[total - 1]?.startedAt.toISOString() ?? null,
    sessionsByWeekday: weekday,
    focusByDay,
    topSessionNames,
  };
}

export interface GlobalOverview {
  totalUsers: number;
  suspendedUsers: number;
  usersByPlan: Record<string, number>;
  newUsers7d: number;
  newUsers30d: number;
  activeUsers7d: number;
  activeUsers30d: number;
  totalSessions: number;
  sessionsToday: number;
  sessions7d: number;
  totalFocusSeconds: number;
  focusSeconds7d: number;
  liveSessionsCount: number;
  totalDevices: number;
}

/** Global dashboard numbers. */
export async function overview(now: Date = new Date()): Promise<GlobalOverview> {
  const week = new Date(now.getTime() - 7 * DAY_MS);
  const month = new Date(now.getTime() - 30 * DAY_MS);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const [
    totalUsers,
    suspendedUsers,
    plans,
    newUsers7d,
    newUsers30d,
    totalSessions,
    totalDevices,
    liveSessionsCount,
    windowEvents,
    activeGroups7,
    activeGroups30,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { status: "suspended" } }),
    prisma.user.groupBy({ by: ["plan"], _count: { _all: true } }),
    prisma.user.count({ where: { createdAt: { gte: week } } }),
    prisma.user.count({ where: { createdAt: { gte: month } } }),
    prisma.focusEvent.count(),
    prisma.device.count(),
    prisma.liveSession.count({ where: liveSessionWhere(now) }),
    // Events within the last 30 days drive today's + 7d focus/session counts.
    prisma.focusEvent.findMany({
      where: { startedAt: { gte: month } },
      select: { startedAt: true, endedAt: true },
    }),
    prisma.focusEvent.groupBy({
      by: ["userId"],
      where: { startedAt: { gte: week } },
    }),
    prisma.focusEvent.groupBy({
      by: ["userId"],
      where: { startedAt: { gte: month } },
    }),
  ]);

  // Total actual focus across ALL events (accurate at current scale; streamed if
  // this ever grows large). We piggyback the 30-day fetch for the windows and do
  // a separate lean fetch for the all-time sum.
  const allEventsTimes = await prisma.focusEvent.findMany({
    select: { startedAt: true, endedAt: true },
  });
  const totalFocusSeconds = allEventsTimes.reduce(
    (sum, e) => sum + secondsBetween(e.startedAt, e.endedAt),
    0,
  );

  let sessionsToday = 0;
  let sessions7d = 0;
  let focusSeconds7d = 0;
  for (const e of windowEvents) {
    if (e.startedAt >= startOfToday) sessionsToday += 1;
    if (e.startedAt >= week) {
      sessions7d += 1;
      focusSeconds7d += secondsBetween(e.startedAt, e.endedAt);
    }
  }

  const usersByPlan: Record<string, number> = {};
  for (const p of plans) usersByPlan[p.plan] = p._count._all;

  return {
    totalUsers,
    suspendedUsers,
    usersByPlan,
    newUsers7d,
    newUsers30d,
    activeUsers7d: activeGroups7.length,
    activeUsers30d: activeGroups30.length,
    totalSessions,
    sessionsToday,
    sessions7d,
    totalFocusSeconds,
    focusSeconds7d,
    liveSessionsCount,
    totalDevices,
  };
}

export interface UserListItem {
  id: string;
  email: string;
  plan: string;
  status: string;
  createdAt: string;
  deviceCount: number;
  sessionCount: number;
  totalFocusSeconds: number;
  lastActiveAt: string | null;
  liveNow: boolean;
}

export interface UsersListResult {
  users: UserListItem[];
  total: number;
  skip: number;
  take: number;
}

export interface UsersListParams {
  search?: string;
  skip?: number;
  take?: number;
  sortBy?: "createdAt" | "email";
  sortDir?: "asc" | "desc";
}

/**
 * Paginated users list with per-user rollups (device count, session count,
 * actual focus seconds, last-active, live-now). Aggregates are computed for just
 * the current page's users, so cost scales with page size, not table size.
 */
export async function usersList(
  params: UsersListParams,
  now: Date = new Date(),
): Promise<UsersListResult> {
  const take = Math.min(Math.max(params.take ?? 25, 1), 100);
  const skip = Math.max(params.skip ?? 0, 0);
  const sortBy = params.sortBy ?? "createdAt";
  const sortDir = params.sortDir ?? "desc";
  const search = params.search?.trim();

  const where: Prisma.UserWhereInput = search
    ? { email: { contains: search, mode: "insensitive" } }
    : {};

  const [total, users] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({
      where,
      orderBy: { [sortBy]: sortDir },
      skip,
      take,
      select: { id: true, email: true, plan: true, status: true, createdAt: true },
    }),
  ]);

  const ids = users.map((u) => u.id);
  if (ids.length === 0) {
    return { users: [], total, skip, take };
  }

  const [deviceGroups, pageEvents, liveRows] = await Promise.all([
    prisma.device.groupBy({
      by: ["userId"],
      where: { userId: { in: ids } },
      _count: { _all: true },
    }),
    prisma.focusEvent.findMany({
      where: { userId: { in: ids } },
      select: { userId: true, startedAt: true, endedAt: true },
    }),
    prisma.liveSession.findMany({
      where: { userId: { in: ids }, ...liveSessionWhere(now) },
      select: { userId: true },
    }),
  ]);

  const deviceCounts = new Map<string, number>();
  for (const g of deviceGroups) deviceCounts.set(g.userId, g._count._all);

  const sessionAgg = new Map<string, { count: number; focus: number; last: Date | null }>();
  for (const e of pageEvents) {
    const a = sessionAgg.get(e.userId) ?? { count: 0, focus: 0, last: null };
    a.count += 1;
    a.focus += secondsBetween(e.startedAt, e.endedAt);
    if (!a.last || e.endedAt > a.last) a.last = e.endedAt;
    sessionAgg.set(e.userId, a);
  }

  const liveIds = new Set(liveRows.map((r) => r.userId));

  return {
    total,
    skip,
    take,
    users: users.map((u) => {
      const agg = sessionAgg.get(u.id);
      return {
        id: u.id,
        email: u.email,
        plan: u.plan,
        status: u.status ?? "active",
        createdAt: u.createdAt.toISOString(),
        deviceCount: deviceCounts.get(u.id) ?? 0,
        sessionCount: agg?.count ?? 0,
        totalFocusSeconds: agg?.focus ?? 0,
        lastActiveAt: agg?.last ? agg.last.toISOString() : null,
        liveNow: liveIds.has(u.id),
      };
    }),
  };
}
