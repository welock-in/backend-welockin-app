import { prisma } from "../../lib/prisma";

export interface AudienceSpec {
  mode: "self" | "sameUserOtherDevices" | "user" | "all";
  userId?: string; // for mode "user"
  excludeOrigin?: boolean; // documented intent for "sameUserOtherDevices" (always excludes)
}

export interface TokenTarget {
  token: string;
  userId: string | null;
}

/**
 * Resolve an audience to the valid push tokens to send to.
 *   self                  → the acting user's own devices
 *   sameUserOtherDevices  → the acting user's OTHER devices (excludes the origin
 *                           deviceId — this is how the PC's event reaches the phone)
 *   user                  → a specific user's devices
 *   all                   → every valid token (broadcast)
 */
export async function resolveAudience(
  audience: AudienceSpec,
  ctx: { userId: string; deviceId?: string },
): Promise<TokenTarget[]> {
  let where: Record<string, unknown>;
  switch (audience.mode) {
    case "self":
      where = { valid: true, userId: ctx.userId };
      break;
    case "sameUserOtherDevices":
      where = {
        valid: true,
        userId: ctx.userId,
        // `{ not: deviceId }` also keeps null-deviceId tokens (they are "other"),
        // and the origin (the PC) has no push token anyway.
        ...(ctx.deviceId ? { deviceId: { not: ctx.deviceId } } : {}),
      };
      break;
    case "user":
      if (!audience.userId) return [];
      where = { valid: true, userId: audience.userId };
      break;
    case "all":
      where = { valid: true };
      break;
    default:
      return [];
  }
  const rows = await prisma.pushToken.findMany({ where, select: { token: true, userId: true } });
  return rows.map((r) => ({ token: r.token, userId: r.userId }));
}
