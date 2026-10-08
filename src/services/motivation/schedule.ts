import { createHash } from "node:crypto";

export const ALL_WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const; // Monday = 0

type LocalParts = { year: number; month: number; day: number; hour: number; minute: number };

const formatters = new Map<string, Intl.DateTimeFormat>();

export function validTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

function localParts(instant: Date, timeZone: string): LocalParts {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    });
    formatters.set(timeZone, formatter);
  }
  const fields = Object.fromEntries(formatter.formatToParts(instant).map((p) => [p.type, p.value]));
  return {
    year: Number(fields.year), month: Number(fields.month), day: Number(fields.day),
    hour: Number(fields.hour), minute: Number(fields.minute),
  };
}

export function localDateKey(instant: Date, timeZone: string): string {
  const p = localParts(instant, timeZone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

export function localToUtc(
  year: number, month: number, day: number, hour: number, minute: number, timeZone: string,
): Date | null {
  const target = Date.UTC(year, month - 1, day, hour, minute);
  let guess = target;
  for (let i = 0; i < 5; i++) {
    const p = localParts(new Date(guess), timeZone);
    const represented = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    const difference = target - represented;
    if (difference === 0) break;
    guess += difference;
  }
  const actual = localParts(new Date(guess), timeZone);
  if (actual.year !== year || actual.month !== month || actual.day !== day ||
      actual.hour !== hour || actual.minute !== minute) return null;
  return new Date(guess);
}

function hashNumber(value: string): number {
  return createHash("sha256").update(value).digest().readUInt32BE(0);
}

// A stable daily choice across 17:35–19:15 local, never at :00 or :30.
const SEND_MINUTES = Array.from({ length: 101 }, (_, i) => 17 * 60 + 35 + i)
  .filter((minuteOfDay) => minuteOfDay % 30 !== 0);

export function chosenLocalMinute(userId: string, dateKey: string): number {
  const dayNumber = Math.floor(Date.parse(`${dateKey}T00:00:00Z`) / 86_400_000);
  // 37 and the 98 eligible minutes are coprime: consecutive dates cannot land
  // at the same minute, and the full window is visited before a slot repeats.
  const index = (hashNumber(`${userId}:motivation-v1`) + dayNumber * 37) % SEND_MINUTES.length;
  return SEND_MINUTES[index];
}

export function nextMotivationAt(
  after: Date, timeZone: string, weekdays: readonly number[], userId: string,
): Date | null {
  if (weekdays.length === 0 || !validTimeZone(timeZone)) return null;
  const local = localParts(after, timeZone);
  const localMidnightAsUtc = Date.UTC(local.year, local.month - 1, local.day);
  for (let add = 0; add <= 7; add++) {
    const date = new Date(localMidnightAsUtc + add * 86_400_000);
    const weekday = (date.getUTCDay() + 6) % 7;
    if (!weekdays.includes(weekday)) continue;
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1;
    const day = date.getUTCDate();
    const dateKey = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const minuteOfDay = chosenLocalMinute(userId, dateKey);
    const due = localToUtc(year, month, day, Math.floor(minuteOfDay / 60), minuteOfDay % 60, timeZone);
    if (due && due.getTime() > after.getTime()) return due;
  }
  return null;
}

export function localDayBounds(instant: Date, timeZone: string): { from: Date; to: Date } {
  const p = localParts(instant, timeZone);
  const next = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
  const from = localToUtc(p.year, p.month, p.day, 0, 0, timeZone);
  const to = localToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0, timeZone);
  if (!from || !to) throw new Error(`Cannot resolve local day in ${timeZone}`);
  return { from, to };
}
