import { z } from "zod";

/**
 * The password rule, defined once.
 *
 * Shared with the reset flow deliberately: a reset that accepted a weaker
 * password than registration would be a downgrade path around the rule rather
 * than a second opinion about it.
 */
const passwordRule = z.string().min(8, "Password must be at least 8 characters");

/** Address normalisation, shared so a lookup can never miss on casing alone. */
const emailRule = z.string().trim().toLowerCase().email();

export const registerSchema = z.object({
  email: emailRule,
  password: passwordRule,
});

export const loginSchema = z.object({
  email: emailRule,
  password: z.string().min(1, "Password is required"),
});

// --- Email verification -----------------------------------------------------
/** Exactly six digits. Anything else never reaches the database. */
export const verifyEmailSchema = z.object({
  code: z.string().trim().regex(/^[0-9]{6}$/, "Enter the 6-digit code"),
});

// --- Password reset ---------------------------------------------------------
export const passwordResetRequestSchema = z.object({ email: emailRule });

export const passwordResetSchema = z.object({
  // Bounded on both sides: a base64url-encoded 32-byte token is 43 characters,
  // and the ceiling keeps a megabyte of junk from ever being hashed.
  token: z.string().trim().min(20).max(256),
  password: passwordRule,
});

// --- Contact form ------------------------------------------------------------
/**
 * The marketing site's contact form. `email` shares `emailRule` so the address
 * support replies to is normalised the same way as everywhere else, and the
 * `message` floor keeps single-character junk from ever costing an email send.
 */
export const contactSchema = z.object({
  name: z.string().trim().max(80).optional(),
  email: emailRule,
  topic: z.enum(["support", "billing", "privacy", "press", "other"]).optional().default("other"),
  message: z
    .string()
    .trim()
    .min(10, "Message must be at least 10 characters")
    .max(4000, "Message is too long"),
});

/** Spellings seen in the wild, normalised so `platform` can be a real enum. */
const PLATFORM_ALIASES: Record<string, string> = {
  mac: "macos",
  darwin: "macos",
  osx: "macos",
  win: "windows",
  win32: "windows",
};

export const devicePlatformSchema = z
  .string()
  .trim()
  .toLowerCase()
  .transform((p) => PLATFORM_ALIASES[p] ?? p)
  .pipe(z.enum(["ios", "ipados", "macos", "windows", "android"]));

/**
 * Device registration — one shape for every platform. The route is a plain
 * upsert on (userId, deviceId): no binding, no takeover, no conflict.
 *
 * `deviceId` is now REQUIRED. It used to be optional, which forced the route to
 * fall back to matching on `name` — and since every Mac called itself "Mac",
 * that fallback silently merged or duplicated rows. Identity is the deviceId or
 * it is nothing.
 *
 * The format check is deliberately permissive (charset + length) rather than a
 * `^(ios|mac|win)-<uuid>$` shape: iOS ships a bare UUID and Windows ships
 * `win-<MachineGuid>`, so demanding a per-platform prefix today would 400 every
 * client already in the field. Tighten it only once every client sends one.
 */
export const deviceSchema = z.object({
  name: z.string().trim().min(1, "name is required").max(120),
  platform: devicePlatformSchema,
  // Form factor hint for choosing an icon. Purely cosmetic now that nothing
  // branches on it (it used to route phones into the binding path).
  kind: z.enum(["desktop", "phone", "tablet"]).optional(),
  deviceId: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9._:-]{8,128}$/, "deviceId must be 8-128 chars of [A-Za-z0-9._:-]"),
  model: z.string().trim().min(1).max(120).optional(),
  osVersion: z.string().trim().min(1).max(60).optional(),
  appVersion: z.string().trim().min(1).max(60).optional(),
});

/**
 * Invite the account's other devices to join a focus session. Carries the
 * INTENT only (how long, how strict) — never what to block, because iOS app
 * selections are opaque tokens the origin device cannot resolve.
 */
