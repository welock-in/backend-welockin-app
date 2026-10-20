import "../src/lib/env";
import { prisma } from "../src/lib/prisma";
import { grantLifetimeCohort } from "../src/lib/lifetime-cohort";

async function main() {
  const mode = process.env.LIFETIME_COHORT_MODE;
  if (!mode) return; // No automatic grant during ordinary builds.
  if (mode !== "dry-run" && mode !== "apply") throw new Error("Invalid LIFETIME_COHORT_MODE");
  const cutoff = new Date(process.env.LIFETIME_COHORT_CUTOFF ?? "");
  const excludedEmails = (process.env.LIFETIME_COHORT_EXCLUDE ?? "").split(",").filter(Boolean);
  const protectedBefore = await prisma.user.findMany({ where: { email: { in: excludedEmails } } });
  const result = await grantLifetimeCohort(prisma, {
    cutoff, excludedEmails, apply: mode === "apply",
    expectedCohortHash: process.env.LIFETIME_COHORT_HASH,
    reason: process.env.LIFETIME_COHORT_REASON ?? "",
  });
  const protectedAfter = await prisma.user.findMany({ where: { id: { in: protectedBefore.map((user) => user.id) } } });
  const accessFields = (users: typeof protectedBefore) => users.sort((a, b) => a.id.localeCompare(b.id)).map((user) => ({
    id: user.id, ios: user.iosLifetimeGrantedAt, desktop: user.desktopLifetimeGrantedAt,
    compActive: user.compActive, compedUntil: user.compedUntil, accessRevoked: user.accessRevoked,
    trialEndsAt: user.trialEndsAt, signupLifetimeOffer: user.signupLifetimeOffer,
  }));
  if (JSON.stringify(accessFields(protectedBefore)) !== JSON.stringify(accessFields(protectedAfter))) {
    throw new Error("Excluded access fields changed during operation");
  }
  const remaining = mode === "apply" ? await prisma.user.count({
    where: { createdAt: { lte: cutoff }, id: { notIn: protectedBefore.map((user) => user.id) }, OR: [
      { iosLifetimeGrantedAt: null }, { iosLifetimeGrantedAt: { isSet: false } },
      { desktopLifetimeGrantedAt: null }, { desktopLifetimeGrantedAt: { isSet: false } },
    ] },
  }) : null;
  if (remaining !== null && remaining !== 0) throw new Error("Lifetime readback incomplete");
  console.log(JSON.stringify({ lifetimeCohort: result, excludedAccessUnchanged: true, remaining }));
}

main().catch((error) => {
  // Never dump Prisma connection metadata into deployment logs.
  console.error(error instanceof Error && !error.name.startsWith("Prisma") ? error.message : "Lifetime cohort operation failed");
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
