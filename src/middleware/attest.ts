import type { NextFunction, Request, Response } from "express";
import { env } from "../lib/env";
import { attestVerifierReady } from "../lib/attest";
import { HttpError } from "../lib/http-error";

/**
 * App Attest enforcement hook for counter-crediting routes (focus-events, breaks).
 * Placed AFTER requireBoundDevice so req.device is available.
 *
 *   - ATTEST_REQUIRED off (default) → pass. Counters are then binding-protected
 *     (a different phone is blocked) but forgeable by the account owner — this is
 *     the honest "vanity counter" posture until attestation is wired.
 *   - ATTEST_REQUIRED on but verifier not wired → 501 (fail closed, never a false
 *     sense of security).
 *   - ATTEST_REQUIRED on and wired → verify assertion (TODO: signature + counter).
 */
export function requireAttest(req: Request, _res: Response, next: NextFunction): void {
  if (!env.attestRequired) return next();
  if (!attestVerifierReady()) {
    next(new HttpError(501, "App Attest enforcement is enabled but not configured"));
    return;
  }
  // Once attestVerifierReady() returns true, verify the X-WeLockIn-Attest header
  // here (challenge + signature + strictly-increasing counter against
  // req.device.attestCounter) and persist the new counter.
  next();
}
