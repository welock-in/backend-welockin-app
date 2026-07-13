import dotenv from "dotenv";

dotenv.config();

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const env = {
  port: Number.parseInt(process.env.PORT ?? "8787", 10),
  databaseUrl: required("DATABASE_URL", "mongodb://localhost:27017/welockin"),
  jwtSecret: required("JWT_SECRET", "change-me"),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? "30d",
  corsOrigin: process.env.CORS_ORIGIN ?? "*",
  nodeEnv: process.env.NODE_ENV ?? "development",
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
  // valid admin token (and vice-versa). Falls back to jwtSecret for convenience.
  adminJwtSecret: process.env.ADMIN_JWT_SECRET ?? process.env.JWT_SECRET ?? "change-me",
  adminJwtExpiresIn: process.env.ADMIN_JWT_EXPIRES_IN ?? "12h",
  // A live session with no heartbeat for longer than this is considered ended
  // (client crashed/offline). Default = 2 missed 5-min beats + grace.
  liveSessionStaleSeconds: Number.parseInt(process.env.LIVE_SESSION_STALE_SECONDS ?? "660", 10),
};

export type Env = typeof env;
