import { createHmac } from "node:crypto";
import dotenv from "dotenv";

dotenv.config();

const nodeEnv = process.env.NODE_ENV ?? "development";
const isProduction = nodeEnv === "production";

/**
 * Read an env var. In **production** a missing/empty value is fatal — we never
 * fall back to a public placeholder, because a localhost `DATABASE_URL` would
 * silently break every query. In dev/test the fallback keeps zero-config local
 * runs (and the test suite) working.
 */
function required(name: string, devFallback?: string): string {
  const value = process.env[name];
  if (value !== undefined && value !== "") return value;
  if (isProduction || devFallback === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return devFallback;
}

/**
 * Like `required`, but in production also refuses the insecure placeholder value.
 * A `change-me` JWT secret in prod would let anyone forge a valid token, so we
 * fail the boot closed instead of running with a guessable signing key.
 */
function requiredSecret(name: string, devFallback: string): string {
  const value = required(name, devFallback);
  if (isProduction && value === devFallback) {
    throw new Error(
      `${name} must be set to a real secret in production (not the "${devFallback}" placeholder)`,
    );
  }
  return value;
}

const jwtSecret = requiredSecret("JWT_SECRET", "change-me");

/**
 * The server-only key behind the TrialClaim ledger's device hashes.
 *
 * Deliberately NOT `required()`. Every claim in the ledger is keyed with this
 * value, so a deploy that boots without it would be bad — but a deploy that
 * refuses to boot at all is worse, and this key is needed by exactly one feature
 * on a backend that also runs focus sessions, notifications and blocking. So an
 * unset pepper is DERIVED from the JWT secret rather than fatal: domain-separated
 * so it is never literally the signing key, and always present because
 * `JWT_SECRET` already fails the boot closed in production.
 *
 * Set an explicit one anyway. The derived value is tied to `JWT_SECRET`, so
 * rotating that — a thing you would otherwise do freely — silently orphans every
 * claim and re-opens the trial farm. An explicit pepper decouples the two.
 */
function resolveTrialPepper(): string {
  const explicit = process.env.TRIAL_LEDGER_PEPPER;
  if (explicit) return explicit;
  if (isProduction) {
    console.warn(
      "[env] TRIAL_LEDGER_PEPPER is not set — deriving one from JWT_SECRET. " +
        "Rotating JWT_SECRET will orphan every TrialClaim and re-open the trial farm.",
    );
  }
  return createHmac("sha256", jwtSecret).update("welockin/trial-ledger-pepper/v1").digest("hex");
}

/**
 * The server-only key behind emailed verification codes and reset tokens.
 *
 * Same derive-don't-die posture as the trial pepper above, but read the warning
 * differently: rotating THIS one is harmless. It only invalidates the codes and
 * links currently in flight, which expire in minutes anyway — nobody loses an
 * entitlement over it. That is precisely why it must not share the ledger's
 * pepper, whose rotation is a data-loss event.
 */
function resolveAuthPepper(): string {
  const explicit = process.env.AUTH_TOKEN_PEPPER;
  if (explicit) return explicit;
  return createHmac("sha256", jwtSecret).update("welockin/auth-token-pepper/v1").digest("hex");
}

/**
 * Strip trailing slashes so callers can concatenate a path without minting a
 * `//` that some proxies redirect and some do not.
 */
function resolvePublicSiteUrl(): string {
  return (process.env.PUBLIC_SITE_URL ?? "https://www.welock.in").replace(/\/+$/, "");
}

/**
 * A whole number from the environment, with a default that actually applies.
 *
 * `Number.parseInt(process.env.X ?? "60", 10)` looks safe and is not: `??` only
 * catches null and undefined, while a hosting dashboard hands back an EMPTY
 * STRING for a variable someone created and left blank — which is a normal
 * accident when pasting a block of names. `parseInt("")` is NaN, and a NaN
 * minute count becomes an Invalid Date that either throws deep inside the
 * database driver or, worse, is stored and silently never compares true.
 */
export function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) {
    console.warn(`[env] ${name}="${raw}" is not a number — using ${fallback}`);
    return fallback;
  }
  return n;
}

