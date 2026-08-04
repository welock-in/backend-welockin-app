import { Router, type Request } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { env } from "../lib/env";
import { LIFETIME_PRODUCT_ID } from "../lib/entitlement";
import { asyncHandler } from "../middleware/async-handler";
import {
  HANDLED_EVENTS,
  isFullRefund,
  isObjectId,
  isSellableOrder,
  parseOrderEvent,
  verifyWebhookSignature,
  type LemonSqueezyWebhook,
  type ParsedOrder,
} from "../lib/lemonsqueezy";

export const lemonSqueezyWebhookRouter = Router();

const PROVIDER = "lemonsqueezy";

/** Terminal states. A redelivery finding one of these has genuinely nothing to do. */
const DONE = new Set(["processed", "skipped"]);

/**
 * Lemon Squeezy order webhook — the first thing in this backend that writes a
 * Purchase, and therefore the first thing that can turn "trialing" into "active".
 *
 * Four rules shape every branch below.
 *
 * 1. VERIFY BEFORE ANYTHING. Until the HMAC checks out we do not read the body,
 *    do not log its contents and do not touch the database.
 *
 * 2. CLAIM, WORK, THEN MARK DONE — in that order, and the claim is not the same
 *    thing as the work. An earlier draft inserted the dedupe row first and then
 *    treated its mere existence as "already handled". Anything that died in
 *    between — a thrown write, a killed serverless instance — meant the retry was
 *    answered "already done" and the customer's licence was lost silently and
 *    permanently. So a row is claimed as `processing`, and a redelivery only
 *    short-circuits on a TERMINAL status.
 *
 * 3. STATUS CODES ARE INSTRUCTIONS. Lemon Squeezy retries anything that is not
 *    2xx. An event we understood and deliberately ignored gets 200, or it is
 *    redelivered forever. A failure on OUR side gets 500, precisely so it IS
 *    retried. Getting this backwards either floods the queue or drops a sale.
 *
 * 4. A SIGNATURE IS NOT AN ENTITLEMENT. It proves the delivery came from our
 *    store, nothing more — not that the order was paid, and not that it was even
 *    for the product we sell. Both are checked explicitly.
 */
lemonSqueezyWebhookRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const raw = (req as Request & { rawBody?: Buffer }).rawBody;

    if (!verifyWebhookSignature(raw, req.header("X-Signature") ?? undefined)) {
      // Logged without any payload content: an unsigned caller gets no help, but
      // a misconfigured secret must not be invisible either — silence here once
      // cost a whole afternoon of "the webhook does nothing".
      console.warn("[lemonsqueezy] rejected delivery: bad or missing signature");
      res.status(401).json({ error: { code: "INVALID_SIGNATURE" } });
      return;
    }

    const body = req.body as LemonSqueezyWebhook;
    const order = parseOrderEvent(body);
    if (!order) {
      console.warn("[lemonsqueezy] signed delivery we cannot parse");
      res.status(200).json({ ok: true, skipped: "unparsable" });
      return;
    }

    // Claim the event. The unique index decides, not a read-then-write, so two
    // cold instances racing the same delivery cannot both proceed.
    const claim = await claimEvent(order, body);
    if (claim === "done") {
      res.status(200).json({ ok: true, deduped: true });
      return;
    }
    if (claim === "retry") {
      // P2034: the write conflicted and did NOT land. Nothing was claimed, so ask
      // to be redelivered rather than swallow the order.
      res.status(503).json({ error: { code: "WRITE_CONFLICT" } });
      return;
    }

    try {
      const outcome = await handle(order, body);
      await markEvent(order.eventKey, outcome.status, outcome.reason);
      res.status(200).json({ ok: true, ...(outcome.reason ? { note: outcome.reason } : {}) });
    } catch (err) {
      // Leave the row non-terminal so the redelivery re-runs the work, then let
      // the error surface as a 500 so there IS a redelivery.
      await markEvent(order.eventKey, "failed", err instanceof Error ? err.message : "unknown error");
      throw err;
    }
  }),
);

type Outcome = { status: "processed" | "skipped" | "failed"; reason?: string };

/**
 * Decide what this order means and record it.
 *
 * Every refusal below is deliberate about WHICH kind it is: "skipped" for
 * something we understood and will never act on, "failed" for something a human
 * may need to finish by hand. Both answer 200 — neither gets better by being
 * redelivered — but only one of them is a to-do list.
 */
