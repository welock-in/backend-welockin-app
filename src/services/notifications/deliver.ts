import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { sendExpoPush } from "../../lib/expo-push";
import type { TokenTarget } from "./audience";

export interface DeliverPayload {
  title: string;
  body: string;
  data?: Record<string, unknown>;
  expiration?: number;
}

export interface DeliverSummary {
  recipients: number;
  sent: number;
  failed: number;
  invalid: number;
  pruned: number;
  deduped: number;
  /** Device rows dropped because their token proved the app is gone. */
  forgotten: number;
}

/**
 * The shared send primitive used by BOTH the admin broadcast route and the rule
 * engine: (best-effort dedupe) → Expo Push → one NotificationDelivery per
 * recipient → prune tokens Expo reports as gone. Keeping this in one place means
 * templated rule-sends and ad-hoc admin sends behave identically.
 */
export async function deliver(
  targets: TokenTarget[],
  payload: DeliverPayload,
  opts: { source: string; dedupeKey?: string | null },
): Promise<DeliverSummary> {
  const empty: DeliverSummary = {
    recipients: 0,
    sent: 0,
    failed: 0,
    invalid: 0,
    pruned: 0,
    deduped: 0,
    forgotten: 0,
  };
  if (targets.length === 0) return empty;

  // Best-effort dedupe: skip users who already got a delivery with this key.
  let list = targets;
  let deduped = 0;
  if (opts.dedupeKey) {
    const userIds = targets.map((t) => t.userId).filter((u): u is string => !!u);
    if (userIds.length > 0) {
      const seenRows = await prisma.notificationDelivery.findMany({
        // Only a delivery that actually WENT OUT counts as seen. Every attempt
        // leaves a row (that is the audit log), so matching on the key alone
        // would let one failed attempt — Expo unreachable, a dead token —
        // swallow every retry for this key forever.
        where: { dedupeKey: opts.dedupeKey, userId: { in: userIds }, status: { in: ["sent", "provider_confirmed", "receipt_missing"] } },
        select: { userId: true },
      });
      const seen = new Set(seenRows.map((r) => r.userId));
      list = targets.filter((t) => !(t.userId && seen.has(t.userId)));
      deduped = targets.length - list.length;
    }
    if (list.length === 0) return { ...empty, deduped };
  }

  const tokens = list.map((t) => t.token);
  const ownerByToken = new Map(list.map((t) => [t.token, t.userId]));
  const sendStartedAt = new Date();
  const results = await sendExpoPush(tokens, payload);

  const dataJson = payload.data as Prisma.InputJsonValue | undefined;
  await prisma.notificationDelivery.createMany({
    data: results.map((r) => ({
      userId: ownerByToken.get(r.token) ?? null,
      token: r.token,
      title: payload.title,
      body: payload.body,
      ...(dataJson !== undefined ? { data: dataJson } : {}),
      status: r.status,
      ticketId: r.ticketId ?? null,
      error: r.error ?? null,
      source: opts.source,
      dedupeKey: opts.dedupeKey ?? null,
    })),
  });

  const dead = results.filter((r) => r.errorCode === "DeviceNotRegistered").map((r) => r.token);
  if (dead.length > 0) {
    await prisma.pushToken.updateMany({
      where: { token: { in: dead }, updatedAt: { lte: sendStartedAt } },
      data: { valid: false, disabledReason: "DeviceNotRegistered" },
    });
    // A dead push registration is not proof the device left the account.
    // Keep it available for foreground recovery and token re-registration.
  }

  return {
    recipients: results.length,
    sent: results.filter((r) => r.status === "sent").length,
    failed: results.filter((r) => r.status === "error").length,
    invalid: results.filter((r) => r.status === "invalid").length,
    pruned: dead.length,
    deduped,
    forgotten: 0,
  };
}
