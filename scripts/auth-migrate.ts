import { Prisma, PrismaClient } from "@prisma/client";

/**
 * Prepare the database for email verification, password reset and device
 * binding. Idempotent — safe to run repeatedly, and safe to run before the code
 * that uses these collections is deployed.
 *
 * Two jobs, and the SECOND one is the dangerous one to skip.
 *
 * 1. INDEXES. On MongoDB, a `@@unique` in the Prisma schema is not a constraint
 *    until someone builds it: `db push` creates it, but a deploy that starts
 *    taking traffic first makes Mongo create the collection implicitly with NO
 *    index — and then `PasswordReset.tokenHash` is not unique, which is the only
 *    thing making a reset link single-use. The guarantee would silently not
 *    exist, and nothing would look wrong. Same lesson as the trial ledger's own
 *    migration.
 *
 * 2. GRANDFATHERING. Every account created before this feature reads
 *    `emailVerified` false or null, because only the Apple path ever set it
 *    true. Turning on `EMAIL_VERIFICATION_ENFORCED` without this pass locks out
 *    the entire existing user base in one deploy — none of whom have a code, and
 *    all of whom would be asked for one to reach the screen that sends codes.
 *    They proved nothing about their address, and that is precisely the point:
 *    they signed up under rules that never asked them to, so the rule starts
 *    with the accounts made after it.
 *
 * Run BEFORE flipping EMAIL_VERIFICATION_ENFORCED or DEVICE_BINDING_ENFORCED:
 *   npm run auth:migrate
 */

const prisma = new PrismaClient();

/** Build one index in ISOLATION, so a failure on one never skips the rest. */
async function buildIndex(collection: string, index: Record<string, unknown>): Promise<boolean> {
  try {
    await prisma.$runCommandRaw({
      createIndexes: collection,
      indexes: [index],
    } as unknown as Parameters<typeof prisma.$runCommandRaw>[0]);
    return true;
  } catch (err) {
    console.error(
      `[indexes] FAILED ${collection}.${String(index.name)}:`,
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

async function createIndexes(): Promise<void> {
  const results = await Promise.all([
    // THE one that matters: without it, "single use" is a hope, not a rule.
    buildIndex("PasswordReset", {
      key: { tokenHash: 1 },
      name: "uniq_tokenHash",
      unique: true,
    }),
    // The upsert key for the throttle table.
    buildIndex("AuthThrottle", {
      key: { key: 1 },
      name: "uniq_key",
      unique: true,
    }),
    // The upsert key for hardware signals, and the lookup that matches them.
    buildIndex("DeviceSignal", {
      key: { claimId: 1, kind: 1, hash: 1 },
      name: "uniq_claim_kind_hash",
      unique: true,
    }),
    buildIndex("DeviceSignal", {
      key: { kind: 1, hash: 1 },
      name: "lookup_kind_hash",
    }),

    // TTL indexes are HOUSEKEEPING ONLY. Mongo's TTL monitor runs roughly once a
    // minute and is explicitly best-effort, so every read still filters on
    // `expiresAt` — the query is the guarantee, this only stops the collections
    // growing forever.
    //
    // The 24h grace past expiry is deliberate: it keeps "expired, ask for
    // another" distinguishable from "never existed" for a day, which is the
    // difference between a support ticket that can be answered and one that
    // cannot.
    buildIndex("EmailVerification", {
      key: { expiresAt: 1 },
      name: "ttl_expiresAt",
      expireAfterSeconds: 86_400,
    }),
    buildIndex("PasswordReset", {
      key: { expiresAt: 1 },
      name: "ttl_expiresAt",
      expireAfterSeconds: 86_400,
    }),
    buildIndex("AuthThrottle", {
      key: { windowStartedAt: 1 },
      name: "ttl_windowStartedAt",
      expireAfterSeconds: 86_400,
    }),
    // Funnel telemetry runs. The write endpoint is public (its callers have no
    // account yet), so nothing but this bounds the collection's lifetime; 120
    // days comfortably outlives the admin console's widest window (90 days).
    buildIndex("funnel_runs", {
      key: { lastSeenAt: 1 },
      name: "ttl_lastSeenAt",
      expireAfterSeconds: 120 * 86_400,
    }),
  ]);

  const ok = results.filter(Boolean).length;
  console.log(`[indexes] built ${ok}/${results.length}`);
  if (ok < results.length) {
    throw new Error("Some indexes failed to build — resolve the errors above and re-run.");
  }
}

/**
 * Mark every PRE-EXISTING account as verified.
 *
 * Bounded by `createdAt` rather than blanket-updating, so re-running this after
 * the flow is live does not quietly verify accounts that were told to verify.
 * The cutoff is the moment of the first run, recorded in the audit log.
 */
async function grandfather(cutoff: Date, apply: boolean): Promise<number> {
  const where: Prisma.UserWhereInput = {
    createdAt: { lt: cutoff },
    OR: [{ emailVerified: false }, { emailVerified: null }],
  };

  const count = await prisma.user.count({ where });
  if (!apply || count === 0) return count;

  const { count: updated } = await prisma.user.updateMany({
    where,
    data: { emailVerified: true, emailVerifiedAt: cutoff },
  });
  return updated;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const cutoff = new Date();

  console.log(apply ? "[auth-migrate] APPLYING" : "[auth-migrate] DRY RUN (pass --apply to write)");

  await createIndexes();

  const n = await grandfather(cutoff, apply);
  console.log(
    apply
      ? `[grandfather] marked ${n} pre-existing account(s) verified`
      : `[grandfather] WOULD mark ${n} pre-existing account(s) verified`,
  );

  if (apply && n > 0) {
    await prisma.adminAuditLog
      .create({
        data: {
          // No human actor: this is a migration, and the log is the only place
          // that will remember it ran.
          actorId: "000000000000000000000000",
          actorEmail: "system:auth-migrate",
          action: "grandfather",
          reason: "Email verification shipped — accounts created before it keep their access",
          meta: { accounts: n, cutoff: cutoff.toISOString() },
        },
      })
      .catch((e) => console.warn("[grandfather] audit row failed:", e));
  }

  console.log("[auth-migrate] done");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
