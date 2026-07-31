import { createHmac } from "node:crypto";
import { env } from "./env";

/**
 * The keyed one-way hash behind the TrialClaim ledger.
 *
 * KEYED, not a plain digest, and the distinction is the whole point. A trial
 * anchor is a low-entropy value in a known format — a macOS `IOPlatformUUID` is
 * 36 characters from a fixed alphabet — so a plain SHA-256 of it is not a
 * one-way function in practice, it is a lookup table. Anyone holding a database
 * copy could enumerate candidate ids and walk the ledger back to the machines it
 * describes. HMAC with a server-only pepper removes that: without the key there
 * is nothing to enumerate against.
 *
 * The pepper therefore lives in the environment and never in Mongo, and this is
 * deliberately NOT `deterministicObjectId()`, which is an unkeyed SHA-256
 * truncated to 96 bits — fine for minting a stable primary key from data that is
 * already public, useless for this.
 *
 * The version prefix is a rotation seam: bump `v1` and every existing claim is
 * orphaned, which is a thing you may one day need to do on purpose and must
 * never do by accident.
 */
export function ledgerHash(raw: string): string {
  return createHmac("sha256", env.trialLedgerPepper).update(`trial:v1:${raw}`).digest("hex");
}
