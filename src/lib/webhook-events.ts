import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";

/**
 * The claim → work → mark cycle every webhook shares, extracted verbatim from
 * the Lemon Squeezy route the day RevenueCat arrived — because the
 * P2034-versus-P2002 distinction below took a lost sale to get right, and two
 * providers each carrying their own copy of it would eventually disagree.
 *
 * The cycle, and why it is three steps rather than one insert:
 *
 *   CLAIM   a row is created as `processing`. The unique index on
 *           (provider, eventId) decides who owns a delivery, not a
 *           read-then-write — two cold instances racing the same delivery
 *           collide in the database rather than both proceeding.
 *   WORK    the route does whatever the event means. Everything it writes must
 *           be idempotent, because a redelivery may legitimately re-run it.
 *   MARK    the row is moved to a final status. Only `processed` and `skipped`
 *           are TERMINAL: a redelivery finding one short-circuits. `failed`
 *           stays claimable, so fixing the cause and redelivering finishes the
 *           work instead of being answered "already done".
 *
 * The claim is deliberately NOT the same thing as the work. An earlier draft
 * inserted the dedupe row first and treated its mere existence as "already
 * handled" — so anything that died in between (a thrown write, a killed
 * serverless instance) meant the retry was answered "already done" and the
 * customer's licence was lost silently and permanently.
 */

/** Terminal states. A redelivery finding one of these has genuinely nothing to do. */
export const WEBHOOK_DONE = new Set(["processed", "skipped"]);

export type WebhookEventStatus = "processed" | "skipped" | "failed";

/**
 * Take ownership of a delivery, or report what it already is.
 *
 * "fresh" — ours to process. "done" — a previous attempt finished it.
 * "retry" — the claim itself conflicted and did not land, so ask the sender to
 * redeliver rather than swallow the event.
 */
export async function claimWebhookEvent(
  provider: string,
  eventKey: string,
  type: string,
  payload: Prisma.InputJsonValue,
): Promise<"fresh" | "done" | "retry"> {
  try {
    await prisma.webhookEvent.create({
      data: {
        provider,
        eventId: eventKey,
        type,
        payload,
        status: "processing",
      },
    });
    return "fresh";
  } catch (err) {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError)) throw err;

    // P2034 is a write CONFLICT: the row was not written. Distinct from P2002,
    // where someone else genuinely got there first. Conflating them tells the
    // sender an event was handled when nothing had been.
    if (err.code === "P2034") return "retry";
    if (err.code !== "P2002") throw err;

    const prior = await prisma.webhookEvent.findUnique({
      where: { provider_eventId: { provider, eventId: eventKey } },
      select: { status: true },
    });
    if (prior && WEBHOOK_DONE.has(prior.status)) return "done";

    // Left "processing" by an instance that died, or "failed" by a real error.
    // Either way the work still owes an outcome, and every write a webhook
    // route makes is idempotent, so redoing it is safe.
    await prisma.webhookEvent
      .update({
        where: { provider_eventId: { provider, eventId: eventKey } },
        data: { status: "processing", attempts: { increment: 1 } },
      })
      .catch(() => undefined);
    return "fresh";
  }
}

/** Record the outcome of a claimed delivery. Terminal rows are immovable. */
export async function markWebhookEvent(
  provider: string,
  eventKey: string,
  status: string,
  error?: string,
): Promise<void> {
  await prisma.webhookEvent
    // updateMany for its WHERE, not its many: the status filter makes a finished
    // row immovable. The claim race (two instances re-running one event) is
    // survivable because every write is idempotent — but only if the LOSER
    // finishing late cannot re-mark the winner's `processed` as `failed`, which
    // would put a completed sale back on the to-do list.
    .updateMany({
      where: {
        provider,
        eventId: eventKey,
        status: { notIn: Array.from(WEBHOOK_DONE) },
      },
      data: { status, error: error ?? null, processedAt: new Date() },
    })
    .catch((e) => {
      // Best-effort, but never silent: this row is the only trace a replay tool
      // would have, and a status write that vanished without a word once made a
      // healthy queue indistinguishable from a stuck one.
      console.error(`[${provider}] could not mark ${eventKey} as ${status}:`, e);
    });
}
