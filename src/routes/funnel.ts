import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAdmin } from "../middleware/admin-auth";
import { asyncHandler } from "../middleware/async-handler";
import { consumeRateLimit } from "../lib/rate-limit";

/**
 * Where each signup-funnel run stands, step by step, machine by machine.
 *
 * The desktop apps report every screen transition from the moment the intro
 * CTA is clicked: when the run started, which machine it is, and how long each
 * screen held the user. The admin console reads it back as one card per run.
 *
 * The transport is deliberately dumb: the client re-sends the run's WHOLE step
 * log on every transition, and this route replaces the stored document with
 * it. That makes every packet self-contained — a retry, a duplicate or a
 * missed packet needs no reconciliation, because the next one carries the full
 * picture again. The only ordering rule is `eventCount`: a packet whose log is
 * SHORTER than what is stored is a delayed earlier one, and is dropped.
 *
 * PostHog is still the tool for aggregate funnel analytics; this exists so the
 * console can answer "what exactly happened on that machine" — with the
 * machine's name — which the anonymised registry deliberately cannot.
 */

/** The platforms that may report. Same reasoning as the referral allow-list:
 *  the endpoint is public, so an unknown platform is discarded silently rather
 *  than written or refused. */
export const FUNNEL_PLATFORMS = ["windows", "macos"] as const;
const KNOWN_PLATFORMS: ReadonlySet<string> = new Set(FUNNEL_PLATFORMS);

/**
 * Every screen either desktop funnel can visit, in walk order — the union of
 * the two: `verify` is Windows-only, `permissions` macOS-only. This is the
 * console's ordering/labelling table, not a validation gate: step NAMES in a
 * packet are free strings within a length cap, so a client one funnel version
 * ahead logs cleanly instead of erroring, and its unknown steps sort last.
 */
export const FUNNEL_STEP_ORDER = [
  "intro",
  "name",
  "age",
  "profile",
  "university",
  "screentime",
  "shock",
  "calc",
  "analysis",
  "plan",
  "commit",
  "account",
  "verify",
  "permissions",
] as const;

/** How much history the console gets by default, in days. */
export const FUNNEL_WINDOW_DAYS = 14;

/** A run silent for this long is "abandoned" rather than "in progress". The
 *  slowest legitimate gap in the walk is the email-verification wait, which is
 *  minutes, not hours. */
export const FUNNEL_ACTIVE_WINDOW_MS = 10 * 60 * 1000;

/** More entries than the longest walk could produce across several restarts
 *  means a broken or hostile client; the log is truncated, never refused. */
const MAX_STEPS = 60;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** A step name as stored: short, and safe to render anywhere. */
const stepName = z.string().trim().min(1).max(32);

/** ISO instants arrive as strings; anything unparseable becomes null rather
 *  than 400 — one bad clock must not cost the rest of the packet. */
const instant = z
  .string()
  .max(40)
  .nullish()
  .transform((s) => {
    if (!s) return null;
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  });

const stepEntry = z.object({
  step: stepName,
  enteredAt: instant,
  leftAt: instant,
  /** The client's own dwell measurement, ms. CLAMPED, never refused: a laptop
   *  that slept through a month closes its open step with a dwell past any cap,
   *  and — the protocol re-sending the full log every packet — a refusal here
   *  would poison every later packet of that run, the completion included. */
  ms: z
    .number()
    .nullish()
    .transform((v) =>
      typeof v === "number" && Number.isFinite(v) && v >= 0
        ? Math.min(Math.round(v), 30 * DAY_MS)
        : null,
    ),
});

/** Free text the OS chose (machine name, OS build): truncated, never refused —
 *  someone's baroque computer name must not cost the whole packet a 400. */
const osString = z
  .string()
  .trim()
  .transform((s) => s.slice(0, 80))
  .nullish();

