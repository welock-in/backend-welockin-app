/**
 * Grandfather the existing cohort before the paywall is switched on.
 *
 *   npm run entitlement:migrate            # give everyone who exists a runway
 *   npm run entitlement:migrate -- --revert  # take it back
 *   npm run entitlement:migrate -- --dry-run # count, change nothing
 *
 * WHY THIS HAS TO RUN FIRST
 *
 * Every account that predates the ledger was stamped with a 14-day
 * `trialEndsAt` that was never enforced, because nothing ever gated on it. For
 * most of them that date is months in the past. The moment `ENTITLEMENT_ENFORCED`
 * flips, all of them resolve `expired` on the same afternoon and meet a paywall
 * they were never warned about — people who have been using the product happily
 * for a year, locked out by a config change.
 *
 * So they get a reversible, time-boxed comp instead: `compActive` with a
 * `compedUntil` 30 days out, which the resolver reports as `comped` (isPro true,
 * no paywall). That is a runway to tell them, not a gift — and `--revert` undoes
 * it exactly, because a migration you cannot take back is one you cannot test.
 *
 * ⚠️ SCHEDULE THE FOLLOW-UP BEFORE YOU RUN THIS. The whole cohort's comp expires
 * on the SAME DAY. Without a second migration (or an in-app campaign) before
 * then, you have moved the cliff, not removed it.
 */
import { prisma } from "../src/lib/prisma";

/**
 * Create the indexes the ledger's guarantees rest on, before anything else.
 *
 * This is not belt-and-braces, it is the ordering trap. MongoDB creates a
 * collection implicitly on first insert — WITHOUT any index — so a deploy that
 * lands before `prisma db push` gets a `TrialClaim` collection with no unique
 * constraint on `deviceIdHash`. Every claim then succeeds, the anti-farm
 * protection is silently absent, and by the time anyone notices there are
 * duplicate rows that make the index impossible to build.
 *
 * Doing it here means the operational step is one command that is safe to run
 * repeatedly, rather than a `db push` someone has to remember to run first.
 */
async function ensureIndexes(): Promise<void> {
  const duplicates = (await prisma.$runCommandRaw({
    aggregate: "TrialClaim",
    pipeline: [
      { $group: { _id: "$deviceIdHash", n: { $sum: 1 } } },
      { $match: { n: { $gt: 1 } } },
      { $count: "dupes" },
    ],
    cursor: {},
  })) as { cursor?: { firstBatch?: { dupes?: number }[] } };

  const dupes = duplicates.cursor?.firstBatch?.[0]?.dupes ?? 0;
  if (dupes > 0) {
    // Refuse rather than pick a survivor: each duplicate is a machine that got
    // more than one trial, and which row to keep is a judgement about a real
    // person's access that a migration script should not make silently.
    throw new Error(
      `${dupes} deviceIdHash values already have more than one TrialClaim — the unique index cannot build. ` +
        `Resolve them by hand (keep the OLDEST claim per machine) and re-run.`,
    );
  }

  try {
    await prisma.$runCommandRaw({
      createIndexes: "TrialClaim",
      indexes: [{ key: { deviceIdHash: 1 }, name: "uniq_trialclaim_deviceIdHash", unique: true }],
    } as unknown as Parameters<typeof prisma.$runCommandRaw>[0]);
    console.log("[indexes] TrialClaim.uniq_trialclaim_deviceIdHash ready");
  } catch (err) {
    // The index IS the anti-farm mechanism. Without it every claim succeeds and
    // the ledger is decoration, so this failure must stop the run.
    throw new Error(
      `could not create the unique index on TrialClaim.deviceIdHash — the trial ledger would enforce NOTHING: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

const GRANDFATHER_DAYS = Number.parseInt(process.env.GRANDFATHER_DAYS ?? "30", 10);
const REASON = "beta-grandfather";
/** A migration has no human actor. A valid 24-hex ObjectId, deliberately zero. */
const SYSTEM_ACTOR = "000000000000000000000000";

const dryRun = process.argv.includes("--dry-run");
const revert = process.argv.includes("--revert");

async function audit(action: string, meta: Record<string, unknown>): Promise<void> {
  await prisma.adminAuditLog
    .create({
      data: {
        actorId: SYSTEM_ACTOR,
        actorEmail: "system:entitlement-migrate",
        action,
        reason: `${action} of the pre-paywall cohort`,
        meta: meta as never,
      },
    })
    .catch((e) => console.error("[migrate] audit row failed:", e));
}

async function grandfather(): Promise<void> {
  const now = new Date();
  const compedUntil = new Date(now.getTime() + GRANDFATHER_DAYS * 24 * 60 * 60 * 1000);

  // Everyone who exists NOW and is not already comped. Guarded on compReason so
  // re-running is a no-op rather than a 30-day extension — a migration that
  // silently renews itself every time someone runs it is worse than none.
  const where = {
    createdAt: { lt: now },
    compActive: { not: true },
    accessRevoked: { not: true },
  } as const;

  const count = await prisma.user.count({ where });
  if (count === 0) {
    console.log("[grandfather] nothing to do — no un-comped accounts.");
    return;
  }
  if (dryRun) {
    console.log(`[grandfather] DRY RUN — would comp ${count} accounts until ${compedUntil.toISOString()}`);
    return;
  }

  const res = await prisma.user.updateMany({
    where,
    data: {
      compActive: true,
      compReason: REASON,
      compedUntil,
      compedAt: now,
      compedByAdminId: SYSTEM_ACTOR,
    },
  });

  await audit("grandfather", { count: res.count, compedUntil: compedUntil.toISOString(), days: GRANDFATHER_DAYS });
  console.log(`[grandfather] comped ${res.count} accounts until ${compedUntil.toISOString()}`);
  console.log(
    `⚠️  Every one of them expires on that date. Schedule the follow-up BEFORE it, ` +
      `or the cliff simply moved ${GRANDFATHER_DAYS} days.`,
  );
}

async function undo(): Promise<void> {
  // ONLY rows this script wrote. A comp granted by support for a real reason must
  // survive a revert — that is what makes the reason field load-bearing.
  const where = { compActive: true, compReason: REASON } as const;

  const count = await prisma.user.count({ where });
  if (count === 0) {
    console.log("[revert] nothing to do — no grandfathered accounts.");
    return;
  }
  if (dryRun) {
    console.log(`[revert] DRY RUN — would clear the comp on ${count} accounts`);
    return;
  }

  const res = await prisma.user.updateMany({
    where,
    data: {
      compActive: false,
      compReason: null,
      compedUntil: null,
      compedAt: null,
      compedByAdminId: null,
    },
  });

  await audit("grandfather_revert", { count: res.count });
  console.log(`[revert] cleared the grandfather comp on ${res.count} accounts`);
}

async function main(): Promise<void> {
  if (!Number.isFinite(GRANDFATHER_DAYS) || GRANDFATHER_DAYS <= 0) {
    throw new Error(`GRANDFATHER_DAYS must be a positive number, got ${process.env.GRANDFATHER_DAYS}`);
  }
  // Always, and first — including on `--revert` and `--dry-run`. The index is
  // what makes the ledger mean anything, and this script is the one command an
  // operator is told to run.
  await ensureIndexes();
  await (revert ? undo() : grandfather());
}

main()
  .catch((err) => {
    console.error("[entitlement:migrate] failed:", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
