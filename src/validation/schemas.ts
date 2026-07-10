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
  // Stable client-generated UUID — the real cross-platform identity key.
  // Optional so old PC clients (name-only) keep working.
  deviceId: z.string().trim().min(1).optional(),
  model: z.string().trim().min(1).optional(),
  osVersion: z.string().trim().min(1).optional(),
  appVersion: z.string().trim().min(1).optional(),
  pushToken: z.string().trim().min(1).optional(),
  // Part D — device identity / one-active-phone binding.
  kind: z.enum(["phone", "desktop"]).optional(), // inferred from platform when absent
  idfv: z.string().trim().min(1).optional(), // weak correlation hint (regenerates on reinstall)
  takeover: z.boolean().optional(), // opt in to superseding the current active phone
  clientRebindId: z.string().trim().min(1).max(64).optional(), // takeover idempotency key
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
  // Apple returns the display name only on the FIRST authorization and NOT inside
  // the token, so the client forwards it once. Optional.
  fullName: z.string().trim().min(1).optional(),
  // Optional email hint from the credential (first sign-in). The token's email is
  // trusted first; this is only a fallback.
  email: z.string().trim().toLowerCase().email().optional(),
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
  platform: z.enum(["ios", "ipados", "macos", "windows"]).optional(),
  clientEventId: z.string().trim().min(1).optional(),
  emergencyUsed: z.boolean().optional().default(false),
  // Part D: the reporting device. Used to attribute/quarantine the event against
  // the user's active phone. Optional so desktop /sync/push events are unaffected.
  deviceId: z.string().trim().min(1).optional(),
});

export const syncPushSchema = z.object({
  blocklists: z.array(z.unknown()),
  sessions: z.array(z.unknown()),
  // Optional (no default): a client that omits `schedules` must NOT clobber the
  // stored plan — the push handler only writes it when explicitly present.
  schedules: z.array(z.unknown()).optional(),
  events: z.array(focusEventInputSchema).optional(),
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

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type AppleAuthInput = z.infer<typeof appleAuthSchema>;
export type DeviceInput = z.infer<typeof deviceSchema>;
export type FocusEventInput = z.infer<typeof focusEventInputSchema>;
export type SyncPushInput = z.infer<typeof syncPushSchema>;
export type CreateFeedbackInput = z.infer<typeof createFeedbackSchema>;
export type ListFeedbackQuery = z.infer<typeof listFeedbackQuerySchema>;
export type UpdateFeedbackStatusInput = z.infer<typeof updateFeedbackStatusSchema>;
export type UpdateFeedbackHiddenInput = z.infer<typeof updateFeedbackHiddenSchema>;
export type ReportFeedbackInput = z.infer<typeof reportFeedbackSchema>;
export type DeactivateDeviceInput = z.infer<typeof deactivateDeviceSchema>;
export type CreateBreakInput = z.infer<typeof createBreakSchema>;
export type AttestRegisterInput = z.infer<typeof attestRegisterSchema>;
