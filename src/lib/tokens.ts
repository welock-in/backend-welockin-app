import { createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { env } from "./env";

/**
 * Secrets that travel by email: the 6-digit verification code and the
 * password-reset token.
 *
 * Both are KEYED-hashed at rest, for the same reason `ledgerHash` is (see
 * lib/hash.ts) but with a sharper edge here: a verification code carries about
 * twenty bits. An unkeyed SHA-256 of a six-digit number is not a one-way
 * function, it is a one-million-row lookup table anyone with a database copy can
 * build in a second. HMAC with a server-only pepper removes the thing there is
 * to look up.
 *
 * This deliberately does NOT reuse the trial ledger's pepper. That one is
 * effectively permanent — rotating it orphans every claim and re-opens the trial
 * farm — whereas rotating this one costs nothing but the codes currently in
 * flight. Tying them together would make the harmless rotation impossible.
 *
 * Note the contrast with the addiction-protection partner OTP, which is stored
 * in PLAINTEXT and shown to admins on purpose: that code is social friction, and
 * an admin reading it is a feature. These decide whether an email address is
 * real and whether a password can be replaced, so they are credentials.
 */

/** Domain separator, and a rotation seam if one of these ever needs orphaning. */
const CODE_DOMAIN = "auth-code:v1";
const RESET_DOMAIN = "auth-reset:v1";

function keyedHash(domain: string, raw: string): string {
  return createHmac("sha256", env.authTokenPepper).update(`${domain}:${raw}`).digest("hex");
}

/**
 * A 6-digit code, CSPRNG. `randomInt` over the whole range then zero-padding —
 * NOT six independent digits, and not `Math.random()`.
 */
export function generateCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

/**
 * The reset token that goes in the emailed link. 32 random bytes, base64url so
 * it survives a URL untouched — no percent-encoding for a mail client to mangle
 * and no ambiguity about whether a trailing `=` was part of it.
 */
export function generateResetToken(): string {
  return randomBytes(32).toString("base64url");
}

export const hashCode = (code: string): string => keyedHash(CODE_DOMAIN, code);
export const hashResetToken = (token: string): string => keyedHash(RESET_DOMAIN, token);

/**
 * Constant-time compare of two hex digests.
 *
 * The stored value is always a 64-char hex digest and so is the candidate, so
 * the length check below never leaks anything an attacker did not already know.
 * `timingSafeEqual` throws on a length mismatch, hence the guard.
 */
export function safeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return timingSafeEqual(bufA, bufB);
}
