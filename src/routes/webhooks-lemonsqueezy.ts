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
  isSubscriptionEvent,
  parseOrderEvent,
  parseSubscriptionEvent,
  verifyWebhookSignature,
  type LemonSqueezyWebhook,
  type ParsedOrder,
  type ParsedSubscription,
} from "../lib/lemonsqueezy";
import { intervalForVariant, subscriptionGrants, validUntilFrom } from "../lib/subscription";

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

    // Subscriptions branch FIRST, and share nothing with the order path below
    // beyond the signature and the dedupe table. Their payload is a different
    // shape and their question is a different question: an order asks "was this
    // paid for, and for what", a subscription asks "what is its state now".
    const event = body.meta?.event_name ?? "";
    if (isSubscriptionEvent(event)) {
      const sub = parseSubscriptionEvent(body);
      if (!sub) {
        console.warn("[lemonsqueezy] signed subscription delivery we cannot parse");
        res.status(200).json({ ok: true, skipped: "unparsable" });
        return;
      }
      const claim = await claimEventKey(sub.eventKey, sub.event, body);
      if (claim === "done") {
        res.status(200).json({ ok: true, deduped: true });
        return;
      }
      if (claim === "retry") {
        res.status(503).json({ error: { code: "IN_FLIGHT" } });
        return;
      }
      try {
        const outcome = await handleSubscription(sub, body);
        await markEvent(sub.eventKey, outcome.status, outcome.reason);
        res.status(200).json({ ok: true, status: outcome.status });
      } catch (e) {
        await markEvent(sub.eventKey, "failed", e instanceof Error ? e.message : "error");
        // 500 so Lemon Squeezy retries: a subscription state we failed to record
        // is a customer whose access is about to be wrong.
        throw e;
      }
      return;
    }

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

  // REVOKING is never gated — and that has to include the sellable check, which
  // used to run first. A Purchase WE recorded is ours to revoke whatever the env
  // says today: rotate the variant id after a price change and every refund of
  // the old variant would have been refused as "not the lifetime licence",
  // terminally — money returned, licence live, invisible until support. The
  // test-mode guard below has the same shape for the same reason: it protects
  // against handing out licences nobody paid for; taking one away has no such
  // downside, and guarding it is actively harmful. (A test order created while
  // the door was open could never be undone once it closed — not hypothetical,
  // it happened here.) The one sellable question a refund does raise — should
  // an order we never saw created mint a row — is answered inside `refund`.
  if (order.event === "order_refunded") {
    return refund(order, body);
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

  // A test order costs nothing and is trivial to produce. Honouring one on a
  // live backend is a free-licence tap, so it takes an explicit opt-in — not an
  // inference from NODE_ENV, which is unset on more machines than people expect.
  //
  // The skip is TERMINAL on purpose: flipping the flag later does not resurrect
  // orders skipped while it was off (their keys are burned) — retest with a
  // NEW order. The alternative, keeping every test order claimable, would grow
  // a permanent to-do per test forever.
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
      // Parsed all along and thrown away until now. See schema.prisma.
      testMode: order.testMode,
    },
    // `isRefunded` is deliberately absent: a replayed order_created arriving
    // after a refund must not resurrect the licence. `userId` is absent too —
    // ownership is decided once, at create; a replay whose custom data resolved
    // differently (an email that changed hands, a stale-claim re-run) must not
    // MOVE the licence to another account. Same rule as the subscription upsert.
    update: { priceUsd: order.priceUsd, rawEvent: body as Prisma.InputJsonValue },
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

  // The refund arrived for an order we never saw created — a delivery lost
  // while this endpoint was down. The sellable check lives HERE, not in front
  // of the whole refund path: revoking an existing row above needed no gate,
  // but MINTING a row from a refund does, or a foreign store's refund would
  // write Purchases into our table.
  const sellable = isSellableOrder(order);
  if (!sellable.ok) {
    return { status: sellable.retryable ? "failed" : "skipped", reason: sellable.reason };
  }

  // A PARTIAL refund for an order we never recorded is parked for a human, not
  // written. Recording it born-revoked would revoke a customer who paid and
  // kept most of it (the existing-row branch above exists to prevent exactly
  // that), and recording it UNREFUNDED would mint a granting licence from a
  // refund delivery — which, with the test-mode gate deliberately absent on
  // this path, would turn test partial refunds into free licences. Neither is
  // acceptable; a lost order_created is rare enough to be a to-do.
  if (!full) {
    return {
      status: "failed",
      reason: `partial refund for order ${order.orderId}, which was never seen created — redeliver its order_created`,
    };
  }

  // Same test-mode gate the grant path uses, and for the mirror reason. This
  // branch MINTS a row; the revocation of an existing row above stays ungated
  // exactly as documented. Without this, a test refund for an order the live
  // deploy never recorded writes a permanent test-graph Purchase into the
  // production table — a row for a sale that never happened here.
  if (order.testMode && !env.lemonSqueezyAllowTestMode) {
    return { status: "skipped", reason: "test-mode refund for an order we never saw created" };
  }

  // A FULL refund is recorded born-revoked, so the later (or replayed) creation
  // cannot grant what has already been given back.
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
      // Marked like every other row we mint, so the live switch can exclude it.
      testMode: order.testMode,
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
  return claimEventKey(order.eventKey, order.event, body);
}

