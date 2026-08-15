/**
 * The device → paying-account precheck (spec S1/N4 + L1/N6).
 *
 * ONE question, asked from two places: "does this physical device already
 * belong to an account whose money is real?" `POST /api/auth/precheck` asks it
 * so the iOS signup screen can interrupt BEFORE an account (and a verification
 * email) exists; the signup gates in routes/auth.ts ask it again server-side,
 * because a client-side interstitial is advice and an attacker's client takes
 * no advice.
 *
 * "PAYING" IS DELIBERATELY NARROW: a non-refunded Purchase, or a Subscription
 * row that `subscriptionGrants` says still grants. A comp is NOT paying — it is
 * our generosity, not their money, and blocking a signup over it would let an
 * admin courtesy brick a family's shared iPad. A machine trial is not paying
 * either, and needs no case here: it produces no Purchase and no Subscription.
 *
 * THE LOOKUP FAILS OPEN at every step, like the trial ledger it borrows its
 * keys from. An unreliable device id (the shared "unidentified" sink), a
 * fingerprint that matches nothing, a claim whose owner deleted their account —
 * each reads as "no paying account", never as a refusal. This is a courtesy
 * against double-paying, not a wall: every path that takes money is guarded
 * elsewhere (RC identity pre-flight, restore behaviour, the cross-provider
 * checkout gates).
 *
 * SELF-HEALING is a property, not a feature to maintain: Device rows cascade
 * with `prisma.user.delete`, so a deleted account stops matching the device
 * leg by construction (spec N13 — deleting your account must not brick your
 * iPhone). The TrialClaim fallbacks survive deletion by design, which is why
 * they skip claims whose `firstUserId` is nulled or points at a ghost.
 */
import { prisma } from "./prisma";
import { ledgerHash } from "./hash";
import { isReliableDeviceId } from "./device";
import { matchClaimByFingerprint, type Signal } from "./fingerprint";
import { hideTestRowsFor, subscriptionGrants } from "./subscription";
import { billingProviderFor, type BillingProvider } from "./entitlement";

/** How a paying account can be signed back into — the interstitial's CTA. */
export type LoginMethod = "password" | "apple";

export type PayingAccount = {
  userId: string;
  /**
   * The RAW address — kept so the signup gates can compare it against the
   * registrant's and so the route can mask it. NEVER put on the wire as-is:
   * every caller that serialises this must go through `maskEmail` first.
   */
  email: string;
  billingProvider: BillingProvider;
  loginMethods: LoginMethod[];
};

export type PrecheckResult = {
  /**
   * Did ANY Device row match this device id? Separate from finding a paying
   * account, because the client's copy differs: an unknown device is a fresh
   * start, a known device without a paying account is merely a returning one.
   */
  deviceKnown: boolean;
  payingAccount: PayingAccount | null;
};

/** The slice of `env` this reads — the test-row gate, passed like everywhere
 *  else in lib/ so the rule stays drivable from a test. */
type TestRowGate = {
  lemonSqueezyAllowTestMode: boolean;
  revenuecatAllowSandbox: boolean;
  revenuecatSandboxAllowedUserIds: readonly string[];
};

export type PrecheckInput = {
  /** RAW, exactly as `readDeviceId` returned it. The reliability gate is
   *  applied HERE, so no caller can key the lookup on the shared sink. */
  deviceId: string;
  /** iOS `identifierForVendor` — the leg that survives an app reinstall. */
  idfv?: string;
  /** Parsed fingerprint signals (desktop) — the leg that survives a wipe. */
  signals?: Signal[];
  env: TestRowGate;
  now?: Date;
};

/**
 * Exactly the columns `subscriptionGrants` reads — the full `SubscriptionLike`
 * select, spelled out because a missing column silently disables a security
 * rule (see the type's own comment in lib/subscription.ts).
 */
const SUBSCRIPTION_GRANT_SELECT = {
  status: true,
  validUntil: true,
  provider: true,
  variantId: true,
  pauseMode: true,
  trialEndsAt: true,
  trialCancelledAt: true,
  providerUpdatedAt: true,
  createdAt: true,
} as const;

