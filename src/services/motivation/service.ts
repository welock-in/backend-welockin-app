import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { notFound } from "../../lib/http-error";
import { deliver } from "../notifications/deliver";
import { MOTIVATION_TEXTS, renderMotivationText } from "./content";
import { ALL_WEEKDAYS, localDateKey, localDayBounds, nextMotivationAt } from "./schedule";

export type MotivationSettings = {
  enabled: boolean;
  weekdays: number[];
  timeZone: string | null;
  language: "en" | "fr";
  nextSendAt: string | null;
};

function publicSettings(row: {
  enabled: boolean; weekdays: number[]; timeZone: string; language: string; nextSendAt: Date | null;
} | null): MotivationSettings {
  return row ? {
    enabled: row.enabled,
    weekdays: row.weekdays,
    timeZone: row.timeZone,
    language: row.language === "fr" ? "fr" : "en",
    nextSendAt: row.nextSendAt?.toISOString() ?? null,
  } : { enabled: true, weekdays: [...ALL_WEEKDAYS], timeZone: null, language: "en", nextSendAt: null };
}

export async function getMotivationSettings(userId: string): Promise<MotivationSettings> {
  return publicSettings(await prisma.motivationPreference.findUnique({ where: { userId } }));
}

async function nextUnsentAt(now: Date, timeZone: string, weekdays: readonly number[], userId: string) {
  const localDate = localDateKey(now, timeZone);
  const alreadyHandled = await prisma.motivationSend.findUnique({
    where: { userId_localDate: { userId, localDate } }, select: { id: true },
  });
  const after = alreadyHandled ? localDayBounds(now, timeZone).to : now;
  return nextMotivationAt(after, timeZone, weekdays, userId);
}

export async function saveMotivationContext(userId: string, timeZone: string, language: "en" | "fr") {
  const now = new Date();
  const existing = await prisma.motivationPreference.findUnique({ where: { userId } });
  if (!existing) {
    try {
      const row = await prisma.motivationPreference.create({
        data: {
          userId, enabled: true, weekdays: [...ALL_WEEKDAYS], timeZone, language,
          nextSendAt: await nextUnsentAt(now, timeZone, ALL_WEEKDAYS, userId),
        },
      });
      return publicSettings(row);
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) throw error;
      // A concurrent first registration won. Preserve that row's opt-out/days.
    }
  }
  const current = existing ?? await prisma.motivationPreference.findUniqueOrThrow({ where: { userId } });
  if (current.timeZone === timeZone && current.language === language &&
      (!current.enabled || current.weekdays.length === 0 || current.nextSendAt)) return publicSettings(current);
  const row = await prisma.motivationPreference.update({
    where: { userId },
    data: {
      timeZone, language,
      nextSendAt: current.enabled ? await nextUnsentAt(now, timeZone, current.weekdays, userId) : null,
    },
  });
  return publicSettings(row);
}

export async function saveMotivationChoices(userId: string, input: { enabled?: boolean; weekdays?: number[] }) {
  const current = await prisma.motivationPreference.findUnique({ where: { userId } });
  if (!current) throw notFound("Motivation settings are not initialized");
  const enabled = input.enabled ?? current.enabled;
  const weekdays = input.weekdays ?? current.weekdays;
  const row = await prisma.motivationPreference.update({
    where: { userId },
    data: { enabled, weekdays, nextSendAt: enabled ? await nextUnsentAt(new Date(), current.timeZone, weekdays, userId) : null },
  });
  return publicSettings(row);
}

async function focusedToday(userId: string, from: Date, to: Date, now: Date): Promise<boolean> {
  const [event, live] = await Promise.all([
    prisma.focusEvent.findFirst({ where: { userId, startedAt: { gte: from, lt: to } }, select: { id: true } }),
    prisma.liveSession.findFirst({ where: { userId, lastHeartbeatAt: { gte: new Date(now.getTime() - 10 * 60_000) } }, select: { id: true } }),
  ]);
  return !!(event || live);
}

async function activePhoneToken(userId: string): Promise<string | null> {
  const tokens = await prisma.pushToken.findMany({
    where: { userId, valid: true, tokenType: "expo", platform: { in: ["ios", "ipados"] } },
    orderBy: { updatedAt: "desc" }, take: 10,
  });
  for (const row of tokens) {
    if (!row.deviceId) continue;
    const device = await prisma.device.findFirst({
      where: { userId, deviceId: row.deviceId }, select: { id: true },
    });
    if (device) return row.token;
  }
  return null;
}

