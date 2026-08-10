import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { env } from "./env";

/**
 * The outbox for billing actions we owe Lemon Squeezy.
 *
 * WHAT IT IS FOR. Two paths have to cancel a subscription at the provider at a
 * moment when the provider may be unreachable, and both of them destroy the
 * local evidence immediately afterwards:
 *
 *   · deleting an account — the Subscription rows cascade away, and if the
 *     cancel did not land the card keeps being charged with nothing left on our
 *     side to explain it;
 *   · buying the lifetime licence — the recurring plan it replaces must stop, or
 *     the customer pays every month on top of something they now own for ever.
 *
 * Both were "best-effort": one fetch, and a `console.error` if it failed. That is
 * not a strategy, it is a hope. The intent is now WRITTEN DOWN first, tried at
 * once, and retried by a scheduled drain until the provider confirms it.
 *
 * EXACTLY-ONCE IS NOT THE GOAL, and pretending otherwise would add machinery for
 * nothing. Cancelling an already-cancelled subscription at Lemon Squeezy is a
 * no-op, and a subscription that is gone answers 404 — which is the state we
 * wanted, so it counts as done. That makes every operation here safely
 * REPEATABLE, and turns the hard problem (never act twice) into an easy one
 * (never LOSE the instruction). The lock exists to avoid waste and duplicate log
 * noise, not to guarantee uniqueness.
 */

const PROVIDER = "lemonsqueezy";

/** A hung outbound call on a serverless function bills until it is killed. */
const LS_TIMEOUT_MS = 10_000;

/** Give up asking automatically after this many tries; the row stays for a human. */
export const MAX_ATTEMPTS = 12;

/**
 * How long a claim is honoured before another run may take the task.
 *
 * Must comfortably exceed one provider call. A run that dies between claiming a
 * task and finishing it would otherwise strand the row for ever — which is the
 * failure this whole file exists to prevent, reintroduced by its own lock.
 */
const LOCK_TTL_MS = 5 * 60_000;

/**
 * Backoff, capped at a day. A provider outage lasting hours must not be met with
 * hundreds of identical calls, and a task that is a day late still fixes the
 * customer's bill.
 */
export function backoffMs(attempts: number): number {
  return Math.min(5 * 60_000 * 2 ** attempts, 24 * 60 * 60_000);
}

const key = (externalId: string) => ({
  provider_externalId_kind: { provider: PROVIDER, externalId, kind: "cancel" },
});

/**
 * Record that we owe a cancellation.
 *
 * Idempotent, and deliberately NOT a plain upsert-with-empty-update. Three cases,
 * and the third is the one a naive upsert gets wrong:
 *
 *   · no row      → create it;
 *   · row pending → leave it alone, so a repeat call cannot reset a backoff that
 *                   is deliberately holding off a struggling provider;
 *   · row SETTLED → re-open it. A settled task means that subscription was
 *                   cancelled once; being asked again means it is live again
 *                   (resumed in the customer portal, say), and a unique key that
 *                   silently swallowed the second instruction would be a
 *                   subscription nobody ever cancels.
 *
 * Never throws. A failure to write the outbox must not abort the account
 * deletion or the licence grant it is attached to — those are the caller's actual
 * job, and this is the follow-up.
 */
export async function enqueueCancel(externalId: string, reason: string): Promise<boolean> {
  if (!externalId) return false;
  try {
    const existing = await prisma.billingTask.findUnique({
      where: key(externalId),
      select: { id: true, doneAt: true },
    });

    if (!existing) {
      try {
        await prisma.billingTask.create({
          data: { provider: PROVIDER, externalId, kind: "cancel", reason },
        });
      } catch (e) {
        // ONLY the race is swallowed. A bare catch here hid every transient
        // database failure too — no row, no log — and the caller then went on to
        // destroy the only copy of the subscription id. The unique-constraint
        // violation is the one error that means "someone else already recorded
        // it", which is success; anything else must reach the handler below and
        // be shouted about.
        if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")) throw e;
      }
      return true;
    }

    if (existing.doneAt) {
      await prisma.billingTask.update({
        where: { id: existing.id },
        data: {
          reason,
          doneAt: null,
          attempts: 0,
          lastError: null,
          lockedAt: null,
          nextAttemptAt: new Date(),
        },
      });
    }
    return true;
  } catch (e) {
    console.error(`[billing-tasks] could not enqueue cancel for ${externalId}:`, e);
    return false;
  }
}

