import { Prisma, type TrialClaim } from "@prisma/client";
import { prisma } from "./prisma";
import { env } from "./env";
import { ledgerHash } from "./hash";
import { matchClaimByFingerprint, recordSignals, type Signal } from "./fingerprint";

/**
 * The trial ledger: one free window per MACHINE, and it outlives the account.
 *
 * Registration used to stamp `User.trialEndsAt`, which made a trial exactly as
 * cheap as an email address — and `DELETE /api/me` frees the address again, so
 * even the same one could go round forever. The anchor moved to something that
 * costs money to duplicate.
 *
 * Everything here is CREATE-ONLY. Nothing in this module can move an `endsAt`,
 * extend a window or reset a claim; the only way back is the admin surface, with
 * a reason and an audit row, because the legitimate cases (a replaced logic
 * board, a resold Mac) need a human and the illegitimate ones are the point.
 */

/** Beyond this, the client's clock is recorded as an abuse signal. */
export const CLOCK_SKEW_THRESHOLD_MS = 5 * 60 * 1000;

const isDuplicateKey = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";

/**
 * The claim governing this caller, or null.
 *
 * Oldest-first on purpose. If a machine ends up correlated with two rows, the
 * ORIGINAL decides — otherwise accumulating identities would be a way to
 * accumulate trials, which is the exact thing being prevented.
 *
 * The account leg (`firstUserId`) matters in the opposite direction from the
 * device leg: it is what lets someone's SECOND Mac see the window they are
 * already inside instead of being handed a fresh one.
 */
export function findClaim(
  deviceIdHash: string | null,
  userId: string,
  idfvHash?: string | null,
): Promise<TrialClaim | null> {
  const or: Prisma.TrialClaimWhereInput[] = [{ firstUserId: userId }];
  if (deviceIdHash) or.push({ deviceIdHash });
  if (idfvHash) or.push({ idfvHash });
  return prisma.trialClaim.findFirst({ where: { OR: or }, orderBy: { createdAt: "asc" } });
}

export type ClaimOptions = {
  idfv?: string;
  /**
   * Did the client's device id come from the hardware, or from a file it can
   * delete? Self-reported, so it is only ever used to make a claim WEAKER — a
   * short, flagged window — never stronger.
   *
   * `undefined` means "not stated", which is NOT the same as `false`: an older
   * client that has never heard of this field must keep getting a normal trial,
   * or shipping the ledger would silently cut everyone to three days. Only an
   * explicit `false` — a client that looked and failed — is treated as unproven.
   */
  hardwareBacked?: boolean;
  /** The client's own clock. Recorded as a signal, never used for timing. */
  clientTime?: Date;
  /**
   * Composite hardware signals (desktop only — see lib/fingerprint.ts).
   *
   * A FOURTH way to recognise a machine, consulted only after the account and
   * device-id legs come up empty. It exists because the device id is a value
   * the client stores and can therefore reset: wipe it and the ledger sees a
   * new machine. The MachineGuid and volume serial do not move when app data
   * does, so they close that gap.
   *
   * Recorded on every claim, matched or fresh, so a machine stays recognisable
   * as its hardware changes around it.
   */
  signals?: Signal[];
};

/**
 * Claim the trial for this machine, or return the claim it already has.
 *
 * Idempotent, and never a reset: a caller that already has a window gets it back
 * elapsed or not. The check-then-act gap between the read and the write is closed
 * by the GLOBAL unique index on `deviceIdHash`, not by the read — two
 * simultaneous claims for one machine collide in the database rather than both
 * proceeding.
 */