const trackSchema = z.object({
  runId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  /** The run's packet ordering — see the model. Clamped like `ms`: a counter a
   *  broken client ran away with must not 400 the log it is meant to order. */
  seq: z
    .number()
    .nullish()
    .transform((v) =>
      typeof v === "number" && Number.isFinite(v) && v >= 0
        ? Math.min(Math.round(v), 1_000_000)
        : 0,
    ),
  platform: z.string().trim().min(1).max(20),
  deviceId: z.string().trim().max(128).nullish(),
  deviceName: osString,
  osVersion: osString,
  appVersion: z.string().trim().max(32).nullish(),
  funnelVersion: z.string().trim().max(32).nullish(),
  locale: z.string().trim().max(20).nullish(),
  withAccount: z.boolean().nullish(),
  screenTotal: z.number().int().min(1).max(30).nullish(),
  startedAt: z.string().max(40),
  completedAt: instant,
  lastStep: stepName.nullish(),
  steps: z.array(stepEntry).max(MAX_STEPS),
});

// --- write side (public) -----------------------------------------------------

export const funnelRouter = Router();

/**
 * Record (or re-record) one run's state. Answers 204 whatever happens.
 *
 * PUBLIC, and it has to be: the funnel runs BEFORE the account exists — the
 * first eleven screens have no token to offer. What replaces auth is the
 * platform allow-list, hard shape caps on everything stored, and a write
 * ceiling per run.
 *
 * The rate limit is keyed on the RUN, not the address: the callers are desktop
 * apps behind campus NATs, where one IP is a whole dorm — a per-IP limit would
 * throttle everyone in order to throttle no one. A run produces at most a few
 * dozen packets in its whole life, so 240/hour is a ceiling on database writes
 * from a stuck retry loop, not something a real user can reach.
 */
funnelRouter.post(
  "/track",
  asyncHandler(async (req, res) => {
    const input = trackSchema.parse(req.body);

    if (!KNOWN_PLATFORMS.has(input.platform)) {
      res.status(204).end();
      return;
    }

    const startedAt = new Date(input.startedAt);
    if (Number.isNaN(startedAt.getTime())) {
      // No t0, no run — this is the one field nothing downstream can limp
      // along without. Still 204: a client with a broken clock is not helped
      // by an error it will retry forever.
      res.status(204).end();
      return;
    }

    await consumeRateLimit(`funnel:run:${input.runId}`, 240, HOUR_MS);

    const now = new Date();
    const steps = input.steps.map((s) => ({
      step: s.step,
      enteredAt: s.enteredAt ? s.enteredAt.toISOString() : null,
      leftAt: s.leftAt ? s.leftAt.toISOString() : null,
      ms: s.ms,
    }));

    const data = {
      seq: input.seq,
      platform: input.platform,
      deviceId: input.deviceId ?? null,
      deviceName: input.deviceName ?? null,
      osVersion: input.osVersion ?? null,
      appVersion: input.appVersion ?? null,
      funnelVersion: input.funnelVersion ?? null,
      locale: input.locale ?? null,
      withAccount: input.withAccount ?? null,
      screenTotal: input.screenTotal ?? null,
      startedAt,
      completedAt: input.completedAt,
      lastStep: input.lastStep ?? steps[steps.length - 1]?.step ?? null,
      eventCount: steps.length,
      steps,
      lastSeenAt: now,
    };

    // Replace-if-not-behind, then create-if-new. `seq: { lte }` is the whole
    // ordering story: a delayed earlier packet carries a smaller seq and
    // matches nothing, so it is dropped instead of rolling the record back.
    // Equal seq can only be a retry of the same packet, which may replace
    // itself freely. Log LENGTH could not do this job: the completion packet
    // does not grow the log, so a strayed pre-completion packet of equal
    // length would erase completedAt from a finished run — permanently, since
    // the client's dirty flag cleared when the completion was acknowledged.
    const where = { runId: input.runId, seq: { lte: input.seq } };
    const updated = await prisma.funnelRun.updateMany({ where, data });
    if (updated.count === 0) {
      // About to mint a NEW document. The per-run limiter above cannot bound
      // how many of those one caller creates — its key is the caller's to
      // rotate — so creates get their own global ceiling: far above any launch
      // day, and a hard cap on what a runId-minting loop can write.
      await consumeRateLimit("funnel:create", 1000, HOUR_MS);
      try {
        await prisma.funnelRun.create({ data: { runId: input.runId, ...data } });
      } catch {
        // Lost the create race — but the row that won is not necessarily newer
        // than this packet (an instance stalled on an EARLIER packet can win
        // it). Re-run the guarded replace: it applies iff this log is not
        // behind the stored one, and still matches nothing for a truly stale
        // packet. Same recovery as the referrals upsert.
        await prisma.funnelRun.updateMany({ where, data });
      }
    }

    res.status(204).end();
  }),
);

