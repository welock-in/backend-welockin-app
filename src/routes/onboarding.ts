import { Router } from "express";
import { Prisma, type OnboardingProfile } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/auth";
import { asyncHandler } from "../middleware/async-handler";
import {
  accountGone,
  ageBelowMinimum,
  onboardingIncomplete,
  onboardingRateLimited,
} from "../lib/http-error";
import { deterministicObjectId } from "../lib/deterministic-id";
import { onboardingSubmitSchema } from "../validation/schemas";
import {
  MIN_AGE,
  type AgeBand,
  ageBandFor,
  computeOnboardingProjection,
  normalizeSlug,
  normalizeSlugList,
} from "../lib/onboarding";

export const onboardingRouter = Router();

// Soft anti-abuse: mutating submissions per user per rolling hour. Storage is
// bounded at one row per user, so this only caps write churn. Counted on the row
// itself (no extra collection); the check-then-act race is accepted, exactly like
// the feedback board's DB count window.
const MAX_SUBMISSIONS_PER_HOUR = 10;
const SUBMISSION_WINDOW_MS = 60 * 60 * 1000;

// Mongo surfaces a raced insert as P2002 (duplicate key, winner committed) OR
// P2034 (write conflict, winner still committing — Prisma wraps writes in an
// implicit transaction on a replica set). Both mean "someone else got there".
const isRaceError = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError &&
  (err.code === "P2002" || err.code === "P2034");

type ShownProjection = {
  hoursPerYear?: number;
  yearsLost?: number;
  reclaimDaysPerYear?: number;
} | null;

/** The wire shape both endpoints return. Never a raw Prisma row. */
function onboardingProfileDto(p: OnboardingProfile) {
  const projection = computeOnboardingProjection(p.selfReportedDailyHours);
  const shown = (p.clientProjection ?? null) as ShownProjection;
  const differs = (a: number | undefined, b: number) => a !== undefined && a !== b;
  return {
    displayName: p.displayName ?? null,
    ageBand: p.ageBand,
    profile: p.profileSlug ?? null,
    university: p.university ?? null,
    goal: p.goalSlug ?? null,
    distractingApps: p.distractingAppSlugs,
    selfReportedDailyHours: p.selfReportedDailyHours,
    // ALWAYS server-computed. The client's own numbers are echoed separately.
    projection,
    clientProjection: shown,
    projectionMismatch:
      !!shown &&
      (differs(shown.hoursPerYear, projection.hoursPerYear) ||
        differs(shown.yearsLost, projection.yearsLost) ||
        differs(shown.reclaimDaysPerYear, projection.reclaimDaysPerYear)),
    funnelVersion: p.funnelVersion,
    locale: p.locale ?? null,
    appVersion: p.appVersion ?? null,
    platform: p.platform ?? null,
    deviceId: p.deviceId ?? null,
    startedAt: p.startedAt?.toISOString() ?? null,
    completedAt: p.completedAt.toISOString(),
    revision: p.revision,
    updatedAt: p.updatedAt.toISOString(),
  };
}

/**
 * Step 2 of the two-write sequence: denormalise the only two fields the app needs
 * on the boot path (GET /api/me) so no join is required. Written AFTER the profile
 * row, so a crash in between leaves a valid receipt with a stale cache — never a
 * cache with no receipt. Last-write-wins with identical values on replay.
 *
 * Called on EVERY path that resolves a stored row (create, merge, replay, raced
 * create) precisely because it is idempotent: this is the only writer of
 * User.displayName / User.onboardingCompletedAt in the backend, and nothing else
 * — no cron, no reconcile script — can repair a mirror that failed once.
 */
