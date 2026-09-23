import { prisma } from "./prisma";

/* ─────────────────────────────────────────────────────────────
   THE DEVICE LIST AND THE NOTIFICATION PATH ARE ONE THING.

   They were two. `resolveAudience` (services/notifications/audience.ts)
   selects PushToken rows by userId — it never looks at Device — so a
   phone that had been removed from the account, or signed out of, kept
   receiving that account's notifications for as long as its token
   stayed `valid`. The list said the device was gone and the push said
   otherwise.

   This module is the join. Two directions, both of them here so
   neither can be half-implemented:

     device leaves the account  → silencePushTokens()          (sign-out, unpair,
                                                                removal from another device)
     token reports it is gone   → forgetUninstalledDevices()   (the app was deleted)

   Reinstalling or signing back in undoes both: POST /notifications/token
   sets `valid: true` again, and POST /devices recreates the row.
   ───────────────────────────────────────────────────────────── */

/**
 * Stop this account's notifications reaching the given devices.
 *
 * Call it BEFORE deleting the Device row, never after: if the write fails the
 * caller still has a device on the list that can be removed again, which is a
 * far better state than a device off the list that is still being pushed to.
 *
 * Returns how many tokens were silenced. The row survives (a token can move to
 * another account, and re-registering revives it) — only its `valid` flag drops.
 */
export async function silencePushTokens(
  userId: string,
  deviceIds: string[],
  reason: string,
): Promise<number> {
  const ids = deviceIds.filter((id) => typeof id === "string" && id.length > 0);
  if (ids.length === 0) return 0;
  const { count } = await prisma.pushToken.updateMany({
    where: { userId, deviceId: { in: ids }, valid: true },
    data: { valid: false, disabledReason: reason },
  });
  return count;
}

/**
 * Drop the Device rows behind push tokens Expo says are gone.
 *
 * `DeviceNotRegistered` is the only uninstall signal iOS gives us — nothing runs
 * on the phone when the app is deleted — so this is where a deleted app leaves
 * the account's device list instead of sitting in it forever.
 *
 * One dead token is NOT proof of an uninstall, so a device is only forgotten
 * once NO valid token is left for it: the Keychain device id survives a
 * reinstall, which means a fresh install mints a NEW valid token for the SAME
 * (userId, deviceId) while the old one keeps bouncing — without the guard, the
 * old corpse would delete a phone that is alive and reachable. The remaining
 * false positive (a revoked notification permission kills every token of a
 * still-installed phone) is deliberately accepted: the client re-registers its
 * device on each foreground, so the row comes back the next time the app is
 * opened. Desktops are untouched by this path — they carry no push token at all.
 *
 * Best-effort by contract: a send must never fail because a cleanup did.
 */
export async function forgetUninstalledDevices(deadTokens: string[]): Promise<number> {
  if (deadTokens.length === 0) return 0;
  try {
    const rows = await prisma.pushToken.findMany({
      where: { token: { in: deadTokens } },
      select: { userId: true, deviceId: true },
    });
    // One delete per owner, deduped: several tokens can belong to the same phone
    // (a reinstall mints a new one), and re-deleting is pure waste.
    const owners = new Map<string, { userId: string; deviceId: string }>();
    for (const r of rows) {
      if (!r.deviceId) continue; // a token with no device row to forget
      owners.set(`${r.userId}:${r.deviceId}`, { userId: r.userId, deviceId: r.deviceId });
    }

    let removed = 0;
    for (const { userId, deviceId } of owners.values()) {
      // The guard. The dead tokens were flagged valid:false BEFORE this call
      // (deliver.ts orders it that way), so they can never vouch for their own
      // device — any valid token found here belongs to a living install.
      const alive = await prisma.pushToken.count({ where: { userId, deviceId, valid: true } });
      if (alive > 0) continue;
      const { count } = await prisma.device.deleteMany({ where: { userId, deviceId } });
      removed += count;
    }
    return removed;
  } catch {
    return 0;
  }
}
