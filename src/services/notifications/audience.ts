import { prisma } from "../../lib/prisma";

export interface AudienceSpec {
  mode: "self" | "sameUserOtherDevices" | "specificDevices" | "user" | "all";
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
 *   specificDevices       → only the devices named in ctx.targetDeviceIds. This is
 *                           what lets the user PICK which devices join a focus,
 *                           instead of broadcasting to everything they own.
 *   user                  → a specific user's devices
 *   all                   → every valid token (broadcast)
 */
export async function resolveAudience(
  audience: AudienceSpec,
  ctx: { userId: string; deviceId?: string; targetDeviceIds?: unknown },
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
    case "specificDevices": {
      const ids = Array.isArray(ctx.targetDeviceIds)
        ? ctx.targetDeviceIds.filter((v): v is string => typeof v === "string")
        : [];
      // No targets must mean NOBODY. Falling through to a broader query here
      // would silently turn a precise pick into an account-wide broadcast.
      if (ids.length === 0) return [];
      where = { valid: true, userId: ctx.userId, deviceId: { in: ids } };
      break;
    }
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