// --- read side (admin console) -----------------------------------------------

export interface FunnelStepLog {
  step: string;
  enteredAt: string | null;
  leftAt: string | null;
  ms: number | null;
}

export type FunnelRunStatus = "completed" | "active" | "abandoned";

export interface FunnelRunDto {
  runId: string;
  platform: string;
  deviceId: string | null;
  deviceName: string | null;
  osVersion: string | null;
  appVersion: string | null;
  funnelVersion: string | null;
  locale: string | null;
  withAccount: boolean | null;
  screenTotal: number | null;
  startedAt: string;
  completedAt: string | null;
  lastSeenAt: string;
  lastStep: string | null;
  status: FunnelRunStatus;
  /** startedAt → completedAt for a finished run, startedAt → lastSeenAt for
   *  the rest — "how long they have been at it" either way. */
  durationMs: number;
  steps: FunnelStepLog[];
}

export interface FunnelSummary {
  started: number;
  completed: number;
  active: number;
  abandoned: number;
  /** Median completed-run length; null until anyone has finished. */
  medianDurationMs: number | null;
  /** Walk order (union of both platforms) → how many runs reached each step,
   *  and how many stopped there. Steps no run visited are omitted. */
  dropoff: { step: string; reached: number; droppedHere: number }[];
}

export interface FunnelResponse {
  runs: FunnelRunDto[];
  summary: FunnelSummary;
  windowDays: number;
  stepOrder: string[];
}

type StoredRun = {
  runId: string;
  platform: string;
  deviceId: string | null;
  deviceName: string | null;
  osVersion: string | null;
  appVersion: string | null;
  funnelVersion: string | null;
  locale: string | null;
  withAccount: boolean | null;
  screenTotal: number | null;
  startedAt: Date;
  completedAt: Date | null;
  lastSeenAt: Date;
  lastStep: string | null;
  steps: unknown;
};

/** The stored Json column, re-checked on the way out — the console must never
 *  crash on a document an older (or newer) writer shaped differently. */
function stepLogs(raw: unknown): FunnelStepLog[] {
  if (!Array.isArray(raw)) return [];
  const out: FunnelStepLog[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.step !== "string") continue;
    out.push({
      step: rec.step,
      enteredAt: typeof rec.enteredAt === "string" ? rec.enteredAt : null,
      leftAt: typeof rec.leftAt === "string" ? rec.leftAt : null,
      ms: typeof rec.ms === "number" && Number.isFinite(rec.ms) ? rec.ms : null,
    });
  }
  return out;
}

function statusOf(run: StoredRun, now: Date): FunnelRunStatus {
  if (run.completedAt) return "completed";
  return now.getTime() - run.lastSeenAt.getTime() <= FUNNEL_ACTIVE_WINDOW_MS
    ? "active"
    : "abandoned";
}

/**
 * Fold the stored rows into what the console renders. Exported for the tests,
 * and because the drop-off arithmetic is the only part worth reading twice.
 */