async function mirrorToUser(userId: string, p: OnboardingProfile): Promise<void> {
  try {
    await prisma.user.update({
      where: { id: userId },
      data: {
        onboardingCompletedAt: p.completedAt,
        ...(p.displayName ? { displayName: p.displayName } : {}),
      },
    });
  } catch (err) {
    // requireAuth is stateless JWT verification, so a token for a DELETED account
    // reaches here and Mongo has no insert-time FK check. Surface that as a
    // machine-readable 404 — the generic P2025 mapping in the error middleware
    // emits the same body as an unrouted path, which the client must retry rather
    // than treat as "the account is gone".
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      throw accountGone();
    }
    throw err;
  }
}

/**
 * Submit (or re-submit) the onboarding funnel answers. ONE call, idempotent on
 * clientSubmissionId. No requireBoundDevice: the funnel's first authenticated
 * call happens before the device is registered (POST /sync/push is the precedent).
 * 201 on first create, 200 on a replay (deduped: true) or a later edit.
 */
onboardingRouter.post(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const input = onboardingSubmitSchema.parse(req.body);
    const userId = req.user!.id;
    const now = new Date();

    // Policy gate BEFORE any read or write, whenever an age is declared at all.
    // The exact age is never persisted — only the band derived from it. An edit that
    // omits `age` keeps the stored band; an edit that DECLARES an under-age value is
    // refused exactly like a first submission (the gate is not skippable).
    let ageBand: AgeBand | undefined;
    if (input.age !== undefined) {
      const band = ageBandFor(input.age);
      if (!band) throw ageBelowMinimum(MIN_AGE);
      ageBand = band;
    }

    // Mergeable answers. Conditional spreads so an absent key leaves the stored
    // column untouched (a partial re-submit must not wipe the app list).
    const answers = {
      ...(ageBand !== undefined ? { ageBand } : {}),
      ...(input.selfReportedDailyHours !== undefined
        ? { selfReportedDailyHours: input.selfReportedDailyHours }
        : {}),
      ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
      ...(input.profile !== undefined ? { profileSlug: normalizeSlug(input.profile) } : {}),
      // Free text, so no slug normalisation — zod already trimmed it. null flows
      // through on purpose: it CLEARS the column (student → non-student re-run),
      // which is exactly why absent and null must stay distinguishable here.
      ...(input.university !== undefined ? { university: input.university } : {}),
      ...(input.goal !== undefined ? { goalSlug: normalizeSlug(input.goal) } : {}),
      ...(input.distractingApps !== undefined
        ? { distractingAppSlugs: normalizeSlugList(input.distractingApps) }
        : {}),
      ...(input.locale !== undefined ? { locale: input.locale } : {}),
      ...(input.appVersion !== undefined ? { appVersion: input.appVersion } : {}),
      ...(input.platform !== undefined ? { platform: input.platform } : {}),
      ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
      ...(input.clientProjection !== undefined
        ? { clientProjection: input.clientProjection as Prisma.InputJsonValue }
        : {}),
    };

    /**
     * A submission id that differs from the stored one = a genuine edit → merge it
     * into the single row. Shared by the sequential path and by the raced-create
     * recovery, where the winner can carry a DIFFERENT id than the caller sent.
     */
    const merge = async (stored: OnboardingProfile): Promise<OnboardingProfile> => {
      const started = stored.writeWindowStartedAt;
      const inWindow = !!started && now.getTime() - started.getTime() < SUBMISSION_WINDOW_MS;
      if (inWindow && (stored.writeWindowCount ?? 0) >= MAX_SUBMISSIONS_PER_HOUR) {
        throw onboardingRateLimited();
      }
      const merged = await prisma.onboardingProfile.update({
        where: { userId },
        data: {
          ...answers,
          clientSubmissionId: input.clientSubmissionId,
          revision: { increment: 1 },
          // IMMUTABLE and deliberately absent here: completedAt, startedAt,
          // funnelVersion, createdAt — they anchor the original submission.
          ...(inWindow
            ? { writeWindowCount: { increment: 1 } }
            : { writeWindowStartedAt: now, writeWindowCount: 1 }),
        },
      });
      await mirrorToUser(userId, merged);
      return merged;
    };

    const existing = await prisma.onboardingProfile.findUnique({ where: { userId } });

    // Idempotency fast-path: the same submission id merges NOTHING — no answer
    // write, no revision bump, no rate-limit charge. The User mirror is still
    // converged, because the first attempt may have committed the receipt and then
    // failed on the mirror (a transient user.update error → 500). The client retries
    // the SAME id, so that lands HERE, not on the race path below — and this is the
    // only place that can ever repair it.
    if (existing && existing.clientSubmissionId === input.clientSubmissionId) {
      await mirrorToUser(userId, existing);
      res.status(200).json({ onboarding: onboardingProfileDto(existing), deduped: true });
      return;
    }

    if (existing) {
      const merged = await merge(existing);
      res.status(200).json({ onboarding: onboardingProfileDto(merged), deduped: false });
      return;
    }

    // A first submission must carry the whole funnel — there is no stored band or
    // gauge value to merge into. Only LATER edits may omit them, which is the entire
    // reason both are optional in zod: a device that reinstalled has the account but
    // not the local answers, and GET never returns the exact age.
    const missing = [
      ...(ageBand === undefined ? ["age"] : []),
      ...(input.selfReportedDailyHours === undefined ? ["selfReportedDailyHours"] : []),
    ];
    if (ageBand === undefined || input.selfReportedDailyHours === undefined) {
      throw onboardingIncomplete(missing);
    }

    // First submission. Deterministic _id so two cold serverless instances racing
    // the same retry collide on the PRIMARY key even if the userId unique index is
    // absent (a deploy that landed before `prisma db push` auto-creates the
    // collection with no indexes).
    try {
      const created = await prisma.onboardingProfile.create({
        data: {
          id: deterministicObjectId("onboarding", userId),
          userId,
          funnelVersion: input.funnelVersion,
          clientSubmissionId: input.clientSubmissionId,
          startedAt: input.startedAt ?? null,
          completedAt: now,
          revision: 1,
          writeWindowStartedAt: now,
          writeWindowCount: 1,
          distractingAppSlugs: [],
          // Narrowed above, so the two required columns are always present here.
          ageBand,
          selfReportedDailyHours: input.selfReportedDailyHours,
          ...answers,
        },
      });
      await mirrorToUser(userId, created);
      res.status(201).json({ onboarding: onboardingProfileDto(created), deduped: false });
      return;
    } catch (err) {
      // Race: a concurrent replay inserted first. Mongo surfaces that as P2002
      // (duplicate key) or P2034 (write conflict) — re-read and dedup.
      if (!isRaceError(err)) throw err;
      const raced = await prisma.onboardingProfile.findUnique({ where: { userId } });
      if (!raced) throw err;
      // The deterministic _id keys on userId ALONE (the submission id is not a
      // component), so a collision only proves "some submission for this user got
      // here first" — NOT "this submission got here first". Reporting the winner as
      // a dedupe would tell the loser its answers are stored while nothing merged
      // them, and a client trusting `deduped: true` then drops its pending edit.
      if (raced.clientSubmissionId !== input.clientSubmissionId) {
        const merged = await merge(raced);
        res.status(200).json({ onboarding: onboardingProfileDto(merged), deduped: false });
        return;
      }
      // A true replay. The winner may have died before mirroring — converge here.
      await mirrorToUser(userId, raced);
      res.status(200).json({ onboarding: onboardingProfileDto(raced), deduped: true });
      return;
    }
  }),
);

/**
 * Read the caller's onboarding record. Returns `{ onboarding: null }` when the
 * funnel was never submitted — unlike /sync/pull we do NOT normalise to an empty
 * record, because a fabricated ageBand/projection would be a lie.
 */
onboardingRouter.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const profile = await prisma.onboardingProfile.findUnique({
      where: { userId: req.user!.id },
    });
    res.json({ onboarding: profile ? onboardingProfileDto(profile) : null });
  }),
);