export const focusInviteCreateSchema = z.object({
  sessionId: z.string().trim().min(1).max(64),
  sessionName: z.string().trim().min(1).max(120).optional(),
  // Bounded: 1 minute to 24 hours. An unbounded value would let one device pin
  // another into an effectively permanent block.
  durationSeconds: z.number().int().min(60).max(24 * 60 * 60),
  hardLock: z.boolean().optional(),
  targetDeviceIds: z.array(z.string().trim().min(1).max(128)).min(1).max(10),
  // Fallback when the X-WeLockIn-Device-Id header is absent.
  fromDeviceId: z.string().trim().min(1).max(128).optional(),
});

export const createBreakSchema = z.object({
  breakLen: z.number().int().positive().max(240), // minutes
  clientBreakId: z.string().trim().min(1).max(64).optional(), // idempotency key
  deviceId: z.string().trim().min(1).optional(),
});

// App Attest key registration (used once the native attestation client ships).
export const attestRegisterSchema = z.object({
  keyId: z.string().trim().min(1),
  attestation: z.string().trim().min(1), // base64 CBOR attestation object
  challenge: z.string().trim().min(1),
});

export const appleAuthSchema = z.object({
  identityToken: z.string().min(1, "identityToken is required"),
  // Extra client-supplied fields are deliberately stripped. In particular, an
  // email hint must never influence account linking; only the signed token may.
});

/**
 * Accepts a date as an ISO 8601 string or a millisecond epoch number and
 * coerces it to a Date. Rejects invalid dates.
 */
const dateInput = z
  .union([z.string(), z.number()])
  .transform((value, ctx) => {
    const date = typeof value === "number" ? new Date(value) : new Date(value);
    if (Number.isNaN(date.getTime())) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Invalid date (expected ISO string or epoch ms)",
      });
      return z.NEVER;
    }
    return date;
  });

export const focusEventInputSchema = z.object({
  name: z.string().trim().min(1),
  startedAt: dateInput,
  endedAt: dateInput,
  plannedSeconds: z.number().int().nonnegative(),
  completed: z.boolean(),
  hardLock: z.boolean(),
  killedTotal: z.number().int().nonnegative().optional().default(0),
  // Multi-platform / mobile additions (all optional → PC payloads unchanged).
  platform: z.enum(["android", "ios", "ipados", "macos", "windows"]).optional(),
  // Part D: the reporting device. Used to attribute/quarantine the event against
  // the user's active phone. Optional so desktop /sync/push events are unaffected.
  deviceId: z.string().trim().min(1).optional(),
  clientEventId: z.string().trim().min(1).optional(),
  emergencyUsed: z.boolean().optional().default(false),
});

export const syncPushSchema = z
  .object({
    blocklists: z.array(z.unknown()).optional(),
    sessions: z.array(z.unknown()).optional(),
    // Optional (no default): a client that omits `schedules` must NOT clobber the
    // stored plan — the push handler only writes it when explicitly present.
    schedules: z.array(z.unknown()).optional(),
    events: z.array(focusEventInputSchema).optional(),
    // An event-bearing request without schedules is treated as append-only by
    // default, protecting the PC snapshot from a stale mobile pull -> push cycle.
    // A caller that intentionally combines an event and a snapshot can opt in.
    replaceSnapshot: z.boolean().optional().default(false),
  })
  .superRefine((value, ctx) => {
    const hasEvents = (value.events?.length ?? 0) > 0;
    const replacesSnapshot = value.replaceSnapshot || !hasEvents || value.schedules !== undefined;
    if (replacesSnapshot && (value.blocklists === undefined || value.sessions === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "blocklists and sessions are required when replacing the snapshot",
      });
    }
  });

// --- Feedback / feature-request board ---------------------------------------

/** Statuses an admin can set on a feature request (mirrors the Prisma enum). */
export const featureRequestStatusSchema = z.enum([
  "open",
  "planned",
  "in_progress",
  "done",
  "declined",
]);

export const createFeedbackSchema = z.object({
  title: z.string().trim().min(3, "Title is too short").max(120, "Title is too long"),
  body: z.string().trim().max(2000, "Description is too long").optional().default(""),
  // Idempotency key for create retries — a network retry of the same POST must not
  // insert a duplicate. Client generates it once per composer session.
  clientRequestId: z.string().trim().min(8).max(64),
});