export function summarise(rows: StoredRun[], now: Date = new Date()): Omit<FunnelResponse, "windowDays"> {
  const runs = rows.map((run): FunnelRunDto => {
    const status = statusOf(run, now);
    const end = run.completedAt ?? run.lastSeenAt;
    return {
      runId: run.runId,
      platform: run.platform,
      deviceId: run.deviceId,
      deviceName: run.deviceName,
      osVersion: run.osVersion,
      appVersion: run.appVersion,
      funnelVersion: run.funnelVersion,
      locale: run.locale,
      withAccount: run.withAccount,
      screenTotal: run.screenTotal,
      startedAt: run.startedAt.toISOString(),
      completedAt: run.completedAt ? run.completedAt.toISOString() : null,
      lastSeenAt: run.lastSeenAt.toISOString(),
      lastStep: run.lastStep,
      status,
      durationMs: Math.max(0, end.getTime() - run.startedAt.getTime()),
      steps: stepLogs(run.steps),
    };
  });

  const completedDurations = runs
    .filter((r) => r.status === "completed")
    .map((r) => r.durationMs)
    .sort((a, b) => a - b);
  const medianDurationMs =
    completedDurations.length === 0
      ? null
      : completedDurations[Math.floor((completedDurations.length - 1) / 2)];

  // Drop-off: how far did each run get. "Farthest" is walk position, not log
  // position — a restarted run's log revisits early steps, and the honest
  // answer for it is still the deepest screen it ever reached. Unknown step
  // names (a future funnel version) keep their first-seen relative order after
  // the known walk.
  const orderIndex = new Map<string, number>(FUNNEL_STEP_ORDER.map((s, i) => [s, i]));
  let nextUnknown = FUNNEL_STEP_ORDER.length;
  const indexOf = (step: string): number => {
    const known = orderIndex.get(step);
    if (known !== undefined) return known;
    orderIndex.set(step, nextUnknown);
    return nextUnknown++;
  };

  const reached = new Map<string, number>();
  const droppedHere = new Map<string, number>();
  for (const run of runs) {
    const visited = new Set(run.steps.map((s) => s.step));
    if (run.lastStep) visited.add(run.lastStep);
    let farthest: string | null = null;
    for (const step of visited) {
      if (farthest === null || indexOf(step) > indexOf(farthest)) farthest = step;
    }
    for (const step of visited) {
      reached.set(step, (reached.get(step) ?? 0) + 1);
    }
    if (farthest !== null && run.status === "abandoned") {
      droppedHere.set(farthest, (droppedHere.get(farthest) ?? 0) + 1);
    }
  }

  const dropoff = [...reached.keys()]
    .sort((a, b) => indexOf(a) - indexOf(b))
    .map((step) => ({
      step,
      reached: reached.get(step) ?? 0,
      droppedHere: droppedHere.get(step) ?? 0,
    }));

  const byStatus = (s: FunnelRunStatus) => runs.filter((r) => r.status === s).length;

  return {
    runs,
    summary: {
      started: runs.length,
      completed: byStatus("completed"),
      active: byStatus("active"),
      abandoned: byStatus("abandoned"),
      medianDurationMs,
      dropoff,
    },
    stepOrder: [...FUNNEL_STEP_ORDER],
  };
}

export const adminFunnelRouter = Router();

adminFunnelRouter.get(
  "/",
  requireAdmin,
  asyncHandler(async (req, res) => {
    // Clamped by hand like every other admin list — query params are not zod
    // territory in this repo.
    const days = Math.min(90, Math.max(1, Number(req.query.days) || FUNNEL_WINDOW_DAYS));
    const take = Math.min(500, Math.max(1, Number(req.query.take) || 200));
    const platform =
      typeof req.query.platform === "string" && KNOWN_PLATFORMS.has(req.query.platform)
        ? req.query.platform
        : null;

    const now = new Date();
    const rows = await prisma.funnelRun.findMany({
      where: {
        lastSeenAt: { gte: new Date(now.getTime() - days * DAY_MS) },
        ...(platform ? { platform } : {}),
      },
      orderBy: { lastSeenAt: "desc" },
      take,
    });

    res.json({ ...summarise(rows, now), windowDays: days } satisfies FunnelResponse);
  }),
);