/**
 * Claim a delivery by key.
 *
 * Split out of `claimEvent` so subscriptions reuse it rather than growing a
 * second copy: the P2034-versus-P2002 distinction below is the part that took a
 * lost sale to get right, and two copies of it would eventually disagree.
 */
async function claimEventKey(
  eventKey: string,
  type: string,
  body: LemonSqueezyWebhook,
): Promise<"fresh" | "done" | "retry"> {
  try {
    await prisma.webhookEvent.create({
      data: {
        provider: PROVIDER,
        eventId: eventKey,
        type,
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
      where: { provider_eventId: { provider: PROVIDER, eventId: eventKey } },
      select: { status: true },
    });
    if (prior && DONE.has(prior.status)) return "done";

    // Left "processing" by an instance that died, or "failed" by a real error.
    // Either way the work still owes an outcome, and every write below is
    // idempotent, so redoing it is safe.
    await prisma.webhookEvent
      .update({
        where: { provider_eventId: { provider: PROVIDER, eventId: eventKey } },
        data: { status: "processing", attempts: { increment: 1 } },
      })
      .catch(() => undefined);
    return "fresh";
  }
}

async function markEvent(eventKey: string, status: string, error?: string): Promise<void> {
  await prisma.webhookEvent
    // updateMany for its WHERE, not its many: the status filter makes a finished
    // row immovable. The claim race (two instances re-running one event) is
    // survivable because every write is idempotent — but only if the LOSER
    // finishing late cannot re-mark the winner's `processed` as `failed`, which
    // would put a completed sale back on the to-do list.
    .updateMany({
      where: {
        provider: PROVIDER,
        eventId: eventKey,
        status: { notIn: Array.from(DONE) },
      },
      data: { status, error: error ?? null, processedAt: new Date() },
    })
    .catch((e) => {
      // Best-effort, but never silent: this row is the only trace a replay tool
      // would have, and a status write that vanished without a word once made a
      // healthy queue indistinguishable from a stuck one.
      console.error(`[lemonsqueezy] could not mark ${eventKey} as ${status}:`, e);
    });
}

/**
 * Record what a subscription now IS.
 *
 * ONE handler for all eleven events, which is the design and not a shortcut.
 * Every subscription payload carries the full object with Lemon Squeezy's own
 * `status` in it, and their guide says `subscription_updated` fires at every
 * event after the first payment. Nine event-specific branches would be nine
 * chances for our idea of the state to drift from theirs, over a payload that
 * already contains the answer. So we mirror what arrived, and
 * `subscriptionGrants` reads it.
 *
 * The event name survives only in the audit row — useful when a customer and
 * support disagree about when something changed.
 */
async function handleSubscription(
  sub: ParsedSubscription,
  body: LemonSqueezyWebhook,
): Promise<Outcome> {
  // Someone else's store. Unconditional, unlike the order path's historical
  // `if (storeId && ...)`: a payload with no store id is not ours to trust.
  if (sub.storeId !== env.lemonSqueezyStoreId) {
    return { status: "skipped", reason: `store ${sub.storeId ?? "unknown"} is not ours` };
  }

  // Test-mode gating applies to GRANTING states only. An expiry or a cancellation
  // arriving from a test subscription still deserves to be written — refusing to
  // record an ending is how a test row stays live for ever.
  const granting = subscriptionGrants(
    { status: sub.status, validUntil: validUntilFrom(sub) },
    new Date(),
  );
  if (sub.testMode && !env.lemonSqueezyAllowTestMode && granting) {
    return { status: "skipped", reason: "test-mode subscription ignored here" };
  }

  const userId = await resolveSubscriptionUser(sub);
  if (!userId) {
    console.warn(`[lemonsqueezy] unmatched subscription ${sub.subscriptionId} (${sub.event})`);
    return { status: "failed", reason: `no account matches subscription ${sub.subscriptionId}` };
  }

  const validUntil = validUntilFrom(sub);
  const data = {
    status: sub.status,
    variantId: sub.variantId ?? "",
    interval: intervalForVariant(
      sub.variantId ?? "",
      env.lemonSqueezyVariantMonthly,
      env.lemonSqueezyVariantYearly,
    ),
    validUntil,
    trialEndsAt: sub.trialEndsAt,
    renewsAt: sub.renewsAt,
    endsAt: sub.endsAt,
    updatePaymentUrl: sub.updatePaymentUrl,
    customerPortalUrl: sub.customerPortalUrl,
    rawEvent: body as Prisma.InputJsonValue,
    testMode: sub.testMode,
    ...(sub.updatedAt ? { providerUpdatedAt: sub.updatedAt } : {}),
  };

  // The staleness guard, shared by both write attempts below. Lemon Squeezy
  // retries failed deliveries with backoff over HOURS, so an old event can
  // legitimately arrive after a newer one — and blindly mirroring it would
  // resurrect a cancelled state, or roll a renewal's validUntil back a month.
  // `lte`, not `lt`: two events can share a second, and a redelivery must
  // still be able to complete a row whose first write half-finished.
  const notNewer = sub.updatedAt
    ? { OR: [{ providerUpdatedAt: null }, { providerUpdatedAt: { lte: sub.updatedAt } }] }
    : {};

  // Conditional, not last-writer-wins: this event lands only if nothing newer
  // is already recorded. updateMany for its WHERE — an `upsert` cannot carry
  // the staleness condition, and a read-then-write version of this check is a
  // race between the two deliveries it exists to order.
  const updated = await prisma.subscription.updateMany({
    where: { provider: PROVIDER, externalId: sub.subscriptionId, ...notNewer },
    data,
  });

  if (updated.count === 0) {
    const existing = await prisma.subscription.findUnique({
      where: { provider_externalId: { provider: PROVIDER, externalId: sub.subscriptionId } },
      select: { id: true },
    });
    if (existing) {
      // The row exists and is NEWER than this event: a stale retry, understood
      // and deliberately dropped. Terminal — redelivering it would only ask
      // the same question again and get the same answer.
      return { status: "skipped", reason: "stale event — a newer state is already recorded" };
    }
    try {
      // `userId` is set HERE and never in an update: a later event whose custom
      // data named a different account must not MOVE the subscription.
      await prisma.subscription.create({
        data: { userId, provider: PROVIDER, externalId: sub.subscriptionId, ...data },
      });
    } catch (err) {
      // A racing instance created the row between our updateMany and create.
      // Re-run the conditional update once, against the row that now exists,
      // under the same staleness guard.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        await prisma.subscription.updateMany({
          where: { provider: PROVIDER, externalId: sub.subscriptionId, ...notNewer },
          data,
        });
      } else {
        throw err;
      }
    }
  }

  return { status: "processed" };
}

