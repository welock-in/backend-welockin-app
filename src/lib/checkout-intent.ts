/**
 * One payable acquisition per account, enforced by MongoDB.
 *
 * `POST /api/checkout` asks Lemon Squeezy for a hosted payment URL. It creates
 * no subscription and, before this file, reserved nothing — so two tabs, two
 * devices or two Vercel instances could each mint a URL, and a customer who paid
 * both ended up with two subscriptions. A `busy` flag on a button or a lock in
 * process memory cannot close that, because the two requests need not share a
 * process. The exclusion has to be a uniqueness constraint in the database.
 *
 * THE SHAPE. `AcquisitionLock` carries `@@unique([userId, scope])` and exists
 * only while a checkout is outstanding; `CheckoutIntent` is the history beside
 * it. Two documents rather than a partial unique index because Prisma's MongoDB
 * connector has none — see the schema comment.
 *
 * THE HARD PART IS NOT THE RACE, it is the ambiguous failure. A timeout does not
 * prove Lemon Squeezy failed to create the checkout: the request may have
 * arrived and the reply been lost. Releasing the lock on any error would hand
 * out a second payable link beside a first one that still works. So an intent
 * whose outcome we could not observe becomes `uncertain` and KEEPS its lock
 * until the link it may have created can no longer be paid.
 */
import crypto from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { isRetryableRaceError } from "./billing-tasks";

/**
 * The one scope today, covering all three plans together.
 *
 * Monthly, yearly and lifetime share it deliberately: holding a payable monthly
 * link AND a payable lifetime link at the same time is precisely the double
 * payment this exists to prevent, and a per-plan lock would allow it.
 */
export const ACQUISITION_SCOPE = "acquisition";

export type IntentState =
  | "reserved"
  | "ready"
  | "uncertain"
  | "completed"
  | "failed"
  | "expired";

/** States in which an intent still holds its lock. */
const HOLDING: readonly IntentState[] = ["reserved", "ready", "uncertain"];

/**
 * How long a minted link stays payable.
 *
 * Short, because the lock is a real constraint on the customer: while it is held
 * they cannot start a different plan. Long enough to actually pay — entering
 * card details, a 3-D Secure round trip, finding a wallet.
 *
 * THE LOCAL EXPIRY MUST NEVER PRECEDE THE PROVIDER'S. We send this same instant
 * to Lemon Squeezy as `expires_at` and store it with a margin on top, so the
 * window in which our row says "free" while the link is still payable does not
 * exist. Getting that backwards is a double payment, not a stale row.
 */
export const CHECKOUT_TTL_MS = 30 * 60_000;

/**
 * Safety margin added to what we told the provider, to absorb clock skew between
 * their servers and ours. Nothing about this needs to be tight; being late to
 * free the lock costs a customer a wait, being early costs them a double charge.
 */
export const EXPIRY_MARGIN_MS = 5 * 60_000;

/**
 * How long an intent we could not observe keeps the lock.
 *
 * The full link lifetime plus the margin, because the checkout we cannot see may
 * have been created at the instant the connection dropped. Nothing shorter is
 * honest: releasing earlier means a second link exists while the first is still
 * payable, which is the exact failure this module is about.
 */
export const UNCERTAIN_HOLD_MS = CHECKOUT_TTL_MS + EXPIRY_MARGIN_MS;

/** An unguessable public handle — never the row id, which is enumerable. */
function mintToken(): string {
  return crypto.randomBytes(24).toString("base64url");
}

export type IntentRow = {
  id: string;
  token: string;
  userId: string;
  plan: string;
  state: string;
  providerCheckoutId: string | null;
  checkoutUrl: string | null;
  expiresAt: Date;
  idempotencyKey: string;
};

export type ReserveOutcome =
  /** The caller owns the lock and must now create the checkout. */
  | { outcome: "reserved"; intent: IntentRow }
  /** An identical, still-valid link already exists — hand it back, call nothing. */
  | { outcome: "reused"; intent: IntentRow }
  /** Someone else's acquisition is in flight. */
  | { outcome: "busy"; intent: IntentRow }
  /** We do not know whether a link exists. Nothing may be created. */
  | { outcome: "uncertain"; intent: IntentRow };

const SELECT = {
  id: true,
  token: true,
  userId: true,
  plan: true,
  state: true,
  providerCheckoutId: true,
  checkoutUrl: true,
  expiresAt: true,
  idempotencyKey: true,
} as const;

/**
 * Has this key already been used for a DIFFERENT plan?
 *
 * Asked before anything else in the route, because it is a fact about the
 * REQUEST rather than about the account's eligibility. A client retrying with a
 * changed payload deserves to be told its key no longer matches — answering
 * "a checkout is in progress" is true but useless: it describes the lock the
 * client's own first call took, and sends them to look at the wrong thing.
 */
export async function conflictingKeyPlan(
  userId: string,
  idempotencyKey: string,
  plan: string,
): Promise<string | null> {
  const prior = await prisma.checkoutIntent.findUnique({
    where: { userId_idempotencyKey: { userId, idempotencyKey } },
    select: { plan: true },
  });
  return prior && prior.plan !== plan ? prior.plan : null;
}