async function handle(order: ParsedOrder, body: LemonSqueezyWebhook): Promise<Outcome> {
  if (!HANDLED_EVENTS.includes(order.event as (typeof HANDLED_EVENTS)[number])) {
    return { status: "skipped", reason: `unhandled event ${order.event}` };
  }

  const sellable = isSellableOrder(order);
  if (!sellable.ok) {
    // `skipped` is TERMINAL (see DONE) — a redelivery finding one short-circuits
    // and the work never runs again. That is right for an order that was never
    // ours, and catastrophic for one we merely were not configured to recognise:
    // the customer paid, the config gets fixed an hour later, and the dashboard
    // redelivery is answered "already handled". So our own misconfiguration is
    // recorded as `failed`, which stays claimable.
    return { status: sellable.retryable ? "failed" : "skipped", reason: sellable.reason };
  }

  // REVOKING is never gated. The test-mode guard below protects against handing
  // out licences nobody paid for; taking one away has no such downside, and
  // guarding it is actively harmful — a test order created while the door was
  // open could never be undone once it closed, leaving the licence live and the
  // order frozen as "paid" for good. That is not hypothetical: it happened here.
  if (order.event === "order_refunded") {
    return refund(order, body);
  }

  // A test order costs nothing and is trivial to produce. Honouring one on a
  // live backend is a free-licence tap, so it takes an explicit opt-in — not an
  // inference from NODE_ENV, which is unset on more machines than people expect.
  if (order.testMode && !env.lemonSqueezyAllowTestMode) {
    return { status: "skipped", reason: "test-mode order ignored here" };
  }

  // An order row exists from the moment checkout begins. Only "paid" owes anyone
  // anything — "pending" resolves later (and sends its own event), "failed" never
  // will, and granting on either hands out licences for money never received.
  if (order.status !== "paid") {
    return { status: "skipped", reason: `order status is ${order.status ?? "unknown"}, not paid` };
  }

  const userId = await resolveUserId(order);
  if (!userId) {
    // Real money, no account we can name. Not an error — retrying will not
    // conjure a user — but it IS unfinished business, so it is marked failed and
    // stays queryable rather than disappearing into a 200.
    console.warn(`[lemonsqueezy] unmatched order ${order.orderId}`);
    return { status: "failed", reason: `no account matches order ${order.orderId}` };
  }

  await prisma.purchase.upsert({
    where: { provider_externalId: { provider: PROVIDER, externalId: order.orderId } },
    create: {
      userId,
      provider: PROVIDER,
      store: PROVIDER,
      productId: order.variantId ?? LIFETIME_PRODUCT_ID,
      externalId: order.orderId,
      priceUsd: order.priceUsd,
      purchasedAt: order.purchasedAt,
      isRefunded: false,
      rawEvent: body as Prisma.InputJsonValue,
    },
    // `isRefunded` is deliberately absent: a replayed order_created arriving
    // after a refund must not resurrect the licence.
    update: { userId, priceUsd: order.priceUsd, rawEvent: body as Prisma.InputJsonValue },
  });
  return { status: "processed" };
}

/**
 * A refund revokes the licence.
 *
 * Deliberately does NOT require resolving the buyer: the Purchase row already
 * carries its userId, and an earlier draft gated both paths on resolution — so a
 * refund for someone whose email had since changed was dropped, leaving money
 * returned and the licence still live. Taking access away must never depend on
 * more than taking it away needs.
 */
