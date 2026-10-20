import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";

export const LIFETIME_COHORT_SELECT = {
  id: true, email: true, createdAt: true, emailVerified: true,
  iosLifetimeGrantedAt: true, desktopLifetimeGrantedAt: true,
  accessRevoked: true, status: true,
} as const;

type Options = {
  cutoff: Date;
  excludedEmails: string[];
  reason: string;
  apply?: boolean;
  expectedCohortHash?: string;
};

/** Explicit one-off operator grant, unrelated to signup switches or paid records. */
export async function grantLifetimeCohort(db: PrismaClient, options: Options) {
  if (!Number.isFinite(options.cutoff.getTime()) || !options.reason.trim()) throw new Error("Invalid cohort options");
  const excludedEmails = [...new Set(options.excludedEmails.map((email) => email.trim().toLowerCase()))].sort();
  if (!excludedEmails.length || excludedEmails.some((email) => !email.includes("@"))) {
    throw new Error("Exact excluded account emails are required");
  }
  const users = await db.user.findMany({
    where: { createdAt: { lte: options.cutoff } }, select: LIFETIME_COHORT_SELECT, orderBy: { id: "asc" },
  });
  const excluded = excludedEmails.map((email) => {
    const matches = users.filter((user) => user.email.toLowerCase() === email);
    if (matches.length !== 1) throw new Error(`Excluded account must resolve exactly once: ${email}`);
    return matches[0];
  });
  const excludedIds = new Set(excluded.map((user) => user.id));
  const targets = users.filter((user) => !excludedIds.has(user.id));
  const cohortHash = createHash("sha256").update(JSON.stringify({
    cutoff: options.cutoff.toISOString(), targets: targets.map((user) => user.id), excluded: excluded.map((user) => user.id),
  })).digest("hex");
  if (options.apply && options.expectedCohortHash !== cohortHash) {
    throw new Error("Cohort changed or was not previewed; run dry-run and review its hash");
  }
  const pending = targets.filter((user) => !user.iosLifetimeGrantedAt || !user.desktopLifetimeGrantedAt);
  let granted = 0;
  const grantedAt = new Date();
  if (options.apply && pending.length) {
    // Each account and its audit record commit together. Retrying the operation
    // skips completed accounts and never replaces an existing lifetime date.
    for (const target of pending) {
      await db.$transaction(async (tx) => {
        const current = await tx.user.findUniqueOrThrow({ where: { id: target.id }, select: LIFETIME_COHORT_SELECT });
        if (excludedIds.has(current.id) || excludedEmails.includes(current.email.toLowerCase()) ||
            current.createdAt > options.cutoff) throw new Error("Cohort identity changed");
        const data = {
          ...(!current.iosLifetimeGrantedAt ? { iosLifetimeGrantedAt: grantedAt } : {}),
          ...(!current.desktopLifetimeGrantedAt ? { desktopLifetimeGrantedAt: grantedAt } : {}),
        };
        if (!Object.keys(data).length) return;
        await tx.user.update({ where: { id: current.id }, data });
        await tx.adminAuditLog.create({ data: {
          actorId: "000000000000000000000000", actorEmail: "operator:lifetime-cohort",
          action: "grant_lifetime_all_platforms", targetUserId: current.id, reason: options.reason,
          before: {
            iosLifetimeGrantedAt: current.iosLifetimeGrantedAt?.toISOString() ?? null,
            desktopLifetimeGrantedAt: current.desktopLifetimeGrantedAt?.toISOString() ?? null,
          },
          after: {
            iosLifetimeGrantedAt: (current.iosLifetimeGrantedAt ?? grantedAt).toISOString(),
            desktopLifetimeGrantedAt: (current.desktopLifetimeGrantedAt ?? grantedAt).toISOString(),
          },
          meta: { cohortHash, cutoff: options.cutoff.toISOString(), excludedUserIds: [...excludedIds] },
        } });
      });
      granted++;
    }
  }
  return {
    mode: options.apply ? "apply" : "dry-run", cutoff: options.cutoff.toISOString(), cohortHash,
    accounts: users.length, targets: targets.length, alreadyGranted: targets.length - pending.length,
    pending: pending.length, granted,
    awaitingEmailVerification: targets.filter((user) => user.emailVerified !== true).length,
    revoked: targets.filter((user) => user.accessRevoked === true).length,
    suspended: targets.filter((user) => user.status === "suspended").length,
    excluded: excluded.map((user) => ({ id: user.id, email: user.email })),
  };
}