export async function findPayingAccountForDevice(input: PrecheckInput): Promise<PrecheckResult> {
  const now = input.now ?? new Date();
  const deviceId = isReliableDeviceId(input.deviceId) ? input.deviceId.trim() : "";
  const idfv = input.idfv?.trim() ?? "";
  const signals = input.signals ?? [];

  // Nothing usable to key on → fail open. An unidentifiable machine gets the
  // ordinary signup flow, never a refusal built on a shared sink value.
  if (!deviceId && !idfv && signals.length === 0) {
    return { deviceKnown: false, payingAccount: null };
  }

  // The device leg first: live Device rows, most recently seen first, so the
  // account actually using this phone outranks one that touched it years ago.
  // `take: 5` bounds the walk — a device id shared that widely is closer to a
  // sink than an identity, and five accounts is already a support case.
  const candidates: string[] = [];
  let deviceKnown = false;
  if (deviceId) {
    const rows = await prisma.device.findMany({
      where: { deviceId },
      orderBy: { lastSeenAt: "desc" },
      take: 5,
      select: { userId: true },
    });
    deviceKnown = rows.length > 0;
    for (const row of rows) {
      if (!candidates.includes(row.userId)) candidates.push(row.userId);
    }
  }

  // Fallback legs, consulted only when the Device rows named nobody — the same
  // order and discipline as the trial ledger: idfv (survives a reinstall),
  // then the hardware fingerprint (survives a wipe). Oldest claim first, and a
  // claim whose owner is gone contributes nothing (the ledger nulls
  // `firstUserId` on deletion precisely so the machine is not bricked).
  if (candidates.length === 0 && idfv) {
    const claim = await prisma.trialClaim.findFirst({
      where: { idfvHash: ledgerHash(idfv) },
      orderBy: { createdAt: "asc" },
      select: { firstUserId: true },
    });
    if (claim?.firstUserId) candidates.push(claim.firstUserId);
  }
  if (candidates.length === 0 && signals.length > 0) {
    const claimId = await matchClaimByFingerprint(signals);
    if (claimId) {
      const claim = await prisma.trialClaim.findUnique({
        where: { id: claimId },
        select: { firstUserId: true },
      });
      if (claim?.firstUserId) candidates.push(claim.firstUserId);
    }
  }

  // First paying candidate wins, in recency order. Candidates whose User row
  // no longer exists are skipped, not errors: a stale claim pointing at a
  // deleted account is exactly the N13 state this must heal through.
  for (const userId of candidates) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, passwordHash: true },
    });
    if (!user) continue;

    const [lifetime, subs] = await Promise.all([
      // A refunded purchase is not ownership — and test rows stop existing the
      // moment their provider's test mode is shut, the same gate every other
      // billing read applies.
      prisma.purchase.findFirst({
        where: { userId, isRefunded: false, ...hideTestRowsFor(userId, input.env) },
        select: { id: true, provider: true },
      }),
      prisma.subscription.findMany({
        where: { userId, ...hideTestRowsFor(userId, input.env) },
        select: SUBSCRIPTION_GRANT_SELECT,
        orderBy: { updatedAt: "desc" },
      }),
    ]);
    const grantingSub = subs.find((sub) => subscriptionGrants(sub, now)) ?? null;

    // No real money on this candidate. A comp (`compActive`) is DELIBERATELY
    // not consulted: it is not the customer's money, so it must not block a
    // signup — see the module comment.
    if (!lifetime && !grantingSub) continue;

    // Whose store bills them: the lifetime's provider first (a lifetime
    // outranks any subscription, mirroring the resolver), else the granting
    // subscription's — where an unrecognised provider reads as LEMON_SQUEEZY,
    // the same default `SubscriptionLike` documents for pre-column rows.
    const billingProvider: BillingProvider =
      (lifetime ? billingProviderFor(lifetime.provider) : null) ??
      (grantingSub ? (billingProviderFor(grantingSub.provider) ?? "LEMON_SQUEEZY") : null) ??
      "NONE";

    // How they can sign back in. "password" comes from the passwordHash, not
    // from an AuthProvider row: registration never writes one for the password
    // method (see routes/auth.ts), so the hash IS the record. AuthProvider
    // rows carry the social methods.
    const providers = await prisma.authProvider.findMany({
      where: { userId },
      select: { provider: true },
    });
    const loginMethods: LoginMethod[] = [];
    if (user.passwordHash || providers.some((p) => p.provider === "password")) {
      loginMethods.push("password");
    }
    if (providers.some((p) => p.provider === "apple")) loginMethods.push("apple");

    return {
      deviceKnown,
      payingAccount: {
        userId: user.id,
        email: user.email,
        billingProvider,
        loginMethods,
      },
    };
  }

  return { deviceKnown, payingAccount: null };
}