export const env = {
  port: intFromEnv("PORT", 8787),
  databaseUrl: required("DATABASE_URL", "mongodb://localhost:27017/welockin"),
  jwtSecret,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? "30d",
  corsOrigin: process.env.CORS_ORIGIN ?? "*",
  nodeEnv,
  // Sign in with Apple: the `aud` claim the client's identityToken must carry
  // (your iOS app bundle id). Defaults to the WeLockIn bundle id.
  appleBundleId: process.env.APPLE_BUNDLE_ID ?? "in.welock.app",

  // --- Device identity / anti-abuse (Part D) ---
  // App Attest hard-enforcement on counter-crediting routes (focus-events,
  // breaks). Default OFF: turn on only once the native attestation client ships
  // and is device-tested, otherwise all focus reporting would be rejected.
  attestRequired: (process.env.ATTEST_REQUIRED ?? "false") === "true",
  // App Attest environment the client attests against. TestFlight/dev builds use
  // "development"; App Store builds "production". Verifying against the wrong root
  // rejects 100% of assertions.
  appAttestEnv: process.env.APP_ATTEST_ENV ?? "production",
  // App Attest app identifier = "<TeamID>.<BundleID>".
  appAttestAppId: process.env.APP_ATTEST_APP_ID ?? "YF7AFPJRYH.in.welock.app",
  /**
   * Which StoreKit environment a purchase must come from: "Production" or "Sandbox".
   *
   * A Sandbox transaction is signed by the SAME Apple chain as a real one, carries
   * the real bundle id and the real product id — and costs nothing. Every check
   * that existed before this one passes on it, so without this comparison the
   * purchase route was a free lifetime-licence tap, reachable with curl from any
   * platform. Apple puts the answer in the payload; we simply have to read it.
   */
  appleEnvironment: process.env.APPLE_ENVIRONMENT ?? "Production",
  /**
   * May Apple purchases be RECORDED at all?
   *
   * OFF until an iOS build ships. See lib/purchase-providers.ts — a door nobody
   * uses should not be open, and while there is no iOS client every request to
   * that route is either a mistake or an attempt.
   *
   * Requires the literal "true", like every other switch here that guards money:
   * anything inferred from an unset value fails open on more machines than
   * anyone expects.
   */
  applePurchasesEnabled: process.env.APPLE_PURCHASES_ENABLED === "true",
  /**
   * Ed25519 private key that signs entitlement receipts (PEM, or that PEM
   * base64-encoded). See lib/entitlement-receipt.ts.
   *
   * Empty is a legitimate state: no key means no receipts, and clients fall back
   * to the unsigned view they already read. That is what lets this ship before
   * every client understands it.
   *
   * Treat it like the updater key. Losing it does not lose data, but every
   * receipt in the field stops verifying the moment you replace it, so each
   * machine is locked until it can next reach the server.
   */
  entitlementSigningKey: process.env.ENTITLEMENT_SIGNING_KEY ?? "",

  // --- Admin console (POST /api/admin/login) ---
  // Credentials checked by the admin API. Set these in the backend's environment
  // / .env — NOT in the admin web app. Admin login is DISABLED when adminPassword
  // is empty (no blank-password admin in prod).
  adminUsername: process.env.ADMIN_USERNAME ?? "admin",
  adminPassword: process.env.ADMIN_PASSWORD ?? "",
  // Separate signing secret for admin tokens so a leaked user JWT can never be a
  // valid admin token (and vice-versa). Falls back to the (prod-validated)
  // jwtSecret when unset.
  adminJwtSecret: process.env.ADMIN_JWT_SECRET ?? jwtSecret,
  adminJwtExpiresIn: process.env.ADMIN_JWT_EXPIRES_IN ?? "12h",
  // A live session with no heartbeat for longer than this is considered ended
  // (client crashed/offline). Default = 2 missed 5-min beats + grace.
  liveSessionStaleSeconds: intFromEnv("LIVE_SESSION_STALE_SECONDS", 660),

  // --- Resend (transactional email — addiction-protection partner OTP) ---
  // API key from resend.com. Email sending is DISABLED (no-op, logged) while empty.
  resendApiKey: process.env.RESEND_API_KEY ?? "",
  // Verified sender. Must be on a domain verified in your Resend account.
  resendFrom: process.env.RESEND_FROM ?? "WeLockin <protection@welock.in>",

  // --- Expo push notifications ---
  // Optional Expo access token (recommended for enhanced security + higher rate
  // limits). Sends still work without it via the open Expo Push API.
  expoAccessToken: process.env.EXPO_ACCESS_TOKEN ?? "",
  // Lemon Squeezy — the DESKTOP purchase path (macOS + Windows, shipped outside
  // the App Store, so no store IAP is imposed and none is possible). iOS keeps
  // going through Adapty because Apple requires it there. Both land in the same
  // Purchase table, told apart by `provider`.
  // LEMON_API_KEY is an alias, not a typo to clean up: it is the name the
  // production dashboard has carried since the first integration, and code
  // accepting both costs one line where a dashboard rename costs an outage
  // window and a human remembering to do it. Canonical name first.
  lemonSqueezyApiKey: process.env.LEMONSQUEEZY_API_KEY ?? process.env.LEMON_API_KEY ?? "",
  lemonSqueezyWebhookSecret: process.env.LEMONSQUEEZY_WEBHOOK_SECRET ?? "",
  lemonSqueezyStoreId: process.env.LEMONSQUEEZY_STORE_ID ?? "",
  /**
   * The LIFETIME variant — a one-off order.
   *
   * Kept under its original name because the webhook's `isSellableOrder` already
   * checks orders against it, and orders are still exactly one product. Unset
   * means SELL NOTHING, never sell everything.
   */
  // VARIANT_LIFETIME is frankly the better name (it says WHICH variant, where
  // _ID says nothing) and it is what production carries; _ID stays canonical
  // only because it shipped first in .env.example and in the boot checks.
  lemonSqueezyVariantId:
    process.env.LEMONSQUEEZY_VARIANT_ID ?? process.env.LEMONSQUEEZY_VARIANT_LIFETIME ?? "",
  /**
   * The two SUBSCRIPTION variants.
   *
   * Used only to label a row "monthly" or "yearly" for humans — never to decide
   * whether a subscription grants, which is `subscriptionGrants`'s job and reads
   * the status. So an unrecognised variant degrades to an unlabelled row rather
   * than to a refused customer: the day a price changes, someone paying us must
   * not lose access because the id in the environment is one release behind.
   */
  lemonSqueezyVariantMonthly: process.env.LEMONSQUEEZY_VARIANT_MONTHLY ?? "",
  lemonSqueezyVariantYearly: process.env.LEMONSQUEEZY_VARIANT_YEARLY ?? "",
  lemonSqueezyApiBase: process.env.LEMONSQUEEZY_API_BASE ?? "https://api.lemonsqueezy.com",
  /**
   * May a TEST-mode order grant a real lifetime licence?
   *
   * Requires the literal string "true" — deliberately NOT inferred from NODE_ENV,
   * which is unset on more machines than anyone expects, and every one of those
   * would have failed OPEN into a free-licence tap.
   */
  lemonSqueezyAllowTestMode: process.env.LEMONSQUEEZY_ALLOW_TEST_MODE === "true",

  /**
   * May the client HARD-GATE on the entitlement status it is told?
   *
   * The server ALWAYS reports the true status; this only says whether the client
   * may act on it yet. It exists because the day the paywall ships, every account
   * whose trial quietly elapsed months ago turns `expired` at once — gating on
   * status alone would lock all of them out in a single update, with no way to
   * stage it. Flip this only after `npm run entitlement:migrate` has given the
   * existing cohort a comp runway.
   *
   * Echoed by GET /api/entitlement and by nothing else: it must never change what
   * the resolver computes, only what the client is allowed to do about it.
   */
  entitlementEnforced: (process.env.ENTITLEMENT_ENFORCED ?? "false") === "true",

  // --- The trial ledger (one free trial per machine) -------------------------
  /** Server-only HMAC key for `TrialClaim.deviceIdHash`. See resolveTrialPepper. */
  trialLedgerPepper: resolveTrialPepper(),
  /**
   * How long a full trial lasts. Snapshotted onto each claim, so changing this
   * never moves the end date of a window someone is already inside.
   */
  /**
   * May SIGNING UP still mint a free cardless trial?
   *
   * FALSE by default, because the product now sells a card-backed trial chosen
   * at a paywall (3 days monthly / 7 days yearly, via Lemon Squeezy). A machine
   * that also received 14 free days on signup would never have to choose one,
   * which makes the paywall decorative.
   *
   * Only MINTING is switched off. `computeEntitlement` still honours a claim
   * that already exists, so nobody mid-trial loses the days they were promised
   * — they meet the paywall when their window ends, like everyone else.
   *
   * Set "true" to bring the cardless trial back without a code change.
   */
  signupTrialEnabled: (process.env.SIGNUP_TRIAL_ENABLED ?? "false") === "true",
  trialDays: intFromEnv("TRIAL_DAYS", 14),
  /**
   * The shorter window given to a machine whose identity is resettable — a Mac
   * whose `IOPlatformUUID` could not be read, so the client fell back to a file
   * the user can delete. Without this, "make ioreg unreadable" is the bypass.
   */
  trialDaysUnverified: intFromEnv("TRIAL_DAYS_UNVERIFIED", 3),

  // --- Email verification + password reset -----------------------------------
  /** Server-only HMAC key for emailed codes/tokens. See resolveAuthPepper. */
  authTokenPepper: resolveAuthPepper(),
  /**
   * Base URL of the marketing site, used to build the emailed reset link.
   *
   * NEVER derive this from `req.headers.host`. Behind any permissive proxy that
   * header is attacker-controlled, and a reset link is exactly the payload you
   * do not want pointed at a host of someone else's choosing.
   *
   * Note the `www`: the apex 308-redirects to it, and a redirect in the middle
   * of a link people click from a mail client is a needless place to lose them.
   */
  publicSiteUrl: resolvePublicSiteUrl(),
  emailVerificationTtlMinutes: intFromEnv("EMAIL_VERIFICATION_TTL_MINUTES", 10),
  emailVerificationMaxAttempts: intFromEnv("EMAIL_VERIFICATION_MAX_ATTEMPTS", 5),
  passwordResetTtlMinutes: intFromEnv("PASSWORD_RESET_TTL_MINUTES", 60),
  /**
   * May the API refuse an unverified account?
   *
   * OFF by default, and the reason is the same shape as `entitlementEnforced`:
   * every account that predates this feature reads `emailVerified` false or
   * null, so flipping it without first backfilling that cohort locks out the
   * entire existing user base at once — none of whom have a code in hand.
   *
   * The order is: ship the verification flow → run `npm run auth:migrate` (which
   * grandfathers existing accounts) → make sure EVERY client (Windows, macOS,
   * mobile) can render the code screen in response to a 403 EMAIL_NOT_VERIFIED →
   * only then turn this on. A client that cannot handle the 403 is a client
   * whose users simply see an error they cannot act on.
   */
  emailVerificationEnforced: (process.env.EMAIL_VERIFICATION_ENFORCED ?? "false") === "true",
  /**
   * May registration be REFUSED because this machine already belongs to another
   * account?
   *
   * Independent of the anti-farm guarantee, which needs no flag: a second
   * account on a claimed machine shares the existing claim and therefore gets no
   * second trial whatever this is set to. This only controls the hard 409, whose
   * false positives are real people — a shared family PC, a resold laptop, a
   * lab machine — and which therefore needs an off switch that works in thirty
   * seconds without a deploy.
   */
  deviceBindingEnforced: (process.env.DEVICE_BINDING_ENFORCED ?? "false") === "true",
  /**
   * Turn off auth rate limiting. TESTS ONLY.
   *
   * Requires the literal string "true" for the same reason
   * `lemonSqueezyAllowTestMode` does: anything inferred from an unset NODE_ENV
   * fails open on more machines than anyone expects.
   */
  authRateLimitDisabled: process.env.AUTH_RATE_LIMIT_DISABLED === "true",
};