async function refund(order: ParsedOrder, body: LemonSqueezyWebhook): Promise<Outcome> {
  const existing = await prisma.purchase.findUnique({
    where: { provider_externalId: { provider: PROVIDER, externalId: order.orderId } },
    select: { id: true },
  });

  const full = isFullRefund(order);

  if (existing) {
    if (!full) {
      // A PARTIAL refund. Record what happened and leave the licence alone: the
      // customer paid, kept most of it, and revoking here would take the product
      // away from someone we just gave a goodwill gesture to. Only `rawEvent`
      // moves, so support can see it and so a later full refund still lands.
      await prisma.purchase.update({
        where: { id: existing.id },
        data: { rawEvent: body as Prisma.InputJsonValue },
      });
      console.warn(
        `[lemonsqueezy] partial refund on order ${order.orderId} ` +
          `(${order.refundedAmountUsd ?? "?"} of ${order.priceUsd ?? "?"}) — licence kept`,
      );
      return { status: "processed" };
    }
    await prisma.purchase.update({
      where: { id: existing.id },
      data: {
        isRefunded: true,
        refundedAt: order.refundedAt ?? new Date(),
        rawEvent: body as Prisma.InputJsonValue,
      },
    });
    return { status: "processed" };
  }

  // The refund arrived for an order we never saw created — a delivery lost while
  // this endpoint was down. Record it refunded anyway, so the later (or replayed)
  // creation cannot grant what has already been given back.
  const userId = await resolveUserId(order);
  if (!userId) {
    return { status: "failed", reason: `refund for unknown order ${order.orderId} and unknown account` };
  }
  await prisma.purchase.create({
    data: {
      userId,
      provider: PROVIDER,
      store: PROVIDER,
      productId: order.variantId ?? LIFETIME_PRODUCT_ID,
      externalId: order.orderId,
      priceUsd: order.priceUsd,
      purchasedAt: order.purchasedAt,
      isRefunded: true,
      refundedAt: order.refundedAt ?? new Date(),
      rawEvent: body as Prisma.InputJsonValue,
    },
  });
  return { status: "processed", reason: "refund recorded for an order we never saw created" };
}

/**
 * Which account does this order belong to?
 *
 * `custom_data.user_id` is what our own checkout puts there and is tried first.
 * Email is the fallback for a purchase made outside it. Email is the weaker
 * signal — people buy with one address and register with another — which is why
 * an unmatched order is parked rather than attached to a guess.
 */
async function resolveUserId(order: ParsedOrder): Promise<string | null> {
  // Validated BEFORE it reaches Prisma. On MongoDB a malformed id raises P2023
  // rather than returning null, which would turn a merely-odd payload into a
  // thrown request — and, before the claim logic was fixed, into a lost sale.
  if (order.customUserId && isObjectId(order.customUserId)) {
    const byId = await prisma.user.findUnique({ where: { id: order.customUserId }, select: { id: true } });
    if (byId) return byId.id;
  }
  if (order.email) {
    const byEmail = await prisma.user.findFirst({
      where: { email: { equals: order.email, mode: "insensitive" } },
      select: { id: true },
    });
    if (byEmail) return byEmail.id;
  }
  return null;
}

/**
 * Take ownership of this delivery, or report what it already is.
 *
 * "fresh" — ours to process. "done" — a previous attempt finished it.
 * "retry" — the claim itself conflicted and did not land.
 */
async function claimEvent(order: ParsedOrder, body: LemonSqueezyWebhook): Promise<"fresh" | "done" | "retry"> {
  try {
    await prisma.webhookEvent.create({
      data: {
        provider: PROVIDER,
        eventId: order.eventKey,
        type: order.event,
        payload: body as Prisma.InputJsonValue,
        status: "processing",
      },
    });
    return "fresh";
  } catch (err) {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError)) throw err;

    // P2034 is a write CONFLICT: the row was not written. Distinct from P2002,
    // where someone else genuinely got there first. Conflating them told Lemon
    // Squeezy an order was handled when nothing had been.
    if (err.code === "P2034") return "retry";
    if (err.code !== "P2002") throw err;

    const prior = await prisma.webhookEvent.findUnique({
      where: { provider_eventId: { provider: PROVIDER, eventId: order.eventKey } },
      select: { status: true },
    });
    if (prior && DONE.has(prior.status)) return "done";

    // Left "processing" by an instance that died, or "failed" by a real error.
    // Either way the work still owes an outcome, and every write below is
    // idempotent, so redoing it is safe.
    await prisma.webhookEvent
      .update({
        where: { provider_eventId: { provider: PROVIDER, eventId: order.eventKey } },
        data: { status: "processing", attempts: { increment: 1 } },
      })
      .catch(() => undefined);
    return "fresh";
  }
}

async function markEvent(eventKey: string, status: string, error?: string): Promise<void> {
  await prisma.webhookEvent
    .update({
      where: { provider_eventId: { provider: PROVIDER, eventId: eventKey } },
      data: { status, error: error ?? null, processedAt: new Date() },
    })
    .catch((e) => {
      // Best-effort, but never silent: this row is the only trace a replay tool
      // would have, and a status write that vanished without a word once made a
      // healthy queue indistinguishable from a stuck one.
      console.error(`[lemonsqueezy] could not mark ${eventKey} as ${status}:`, e);
    });
}
