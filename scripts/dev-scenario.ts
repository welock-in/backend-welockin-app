/**
 * Put one account into any entitlement state, instantly.
 *
 *   npm run dev:scenario -- me@test.dev expired
 *   npm run dev:scenario -- me@test.dev trialing
 *   npm run dev:scenario -- me@test.dev fresh
 *
 * The states the product can be in are all reachable only by waiting fourteen
 * days, paying real money, or hand-editing Mongo — which means the paywall, the
 * expiry copy and the post-purchase unlock are the least-looked-at screens in the
 * app, and they are the ones money passes through. This makes each of them one
 * command away.
 *
 * States
 *   fresh     — no account, no claim. The next launch is a true first run:
 *               onboarding funnel, then a brand-new 14-day window.
 *   trialing  — 7 days left.
 *   ending    — 20 minutes left. For the "your trial ends soon" surfaces.
 *   expired   — window elapsed. THE PAYWALL.
 *   paid      — a lifetime licence. Unlocked, and the Buy button should vanish.
 *   refunded  — bought then refunded. Paywall, with the refunded wording.
 *   comped    — an admin grant. Unlocked with no purchase.
 *   revoked   — hard revoke. Outranks everything, including a live purchase.
 *
 * REFUSES TO RUN against a database whose name does not look like a test one.
 * It deletes users and rewrites entitlement; pointed at production by a stale
 * shell it would be a very bad afternoon.
 */
import bcrypt from "bcryptjs";
import { prisma } from "../src/lib/prisma";
import { env } from "../src/lib/env";
import { ledgerHash } from "../src/lib/hash";

const STATES = [
  "fresh",
  "trialing",
  "ending",
  "expired",
  "paid",
  "refunded",
  "comped",
  "revoked",
] as const;
type State = (typeof STATES)[number];

const [emailArg, stateArg] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const force = process.argv.includes("--force");

const days = (n: number) => new Date(Date.now() + n * 24 * 60 * 60 * 1000);
const minutes = (n: number) => new Date(Date.now() + n * 60 * 1000);

/**
 * The guard that makes the rest of this file safe to write.
 *
 * A scenario script is a loaded weapon: it deletes accounts and rewrites who has
 * paid. The only thing standing between it and a real customer is which shell it
 * was run from, so the database has to say out loud that it is disposable.
 */
function assertDisposableDatabase(): void {
  const dbName = env.databaseUrl.split("/").pop()?.split("?")[0] ?? "";
  const looksDisposable = /(dev|test|local|staging|sandbox)/i.test(dbName);
  if (looksDisposable || force) {
    console.log(`[scenario] database: ${dbName}${force && !looksDisposable ? "  (--force)" : ""}`);
    return;
  }
  throw new Error(
    `refusing to run against "${dbName}" — the name does not look disposable. ` +
      `This script deletes accounts and rewrites entitlement. Point DATABASE_URL at a ` +
      `dev/test database, or pass --force if you genuinely mean it.`,
  );
}

/** Every trace of this person and of the machine they claimed from. */
async function wipe(email: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (user) {
    // The claim is keyed on the machine, not the user, so deleting the account
    // would normally LEAVE it — that is the anti-farm design. Here we want a true
    // first run, so it goes too.
    await prisma.trialClaim.deleteMany({ where: { firstUserId: user.id } });
    await prisma.purchase.deleteMany({ where: { userId: user.id } });
    await prisma.device.deleteMany({ where: { userId: user.id } });
    await prisma.onboardingProfile.deleteMany({ where: { userId: user.id } });
    await prisma.authProvider.deleteMany({ where: { userId: user.id } });
    await prisma.user.delete({ where: { id: user.id } }).catch(() => undefined);
  }
  console.log(`[scenario] wiped ${email}`);
}

/** An obviously-fake local password, so the account can be signed into at once. */
export const DEV_PASSWORD = "devdevdev";

async function ensureUser(email: string) {
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return existing;
  // HASHED HERE rather than pasted as a constant. A hard-coded digest cannot be
  // read back to check it, so a wrong one produces an account that exists and
  // cannot be signed into — which is exactly what happened the first time.
  const passwordHash = await bcrypt.hash(DEV_PASSWORD, 10);
  const user = await prisma.user.create({
    data: { email, passwordHash, plan: "trial", emailVerified: true },
  });
  console.log(`[scenario] created ${email} (password: ${DEV_PASSWORD})`);
  return user;
}

