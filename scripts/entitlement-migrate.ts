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

  // `prisma db push` creates the same constraint under its OWN name
  // (`TrialClaim_deviceIdHash_key`), and MongoDB rejects a second index with the
  // same key spec under a different name — so a repo that followed the README
  // and ran `db push` first would hit a hard failure here. What matters is that
  // SOMETHING enforces uniqueness on deviceIdHash, not what it is called.
  const existing = (await prisma
    .$runCommandRaw({ listIndexes: "TrialClaim" } as never)
    .catch(() => null)) as { cursor?: { firstBatch?: { name?: string; key?: Record<string, number>; unique?: boolean }[] } } | null;

  const already = existing?.cursor?.firstBatch?.find(
    (i) => i.unique === true && i.key?.deviceIdHash === 1 && Object.keys(i.key).length === 1,
  );
  if (already) {
    console.log(`[indexes] TrialClaim.${already.name} already enforces uniqueness on deviceIdHash`);
    return;
  }

  if (dryRun) {
    // A dry run that writes is a trap, even when the write is idempotent: the
    // whole point of the flag is that someone can point it at production to find
    // out what WOULD happen.
    console.log("[indexes] DRY RUN — would create TrialClaim.uniq_trialclaim_deviceIdHash (unique)");
    return;
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

/**
 * Every filter here is RAW MongoDB, and that is not a style choice.
 *
 * The accounts this script exists for are precisely the ones that predate the
 * comp columns, so their documents have no `compActive` field AT ALL — `@default`
 * on MongoDB is create-time only, and `db push` never rewrites existing
 * documents. Prisma's `{ not: true }` requires the field to be present, so a
 * Prisma-native filter matches ZERO of them: the migration would report success,
 * change nothing, and the operator would flip `ENTITLEMENT_ENFORCED` believing
 * the cohort was safe. Mongo's `$ne: true` matches missing, null and false, which
 * is the population actually meant.
 */
const CANDIDATES = { compActive: { $ne: true }, accessRevoked: { $ne: true } } as const;

async function countRaw(filter: Record<string, unknown>): Promise<number> {
  const res = (await prisma.$runCommandRaw({ count: "User", query: filter } as never)) as { n?: number };
  return res.n ?? 0;
}

async function updateRaw(filter: Record<string, unknown>, set: Record<string, unknown>) {
  return (await prisma.$runCommandRaw({
    update: "User",
    updates: [{ q: filter, u: { $set: set }, multi: true }],
  } as never)) as { n?: number; nModified?: number };
}

async function grandfather(): Promise<void> {
  const now = new Date();
  const compedUntil = new Date(now.getTime() + GRANDFATHER_DAYS * 24 * 60 * 60 * 1000);

  const count = await countRaw(CANDIDATES);
  if (count === 0) {
    console.log("[grandfather] nothing to do — every account is already comped or revoked.");
    return;
  }
  if (dryRun) {
    console.log(`[grandfather] DRY RUN — would comp ${count} accounts until ${compedUntil.toISOString()}`);
    return;
  }

  const res = await updateRaw(CANDIDATES, {
    compActive: true,
    compReason: REASON,
    compedUntil: { $date: compedUntil.toISOString() },
    compedAt: { $date: now.toISOString() },
    compedByAdminId: SYSTEM_ACTOR,
  });

  const modified = res.nModified ?? 0;
  // Never report success on a no-op. A migration that quietly matches nothing is
  // the failure this whole script is guarding against — see CANDIDATES.
  if (modified !== count) {
    console.error(`⚠️  expected to comp ${count} accounts but modified ${modified}. DO NOT enable enforcement.`);
  }

  await audit("grandfather", { count: modified, compedUntil: compedUntil.toISOString(), days: GRANDFATHER_DAYS });
  console.log(`[grandfather] comped ${modified} accounts until ${compedUntil.toISOString()}`);
  console.log(
    `⚠️  Every one of them expires on that date. Schedule the follow-up BEFORE it, ` +
      `or the cliff simply moved ${GRANDFATHER_DAYS} days.`,
  );
}

async function undo(): Promise<void> {
  // ONLY rows this script wrote. A comp granted by support for a real reason must
  // survive a revert — that is what makes the reason field load-bearing.
  const mine = { compActive: true, compReason: REASON } as const;

  const count = await countRaw(mine);
  if (count === 0) {
    console.log("[revert] nothing to do — no grandfathered accounts.");
    return;
  }
  if (dryRun) {
    console.log(`[revert] DRY RUN — would clear the comp on ${count} accounts`);
    return;
  }

  // Set rather than unset, so the fields now EXIST as false/null — which is what
  // makes a second grandfather run able to find them again. A revert that left
  // the documents un-matchable would be a one-way door wearing a two-way sign.
  const res = await updateRaw(mine, {
    compActive: false,
    compReason: null,
    compedUntil: null,
    compedAt: null,
    compedByAdminId: null,
  });

  await audit("grandfather_revert", { count: res.nModified ?? 0 });
  console.log(`[revert] cleared the grandfather comp on ${res.nModified ?? 0} accounts`);
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