export async function claimTrial(
  userId: string,
  deviceId: string,
  opts: ClaimOptions = {},
): Promise<TrialClaim | null> {
  const now = new Date();
  const deviceIdHash = ledgerHash(deviceId);
  const idfvHash = opts.idfv ? ledgerHash(opts.idfv) : null;

  const clockSkewMs = opts.clientTime ? opts.clientTime.getTime() - now.getTime() : undefined;
  const overSkew = clockSkewMs != null && Math.abs(clockSkewMs) > CLOCK_SKEW_THRESHOLD_MS;

  const signals = opts.signals ?? [];

  // The account and device-id legs first, then the hardware. Order matters: the
  // hardware match is the fallback for a device id that was reset, not a
  // replacement for the cheap lookups.
  let prior = await findClaim(deviceIdHash, userId, idfvHash);
  if (!prior && signals.length > 0) {
    const matchedId = await matchClaimByFingerprint(signals);
    if (matchedId) {
      prior = await prisma.trialClaim.findUnique({ where: { id: matchedId } });
    }
  }

  if (prior) {
    // Record BEFORE the early return below, so a claim recognised by one signal
    // learns the others — that is how a machine stays matchable after the one
    // signal that identified it changes.
    if (signals.length > 0) await recordSignals(prior.id, signals);
  }

  if (prior) {
    if (clockSkewMs == null) return prior;
    // A claim exists → startedAt / endsAt / trialDays are untouchable. Only the
    // abuse counters move, and only upward.
    return (
      (await prisma.trialClaim
        .update({
          where: { id: prior.id },
          data: {
            clockSkewMs,
            ...(overSkew ? { skewStrikes: { increment: 1 }, flagged: true } : {}),
          },
        })
        .catch(() => prior)) ?? prior
    );
  }

  // A machine that LOOKED for its hardware id and could not read it fell back to
  // a file the user can delete, so its identity is resettable. The full window
  // would make "break the hardware lookup" the bypass; it gets a short, flagged
  // one instead, and a support path if that turns out to be wrong.
  const unproven = opts.hardwareBacked === false;
  const days = unproven ? env.trialDaysUnverified : env.trialDays;

  try {
    const created = await prisma.trialClaim.create({
      data: {
        deviceIdHash,
        idfvHash,
        firstUserId: userId,
        trialDays: days,
        startedAt: now,
        endsAt: new Date(now.getTime() + days * 24 * 60 * 60 * 1000),
        status: "active",
        hardwareBacked: !unproven,
        flagged: unproven || overSkew,
        ...(clockSkewMs != null ? { clockSkewMs } : {}),
        ...(overSkew ? { skewStrikes: 1 } : {}),
      },
    });
    if (signals.length > 0) await recordSignals(created.id, signals);
    return created;
  } catch (err) {
    // Someone else claimed this machine first. NOT an error, and explicitly not a
    // reset: the winner's window stands, so read it back and return that.
    if (!isDuplicateKey(err)) throw err;
    const winner = await findClaim(deviceIdHash, userId, idfvHash);
    if (winner && signals.length > 0) await recordSignals(winner.id, signals);
    return winner;
  }
}

/**
 * Claim on the account-creation path, without ever failing the registration.
 *
 * Registration is the ONLY moment an existing client offers, because no shipped
 * app knows about `POST /api/entitlement/trial` yet. Leaving the claim to that
 * endpoint alone would mean every account created by a current build resolved
 * `expired` from its first second — the ledger has to arrive without breaking
 * the clients that predate it.
 *
 * `hardwareBacked` is deliberately not consulted here: registration carries no
 * such field, and inferring "unproven" from its absence would cut every new user
 * to a three-day trial. Unknown means the benefit of the doubt; the anchor is
 * still one window per machine either way.
 */
export async function claimTrialOnSignup(
  userId: string,
  deviceId: string,
  opts: ClaimOptions = {},
): Promise<void> {
  if (!deviceId) return;
  try {
    await claimTrial(userId, deviceId, opts);
  } catch (err) {
    // A ledger write that failed must never cost someone their account — they
    // would have no way to retry it, and the row they did get would be unusable.
    console.error("[trial] could not claim on signup:", err instanceof Error ? err.message : err);
  }
}