/** The claim IS the trial. One row per machine; here, one per test account. */
async function setClaim(userId: string, email: string, endsAt: Date): Promise<void> {
  const deviceIdHash = ledgerHash(`dev-scenario:${email}`);
  await prisma.trialClaim.deleteMany({ where: { OR: [{ firstUserId: userId }, { deviceIdHash }] } });
  await prisma.trialClaim.create({
    data: {
      deviceIdHash,
      firstUserId: userId,
      trialDays: env.trialDays,
      startedAt: new Date(endsAt.getTime() - env.trialDays * 24 * 60 * 60 * 1000),
      endsAt,
      status: endsAt > new Date() ? "active" : "expired",
      hardwareBacked: true,
    },
  });
}

async function setOverrides(
  userId: string,
  over: { compActive?: boolean; compedUntil?: Date | null; accessRevoked?: boolean },
): Promise<void> {
  // Raw, because these columns are absent from documents that predate them and
  // Prisma's filters/updates on MongoDB need the field to exist. Same reason
  // entitlement-migrate.ts does.
  await prisma.$runCommandRaw({
    update: "User",
    updates: [
      {
        q: { _id: { $oid: userId } },
        u: {
          $set: {
            compActive: over.compActive ?? false,
            compedUntil: over.compedUntil ? { $date: over.compedUntil.toISOString() } : null,
            accessRevoked: over.accessRevoked ?? false,
            compReason: over.compActive ? "dev-scenario" : null,
          },
        },
      },
    ],
  } as never);
}

async function setPurchase(userId: string, refunded: boolean): Promise<void> {
  await prisma.purchase.deleteMany({ where: { userId } });
  await prisma.purchase.create({
    data: {
      userId,
      provider: "lemonsqueezy",
      store: "lemonsqueezy",
      productId: "dev-scenario",
      externalId: `dev-${userId}`,
      priceUsd: 22.92,
      purchasedAt: new Date(),
      isRefunded: refunded,
      refundedAt: refunded ? new Date() : null,
    },
  });
}

async function apply(email: string, state: State): Promise<void> {
  if (state === "fresh") {
    await wipe(email);
    console.log("→ next launch is a true first run: onboarding, then a new 14-day window.");
    return;
  }

  const user = await ensureUser(email);
  // Always start from a clean slate, so states never silently compose.
  await prisma.purchase.deleteMany({ where: { userId: user.id } });
  await setOverrides(user.id, {});

  switch (state) {
    case "trialing":
      await setClaim(user.id, email, days(7));
      break;
    case "ending":
      await setClaim(user.id, email, minutes(20));
      break;
    case "expired":
      await setClaim(user.id, email, days(-1));
      break;
    case "paid":
      await setClaim(user.id, email, days(-1));
      await setPurchase(user.id, false);
      break;
    case "refunded":
      await setClaim(user.id, email, days(-1));
      await setPurchase(user.id, true);
      break;
    case "comped":
      await setClaim(user.id, email, days(-1));
      await setOverrides(user.id, { compActive: true, compedUntil: days(30) });
      break;
    case "revoked":
      await setClaim(user.id, email, days(7));
      await setPurchase(user.id, false);
      await setOverrides(user.id, { accessRevoked: true });
      break;
  }

  // Report what the resolver ACTUALLY says, rather than what was intended — the
  // two disagreeing is exactly the bug a scenario script should surface.
  const { resolveAndCache } = await import("../src/routes/entitlement");
  const view = await resolveAndCache(user.id, `dev-scenario:${email}`);
  console.log(`[scenario] ${email} → ${state}`);
  console.log(JSON.stringify(view, null, 2));
  if (!env.entitlementEnforced) {
    console.log("\n⚠️  ENTITLEMENT_ENFORCED is false here, so the client will NOT show the paywall.");
  }
}

async function main(): Promise<void> {
  if (!emailArg || !stateArg || !STATES.includes(stateArg as State)) {
    console.error(`usage: npm run dev:scenario -- <email> <${STATES.join("|")}> [--force]`);
    process.exitCode = 1;
    return;
  }
  assertDisposableDatabase();
  await apply(emailArg, stateArg as State);
}

main()
  .catch((err) => {
    console.error("[dev:scenario]", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
