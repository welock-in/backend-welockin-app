/**
 * Feedback board maintenance / reconciliation.
 *
 * Run after `prisma db push` (and safe to run again as a cron):
 *   npm run reconcile:feedback
 *
 * It is idempotent and does three things:
 *   1. Normalize User.isAdmin=false on legacy docs that predate the column. The
 *      column is OPTIONAL so missing values already read back as null (non-admin)
 *      — this is just tidy normalization, not required for correctness. Done via a
 *      RAW Mongo update ($runCommandRaw) so it doesn't depend on the typed layer.
 *   2. Purge orphan Vote / FeatureReport rows whose featureRequestId no longer
 *      resolves (Mongo has no real FKs; the emulated cascade can miss rows deleted
 *      out-of-band).
 *   3. Recompute the denormalized FeatureRequest.voteCount / reportCount from the
 *      authoritative count(votes) / count(reports).
 */
import { prisma } from "../src/lib/prisma";

async function normalizeIsAdmin(): Promise<void> {
  const result = (await prisma.$runCommandRaw({
    update: "User",
    updates: [
      { q: { isAdmin: { $exists: false } }, u: { $set: { isAdmin: false } }, multi: true },
    ],
  })) as { n?: number; nModified?: number };
  console.log(`[isAdmin] matched ${result.n ?? 0}, modified ${result.nModified ?? 0}`);
}

async function purgeOrphans(): Promise<void> {
  const frIds = new Set(
    (await prisma.featureRequest.findMany({ select: { id: true } })).map((r) => r.id),
  );

  const votes = await prisma.vote.findMany({ select: { id: true, featureRequestId: true } });
  const orphanVoteIds = votes.filter((v) => !frIds.has(v.featureRequestId)).map((v) => v.id);
  if (orphanVoteIds.length) {
    await prisma.vote.deleteMany({ where: { id: { in: orphanVoteIds } } });
  }

  const reports = await prisma.featureReport.findMany({
    select: { id: true, featureRequestId: true },
  });
  const orphanReportIds = reports
    .filter((r) => !frIds.has(r.featureRequestId))
    .map((r) => r.id);
  if (orphanReportIds.length) {
    await prisma.featureReport.deleteMany({ where: { id: { in: orphanReportIds } } });
  }

  console.log(`[orphans] removed ${orphanVoteIds.length} votes, ${orphanReportIds.length} reports`);
}

async function recomputeCounts(): Promise<void> {
  const frs = await prisma.featureRequest.findMany({
    select: { id: true, voteCount: true, reportCount: true },
  });
  let fixed = 0;
  for (const fr of frs) {
    const [voteCount, reportCount] = await Promise.all([
      prisma.vote.count({ where: { featureRequestId: fr.id } }),
      prisma.featureReport.count({ where: { featureRequestId: fr.id } }),
    ]);
    if (voteCount !== fr.voteCount || reportCount !== fr.reportCount) {
      await prisma.featureRequest.update({
        where: { id: fr.id },
        data: { voteCount, reportCount },
      });
      fixed += 1;
    }
  }
  console.log(`[counts] reconciled ${fixed}/${frs.length} feature requests`);
}

async function main(): Promise<void> {
  await normalizeIsAdmin();
  await purgeOrphans();
  await recomputeCounts();
  console.log("Feedback reconciliation complete.");
}

main()
  .catch((err) => {
    console.error("Reconciliation failed:", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