type Attempt = { ok: boolean; error?: string };

/**
 * The provider call itself. Separated so tests can drive every branch without a
 * database.
 *
 * WHAT COUNTS AS DONE is the whole subtlety. We are not trying to observe a
 * successful DELETE, we are trying to reach a state: this subscription is not
 * billing. A 404 reaches it (there is nothing to bill), so it settles. A 429 or a
 * 5xx says "ask again", so it retries. A 4xx we do not understand also retries —
 * an expired API key answers 401, and a key that gets fixed tomorrow should find
 * the work still waiting rather than a task someone marked terminal.
 */
export async function cancelAtProvider(externalId: string): Promise<Attempt> {
  if (!env.lemonSqueezyApiKey) return { ok: false, error: "no API key configured" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LS_TIMEOUT_MS);
  try {
    const r = await fetch(`${env.lemonSqueezyApiBase}/v1/subscriptions/${externalId}`, {
      method: "DELETE",
      headers: {
        Accept: "application/vnd.api+json",
        "Content-Type": "application/vnd.api+json",
        Authorization: `Bearer ${env.lemonSqueezyApiKey}`,
      },
      signal: controller.signal,
    });
    if (r.ok || r.status === 404) return { ok: true };
    return { ok: false, error: `HTTP ${r.status}` };
  } catch (err) {
    // Never echo the error verbatim — the request carried the API key in a
    // header and some fetch errors quote the request back.
    return { ok: false, error: err instanceof Error ? err.message : "unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Take ownership of a task, atomically.
 *
 * `updateMany` with the condition in the WHERE, not read-then-write: two cron
 * runs starting in the same second would both pass a read-then-write check. The
 * count tells us who won.
 */
async function claim(taskId: string): Promise<boolean> {
  const stale = new Date(Date.now() - LOCK_TTL_MS);
  const claimed = await prisma.billingTask.updateMany({
    where: {
      id: taskId,
      doneAt: null,
      OR: [{ lockedAt: null }, { lockedAt: { lt: stale } }],
    },
    data: { lockedAt: new Date() },
  });
  return claimed.count === 1;
}

/**
 * Try one owed cancellation and record what happened.
 *
 * Returns whether it is now settled. Never throws: this runs inside deletion and
 * webhook paths whose own success must not depend on the provider answering.
 *
 * NOTE ON THE CRASH WINDOW. If the process dies after the provider confirms and
 * before the row is marked done, the task is retried later and the provider is
 * asked again — which answers 404 or a harmless no-op, and settles. That is the
 * dividend of making every operation repeatable instead of chasing exactly-once.
 */
export async function runCancel(task: {
  id: string;
  externalId: string;
  attempts: number;
}): Promise<boolean> {
  const result = await cancelAtProvider(task.externalId);
  try {
    if (result.ok) {
      await prisma.billingTask.update({
        where: { id: task.id },
        data: { doneAt: new Date(), lastError: null, lockedAt: null },
      });
      return true;
    }
    const attempts = task.attempts + 1;
    await prisma.billingTask.update({
      where: { id: task.id },
      data: {
        attempts,
        lastError: result.error ?? "failed",
        // Released, not held: the next run should be free to try again once the
        // backoff has elapsed.
        lockedAt: null,
        nextAttemptAt: new Date(Date.now() + backoffMs(attempts)),
      },
    });
    if (attempts >= MAX_ATTEMPTS) {
      // THE ALERT. This is money still leaving a customer's card, and the row is
      // about to stop being retried automatically — so this line is the only
      // thing standing between a stuck task and nobody ever knowing.
      console.error(
        `[billing-tasks] DEAD-LETTERED ${task.externalId} after ${attempts} attempts (${result.error}) ` +
          `— a customer may still be being charged. Replay it from the admin console once the cause is fixed.`,
      );
    }
  } catch (e) {
    console.error(`[billing-tasks] could not record attempt for ${task.externalId}:`, e);
  }
  return false;
}

/**
 * Write the intent down, then try it immediately.
 *
 * The order matters and is the whole design: enqueue FIRST, so that a process
 * killed mid-call still leaves the instruction behind.
 *
 * RETURNS WHETHER THE INSTRUCTION IS DURABLE — not whether the provider answered.
 * The two callers need opposite things from a failure here and cannot both be
 * served by swallowing it: account deletion must NOT proceed to destroy the only
 * copy of the subscription id (better a 500 the client retries than a live
 * subscription nobody can find again), while the lifetime grant must proceed
 * regardless, because the money is already taken.
 */
export async function enqueueAndAttemptCancel(externalId: string, reason: string): Promise<boolean> {
  const recorded = await enqueueCancel(externalId, reason);
  try {
    const task = await prisma.billingTask.findUnique({
      where: key(externalId),
      select: { id: true, externalId: true, attempts: true, doneAt: true },
    });
    if (!task || task.doneAt) return recorded;
    if (!(await claim(task.id))) return recorded; // a drain is already on it
    await runCancel(task);
  } catch (e) {
    // The attempt failed, not the record. The scheduled drain will pick it up.
    console.error(`[billing-tasks] inline cancel attempt failed for ${externalId}:`, e);
  }
  return recorded;
}

export type DrainReport = {
  /** Tasks that were due and not already claimed by another run. */
  due: number;
  /** Of those, how many the provider confirmed. */
  settled: number;
  /** Skipped because another run held the lock. */
  contended: number;
  /** Still owed after this run, including dead-lettered ones. */
  stillOwed: number;
  /** Past MAX_ATTEMPTS: no longer retried automatically, waiting for a human. */
  deadLettered: number;
};

/**
 * Work through the cancellations that are still owed and DUE.
 *
 * Called by the scheduled route (`/api/cron/billing-tasks`) and by the admin
 * console. Bounded per run so one invocation cannot exceed a function's time
 * limit; whatever is left is picked up by the next tick.
 *
 * Dead-lettered tasks are excluded on purpose — retrying a task that has failed
 * twelve times, every quarter of an hour, forever, is how a real alert gets
 * buried under its own noise. They stay visible in `GET /api/admin/billing-tasks`
 * and come back only when a human replays them.
 */
export async function drainCancels(limit = 25): Promise<DrainReport> {
  const now = new Date();
  const stale = new Date(now.getTime() - LOCK_TTL_MS);

  const due = await prisma.billingTask.findMany({
    where: {
      kind: "cancel",
      doneAt: null,
      nextAttemptAt: { lte: now },
      attempts: { lt: MAX_ATTEMPTS },
      OR: [{ lockedAt: null }, { lockedAt: { lt: stale } }],
    },
    orderBy: { nextAttemptAt: "asc" },
    take: limit,
    select: { id: true, externalId: true, attempts: true },
  });

  let settled = 0;
  let contended = 0;
  for (const task of due) {
    // Re-checked atomically: the list above is a snapshot, and another run may
    // have taken this row between the read and here.
    if (!(await claim(task.id))) {
      contended += 1;
      continue;
    }
    if (await runCancel(task)) settled += 1;
  }

  const [stillOwed, deadLettered] = await Promise.all([
    prisma.billingTask.count({ where: { kind: "cancel", doneAt: null } }),
    prisma.billingTask.count({
      where: { kind: "cancel", doneAt: null, attempts: { gte: MAX_ATTEMPTS } },
    }),
  ]);

  if (deadLettered > 0) {
    console.error(
      `[billing-tasks] ${deadLettered} cancellation(s) dead-lettered and no longer retried automatically ` +
        `— customers may still be being charged.`,
    );
  }

  return { due: due.length, settled, contended, stillOwed, deadLettered };
}

/**
 * Put a dead-lettered task back in the queue.
 *
 * The escape hatch that makes the dead letter safe to have: the reason a task
 * exhausts its attempts is almost always something an operator fixes (an expired
 * API key, a subscription in a state Lemon Squeezy refused), and without a way
 * back the only remedy would be editing the database by hand.
 */
export async function replayTask(id: string): Promise<boolean> {
  const updated = await prisma.billingTask.updateMany({
    where: { id, doneAt: null },
    data: { attempts: 0, lastError: null, lockedAt: null, nextAttemptAt: new Date() },
  });
  return updated.count === 1;
}
