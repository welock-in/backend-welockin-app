import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAdmin } from "../middleware/admin-auth";
import { asyncHandler } from "../middleware/async-handler";
import { consumeRateLimit } from "../lib/rate-limit";

/**
 * Where a visitor came from, when the link was printed rather than clicked.
 *
 * The QR code on the flyers points at `welock.in/?ref=qrcode`. The site fires
 * one beacon at `POST /api/referrals/hit` when it sees that parameter, and this
 * file keeps the tally the admin console reads back.
 *
 * PostHog already records the same pageview with its query string, and is the
 * better tool for anything shaped like a funnel. This exists because the console
 * should be able to answer "did the flyers do anything" without a second login
 * to a second product — so it is deliberately one number, not an analytics
 * system, and nothing in the product is ever gated on it.
 */

/**
 * The campaigns that may be counted. An allow-list rather than free text: the
 * write endpoint is public by necessity, and without this any caller could mint
 * rows with names of their choosing and turn the table into a message board.
 *
 * Adding a campaign means adding it here AND printing the matching `?ref=`.
 */
export const REFERRAL_SOURCES = ["qrcode"] as const;
export type ReferralSource = (typeof REFERRAL_SOURCES)[number];

const KNOWN_SOURCES: ReadonlySet<string> = new Set(REFERRAL_SOURCES);

/** How much history the console gets back, in days. */
export const REFERRAL_WINDOW_DAYS = 14;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Loose on purpose — the allow-list below decides what counts.
 *
 * A `z.enum` here would answer 400 to a link we no longer run, which the site
 * would surface as a failed request in the console of every visitor still
 * holding an old flyer. A retired campaign is not a client error.
 */
const hitSchema = z.object({
  source: z.string().trim().min(1).max(40),
});

/** The UTC bucket key for an instant. See the model's note on why it is a string. */
export function dayKey(at: Date): string {
  return at.toISOString().slice(0, 10);
}

// --- write side (public) -----------------------------------------------------

export const referralsRouter = Router();

/**
 * Count one arrival. Answers 204 whatever happens to the tally.
 *
 * PUBLIC, and it has to be: the whole point is the visitor who has no account
 * yet. What replaces auth is the allow-list above — an unknown source is
 * discarded silently rather than refused, so an old flyer is a no-op and not an
 * error in someone's browser.
 *
 * The rate limit is keyed on the CAMPAIGN, not on the address, because the
 * address is not usable here: the site proxies this call through its own server
 * (same-origin, so the backend's CORS list stays short), which means every
 * visitor reaches us from one machine and `clientIp` collapses them into a
 * single bucket. A per-IP limit would therefore throttle the whole site at the
 * cost of throttling no one in particular. The cap that remains is a ceiling on
 * database writes, not an anti-fraud measure — see the model's note.
 */
referralsRouter.post(
  "/hit",
  asyncHandler(async (req, res) => {
    const { source } = hitSchema.parse(req.body);

    if (!KNOWN_SOURCES.has(source)) {
      res.status(204).end();
      return;
    }

    await consumeRateLimit(`referral:${source}`, 5000, HOUR_MS);

    const day = dayKey(new Date());
    try {
      await prisma.referralHit.upsert({
        where: { source_day: { source, day } },
        create: { source, day, count: 1 },
        update: { count: { increment: 1 } },
      });
    } catch {
      // Two first-scans-of-the-day can both find no row and both try to create
      // it; the unique index rejects the loser. The row exists by now, so the
      // loser bumps it instead of dropping its own scan on the floor.
      await prisma.referralHit.updateMany({
        where: { source, day },
        data: { count: { increment: 1 } },
      });
    }

    res.status(204).end();
  }),
);

// --- read side (admin console) -----------------------------------------------

export interface ReferralSourceSummary {
  source: string;
  total: number;
  today: number;
  last7d: number;
  /** Oldest first, zero-filled — a gap in the data and a day with no scans are
   *  the same thing here, and a sparkline that skips empty days lies. */
  days: { day: string; count: number }[];
}

export interface ReferralsSummary {
  sources: ReferralSourceSummary[];
  windowDays: number;
}

/**
 * Fold the rows into what the console renders. Exported for the tests, and
 * because the arithmetic is the only part of this file worth reading twice.
 */
export function summarise(
  rows: { source: string; day: string; count: number }[],
  now: Date = new Date(),
): ReferralsSummary {
  const today = dayKey(now);
  // Inclusive of today, so "last 7 days" is today plus the six before it.
  const weekFloor = dayKey(new Date(now.getTime() - 6 * DAY_MS));

  const byDay = new Map<string, Map<string, number>>();
  const totals = new Map<string, number>();
  for (const row of rows) {
    totals.set(row.source, (totals.get(row.source) ?? 0) + row.count);
    let days = byDay.get(row.source);
    if (!days) byDay.set(row.source, (days = new Map()));
    days.set(row.day, (days.get(row.day) ?? 0) + row.count);
  }

  // Every known campaign appears, even at zero. A source that has never been
  // scanned is exactly the thing the console is being asked about, and dropping
  // it renders an empty panel that looks like a broken page.
  const names = new Set<string>([...REFERRAL_SOURCES, ...totals.keys()]);

  const sources = [...names].sort().map((source): ReferralSourceSummary => {
    const days = byDay.get(source) ?? new Map<string, number>();
    const series: { day: string; count: number }[] = [];
    for (let i = REFERRAL_WINDOW_DAYS - 1; i >= 0; i -= 1) {
      const day = dayKey(new Date(now.getTime() - i * DAY_MS));
      series.push({ day, count: days.get(day) ?? 0 });
    }
    let last7d = 0;
    for (const [day, count] of days) {
      if (day >= weekFloor && day <= today) last7d += count;
    }
    return {
      source,
      total: totals.get(source) ?? 0,
      today: days.get(today) ?? 0,
      last7d,
      days: series,
    };
  });

  return { sources, windowDays: REFERRAL_WINDOW_DAYS };
}

export const adminReferralsRouter = Router();

adminReferralsRouter.get(
  "/",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    // Every row, not just the window: `total` is "since the flyers went out",
    // which is the number anyone actually asks for. One document per campaign
    // per day keeps this a small read for as long as this is worth measuring.
    const rows = await prisma.referralHit.findMany({
      select: { source: true, day: true, count: true },
      orderBy: [{ source: "asc" }, { day: "asc" }],
    });
    res.json(summarise(rows));
  }),
);