export type PaymentConfigVerdict = {
  /** Half-configured: the storefront is unusable and must be treated as OFF. */
  degraded: boolean;
  /** Enforcement was asked for with nothing to buy, and has been forced off. */
  enforcementSuppressed: boolean;
  /** Human-readable, in the order an operator should fix them. */
  problems: string[];
};

/**
 * Decide whether this deploy may sell anything, and say so out loud.
 *
 * Payments are optional on purpose: a deploy with none of these set simply cannot
 * sell, and that is a legitimate state — a self-hosted or pre-launch instance.
 *
 * The dangerous state is a PARTIAL config, because it fails toward lost money
 * rather than lost function: with an api key but no webhook secret, `POST
 * /api/checkout` mints a real payment page and every delivery that comes back is
 * rejected as unsigned, so the customer is charged and no licence is ever
 * granted. Nothing downstream can recover that.
 *
 * The answer is to DEGRADE, not to die. An earlier version of this threw at boot,
 * which was the wrong shape of safe: the storefront is one feature among many,
 * and taking focus sessions, notifications and blocking down to protect a sale
 * that has not happened yet trades a real outage for a hypothetical refund. Off
 * is already safe — an unusable storefront that refuses to open a checkout takes
 * no money, so there is nothing to lose. So a half-configured storefront is
 * switched off and shouted about, and only a dev/test run throws, where the
 * throw costs nothing and is seen immediately.
 *
 * Pure, so the rule can be tested without spawning a process to watch a
 * module-load throw.
 */
