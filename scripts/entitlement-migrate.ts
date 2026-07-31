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
  await (revert ? undo() : grandfather());
}

main()
  .catch((err) => {
    console.error("[entitlement:migrate] failed:", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