export const listFeedbackQuerySchema = z.object({
  sort: z.enum(["top", "new"]).optional().default("top"),
});

export const updateFeedbackStatusSchema = z.object({
  status: featureRequestStatusSchema,
});

export const updateFeedbackHiddenSchema = z.object({
  hidden: z.boolean(),
});

export const reportFeedbackSchema = z.object({
  reason: z.string().trim().min(3).max(500),
});

// ── live sessions (client heartbeat) ─────────────────────────────────────────

export const sessionHeartbeatSchema = z.object({
  deviceId: z.string().trim().min(1, "deviceId is required"),
  // Per-session id (a device runs up to two sessions at once). Defaults to
  // "default" for older single-session clients that don't send one.
  sessionId: z.string().trim().min(1).default("default"),
  deviceName: z.string().trim().min(1).optional(),
  platform: z.enum(["android", "ios", "ipados", "macos", "windows"]).optional(),
  name: z.string().trim().min(1).default("Focus session"),
  phase: z.enum(["running", "break"]).optional().default("running"),
  hardLock: z.boolean().optional().default(false),
  totalSeconds: z.number().int().nonnegative().optional().default(0),
  remainSeconds: z.number().int().nonnegative().optional().default(0),
  killedTotal: z.number().int().nonnegative().optional().default(0),
  appsCount: z.number().int().nonnegative().optional().default(0),
  sitesCount: z.number().int().nonnegative().optional().default(0),
  originEventId: z.string().trim().min(1).optional(),
  startedAt: dateInput,
});

export const sessionEndSchema = z.object({
  deviceId: z.string().trim().min(1, "deviceId is required"),
  // End one specific session; omit to end ALL of the device's live sessions.
  sessionId: z.string().trim().min(1).optional(),
});

// ── admin console ────────────────────────────────────────────────────────────

/**
 * `POST /api/entitlement/trial`. Everything is optional: the identity that
 * matters is the `X-WeLockIn-Device-Id` header, and a client that sends nothing
 * else still gets a correct answer.
 */
export const startTrialSchema = z.object({
  /** iOS `identifierForVendor`, a secondary correlation key. Absent on macOS. */
  idfv: z.string().trim().min(1).optional(),
  /**
   * Whether the client's device id came from the hardware or from a file it can
   * delete. Self-reported and therefore not trusted as a grant — only ever used
   * to make a claim WEAKER (shorter window, flagged), never stronger.
   *
   * NOT defaulted, despite what this comment used to claim. An omitted value is
   * `undefined`, and `claimTrial` treats only an explicit `false` as unproven —
   * so saying nothing currently earns a FULL window while admitting a failed
   * hardware read earns a short one. That asymmetry is deliberate for old clients
   * that never heard of the field, and it is also the reason a modern client must
   * send the fingerprint header: the routes derive this from it when present, so
   * "say nothing" stops being the strongest position available.
   */
  hardwareBacked: z.boolean().optional(),
  /** The client's own clock, recorded as an abuse signal. Never used for timing. */
  clientTime: dateInput.optional(),
});

export const adminLoginSchema = z.object({
  username: z.string().min(1, "username is required"),
  password: z.string().min(1, "password is required"),
});

export const adminSetPlanSchema = z.object({
  plan: z.string().trim().min(1, "plan is required"),
});

// ── addiction protection ─────────────────────────────────────────────────────

// Client turns protection on. Partner method needs a partner email (the OTP is
// mailed there); date method needs the lock-until date.
export const protectionLockSchema = z
  .object({
    method: z.enum(["partner", "date"]),
    categories: z.array(z.string().trim().min(1)).default([]),
    partnerContact: z.string().trim().email().optional(),
    lockedUntil: dateInput.optional(),
  })
  .superRefine((v, ctx) => {
    if (v.method === "partner" && !v.partnerContact) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "partnerContact (email) is required for the partner method", path: ["partnerContact"] });
    }
    if (v.method === "date" && !v.lockedUntil) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "lockedUntil is required for the date method", path: ["lockedUntil"] });
    }
  });

