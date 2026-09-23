/**
 * THE analytics registry — event names, the properties every event carries,
 * the anonymity contract, and the kill switch.
 *
 * Named `posthog-events` and not `analytics-*` on purpose: in this repository
 * `analytics` already means something else entirely — src/routes/analytics.ts
 * and src/services/analytics.ts serve a user their own focus statistics, and
 * are mounted at /api/analytics. Two meanings of the word in one src/ is how a
 * later reader ends up reading the wrong file.
 *
 * WHY THIS FILE IS DUPLICATED IN FOUR REPOSITORIES. ios, windows, macos and
 * this backend are four independent git repositories feeding ONE PostHog
 * project, and PostHog imposes no schema of its own: it accepts whatever name
 * you send, forever. Two repos that each keep their own idea of what the
 * purchase event is called produce two funnels that can never be joined, and
 * the divergence is invisible until someone tries to compare iOS revenue to
 * desktop revenue months later.
 *
 * So the file is copied verbatim from the client copies — src/lib/analytics-events.ts
 * in each of the three apps — and `EVENT_REGISTRY_FINGERPRINT` below is what
 * keeps the copies honest: each repo's test recomputes the fingerprint from its
 * OWN list and asserts it equals the baked constant. Adding an event in one
 * repo alone turns that repo's test red, and the only way to green is to add it
 * in all four.
 *
 * WHY THE SERVER SHIPS THE CLIENT EVENTS TOO, when it emits four of the
 * thirty-six. A registry that is a subset per platform cannot be fingerprinted,
 * and the server is also the side that will read these names back — a cron
 * reconciling checkout_started against checkout_confirmed needs both spellings
 * from the same source.
 *
 * NO IMPORTS, not even node:crypto. The module is pure so it stays
 * byte-identical to the copies that run in a React Native bundle and in a Tauri
 * WebView. Anything needing the runtime — the HTTP call, the $insert_id derived
 * from a provider event key, the flush before the response — belongs to the
 * emitter, not here.
 */

/** FNV-1a of the sorted event list. Recomputed by every repo's test.
 *  Change the list, this changes, and four repos have to move together. */
export const EVENT_REGISTRY_FINGERPRINT = "ddec0f16";

/* ── the events ───────────────────────────────────────────────────────────
   snake_case, English. The name is the only part that is expensive to change
   later: PostHog never renames retroactively, so a rename leaves a permanent
   seam in the data and silently breaks every insight built on it. */

/** Emitted by the apps. The subset each platform actually sends is a property
 *  of that platform's code, not of this list. */
export const CLIENT_EVENTS = [
  /* first-run funnel. ONE event with a `step` property rather than one event
     per screen: a PostHog funnel can stack the same event filtered on
     different values, so the funnel can be reordered — or a screen inserted —
     without touching a line of instrumentation.

     Desktop note: the screen COUNT varies at runtime. `orderFor(withAccount)`
     drops the signup-only screens, so a run is 14, 13 or 12 screens depending
     on platform and whether anyone is signed in. Every funnel event carries
     `with_account` and `screen_total` for that reason — a funnel built on
     fixed screen names shows drops that never happened. */
  "onboarding_started",
  "onboarding_step_viewed",
  "onboarding_step_completed",
  /** A resumed run SKIPPED screens. Without this a naive funnel reads the skip
   *  as a conversion. */
  "onboarding_resumed",
  /** The funnel is walked a second time on the same install, answers
   *  pre-filled. Carries the previous funnel_run_id. */
  "onboarding_restarted",
  "onboarding_completed",

  /* account + verification — the highest-friction stretch of the funnel */
  "account_submitted",
  "verification_code_requested",
  "verification_code_submitted",
  "account_created",

  /* identity lifecycle. These are what make a shared device legible. Windows
     has SIX sign-out paths and macOS has FOUR; missing one attributes the next
     account's events to the previous person. */
  "account_switched",
  "account_deleted",
  "user_signed_out",
  /** Involuntary (401). Deliberately NOT followed by reset(): the user did not
   *  ask to leave, and a reset here invents a new person on every token
   *  expiry. */
  "session_expired",
  /** Involuntary (404 ACCOUNT_NOT_FOUND). Same rule. */
  "session_invalidated",

  "permission_result",

  /* paywall. The blocking gate and the consultative /upgrade page are the SAME
     component in two modes, so every paywall event carries `blocking` — without
     it the conversion wall and the page people browse are averaged together. */
  "paywall_viewed",
  /** Offers arrive after the store answers, so the first render has no prices
   *  at all. Without a separate event, paywall_viewed always carries
   *  price:null and "slow" is indistinguishable from "catalogue broken". */
  "paywall_offers_loaded",
  /** The hard account-binding variants — no cards, no restore, the only way out
   *  is to sign out. A qualified lost sale, not an abandon. */
  "paywall_blocked",
  "paywall_plan_selected",
  "paywall_cta_clicked",
  "paywall_confirm_viewed",
  "paywall_confirm_back",
  "paywall_dismissed",
  /** The single convergence point of buy and restore. Carries the outcome
   *  kind — never a revenue amount, see SERVER_EVENTS. */
  "purchase_result",
  /** The server attributed the purchase elsewhere and access was revoked after
   *  the paywall had already closed. Without it, that close is a permanent
   *  false positive. */
  "purchase_revoked_conflict",
  "already_paid_checked",

  /* checkout. The payment leaves the app for a browser: the leakiest stretch of
     the three platforms and the only one nobody measures by default. The ratio
     of checkout_started to the backend's checkout_confirmed is the single most
     valuable number in this registry.

     `checkout_browser_opened` carries the checkout HOST, never the URL — the
     URL carries the intent token. */
  "checkout_started",
  "checkout_browser_opened",
  "checkout_returned",
  "checkout_chase_ended",

  /** Emitted once per launch. Every failure mode of this stack looks like
   *  "nobody uses the app" — wrong region (PostHog accepts and stores nothing),
   *  a placeholder key (mute binary), a QA build pointed at loopback, or fetch
   *  that never leaves the WebView. Comparing heartbeats per app_version
   *  against known installs is the only thing that tells them apart. */
  "analytics_heartbeat",
] as const;