export function checkPaymentConfig(input: {
  lemonSqueezyApiKey: string;
  lemonSqueezyWebhookSecret: string;
  lemonSqueezyStoreId: string;
  lemonSqueezyVariantId: string;
  entitlementEnforced: boolean;
}): PaymentConfigVerdict {
  const required = {
    LEMONSQUEEZY_API_KEY: input.lemonSqueezyApiKey,
    LEMONSQUEEZY_WEBHOOK_SECRET: input.lemonSqueezyWebhookSecret,
    LEMONSQUEEZY_STORE_ID: input.lemonSqueezyStoreId,
    LEMONSQUEEZY_VARIANT_ID: input.lemonSqueezyVariantId,
  };
  const names = Object.keys(required) as (keyof typeof required)[];
  const missing = names.filter((n) => !required[n]);
  const configured = missing.length === 0;
  const degraded = missing.length > 0 && missing.length < names.length;

  const problems: string[] = [];
  if (degraded) {
    problems.push(
      `Lemon Squeezy is half-configured, so purchasing is DISABLED — set all of it or none of it. Missing: ${missing.join(", ")}`,
    );
  }

  // A paywall nobody can pay through is worse than no paywall: it locks out every
  // expired account with no way out. So enforcement is dropped rather than the
  // storefront being pretended into existence.
  const enforcementSuppressed = input.entitlementEnforced && !configured;
  if (enforcementSuppressed) {
    problems.push(
      "ENTITLEMENT_ENFORCED is on with no usable storefront, so it has been forced OFF — a paywall with no way to buy would lock out every expired account",
    );
  }

  return { degraded, enforcementSuppressed, problems };
}

