/**
 * Pure onboarding-funnel helpers: the canonical projection math, the age → band
 * reduction, and answer-slug normalisation. No DB, no Express — this is the
 * single source of truth for numbers the client also computes locally.
 */

// --- Age gate ---------------------------------------------------------------

/** Minimum declared age. Mirrors welockin-mobile legal.ts §11 / Terms §1. */
export const MIN_AGE = 16;
/** The funnel's keypad is exactly two digits, so 99 is the ceiling. */
export const MAX_AGE = 99;

export const AGE_BANDS = ["16_17", "18_24", "25_34", "35_44", "45_plus"] as const;
export type AgeBand = (typeof AGE_BANDS)[number];

/**
 * Reduce a declared age to the coarsest band the product can still personalise
 * with. Returns null below MIN_AGE so the caller refuses the submission. The
 * exact integer is NEVER persisted (data minimisation).
 */
export function ageBandFor(age: number): AgeBand | null {
  if (!Number.isInteger(age) || age < MIN_AGE || age > MAX_AGE) return null;
  if (age <= 17) return "16_17";
  if (age <= 24) return "18_24";
  if (age <= 34) return "25_34";
  if (age <= 44) return "35_44";
  return "45_plus";
}

// --- Projection -------------------------------------------------------------

export const DAYS_PER_YEAR = 365;
export const LIFE_EXPECTANCY_YEARS = 80;
export const RECLAIM_FRACTION = 0.4;
export const MAX_DAILY_HOURS = 12;

export interface OnboardingProjection {
  selfReportedDailyHours: number;
  hoursPerYear: number;
  yearsLost: number;
  reclaimDaysPerYear: number;
}

/**
 * The canonical funnel numbers — byte-for-byte the prototype's formulas
 * (Onboarding téléphone v6: playCalc + planReclaim), so the screens the user saw
 * and the server record can never disagree. Math.round is half-up, which matters
 * at h=6 (36.5 → 37) and h=12 (182.5 → 183). Client-sent derived values are
 * NEVER trusted; this is always recomputed from the stored hours.
 */
export function computeOnboardingProjection(hours: number): OnboardingProjection {
  const h = Math.max(0, Math.min(MAX_DAILY_HOURS, Math.trunc(hours)));
  return {
    selfReportedDailyHours: h,
    hoursPerYear: h * DAYS_PER_YEAR,
    yearsLost: Math.round((h / 24) * LIFE_EXPECTANCY_YEARS),
    reclaimDaysPerYear: Math.round((h * RECLAIM_FRACTION * DAYS_PER_YEAR) / 24),
  };
}

// --- Answer slugs -----------------------------------------------------------

/**
 * The options the CURRENT funnel ships. Documentation + tests ONLY — never used
 * to reject input: the funnel evolves without a deploy and old binaries keep
 * POSTing, so an unknown slug is stored verbatim rather than 400'd.
 */
export const KNOWN_PROFILE_SLUGS = [
  // Legacy set (pre-v2 funnels) — kept because old binaries still POST them.
  "student",
  "working_professional",
  "founder_or_freelancer",
  "profile_other",
  // Funnel-v2 set (desktop_v2 / phone_v7).
  "high_school",
  "undergraduate",
  "postgraduate",
  "phd_student",
  "working",
] as const;
export const KNOWN_GOAL_SLUGS = [
  "focus_better",
  "less_screen_time",
  "build_better_habits",
  "be_more_present",
  "goal_other",
] as const;
export const KNOWN_APP_SLUGS = [
  "instagram",
  "tiktok",
  "youtube",
  "x_twitter",
  "snapchat",
  "reddit",
  "games",
  "app_other",
] as const;

/**
 * APPEND-ONLY rename map so renamed options converge instead of forking.
 * Prototype-less on purpose — see normalizeSlug.
 */
export const SLUG_ALIASES: Record<string, string> = Object.assign(Object.create(null), {
  x: "x_twitter",
  twitter: "x_twitter",
});

/** Stored ceiling for the multi-select (zod bounds the raw input at 32). */
export const MAX_DISTRACTING_APPS = 16;

export function normalizeSlug(slug: string): string {
  const s = slug.trim().toLowerCase();
  // `SLUG_ALIASES[s] ?? s` on a plain object literal resolved through
  // Object.prototype: the slug "constructor" passes the zod slug regex, so it
  // returned Object.prototype.constructor — a FUNCTION, which `??` does not catch
  // and which Prisma then rejects with a validation error on the ONE request that
  // gates the paywall. Own-property lookup only.
  const alias = Object.prototype.hasOwnProperty.call(SLUG_ALIASES, s)
    ? SLUG_ALIASES[s]
    : undefined;
  return typeof alias === "string" ? alias : s;
}

/** Dedupe keeping FIRST occurrence: tap order drives screen 12's plan copy. */
export function normalizeSlugList(slugs: string[]): string[] {
  const out: string[] = [];
  for (const raw of slugs) {
    const slug = normalizeSlug(raw);
    if (!out.includes(slug)) out.push(slug);
    if (out.length >= MAX_DISTRACTING_APPS) break;
  }
  return out;
}
