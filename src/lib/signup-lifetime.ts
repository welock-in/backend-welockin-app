import type { Request } from "express";
import { readDeviceId } from "./device";
import { HttpError } from "./http-error";
import { prisma } from "./prisma";

export type ClientPlatform = "ios" | "windows" | "macos" | "unknown";
export type SignupLifetimeOffer = "ios" | "desktop";
export const SIGNUP_LIFETIME_SETTINGS_ID = "signup-lifetime";

/** Legacy desktop IDs take precedence over a conflicting mobile header. */
export function readClientPlatform(req: Request): ClientPlatform {
  const deviceId = readDeviceId(req);
  if (/^win-\S+$/.test(deviceId)) return "windows";
  if (/^mac-\S+$/.test(deviceId)) return "macos";
  const platform = req.header("x-welockin-platform")?.trim().toLowerCase();
  if (platform === "ios" || platform === "ipados") return "ios";
  if (platform === "windows" || platform === "macos") return platform;
  return "unknown";
}

export type SignupLifetimeSettingsView = {
  iosSignupLifetimeEnabled: boolean;
  desktopSignupLifetimeEnabled: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
};

type SettingsRow = {
  iosSignupLifetimeEnabled: boolean;
  desktopSignupLifetimeEnabled: boolean;
  updatedAt: Date;
  updatedBy: string | null;
};

export function signupLifetimeSettingsView(row: SettingsRow | null): SignupLifetimeSettingsView {
  return {
    iosSignupLifetimeEnabled: row?.iosSignupLifetimeEnabled ?? false,
    desktopSignupLifetimeEnabled: row?.desktopSignupLifetimeEnabled ?? false,
    updatedAt: row?.updatedAt.toISOString() ?? null,
    updatedBy: row?.updatedBy ?? null,
  };
}

export function signupLifetimeSettingsUnavailable(): HttpError {
  return new HttpError(503, "Signup lifetime settings are temporarily unavailable. Please try again.", {
    code: "SIGNUP_LIFETIME_SETTINGS_UNAVAILABLE",
  });
}

/** No instance cache and no environment fallback: only a missing row means OFF. */
export async function readSignupLifetimeSettings(): Promise<SignupLifetimeSettingsView> {
  try {
    return signupLifetimeSettingsView(await prisma.signupLifetimeSettings.findUnique({
      where: { id: SIGNUP_LIFETIME_SETTINGS_ID },
    }));
  } catch {
    throw signupLifetimeSettingsUnavailable();
  }
}

/** Read-only offer lookup: precheck previews it; only account creation persists a reservation. */
export async function reserveSignupLifetimeOffer(platform: ClientPlatform): Promise<SignupLifetimeOffer | null> {
  const settings = await readSignupLifetimeSettings();
  if (platform === "ios" && settings.iosSignupLifetimeEnabled) return "ios";
  if ((platform === "windows" || platform === "macos") && settings.desktopSignupLifetimeEnabled) return "desktop";
  return null;
}

type ReservedSignup = {
  signupPlatform?: string | null;
  signupLifetimeOffer?: string | null;
  iosLifetimeGrantedAt?: Date | null;
  desktopLifetimeGrantedAt?: Date | null;
};

/** Convert the saved offer once. Never read today's switches at verification. */
export function signupLifetimeGrantData(user: ReservedSignup, now: Date): {
  iosLifetimeGrantedAt?: Date;
  desktopLifetimeGrantedAt?: Date;
} {
  if (user.signupLifetimeOffer === "ios" && user.signupPlatform === "ios" && !user.iosLifetimeGrantedAt) {
    return { iosLifetimeGrantedAt: now };
  }
  if (user.signupLifetimeOffer === "desktop" &&
      (user.signupPlatform === "windows" || user.signupPlatform === "macos") && !user.desktopLifetimeGrantedAt) {
    return { desktopLifetimeGrantedAt: now };
  }
  return {};
}
