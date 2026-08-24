import assert from "node:assert/strict";
import { test } from "node:test";
import {
  appleAuthSchema,
  focusEventInputSchema,
  onboardingSubmitSchema,
  syncPushSchema,
} from "./schemas";

const event = {
  name: "Deep work",
  startedAt: Date.UTC(2026, 6, 10, 8, 0, 0),
  endedAt: Date.UTC(2026, 6, 10, 8, 30, 0),
  plannedSeconds: 1800,
  completed: true,
  hardLock: false,
  platform: "android" as const,
  deviceId: "android-device-1",
  clientEventId: "event-1",
};

test("focus events accept the Android platform and stable device identity", () => {
  const parsed = focusEventInputSchema.parse(event);
  assert.equal(parsed.platform, "android");
  assert.equal(parsed.deviceId, "android-device-1");
  assert.equal(parsed.clientEventId, "event-1");
  assert.equal(parsed.emergencyUsed, false);
});

test("Apple auth strips untrusted email and name hints", () => {
  const parsed = appleAuthSchema.parse({
    identityToken: "signed-token",
    email: "victim@example.com",
    fullName: "Untrusted Name",
  });
  assert.deepEqual(parsed, { identityToken: "signed-token" });
});

test("sync accepts append-only events without a snapshot", () => {
  const parsed = syncPushSchema.parse({ events: [event] });
  assert.equal(parsed.events?.length, 1);
  assert.equal(parsed.replaceSnapshot, false);
});

test("sync requires both PC snapshot arrays when replacing state", () => {
  assert.throws(() => syncPushSchema.parse({ blocklists: [] }));
  assert.doesNotThrow(() =>
    syncPushSchema.parse({ blocklists: [], sessions: [], schedules: [] }),
  );
});

// --- Onboarding funnel -------------------------------------------------------

const submission = {
  clientSubmissionId: "9f2c1a44-6b1e-4f0a-9a10-2f3d7c5e8b01",
  funnelVersion: "phone_v6",
  displayName: "Hedi",
  age: 27,
  profile: "founder_or_freelancer",
  goal: "focus_better",
  distractingApps: ["instagram", "tiktok", "youtube"],
  selfReportedDailyHours: 6,
  locale: "fr-FR",
  appVersion: "1.0.0",
  platform: "ios" as const,
  deviceId: "6E1C0F2A-0000-4000-8000-000000000001",
  startedAt: "2026-07-25T09:12:03.000Z",
  clientProjection: { hoursPerYear: 2190, yearsLost: 20, reclaimDaysPerYear: 37 },
};

test("onboarding accepts the full funnel payload and preserves tap order", () => {
  const parsed = onboardingSubmitSchema.parse(submission);
  assert.equal(parsed.age, 27);
  assert.equal(parsed.displayName, "Hedi");
  assert.deepEqual(parsed.distractingApps, ["instagram", "tiktok", "youtube"]);
  assert.ok(parsed.startedAt instanceof Date);
});

test("onboarding stores unknown answer slugs instead of rejecting them", () => {
  // Load-bearing: the funnel evolves without a backend deploy and old binaries
  // keep POSTing — a closed enum would 400 the user into a paywall dead end.
  const parsed = onboardingSubmitSchema.parse({
    ...submission,
    profile: "cosmonaut",
    goal: "vibes",
    distractingApps: ["threads"],
  });
  assert.equal(parsed.profile, "cosmonaut");
  assert.equal(parsed.goal, "vibes");
  assert.deepEqual(parsed.distractingApps, ["threads"]);
});

test("onboarding bounds the self-reported gauge to the reachable 0..12 range", () => {
  assert.equal(onboardingSubmitSchema.parse({ ...submission, selfReportedDailyHours: 0 })
    .selfReportedDailyHours, 0);
  assert.equal(onboardingSubmitSchema.parse({ ...submission, selfReportedDailyHours: 12 })
    .selfReportedDailyHours, 12);
  assert.throws(() => onboardingSubmitSchema.parse({ ...submission, selfReportedDailyHours: -1 }));
  assert.throws(() => onboardingSubmitSchema.parse({ ...submission, selfReportedDailyHours: 13 }));
  assert.throws(() => onboardingSubmitSchema.parse({ ...submission, selfReportedDailyHours: 6.5 }));
});

