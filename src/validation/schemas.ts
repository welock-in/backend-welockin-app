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
});

export const syncPushSchema = z.object({
  blocklists: z.array(z.unknown()),
  sessions: z.array(z.unknown()),
  // Optional (no default): a client that omits `schedules` must NOT clobber the
  // stored plan — the push handler only writes it when explicitly present.
  schedules: z.array(z.unknown()).optional(),
  events: z.array(focusEventInputSchema).optional(),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type DeviceInput = z.infer<typeof deviceSchema>;
export type FocusEventInput = z.infer<typeof focusEventInputSchema>;
export type SyncPushInput = z.infer<typeof syncPushSchema>;