export const protectionUnlockSchema = z.object({
  code: z.string().trim().min(1, "code is required"),
});

// Admin: create / bulk-import / update curated protection entries.
export const protectionEntrySchema = z.object({
  category: z.string().trim().min(1),
  kind: z.enum(["site", "app"]),
  value: z.string().trim().min(1),
  label: z.string().trim().min(1).optional(),
  platform: z.string().trim().min(1).optional(),
  active: z.boolean().optional(),
});

export const protectionEntryUpdateSchema = z.object({
  category: z.string().trim().min(1).optional(),
  label: z.string().trim().min(1).optional(),
  platform: z.string().trim().min(1).optional(),
  active: z.boolean().optional(),
});

export const protectionImportSchema = z.object({
  category: z.string().trim().min(1),
  kind: z.enum(["site", "app"]),
  values: z.array(z.string().trim().min(1)).min(1, "at least one value"),
});

// ── push notifications ────────────────────────────────────────────────────────

// Register / refresh a device's push token (POST /api/notifications/token).
export const pushTokenSchema = z.object({
  token: z.string().trim().min(1), // "ExponentPushToken[...]" (or a raw APNs/FCM token)
  platform: z.string().trim().min(1).optional(), // "ios" | "ipados" | "android"
  tokenType: z.enum(["expo", "apns", "fcm"]).optional().default("expo"),
  deviceId: z.string().trim().min(1).optional(), // links the token to a Device row
  appVersion: z.string().trim().min(1).optional(),
});

// Admin: send an ad-hoc push to an audience (POST /api/admin/notifications/send).
export const sendNotificationSchema = z
  .object({
    audience: z.object({
      mode: z.enum(["all", "user"]),
      userId: z.string().trim().min(1).optional(),
    }),
    title: z.string().trim().min(1).max(120),
    body: z.string().trim().min(1).max(500),
    // Arbitrary deep-link payload the client routes on tap (e.g. { route, params }).
    data: z.record(z.unknown()).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.audience.mode === "user" && !v.audience.userId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "audience.userId is required when mode is 'user'", path: ["audience", "userId"] });
    }
  });

// Admin CRUD: notification templates (the content) + rules (the wiring). The JSON
// fields (data / condition / audience) are validated as objects; their inner shape
// is the engine's concern (render / matchCondition / resolveAudience).
export const notificationTemplateSchema = z.object({
  key: z.string().trim().min(1).max(64),
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(1000),
  data: z.record(z.unknown()).optional(),
  category: z.string().trim().min(1).max(40).optional(),
  sound: z.string().trim().min(1).nullable().optional(),
  active: z.boolean().optional(),
});
// `key` is immutable (it's the reference used by rules).
export const notificationTemplateUpdateSchema = notificationTemplateSchema.omit({ key: true }).partial();

export const notificationRuleSchema = z.object({
  name: z.string().trim().min(1).max(120),
  event: z.string().trim().min(1).max(64),
  condition: z.record(z.unknown()).optional(),
  templateKey: z.string().trim().min(1),
  audience: z.record(z.unknown()),
  dedupeKeyTemplate: z.string().trim().min(1).nullable().optional(),
  enabled: z.boolean().optional(),
  priority: z.number().int().optional(),
});
export const notificationRuleUpdateSchema = notificationRuleSchema.partial();

// Only the inferred types actually consumed elsewhere are exported; every other
// route parses its schema inline (`schema.parse(req.body)`), which infers the type
// locally, so a full mirror of `*Input` aliases would just be dead surface.
export type FocusEventInput = z.infer<typeof focusEventInputSchema>;
export type SyncPushInput = z.infer<typeof syncPushSchema>;
export type OnboardingSubmitInput = z.infer<typeof onboardingSubmitSchema>;
// --- Onboarding funnel -------------------------------------------------------

