import { z } from "zod";

export const registerSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1, "Password is required"),
});

export const deviceSchema = z.object({
  name: z.string().trim().min(1, "name is required"),
  platform: z.string().trim().min(1, "platform is required"),
  // Form factor, so the UI can slot desktop/phone/tablet distinctly.
  kind: z.enum(["desktop", "phone", "tablet"]).optional(),
  // Stable client-generated UUID — the real cross-platform identity key.
  // Optional so old PC clients (name-only) keep working.
  deviceId: z.string().trim().min(1).optional(),
  model: z.string().trim().min(1).optional(),
  osVersion: z.string().trim().min(1).optional(),
  appVersion: z.string().trim().min(1).optional(),
  pushToken: z.string().trim().min(1).optional(),
  // Part D — device identity / one-active-phone binding (kind above covers phone/desktop/tablet).
  idfv: z.string().trim().min(1).optional(), // weak correlation hint (regenerates on reinstall)
  takeover: z.boolean().optional(), // opt in to superseding the current active phone
});

export const deactivateDeviceSchema = z.object({
  reason: z.string().trim().min(1).max(200).optional(),
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

// Only the inferred types actually consumed elsewhere are exported; every other
// route parses its schema inline (`schema.parse(req.body)`), which infers the type
// locally, so a full mirror of `*Input` aliases would just be dead surface.
export type FocusEventInput = z.infer<typeof focusEventInputSchema>;
export type SyncPushInput = z.infer<typeof syncPushSchema>;
