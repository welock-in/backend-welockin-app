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

export const env = {
  port: Number.parseInt(process.env.PORT ?? "8787", 10),
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
  liveSessionStaleSeconds: Number.parseInt(process.env.LIVE_SESSION_STALE_SECONDS ?? "660", 10),

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
  lemonSqueezyApiKey: process.env.LEMONSQUEEZY_API_KEY ?? "",
  lemonSqueezyWebhookSecret: process.env.LEMONSQUEEZY_WEBHOOK_SECRET ?? "",
  lemonSqueezyStoreId: process.env.LEMONSQUEEZY_STORE_ID ?? "",
  /** The one variant we sell. Unset means SELL NOTHING, never sell everything. */
  lemonSqueezyVariantId: process.env.LEMONSQUEEZY_VARIANT_ID ?? "",
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

const paymentConfig = checkPaymentConfig(env);

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
