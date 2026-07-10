import crypto from "crypto";
import { env } from "./env";

/* ─────────────────────────────────────────────────────────────
   App Attest helpers.

   SCOPE NOTE: this module ships the pieces that are safe to implement and test
   without a physical device — the anti-replay CHALLENGE (stateless, signed) and
   the strictly-increasing assertion COUNTER check. The cryptographic verification
   of the attestation object (Apple App Attest root cert chain, the nonce in the
   credCert extension 1.2.840.113635.100.8.2) and of each assertion signature
   (EC P-256 over SHA256(authenticatorData ‖ clientDataHash)) MUST be added with a
   vetted verifier (e.g. the `node-app-attest` package) and tested on a real device
   against Apple's servers BEFORE setting ATTEST_REQUIRED=true. Until then the
   enforcement hook fails closed (501) rather than pretend to be secure.
   ───────────────────────────────────────────────────────────── */

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

/** Issue a short-lived, stateless challenge: `nonce.exp.hmac`. */
export function issueChallenge(): string {
  const nonce = crypto.randomBytes(24).toString("base64url");
  const exp = Date.now() + CHALLENGE_TTL_MS;
  const payload = `${nonce}.${exp}`;
  const sig = crypto.createHmac("sha256", env.jwtSecret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

/** Validate a challenge issued by issueChallenge (HMAC + not expired). */
export function verifyChallenge(token: string): boolean {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [nonce, expStr, sig] = parts;
  const expected = crypto
    .createHmac("sha256", env.jwtSecret)
    .update(`${nonce}.${expStr}`)
    .digest("base64url");
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return false;
  const exp = Number(expStr);
  return Number.isFinite(exp) && Date.now() <= exp;
}

/** Reject an assertion whose counter is not strictly greater than the stored one. */
export function assertCounterIncreasing(prev: number | null | undefined, next: number): void {
  if (!Number.isInteger(next) || next <= (prev ?? 0)) {
    throw new Error("App Attest counter not strictly increasing (possible replay)");
  }
}

/** True when the App Attest verifier is fully wired (see scope note). */
export function attestVerifierReady(): boolean {
  // Flip to true only once attestation-object + assertion-signature verification
  // is implemented and device-tested.
  return false;
}

export { CHALLENGE_TTL_MS };