export const paymentConfig = checkPaymentConfig(env);

/**
 * The two ids the hard config check does NOT cover.
 *
 * `checkPaymentConfig` guards the four values a deploy cannot sell without at
 * all, and the subscription variants cannot join that set: a lifetime-only
 * deploy is legitimate and must not be degraded for lacking them. But silence
 * is the wrong default when a key IS configured — a blank or stale
 * subscription id is exactly the shape of the test/live graph swap, and its
 * only symptom is one plan answering 400 while the others sell.
 */
if (process.env.LEMONSQUEEZY_API_KEY || process.env.LEMON_API_KEY) {
  const missingPlans = [
    ["LEMONSQUEEZY_VARIANT_MONTHLY", process.env.LEMONSQUEEZY_VARIANT_MONTHLY],
    ["LEMONSQUEEZY_VARIANT_YEARLY", process.env.LEMONSQUEEZY_VARIANT_YEARLY],
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missingPlans.length > 0) {
    console.warn(
      `[env] Lemon Squeezy is configured but ${missingPlans.join(" and ")} ` +
        `${missingPlans.length > 1 ? "are" : "is"} empty — those plans will answer 400.`,
    );
  }
}

// A half-configured storefront is not a storefront. Blanking the keys is how that
// is said to the rest of the process: `POST /api/checkout` already refuses
// without them (400, logged), and `verifyWebhookSignature` already fails closed.
// One decision here beats four `if configured` checks scattered downstream.
if (paymentConfig.degraded) {
  env.lemonSqueezyApiKey = "";
  env.lemonSqueezyWebhookSecret = "";
  env.lemonSqueezyStoreId = "";
  env.lemonSqueezyVariantId = "";
}
if (paymentConfig.enforcementSuppressed) {
  env.entitlementEnforced = false;
}

for (const problem of paymentConfig.problems) console.error(`[env] ${problem}`);

// In dev and CI a misconfiguration should stop the run, because there it costs a
// restart rather than an outage — and being told at boot is the entire point.
if (paymentConfig.problems.length > 0 && !isProduction) {
  throw new Error(paymentConfig.problems.join(" / "));
}