/** Emitted by the backend, from the webhook handlers. Money NEVER comes from a
 *  client: the paywall closes before the server has agreed, and a purchase the
 *  server later attributes to another account would leave a revenue event with
 *  no counter-event. */
export const SERVER_EVENTS = [
  "purchase_completed",
  "subscription_state_changed",
  "checkout_confirmed",
  /** Started, never confirmed. Emitted by cron, not by a webhook — the absence
   *  of an event is not an event. */
  "checkout_abandoned",
] as const;

export type ClientEvent = (typeof CLIENT_EVENTS)[number];
export type ServerEvent = (typeof SERVER_EVENTS)[number];
export type EventName = ClientEvent | ServerEvent;

export const ALL_EVENTS: readonly EventName[] = [...CLIENT_EVENTS, ...SERVER_EVENTS];

/** Lowercase, digits and underscores, starting with a letter. Checked at test
 *  time rather than at runtime: a typo'd name is not an error anywhere in
 *  PostHog, it is a new event that nobody will ever look at. */
export const EVENT_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

export const isValidEventName = (name: string): boolean => EVENT_NAME_PATTERN.test(name);

/* ── the fingerprint ──────────────────────────────────────────────────────
   FNV-1a rather than SHA: it has to run identically in an import-free mobile
   module, in vitest, in node:test and in a bare .mjs script, and `node:crypto`
   is not available to all four. Collision resistance is irrelevant here — this
   guards against forgetting, not against an attacker. */