test("onboarding requires a usable idempotency key", () => {
  const { clientSubmissionId: _omitted, ...withoutKey } = submission;
  assert.throws(() => onboardingSubmitSchema.parse(withoutKey));
  assert.throws(() => onboardingSubmitSchema.parse({ ...submission, clientSubmissionId: "abcdefg" }));
  assert.doesNotThrow(() =>
    onboardingSubmitSchema.parse({ ...submission, clientSubmissionId: "a".repeat(64) }),
  );
  assert.throws(() =>
    onboardingSubmitSchema.parse({ ...submission, clientSubmissionId: "a".repeat(65) }),
  );
});

test("onboarding normalises answer casing and rejects non-slug shapes", () => {
  assert.equal(onboardingSubmitSchema.parse({ ...submission, profile: "Instagram" }).profile,
    "instagram");
  assert.throws(() => onboardingSubmitSchema.parse({ ...submission, profile: "in stagram" }));
  assert.throws(() => onboardingSubmitSchema.parse({ ...submission, profile: "_lead" }));
  assert.throws(() => onboardingSubmitSchema.parse({ ...submission, profile: "" }));
  assert.throws(() => onboardingSubmitSchema.parse({ ...submission, profile: "a".repeat(41) }));
});

test("onboarding accepts a free-text university and bounds it at 160 chars", () => {
  // Free text, NOT a slug: picked from a bundled list or typed by hand, so
  // accents, spaces and casing must all survive verbatim.
  assert.equal(
    onboardingSubmitSchema.parse({ ...submission, university: "  École Polytechnique " })
      .university,
    "École Polytechnique",
  );
  assert.equal(onboardingSubmitSchema.parse(submission).university, undefined);
  // null parses AND survives distinct from absent: every v2 submission carries
  // `university ?? null`, and null must reach the route to CLEAR the column.
  assert.equal(onboardingSubmitSchema.parse({ ...submission, university: null }).university, null);
  assert.doesNotThrow(() =>
    onboardingSubmitSchema.parse({ ...submission, university: "a".repeat(160) }),
  );
  assert.throws(() =>
    onboardingSubmitSchema.parse({ ...submission, university: "a".repeat(161) }),
  );
  assert.throws(() => onboardingSubmitSchema.parse({ ...submission, university: "   " }));
});

test("onboarding leaves the age policy gate to the route, not zod", () => {
  // 15 PARSES: the refusal must be a branchable 403 AGE_BELOW_MINIMUM, not a
  // generic validation string the client's 400 handler would swallow.
  assert.equal(onboardingSubmitSchema.parse({ ...submission, age: 15 }).age, 15);
  assert.throws(() => onboardingSubmitSchema.parse({ ...submission, age: 100 }));
  assert.throws(() => onboardingSubmitSchema.parse({ ...submission, age: 18.5 }));
});

test("onboarding caps the raw multi-select at 32 entries", () => {
  const apps = (n: number) => Array.from({ length: n }, (_value, i) => `app_${i}`);
  assert.doesNotThrow(() =>
    onboardingSubmitSchema.parse({ ...submission, distractingApps: apps(32) }),
  );
  assert.throws(() => onboardingSubmitSchema.parse({ ...submission, distractingApps: apps(33) }));
});

test("onboarding strips unknown clientProjection keys and rejects non-integers", () => {
  const parsed = onboardingSubmitSchema.parse({
    ...submission,
    clientProjection: { yearsLost: 20, planReclaim: 37, nonsense: "x" },
  });
  assert.deepEqual(parsed.clientProjection, { yearsLost: 20 });
  assert.throws(() =>
    onboardingSubmitSchema.parse({ ...submission, clientProjection: { yearsLost: 20.5 } }),
  );
});

test("onboarding startedAt accepts an ISO string or epoch ms", () => {
  const iso = onboardingSubmitSchema.parse({ ...submission, startedAt: "2026-07-25T09:12:03.000Z" });
  assert.equal(iso.startedAt?.toISOString(), "2026-07-25T09:12:03.000Z");
  const epoch = onboardingSubmitSchema.parse({ ...submission, startedAt: 1_784_000_000_000 });
  assert.equal(epoch.startedAt?.getTime(), 1_784_000_000_000);
  assert.throws(() => onboardingSubmitSchema.parse({ ...submission, startedAt: "not-a-date" }));
});