/**
 * Which account this subscription belongs to.
 *
 * `custom_data.user_id` first and by design — it is the only field we control,
 * because our own checkout put it there. The email fallback exists because a
 * subscription's LATER events (a renewal a year on) can arrive without the
 * custom data the original checkout carried, and refusing them would silently
 * stop tracking a paying customer.
 */
async function resolveSubscriptionUser(sub: ParsedSubscription): Promise<string | null> {
  // Validated BEFORE it reaches Prisma, exactly as the order path does. On
  // MongoDB a malformed id raises P2023 rather than returning null, and the
  // throw here would skip the two fallbacks below and turn every delivery for
  // that subscription into a retry loop. Reachable because a Lemon Squeezy
  // hosted-checkout URL accepts `checkout[custom][user_id]` as a query
  // parameter — so custom data is only OURS on checkouts we minted.
  if (sub.customUserId && isObjectId(sub.customUserId)) {
    const byId = await prisma.user.findUnique({
      where: { id: sub.customUserId },
      select: { id: true },
    });
    if (byId) return byId.id;
  }
  // Already recorded once? Then we know the answer without trusting an address.
  const existing = await prisma.subscription.findUnique({
    where: { provider_externalId: { provider: PROVIDER, externalId: sub.subscriptionId } },
    select: { userId: true },
  });
  if (existing) return existing.userId;

  if (!sub.email) return null;
  const byEmail = await prisma.user.findUnique({ where: { email: sub.email }, select: { id: true } });
  return byEmail?.id ?? null;
}