/**
 * A stable answer slug. Shape-validated ONLY — deliberately NOT a z.enum. This
 * POST is the single request that gates the paywall, the funnel evolves without a
 * backend deploy, and old binaries keep POSTing; a closed server enum would 400
 * the user into a dead end. Unknown slugs are persisted verbatim (the known lists
 * live in src/lib/onboarding.ts, for docs and tests only).
 */
const answerSlug = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9_]{0,39}$/, "Answer must be a lowercase slug");

/** Audit echo of the numbers the client actually DISPLAYED. Never trusted, never
 *  read for logic — the server always recomputes from selfReportedDailyHours. */
const clientProjectionSchema = z.object({
  hoursPerYear: z.number().int().nonnegative().max(100_000).optional(),
  yearsLost: z.number().int().nonnegative().max(200).optional(),
  reclaimDaysPerYear: z.number().int().nonnegative().max(400).optional(),
});

export const onboardingSubmitSchema = z.object({
  // Idempotency key, minted once per completed funnel run (and once per later
  // edit). REQUIRED: a nullable unique key is a MongoDB footgun, and a required
  // key on a brand-new model is always safe.
  clientSubmissionId: z.string().trim().min(8).max(64),
  funnelVersion: z.string().trim().min(1).max(32), // e.g. "phone_v6"
  displayName: z.string().trim().min(1).max(40).optional(),
  // min(1), NOT min(MIN_AGE): the age gate must produce a branchable
  // 403 AGE_BELOW_MINIMUM in the route, not a generic zod 400. Only the derived
  // band is persisted — the exact integer never reaches the database.
  //
  // Optional HERE, required BY THE ROUTE on a first submission (400
  // ONBOARDING_INCOMPLETE). It cannot be required at this layer: GET returns only
  // `ageBand`, so a signed-in user who reinstalled has no legal age to re-send and
  // would be locked out of every later edit (renaming in Settings) unless they
  // fabricated one inside the band.
  age: z.number().int().min(1).max(99).optional(),
  profile: answerSlug.optional(),
  goal: answerSlug.optional(),
  // Tap order is preserved (screen 12 renders the first three). 32 is a raw-input
  // bound; the normaliser dedupes and stores at most 16.
  distractingApps: z.array(answerSlug).max(32).optional(),
  // Self-REPORTED hours/day, 0..12. 0 is a legal, reachable gauge value. Named so
  // it can never be mistaken for measured Screen Time data (which is never uploaded).
  // Optional for the same reason as `age`: required by the route on a first
  // submission only, so a later partial edit does not have to restate the funnel.
  selfReportedDailyHours: z.number().int().min(0).max(12).optional(),
  locale: z.string().trim().min(2).max(35).optional(), // BCP-47
  appVersion: z.string().trim().min(1).max(32).optional(),
  platform: z.enum(["android", "ios", "ipados", "macos", "windows"]).optional(),
  deviceId: z.string().trim().min(1).max(128).optional(),
  startedAt: dateInput.optional(),
  clientProjection: clientProjectionSchema.optional(),
});


// --- Admin entitlement overrides ---------------------------------------------
/**
 * Every one of these demands a `reason`, and that is not paperwork.
 *
 * A comp and a revocation are the two ways a human can overrule the entitlement
 * resolver, and an override nobody can explain later is indistinguishable from a
 * mistake — which is exactly what you are trying to tell apart when you go
 * looking six months on.
 */
const adminReason = z.string().trim().min(3, "A reason is required").max(500);

export const adminCompSchema = z.object({
  reason: adminReason,
  /**
   * When the comp ends. Omit for a LIFETIME grant.
   *
   * Explicitly nullable as well as optional so the admin UI can send `null` to
   * mean "no end date" without it reading as "field forgotten".
   */
  until: dateInput.nullish(),
});

export const adminRevokeSchema = z.object({ reason: adminReason });

export const adminTrialResetSchema = z.object({
  reason: adminReason,
  /**
   * Deleting a trial claim is the exact operation the ledger exists to prevent,
   * so it cannot be reached by a fat finger: the caller must say out loud which
   * account they are handing a second window to.
   */
  confirmUserId: z.string().trim().min(1),
});