async function chooseText(userId: string, from: Date, language: string, name: string | null, dateKey: string) {
  const [lastEvent, recent] = await Promise.all([
    prisma.focusEvent.findFirst({ where: { userId, startedAt: { lt: from } }, orderBy: { startedAt: "desc" }, select: { startedAt: true } }),
    prisma.motivationSend.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: 10, select: { textKey: true } }),
  ]);
  const lastFocusAt = lastEvent?.startedAt.getTime() ?? 0;
  const returning = lastFocusAt > 0 && from.getTime() - lastFocusAt >= 3 * 86_400_000;
  const kind = returning ? "return" : "regular";
  const pool = MOTIVATION_TEXTS.filter((text) => text.kind === kind && (!text.needsName || !!name?.trim()));
  const recentKeys = new Set(recent.map((send) => send.textKey));
  const fresh = pool.filter((text) => !recentKeys.has(text.key));
  const choices = fresh.length ? fresh : pool;
  const seed = `${userId}:${dateKey}:${kind}`;
  let hash = 0;
  for (const char of seed) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0;
  const text = choices[hash % choices.length];
  return { key: text.key, ...renderMotivationText(text, language, name) };
}

export async function drainMotivationReminders(now = new Date()) {
  const due = await prisma.motivationPreference.findMany({
    where: { enabled: true, nextSendAt: { lte: now } },
    // Bound one invocation. Vercel calls this every minute; parallel dispatch
    // keeps one slow Expo request from holding every other due user hostage.
    orderBy: { nextSendAt: "asc" }, take: 20,
  });
  const report = { due: due.length, sent: 0, skipped: 0, failed: 0, contended: 0 };
  await Promise.all(due.map(async (preference) => {
    const scheduledAt = preference.nextSendAt;
    if (!scheduledAt) return;
    const localDate = localDateKey(scheduledAt, preference.timeZone);
    try {
      // A delayed cron does not send a stale evening reminder at night.
      if (now.getTime() - scheduledAt.getTime() > 45 * 60_000) {
        report.skipped++;
        return;
      }
      const { from, to } = localDayBounds(scheduledAt, preference.timeZone);
      if (await focusedToday(preference.userId, from, to, now)) {
        report.skipped++;
        return;
      }
      const token = await activePhoneToken(preference.userId);
      if (!token) {
        report.skipped++;
        return;
      }
      const user = await prisma.user.findUnique({ where: { id: preference.userId }, select: { displayName: true } });
      if (!user) { report.skipped++; return; }
      const copy = await chooseText(preference.userId, from, preference.language, user.displayName, localDate);
      try {
        await prisma.motivationSend.create({
          data: { userId: preference.userId, localDate, scheduledAt, textKey: copy.key },
        });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          report.contended++;
          return;
        }
        throw error;
      }
      // Recheck opt-out after the claim and before contacting Expo.
      const stillEnabled = await prisma.motivationPreference.findFirst({
        where: { id: preference.id, enabled: true, nextSendAt: scheduledAt }, select: { id: true },
      });
      if (!stillEnabled) {
        await prisma.motivationSend.update({ where: { userId_localDate: { userId: preference.userId, localDate } }, data: { status: "cancelled" } });
        report.skipped++;
        return;
      }
      const result = await deliver(
        [{ token, userId: preference.userId }],
        { title: copy.title, body: copy.body, data: { route: "/start-focus", params: { source: "motivation", min: "25" } }, ttl: 3600 },
        { source: "motivation", dedupeKey: `motivation:${preference.userId}:${localDate}` },
      );
      const status = result.sent > 0 ? "sent" : "failed";
      await prisma.motivationSend.update({ where: { userId_localDate: { userId: preference.userId, localDate } }, data: { status } });
      if (status === "sent") report.sent++; else report.failed++;
    } catch (error) {
      report.failed++;
      console.error(`[motivation] send failed for ${preference.userId} on ${localDate}`, error);
    } finally {
      try {
        await prisma.motivationPreference.updateMany({
          where: { id: preference.id, nextSendAt: scheduledAt },
          data: { nextSendAt: preference.enabled
            ? nextMotivationAt(new Date(Math.max(now.getTime(), scheduledAt.getTime()) + 1000), preference.timeZone, preference.weekdays, preference.userId)
            : null },
        });
      } catch (error) {
        // The next minute will see the same slot. Its unique daily claim still
        // prevents a duplicate send, then it can advance the schedule again.
        console.error(`[motivation] failed to advance ${preference.userId} on ${localDate}`, error);
      }
    }
  }));
  return report;
}
