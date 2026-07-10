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
};

export type Env = typeof env;
