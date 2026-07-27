import assert from "node:assert/strict";
import { test } from "node:test";
import {
  KNOWN_APP_SLUGS,
  KNOWN_GOAL_SLUGS,
  KNOWN_PROFILE_SLUGS,
  MAX_DISTRACTING_APPS,
  ageBandFor,
  computeOnboardingProjection,
  normalizeSlug,
  normalizeSlugList,
} from "./onboarding";

// The prototype's own table (Onboarding téléphone v6: playCalc + planReclaim).
// Locks JS half-up rounding at h=6 (36.5 → 37) and h=12 (182.5 → 183 → 73).
const PROTOTYPE_TABLE = [
  { h: 0, hoursPerYear: 0, yearsLost: 0, reclaimDaysPerYear: 0 },
  { h: 1, hoursPerYear: 365, yearsLost: 3, reclaimDaysPerYear: 6 },
  { h: 2, hoursPerYear: 730, yearsLost: 7, reclaimDaysPerYear: 12 },
  { h: 3, hoursPerYear: 1095, yearsLost: 10, reclaimDaysPerYear: 18 },
  { h: 4, hoursPerYear: 1460, yearsLost: 13, reclaimDaysPerYear: 24 },
  { h: 5, hoursPerYear: 1825, yearsLost: 17, reclaimDaysPerYear: 30 },
  { h: 6, hoursPerYear: 2190, yearsLost: 20, reclaimDaysPerYear: 37 },
  { h: 7, hoursPerYear: 2555, yearsLost: 23, reclaimDaysPerYear: 43 },
  { h: 8, hoursPerYear: 2920, yearsLost: 27, reclaimDaysPerYear: 49 },
  { h: 9, hoursPerYear: 3285, yearsLost: 30, reclaimDaysPerYear: 55 },
  { h: 10, hoursPerYear: 3650, yearsLost: 33, reclaimDaysPerYear: 61 },
  { h: 11, hoursPerYear: 4015, yearsLost: 37, reclaimDaysPerYear: 67 },
  { h: 12, hoursPerYear: 4380, yearsLost: 40, reclaimDaysPerYear: 73 },
];

test("the projection matches the prototype table for every reachable gauge value", () => {
  for (const row of PROTOTYPE_TABLE) {
    const p = computeOnboardingProjection(row.h);
    assert.equal(p.selfReportedDailyHours, row.h);
    assert.equal(p.hoursPerYear, row.hoursPerYear, `hoursPerYear at h=${row.h}`);
    assert.equal(p.yearsLost, row.yearsLost, `yearsLost at h=${row.h}`);
    assert.equal(
      p.reclaimDaysPerYear,
      row.reclaimDaysPerYear,
      `reclaimDaysPerYear at h=${row.h}`,
    );
  }
});

test("the projection clamps out-of-range hours instead of extrapolating", () => {
  assert.equal(computeOnboardingProjection(-3).selfReportedDailyHours, 0);
  assert.equal(computeOnboardingProjection(-3).hoursPerYear, 0);
  assert.equal(computeOnboardingProjection(99).selfReportedDailyHours, 12);
  assert.equal(computeOnboardingProjection(99).hoursPerYear, 4380);
  assert.equal(computeOnboardingProjection(6.7).selfReportedDailyHours, 6);
  assert.equal(computeOnboardingProjection(6.7).reclaimDaysPerYear, 37);
});

test("ageBandFor collapses every accepted age onto the right band boundary", () => {
  assert.equal(ageBandFor(16), "16_17");
  assert.equal(ageBandFor(17), "16_17");
  assert.equal(ageBandFor(18), "18_24");
  assert.equal(ageBandFor(24), "18_24");
  assert.equal(ageBandFor(25), "25_34");
  assert.equal(ageBandFor(34), "25_34");
  assert.equal(ageBandFor(35), "35_44");
  assert.equal(ageBandFor(44), "35_44");
  assert.equal(ageBandFor(45), "45_plus");
  assert.equal(ageBandFor(99), "45_plus");
});

test("ageBandFor refuses under-age and non-integer declarations", () => {
  assert.equal(ageBandFor(15), null);
  assert.equal(ageBandFor(0), null);
  assert.equal(ageBandFor(100), null);
  assert.equal(ageBandFor(Number.NaN), null);
  assert.equal(ageBandFor(18.5), null);
});

test("normalizeSlug trims, lowercases, and applies the rename aliases", () => {
  assert.equal(normalizeSlug("  Instagram "), "instagram");
  assert.equal(normalizeSlug("X"), "x_twitter");
  assert.equal(normalizeSlug("twitter"), "x_twitter");
  // Forward compatibility: an option this build has never heard of survives.
  assert.equal(normalizeSlug("cosmonaut"), "cosmonaut");
});

test("normalizeSlugList dedupes keeping tap order and caps the stored list", () => {
  assert.deepEqual(normalizeSlugList(["tiktok", "instagram", "tiktok"]), [
    "tiktok",
    "instagram",
  ]);
  // Aliases collapse onto the canonical slug before the dedupe.
  assert.deepEqual(normalizeSlugList(["x", "twitter", "reddit"]), ["x_twitter", "reddit"]);

  const many = Array.from({ length: 40 }, (_value, i) => `app_${i}`);
  const capped = normalizeSlugList(many);
  assert.equal(capped.length, MAX_DISTRACTING_APPS);
  assert.equal(capped[0], "app_0");
  assert.equal(capped[MAX_DISTRACTING_APPS - 1], `app_${MAX_DISTRACTING_APPS - 1}`);
});

test("normalizeSlug never resolves an answer through Object.prototype", () => {
  // "constructor" is a legal slug as far as the zod regex is concerned, so it DOES
  // reach here from the wire. The old `SLUG_ALIASES[s] ?? s` returned
  // Object.prototype.constructor (a function) — Prisma then rejected the write and
  // the single paywall-gating request 500'd.
  for (const hazard of ["constructor", "__proto__", "toString", "valueOf", "hasOwnProperty"]) {
    const normalized = normalizeSlug(hazard);
    assert.equal(typeof normalized, "string", `${hazard} must normalise to a string`);
    assert.equal(normalized, hazard.toLowerCase());
  }
  assert.deepEqual(normalizeSlugList(["constructor", "instagram"]), ["constructor", "instagram"]);
});

test("every catalogued slug survives normalisation unchanged", () => {
  for (const slug of [...KNOWN_PROFILE_SLUGS, ...KNOWN_GOAL_SLUGS, ...KNOWN_APP_SLUGS]) {
    assert.equal(normalizeSlug(slug), slug, `alias map rewrites the canonical slug ${slug}`);
  }
});
