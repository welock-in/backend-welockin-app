import crypto from "node:crypto";
import jwt, { type JwtHeader, type JwtPayload } from "jsonwebtoken";
import { env } from "./env";
import { unauthorized } from "./http-error";

// Sign in with Apple identity-token verification.
//
// Apple signs the identityToken (RS256) with a rotating key published as a JWKS
// at https://appleid.apple.com/auth/keys. We fetch + cache those keys, pick the
// one matching the token's `kid`, build a public key with Node's crypto (JWK
// format is supported natively on Node 16+), then verify signature + iss + aud
// + exp. No extra dependency needed.

const APPLE_ISSUER = "https://appleid.apple.com";
const APPLE_KEYS_URL = "https://appleid.apple.com/auth/keys";
const KEY_TTL_MS = 60 * 60 * 1000; // refresh Apple's keys hourly

interface AppleJwk {
  kty: string;
  kid: string;
  use: string;
  alg: string;
  n: string;
  e: string;
}

let keyCache: { keys: AppleJwk[]; fetchedAt: number } | null = null;

async function getAppleKeys(forceRefresh = false): Promise<AppleJwk[]> {
  if (!forceRefresh && keyCache && Date.now() - keyCache.fetchedAt < KEY_TTL_MS) {
    return keyCache.keys;
  }
  const res = await fetch(APPLE_KEYS_URL);
  if (!res.ok) throw new Error(`Apple JWKS fetch failed: ${res.status}`);
  const body = (await res.json()) as { keys: AppleJwk[] };
  keyCache = { keys: body.keys, fetchedAt: Date.now() };
  return body.keys;
}

export interface AppleIdentity {
  sub: string; // stable Apple user id → providerUid
  email?: string;
  emailVerified?: boolean;
}

/** Only a verified claim from Apple's signed token may be used for account linking. */
export function getVerifiedAppleEmail(identity: AppleIdentity): string | null {
  return identity.email && identity.emailVerified === true ? identity.email : null;
}

/** Prevent pre-hijacking: only an already-verified account may be auto-linked. */
export function canAutoLinkAppleAccount(user: { emailVerified?: boolean | null }): boolean {
  return user.emailVerified === true;
}

/** Verify a Sign-in-with-Apple identityToken and return its verified claims. */
export async function verifyAppleIdentityToken(identityToken: string): Promise<AppleIdentity> {
  const decoded = jwt.decode(identityToken, { complete: true });
  if (!decoded || typeof decoded === "string") {
    throw unauthorized("Malformed Apple identity token");
  }
  const header = decoded.header as JwtHeader;

  let keys = await getAppleKeys();
  let jwk = keys.find((k) => k.kid === header.kid);
  // Apple may rotate signing keys before our one-hour cache expires. Refresh
  // once on an unknown kid so a warm serverless instance does not reject valid
  // sign-ins until the TTL elapses.
  if (!jwk) {
    keys = await getAppleKeys(true);
    jwk = keys.find((k) => k.kid === header.kid);
  }
  if (!jwk) throw unauthorized("Unknown Apple signing key");

  const publicKey = crypto.createPublicKey({
    key: jwk as unknown as crypto.JsonWebKey,
    format: "jwk",
  });

  let payload: JwtPayload;
  try {
    payload = jwt.verify(identityToken, publicKey, {
      algorithms: ["RS256"],
      issuer: APPLE_ISSUER,
      audience: env.appleBundleId,
    }) as JwtPayload;
  } catch {
    throw unauthorized("Invalid or expired Apple identity token");
  }

  const sub = payload.sub;
  if (typeof sub !== "string" || sub.length === 0) {
    throw unauthorized("Apple token missing subject");
  }
  const email = typeof payload.email === "string" ? payload.email.toLowerCase() : undefined;
  const emailVerified = payload.email_verified === true || payload.email_verified === "true";
  return { sub, email, emailVerified };
}