export function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (const ch of input) {
    h ^= ch.codePointAt(0) ?? 0;
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Sorted before hashing, so reordering the list for readability is free and
 *  only a genuine addition or removal moves the fingerprint. */
export function registryFingerprint(names: readonly string[]): string {
  return fnv1a([...names].sort().join("\n"));
}

/* ── super-properties ─────────────────────────────────────────────────────
   Registered once and attached to every event. They are the reason
   segmentation is possible at all, and they are NOT retro-applicable: anything
   emitted before they exist is permanently unsegmentable, and the only remedy
   afterwards is to throw away the first months. */

/** One PostHog project for the whole product — a funnel that runs from
 *  welock.in to an install to a purchase is cross-surface by definition, and
 *  PostHog joins no person across two projects. `surface` keeps the four apart
 *  inside it. */
export const SURFACES = ["ios", "windows", "macos", "landing"] as const;
export type Surface = (typeof SURFACES)[number];

/** Without this, a handful of testers moves a conversion rate by several points
 *  at current volumes — and the mixing is irreversible. `qa` exists because the
 *  qa-smoke build replaces the whole API with a loopback server and would
 *  otherwise report into production. */
export const ENVIRONMENTS = ["dev", "sandbox", "testflight", "qa", "prod"] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

export type BaseProperties = {
  surface: Surface;
  environment: Environment;
  app_version: string;
  /** The funnel's own version. The clean way out the day the funnel changes:
   *  old and new runs stay in separate cohorts instead of averaging two
   *  different products together. */
  funnel_version: string;
  locale: string | null;
  /** UTC day of first launch, 'YYYY-MM-DD'. Retention is meaningless without it
   *  and it cannot be reconstructed after the fact. */
  install_cohort: string | null;
  is_staff: boolean;
};

/** UTC on purpose: a local-time cohort shifts by a day depending on where the
 *  machine was when it was first opened. */
export function installCohort(firstLaunch: Date): string {
  const y = firstLaunch.getUTCFullYear();
  const m = String(firstLaunch.getUTCMonth() + 1).padStart(2, "0");
  const d = String(firstLaunch.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function baseProperties(input: {
  surface: Surface;
  environment: Environment;
  appVersion: string | null | undefined;
  funnelVersion: string;
  locale?: string | null;
  firstLaunch?: Date | null;
  isStaff?: boolean;
}): BaseProperties {
  return {
    surface: input.surface,
    environment: input.environment,
    // 'unknown' rather than null: a missing version is the signal that the build
    // metadata is not wired, and a null silently groups every broken build
    // together with every future one.
    app_version: input.appVersion || "unknown",
    funnel_version: input.funnelVersion,
    locale: input.locale ?? null,
    install_cohort: input.firstLaunch ? installCohort(input.firstLaunch) : null,
    is_staff: input.isStaff === true,
  };
}

/* ── the anonymity contract ───────────────────────────────────────────────
   The privacy policy and the terms say the app collects ANONYMOUS usage data.
   That sentence is a constraint on this code, not a description of it: the
   moment one event carries an email or a first name it stops being true, and
   nothing in PostHog will tell us.

   The distinct_id stays the backend userId — an opaque account handle, never an
   email.

   Two of these entries are not privacy but security: a checkout URL carries the
   intent token, and the auth token never touches the WebView at all. Neither
   belongs in an analytics payload under any policy. */

export const FORBIDDEN_PROPERTY_SUBSTRINGS: readonly string[] = [
  "email",
  "password",
  "token",
  "secret",
  "bearer",
  "jwt",
  "phone",
  "first_name",
  "last_name",
  "full_name",
  "display_name",
  "checkout_url",
  /** App names, bundle ids and picker tokens must never reach analytics — on
   *  iOS it also violates the Family Controls entitlement. Only counts ever
   *  leave the device. */
  "app_name",
  "bundle_id",
  "apple_id",
];

/** Exact names, for words too common to match as substrings. `age` is here and
 *  no band replaces it: the funnel refuses under-16s locally and that branch
 *  must stay one that sends nothing at all. */
export const FORBIDDEN_PROPERTY_NAMES: readonly string[] = ["age", "name", "url", "ip"];

/** The offending keys, or an empty array. Callers decide what to do with them —
 *  throw in development, drop and warn once in production. Returning the list
 *  rather than a boolean is deliberate: a guard that only says "no" sends
 *  whoever hit it back to read this file. */
export function forbiddenPropertyKeys(properties: Record<string, unknown>): string[] {
  const offenders: string[] = [];
  for (const key of Object.keys(properties)) {
    const k = key.toLowerCase();
    if (FORBIDDEN_PROPERTY_NAMES.includes(k)) {
      offenders.push(key);
      continue;
    }
    if (FORBIDDEN_PROPERTY_SUBSTRINGS.some((bad) => k.includes(bad))) offenders.push(key);
  }
  return offenders;
}

/* ── kill switch and sampling ─────────────────────────────────────────────
   Served by the backend in a response the apps already call at boot and on
   every foreground, read with a cached default. This is the ONLY thing that
   makes the instrumentation reversible once published: on desktop a change
   means a new signed release, on iOS it means App Review. If it is not in the
   first binary that emits, it does not exist until the next one. */

export type AnalyticsConfig = {
  enabled: boolean;
  /** 0..1. Applied per PERSON, never per event — see shouldEmitFor. */
  sampleRate: number;
};

/** Fail-open. An analytics switch is not a security control, and a backend that
 *  cannot be reached must not silently blind the product. */
export const ANALYTICS_CONFIG_DEFAULT: AnalyticsConfig = { enabled: true, sampleRate: 1 };

export function parseAnalyticsConfig(raw: unknown): AnalyticsConfig {
  if (!raw || typeof raw !== "object") return ANALYTICS_CONFIG_DEFAULT;
  const source = raw as { enabled?: unknown; sampleRate?: unknown };
  const enabled = typeof source.enabled === "boolean" ? source.enabled : ANALYTICS_CONFIG_DEFAULT.enabled;
  const rate =
    typeof source.sampleRate === "number" && Number.isFinite(source.sampleRate)
      ? Math.min(1, Math.max(0, source.sampleRate))
      : ANALYTICS_CONFIG_DEFAULT.sampleRate;
  return { enabled, sampleRate: rate };
}

/**
 * Whether this INSTALL emits at all.
 *
 * Deterministic on `rollKey` (the distinct_id), never random. A per-event roll
 * samples events, which is the one thing sampling must never do to a funnel: it
 * drops step 7 for someone who saw step 6, and the drop-off curve it produces is
 * not a smaller version of the truth, it is noise. Bucketing per person keeps
 * every retained funnel whole.
 *
 * The same key always lands in the same bucket, so raising sampleRate later
 * keeps the current population and adds to it, rather than reshuffling everyone
 * and breaking continuity with the data already collected.
 */
export function shouldEmitFor(config: AnalyticsConfig, rollKey: string): boolean {
  if (!config.enabled) return false;
  if (config.sampleRate >= 1) return true;
  if (config.sampleRate <= 0) return false;
  const bucket = parseInt(fnv1a(rollKey), 16) / 0xffffffff;
  return bucket < config.sampleRate;
}
