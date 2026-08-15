import { prisma } from "../lib/prisma";

/**
 * Shared scaffolding for the account guard. TEST-ONLY — nothing in the app
 * imports this.
 *
 * `requireCurrentSession` / `requireVerifiedAccount` are mounted in front of
 * every authenticated router (see app.ts), so EVERY gated request now performs a
 * `prisma.user.findUnique` that no route test previously had to think about.
 *
 * There is no test database, and `DATABASE_URL` is not set in the test
 * environment at all — `lib/env.ts` supplies a dev fallback for its own object,
 * but Prisma reads `env("DATABASE_URL")` from the real process environment. So
 * an unstubbed call is not an empty result, it is a
 * `PrismaClientInitializationError`, which the error handler turns into a bare
 * 500. That is precisely what broke 51 tests the day the guard was mounted, and
 * it is a test-setup gap rather than anything wrong with the guard: stub the
 * read and it answers 404 ACCOUNT_NOT_FOUND for a missing row and 200 for a live
 * one, exactly as written.
 */

/** The subject every route test signs its token for. */
export const TEST_USER_ID = "507f1f77bcf86cd799439011";
export const TEST_USER_EMAIL = "user@example.com";

export type GuardAccount = {
  id: string;
  email: string;
  emailVerified: boolean | null;
  passwordChangedAt: Date | null;
};

/**
 * Is this the GUARD's read, as opposed to a route's own user lookup?
 *
 * Identified by its `select`: the guard is the only caller in `src/` that asks
 * for `passwordChangedAt`, so the shape is unambiguous. Matching on the select
 * rather than intercepting every `findUnique` is what keeps this from being a
 * blanket bypass — see the note on `stubAccountGuard`.
 */
function isGuardQuery(args: unknown): boolean {
  const select = (args as { select?: Record<string, unknown> } | undefined)?.select;
  return Boolean(select && select.passwordChangedAt === true && select.emailVerified === true);
}

/**
 * Answer the guard's read for this test file, and NOTHING else.
 *
 * Call once at module scope: node's runner gives each test file its own process,
 * so there is no cross-file leakage to restore.
 *
 * Deliberately NOT a blanket "every user lookup succeeds" stub, for two reasons:
 *
 *  1. Any OTHER `prisma.user.findUnique` — a route reading its own caller, say —
 *     falls through to whatever was installed before, which at module load is
 *     the real client. So an unstubbed route-level read still fails loudly
 *     instead of silently receiving a fabricated account. That property is the
 *     only reason the suite catches missing stubs at all, and it survives intact.
 *  2. A test that wants a DIFFERENT account — unverified, or one whose password
 *     moved — installs its own `stubMethod(t, prisma.user, "findUnique", …)` as
 *     usual. That captures this wrapper as its `original` and restores it after,
 *     so per-test intent always wins over the file-wide default.
 */
export function stubAccountGuard(account: Partial<GuardAccount> = {}): void {
  const target = prisma.user as unknown as Record<string, any>;
  const previous = target.findUnique.bind(prisma.user);

  target.findUnique = async (args: any) => {
    if (isGuardQuery(args)) {
      return {
        id: args?.where?.id ?? TEST_USER_ID,
        email: TEST_USER_EMAIL,
        // The ordinary case the gated routers assume: a live, verified account
        // whose password has never moved.
        emailVerified: true,
        passwordChangedAt: null,
        ...account,
      };
    }
    return previous(args);
  };
}

/**
 * Answer "this account has no Lemon Squeezy subscription" for the whole file.
 *
 * The entitlement resolver reads subscriptions on every call, which means every
 * test that touches it — and that is most of them, because the resolver is on
 * the boot path — would otherwise reach an unstubbed Prisma client and 500.
 *
 * Installed at module scope rather than per test, and NOT restored: a suite that
 * wants a subscription stubs `findMany` itself afterwards, which wins because it
 * replaces this one.
 */
export function stubNoSubscriptions(): void {
  const target = prisma.subscription as unknown as Record<string, any>;
  target.findMany = async () => [];
}

/**
 * Answer "no lifetime, no device claim, no checkout hold, nothing owed" for the
 * whole file — the reads `loadEligibilityInputs` (lib/eligibility-io.ts) now
 * performs on every entitlement resolution, since the view carries the same
 * purchase-eligibility verdicts the paywall and the checkout share.
 *
 * Installed at module scope like `stubNoSubscriptions`, and NOT restored, for
 * the same reason: a test that wants a hold, a claim or an owed cancellation
 * stubs the method itself, which replaces this default and wins.
 */
export function stubNoBillingHolds(): void {
  (prisma.purchase as unknown as Record<string, any>).findFirst = async () => null;
  (prisma.trialClaim as unknown as Record<string, any>).findUnique = async () => null;
  (prisma.acquisitionLock as unknown as Record<string, any>).findUnique = async () => null;
  (prisma.checkoutIntent as unknown as Record<string, any>).findUnique = async () => null;
  (prisma.billingTask as unknown as Record<string, any>).findMany = async () => [];
}