/**
 * Take the account's acquisition lock, or explain who has it.
 *
 * SHORT AND TRANSACTIONAL. Everything here is database work; the provider call
 * happens after this returns and commits, because an HTTP request cannot be
 * rolled back and holding a transaction open across one turns a slow provider
 * into a stalled database.
 */
export async function reserveAcquisition(input: {
  userId: string;
  plan: string;
  idempotencyKey?: string | null;
  now?: Date;
}): Promise<ReserveOutcome> {
  const now = input.now ?? new Date();

  for (let attempt = 0; ; attempt++) {
    try {
      return await attemptReserve(input, now);
    } catch (e) {
      // Two requests reached the insert together and the unique index rejected
      // the loser. That collision means someone else took the lock — which is an
      // answer, not a failure — so the whole transaction is replayed and the
      // replay reads the winner's row. Bounded, and allowlisted to the errors a
      // real race actually produces (see `isRetryableRaceError`).
      if (attempt >= 2 || !isRetryableRaceError(e)) throw e;
    }
  }
}

async function attemptReserve(
  input: { userId: string; plan: string; idempotencyKey?: string | null },
  now: Date,
): Promise<ReserveOutcome> {
  return prisma.$transaction(async (tx) => {
    // The idempotency leg first: a client retrying with the same key must get
    // the same intent, not a second one — even if the first is still in flight.
    if (input.idempotencyKey) {
      const prior = await tx.checkoutIntent.findUnique({
        where: {
          userId_idempotencyKey: {
            userId: input.userId,
            idempotencyKey: input.idempotencyKey,
          },
        },
        select: SELECT,
      });
      if (prior) {
        if (prior.plan !== input.plan) {
          // Same key, different payload. Answering with the first intent would
          // sell them the wrong plan; minting a second breaks the key's promise.
          throw new IdempotencyConflict(prior.plan, input.plan);
        }
        return classifyExisting(prior, input.plan, now);
      }
    }

    const lock = await tx.acquisitionLock.findUnique({
      where: { userId_scope: { userId: input.userId, scope: ACQUISITION_SCOPE } },
    });

    if (lock) {
      const holder = await tx.checkoutIntent.findUnique({
        where: { id: lock.intentId },
        select: SELECT,
      });

      // A lock whose holder vanished is not a lock. Take it over rather than
      // stranding the account for ever on a row that no longer exists.
      // THE SAME WINDOW, and the `|| holder.state === "uncertain"` that used to
      // sit here was the other half of the permanent lockout: it kept the lock
      // alive past its own expiry, so a single dropped response barred the
      // account from every plan for ever.
      if (holder && lock.expiresAt.getTime() > now.getTime()) {
        return classifyExisting(holder, input.plan, now);
      }

      // Expired, and its holder is not `uncertain` — the link it minted can no
      // longer be paid, so a fresh acquisition is safe.
      if (holder) {
        await tx.checkoutIntent.updateMany({
          where: { id: holder.id, state: { in: ["reserved", "ready"] } },
          data: { state: "expired" },
        });
      }
      await tx.acquisitionLock.delete({ where: { id: lock.id } });
    }

    const token = mintToken();
    const intent = await tx.checkoutIntent.create({
      data: {
        token,
        userId: input.userId,
        plan: input.plan,
        scope: ACQUISITION_SCOPE,
        // The token when the client gave us nothing — see the schema. A null
        // here is not "no key", it is a value that collides with the next one.
        idempotencyKey: input.idempotencyKey ?? token,
        state: "reserved",
        provider: "lemonsqueezy",
        // Provisional: replaced with the instant we actually agree with the
        // provider once the checkout exists.
        expiresAt: new Date(now.getTime() + CHECKOUT_TTL_MS + EXPIRY_MARGIN_MS),
      },
      select: SELECT,
    });

    await tx.acquisitionLock.create({
      data: {
        userId: input.userId,
        scope: ACQUISITION_SCOPE,
        intentId: intent.id,
        expiresAt: intent.expiresAt,
      },
    });

    return { outcome: "reserved", intent };
  });
}

/**
 * What an already-existing intent means for the caller asking now.
 *
 * THE PLAN COMPARISON IS NOT A DETAIL. Without it a customer who had a monthly
 * link open and pressed "Buy yearly" was handed the MONTHLY link back, marked
 * `reused`, and sent off to pay the wrong price — the request succeeded, one
 * checkout existed, and the money was for the wrong thing. Reuse only ever means
 * "you already have exactly this"; anything else is a conflict.
 */
function classifyExisting(intent: IntentRow, plan: string, now: Date): ReserveOutcome {
  if (intent.state === "uncertain") return { outcome: "uncertain", intent };
  if (
    intent.plan === plan &&
    intent.state === "ready" &&
    intent.checkoutUrl &&
    intent.expiresAt.getTime() > now.getTime()
  ) {
    return { outcome: "reused", intent };
  }
  return { outcome: "busy", intent };
}

