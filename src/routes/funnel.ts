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

/**
 * How confidently an account was tied to a run.
 *
 *  "run"    — this walk produced that account: the onboarding answers carry the
 *             run's OWN id, or the account was minted while the run was live.
 *  "device" — same machine, but an account older than the run (a reinstall, a
 *             second walk on a shared desk). Still worth showing, but it is an
 *             inference and the console says so rather than passing it off as
 *             the person who just walked the funnel.
 */
export type FunnelEmailMatch = "run" | "device";

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
  /** The account behind the walk, once one exists — null while it does not. */
  userId: string | null;
  email: string | null;
  emailMatch: FunnelEmailMatch | null;
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
      // Left empty here on purpose: `summarise` stays a pure fold over the
      // stored rows, and the account join is a separate, database-touching
      // pass (`attachAccounts`) so both halves stay testable on their own.
      userId: null,
      email: null,
      emailMatch: null,
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

// --- who is behind the walk --------------------------------------------------

/**
 * The point of this join: the console is where a signup is CHASED, and chasing
 * needs an address. Without it every promising run costs a trip to the users
 * page and a guess about which account the machine turned into.
 *
 * It is resolved SERVER-SIDE from what is already stored rather than added to
 * the tracking packet, for two reasons. The desktop clients would each need a
 * release, and — more to the point — the packet is public and unauthenticated:
 * an address posted there is an address anyone can post about anyone. Read back
 * from the account tables, an email is only ever one the backend itself wrote.
 * It also means the link works on runs already recorded, not just future ones.
 */

/** How far a client-reported `startedAt` may sit ahead of the server clock and
 *  still count as "the account was made during this walk". Small: the wider
 *  this is, the more an unrelated earlier account can pass for this run's. */
const SIGNUP_CLOCK_SLACK_MS = 15 * 60 * 1000;

/** How long AFTER a run's last packet an account may still be born of it. The
 *  walk goes quiet the moment the account screen submits, and the row lands a
 *  moment later. */
const SIGNUP_TAIL_MS = 30 * 60 * 1000;

type LinkedUser = { id: string; email: string; createdAt: Date };

export interface FunnelAccountLinks {
  /** runId -> userId. The exact link: the onboarding answers were submitted
   *  under this very run's id. */
  byRunId: Map<string, string>;
  /** deviceId -> every account ever seen on that machine. A set, because a
   *  reinstall or a shared desk puts several there. */
  byDeviceId: Map<string, Set<string>>;
  users: Map<string, LinkedUser>;
}

/**
 * Fill in `userId` / `email` / `emailMatch` on runs that have an account behind
 * them. Pure, and exported for the tests — the confidence rule below is the
 * only part of this feature that can be quietly wrong.
 */
export function attachAccounts(runs: FunnelRunDto[], links: FunnelAccountLinks): void {
  for (const run of runs) {
    const set = (user: LinkedUser, match: FunnelEmailMatch) => {
      run.userId = user.id;
      run.email = user.email;
      run.emailMatch = match;
    };

    // 1. The run's own submission id. Nothing to weigh: these are the same walk.
    const exact = links.byRunId.get(run.runId);
    const exactUser = exact ? links.users.get(exact) : undefined;
    if (exactUser) {
      set(exactUser, "run");
      continue;
    }

    const candidates = (run.deviceId ? [...(links.byDeviceId.get(run.deviceId) ?? [])] : [])
      .map((id) => links.users.get(id))
      .filter((u): u is LinkedUser => u !== undefined);
    if (candidates.length === 0) continue;

    // 2. Born during the walk. `startedAt` is the CLIENT's clock and the other
    //    two instants are the server's, hence the slack on the lower bound.
    const from = new Date(run.startedAt).getTime() - SIGNUP_CLOCK_SLACK_MS;
    const until = new Date(run.lastSeenAt).getTime() + SIGNUP_TAIL_MS;
    const during = candidates
      .filter((u) => {
        const t = u.createdAt.getTime();
        return t >= from && t <= until;
      })
      // Earliest: the account the walk reached the account screen with, not one
      // made afterwards in a second sitting.
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    if (during.length > 0) {
      set(during[0], "run");
      continue;
    }

    // 3. Same machine, older account. Shown because it is almost always the
    //    person sitting at it — and flagged, because "almost always" is not
    //    something an email should be sent on without knowing. The newest
    //    account wins: on a machine handed over, that is its current owner.
    const newest = [...candidates].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    set(newest, "device");
  }
}

/**
 * Gather the account links for one page of runs. Three reads, none of them
 * per-run: the console polls this every ten seconds.
 */
async function loadAccountLinks(runs: FunnelRunDto[]): Promise<FunnelAccountLinks> {
  const runIds = new Set(runs.map((r) => r.runId));
  const deviceIds = [...new Set(runs.map((r) => r.deviceId).filter((d): d is string => Boolean(d)))];

  const byRunId = new Map<string, string>();
  const byDeviceId = new Map<string, Set<string>>();
  const users = new Map<string, LinkedUser>();
  const seenOnDevice = (deviceId: string, userId: string) => {
    const set = byDeviceId.get(deviceId) ?? new Set<string>();
    set.add(userId);
    byDeviceId.set(deviceId, set);
  };
  if (runIds.size === 0) return { byRunId, byDeviceId, users };

  // One pass over the onboarding answers serves BOTH links — the same row
  // carries the submission id and the pre-registration deviceId. Neither column
  // is indexed (see the model: `clientSubmissionId` is deliberately not, and a
  // MongoDB index here would have to be created by hand on the live cluster);
  // this is a small collection behind an admin-only read, so the scan is the
  // cheaper side of that trade.
  const profiles = await prisma.onboardingProfile.findMany({
    where: {
      OR: [
        { clientSubmissionId: { in: [...runIds] } },
        ...(deviceIds.length > 0 ? [{ deviceId: { in: deviceIds } }] : []),
      ],
    },
    select: { userId: true, clientSubmissionId: true, deviceId: true },
  });
  for (const p of profiles) {
    // `clientSubmissionId` is rewritten when the answers are edited, so a row
    // may match on the device alone — that is exactly why both links exist.
    if (runIds.has(p.clientSubmissionId)) byRunId.set(p.clientSubmissionId, p.userId);
    if (p.deviceId) seenOnDevice(p.deviceId, p.userId);
  }

  // Registered devices catch the walks whose answers never landed: the account
  // exists, the onboarding POST failed or was abandoned. `deviceId` is indexed.
  const devices =
    deviceIds.length === 0
      ? []
      : await prisma.device.findMany({
          where: { deviceId: { in: deviceIds } },
          select: { userId: true, deviceId: true },
        });
  for (const d of devices) {
    if (d.deviceId) seenOnDevice(d.deviceId, d.userId);
  }

  const userIds = [
    ...new Set([...byRunId.values(), ...[...byDeviceId.values()].flatMap((set) => [...set])]),
  ];
  if (userIds.length > 0) {
    const rows = await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, email: true, createdAt: true },
    });
    for (const u of rows) users.set(u.id, u);
  }

  return { byRunId, byDeviceId, users };
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

    const result = summarise(rows, now);
    attachAccounts(result.runs, await loadAccountLinks(result.runs));

    res.json({ ...result, windowDays: days } satisfies FunnelResponse);
  }),
);
