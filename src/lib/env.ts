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
  // Hours a phone must wait between takeovers of the single active-phone slot.
  rebindCooldownHours: Number.parseInt(process.env.REBIND_COOLDOWN_HOURS ?? "12", 10),
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
};