/** Same key, different plan — the one case where a retry is not a retry. */
export class IdempotencyConflict extends Error {
  constructor(
    readonly existingPlan: string,
    readonly requestedPlan: string,
  ) {
    super("This idempotency key was already used for a different plan.");
    this.name = "IdempotencyConflict";
  }
}

/**
 * The checkout exists. Record what it is and align both expiries to it.
 *
 * The lock's expiry is moved with the intent's, never independently: they are
 * two rows describing one fact, and a lock that outlived its intent would block
 * an account whose link had already died.
 */
export async function markReady(input: {
  intentId: string;
  providerCheckoutId: string | null;
  checkoutUrl: string;
  expiresAt: Date;
}): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.checkoutIntent.updateMany({
      where: { id: input.intentId, state: "reserved" },
      data: {
        state: "ready",
        providerCheckoutId: input.providerCheckoutId,
        checkoutUrl: input.checkoutUrl,
        expiresAt: input.expiresAt,
      },
    });
    await tx.acquisitionLock.updateMany({
      where: { intentId: input.intentId },
      data: { expiresAt: input.expiresAt },
    });
  });
}

/**
 * Lemon Squeezy told us, in so many words, that it created nothing.
 *
 * ONLY for a refusal we can read — a 4xx with a body. The lock goes immediately,
 * because there is no link to collide with and making the customer wait out a
 * timeout for a typo would be gratuitous.
 */
export async function markFailed(intentId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.checkoutIntent.updateMany({
      where: { id: intentId, state: "reserved" },
      data: { state: "failed" },
    });
    await tx.acquisitionLock.deleteMany({ where: { intentId } });
  });
}

/**
 * We do not know what happened, and must not guess.
 *
 * A timeout, a dropped socket, a 5xx with no body — none of them prove the
 * checkout was not created. The lock is KEPT, pushed out to cover the longest
 * life the invisible link could have, and the state says plainly that a human or
 * a reconciliation pass has to settle it. Recreating blindly here is the bug.
 */
export async function markUncertain(intentId: string, now: Date = new Date()): Promise<void> {
  const until = new Date(now.getTime() + UNCERTAIN_HOLD_MS);
  await prisma.$transaction(async (tx) => {
    await tx.checkoutIntent.updateMany({
      where: { id: intentId, state: "reserved" },
      data: { state: "uncertain", expiresAt: until },
    });
    await tx.acquisitionLock.updateMany({
      where: { intentId },
      data: { expiresAt: until },
    });
  });
}

/**
 * A payment landed. Close the intent it belongs to and free only its own lock.
 *
 * KEYED ON THE INTENT, not on the account, and that is the whole safety of it. A
 * webhook that arrives late — after the customer abandoned that checkout, took a
 * new one and is midway through paying it — must not release the NEW lock. The
 * `intentId` condition makes a stale delivery a no-op rather than a hole.
 *
 * Idempotent: a redelivery finds the intent already `completed`, the guarded
 * update matches nothing, and the lock is already gone.
 */
export async function completeIntent(intentId: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const updated = await tx.checkoutIntent.updateMany({
      where: { id: intentId, state: { in: HOLDING as string[] } },
      data: { state: "completed" },
    });
    await tx.acquisitionLock.deleteMany({ where: { intentId } });
    return updated.count === 1;
  });
}

/** Resolve the public handle a webhook carries back to us. */
export async function intentByToken(token: string): Promise<IntentRow | null> {
  if (!token) return null;
  return prisma.checkoutIntent.findUnique({ where: { token }, select: SELECT });
}

/**
 * What the account's outstanding acquisition is, for the status read.
 *
 * Returns null when nothing is outstanding OR when what is outstanding has
 * expired — the decision is a comparison against the server clock, never a TTL
 * sweep. A TTL index deletes documents on its own schedule, which is fine for
 * housekeeping and useless as a guarantee.
 */
export async function outstandingAcquisition(
  userId: string,
  now: Date = new Date(),
): Promise<IntentRow | null> {
  const lock = await prisma.acquisitionLock.findUnique({
    where: { userId_scope: { userId, scope: ACQUISITION_SCOPE } },
  });
  if (!lock) return null;
  const intent = await prisma.checkoutIntent.findUnique({
    where: { id: lock.intentId },
    select: SELECT,
  });
  if (!intent) return null;
  if (!HOLDING.includes(intent.state as IntentState)) return null;
  // THE HOLD IS A WINDOW, NOT A LIFE SENTENCE — including for `uncertain`.
  //
  // This used to return an `uncertain` intent regardless of the clock, which
  // made the window `markUncertain` computes meaningless: one dropped response
  // during a checkout and the account could never buy anything again, with a
  // message telling the customer to cancel something the product gives them no
  // way to cancel. Reported from the real app by an active subscriber who could
  // no longer reach lifetime or yearly.
  //
  // `UNCERTAIN_HOLD_MS` already answers the only question that matters: after
  // the full life the invisible link could have, plus the clock-skew margin, it
  // can no longer be paid — so a fresh purchase is safe. Honouring that instant
  // is the fix; ignoring it was never safer, only permanent.
  return lock.expiresAt.getTime() > now.getTime() ? intent : null;
}

/** Re-exported so callers do not have to know the Prisma symbol. */
export { Prisma };
