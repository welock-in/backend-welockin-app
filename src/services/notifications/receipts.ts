import { prisma } from "../../lib/prisma";
import { getExpoReceipts } from "../../lib/expo-push";

/** Small scheduled diagnostic, shared with the admin refresh button.
 * Provider confirmation is NOT proof a banner was shown on the device.
 */
export async function checkNotificationReceipts() {
  const now = Date.now();
  // Expired Expo receipts are unavailable after 24h. Close these rows so they
  // cannot starve a limited batch forever; don't resend an ambiguous delivery.
  const expired = await prisma.notificationDelivery.updateMany({
    where: { status: "sent", ticketId: { not: null }, createdAt: { lt: new Date(now - 24 * 60 * 60_000) } },
    data: { status: "receipt_missing", error: "Expo receipt unavailable after 24 hours" },
  });
  const rows = await prisma.notificationDelivery.findMany({
    where: { status: "sent", ticketId: { not: null }, createdAt: { lte: new Date(now - 15 * 60_000), gte: new Date(now - 24 * 60 * 60_000) } },
    orderBy: { createdAt: "asc" }, take: 300,
    select: { id: true, ticketId: true, token: true, userId: true, createdAt: true },
  });
  const receipts = await getExpoReceipts(rows.flatMap((r) => r.ticketId ? [r.ticketId] : []));
  let confirmed = 0, failed = 0, waiting = 0;
  for (const row of rows) {
    const receipt = row.ticketId ? receipts[row.ticketId] : undefined;
    if (!receipt) { waiting++; continue; }
    if (receipt.status === "ok") {
      await prisma.notificationDelivery.updateMany({ where: { id: row.id, status: "sent" }, data: { status: "provider_confirmed", error: null } });
      confirmed++;
    } else {
      const code = receipt.details?.error ?? "ProviderError";
      await prisma.notificationDelivery.updateMany({ where: { id: row.id, status: "sent" }, data: { status: "error", error: `${code}: ${receipt.message ?? "Push rejected"}` } });
      if (code === "DeviceNotRegistered" && row.token) {
        // A receipt for an old registration must not invalidate a fresh one.
        await prisma.pushToken.updateMany({
          where: { token: row.token, userId: row.userId ?? undefined, updatedAt: { lte: row.createdAt } },
          data: { valid: false, disabledReason: code },
        });
      }
      failed++;
    }
  }
  return { checked: rows.length, confirmed, failed, waiting, expired: expired.count };
}
