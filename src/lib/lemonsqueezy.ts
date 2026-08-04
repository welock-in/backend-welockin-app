import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "./env";

/**
 * Lemon Squeezy — the desktop storefront.
 *
 * WeLockIn sells one thing here: a lifetime licence for the macOS and Windows
 * builds, which ship outside the App Store and therefore neither have to use, nor
 * can use, store IAP. iOS keeps going through Adapty because Apple requires it.
 *
 * This module proves a delivery really came from Lemon Squeezy and reads the few
 * fields we care about. What a payment MEANS is the route's business.
 */

/** Events we act on. Anything else is recorded and skipped, never guessed at. */
export const HANDLED_EVENTS = ["order_created", "order_refunded"] as const;
export type HandledEvent = (typeof HANDLED_EVENTS)[number];

/**
 * Is this signature genuinely Lemon Squeezy's?
 *
 * HMAC-SHA256 over the RAW request bytes, compared in constant time.
 *
 * The raw body matters more than it looks: JSON.parse then re-serialise is not
 * byte-identical to what was sent (key order, unicode escaping, number
 * formatting), so hashing the parsed object rejects every genuine delivery. The
 * seductive fix for "signatures never match" is to stop checking them, and this
 * endpoint hands out paid licences — so the raw buffer is captured in app.ts and
 * threaded through here instead.
 *
 * Fails CLOSED on everything: no body, no header, no configured secret. An
 * unconfigured backend must refuse every delivery, never accept every delivery.
 */
export function verifyWebhookSignature(rawBody: Buffer | undefined, signature: string | undefined): boolean {
  if (!rawBody || rawBody.length === 0) return false;
  if (!signature || !env.lemonSqueezyWebhookSecret) return false;

  // Buffer.from(str, "hex") does NOT throw on malformed input — it stops at the
  // first bad pair and returns a SHORT buffer. "zz" yields zero bytes. So the
  // shape is checked before decoding rather than trusted afterwards.
  if (!/^[0-9a-f]{64}$/i.test(signature)) return false;

  const expected = createHmac("sha256", env.lemonSqueezyWebhookSecret).update(rawBody).digest();
  const received = Buffer.from(signature, "hex");
  if (received.length !== expected.length) return false;
  return timingSafeEqual(received, expected);
}

/** The shape we rely on. Everything optional: this is someone else's payload. */
export type LemonSqueezyWebhook = {
  meta?: {
    event_name?: string;
    test_mode?: boolean;
    custom_data?: Record<string, unknown>;
  };
  data?: {
    id?: string;
    attributes?: {
      user_email?: string;
      status?: string;
      refunded?: boolean;
      refunded_at?: string | null;
      total_usd?: number;
      refunded_amount_usd?: number;
      created_at?: string;
      test_mode?: boolean;
      store_id?: number;
      first_order_item?: { product_id?: number; variant_id?: number };
    };
  };
};

export type ParsedOrder = {
  event: string;
  /** Lemon Squeezy's order id — stable across replay and refund. */
  orderId: string;
  /** Dedupe key: the same event for the same order lands once. */
  eventKey: string;
  /**
   * Lemon Squeezy's own order status. "paid" is the only one that owes anyone a
   * licence — an order row exists from the moment checkout starts, and some
   * payment methods sit in "pending" for days or fail outright.
   */
  status: string | null;
  email: string | null;
  /** WeLockIn user id, when our checkout put one there. */
  customUserId: string | null;
  refunded: boolean;
  refundedAt: Date | null;
  /**
   * How much came back, in the same unit as `priceUsd`.
   *
   * Load-bearing, not informational: `order_refunded` fires for a PARTIAL refund
   * too, so without this a one-euro goodwill gesture on a twenty-euro order was
   * indistinguishable from giving the whole thing back — and revoked the licence
   * of a customer who had paid in full and kept nineteen euros of it.
   */
  refundedAmountUsd: number | null;
  purchasedAt: Date;
  priceUsd: number | null;
  storeId: string | null;
  variantId: string | null;
  testMode: boolean;
};

/**
 * Does this refund end the licence, or is it a partial gesture?
 *
 * Lemon Squeezy fires `order_refunded` for BOTH, and the difference is the whole
 * question: a one-euro goodwill refund on a twenty-euro order must not revoke
 * anything, while a full refund must revoke immediately.
 *
 * The order of the tests matters. `status` is Lemon Squeezy's own verdict and is
 * believed first — it distinguishes `refunded` from `partial_refund` explicitly.
 * Only when the status is unhelpful do we compare amounts, and only when BOTH
 * numbers are present: comparing against a missing total would make every refund
 * look total.
 *
 * The final fallback is REVOKE. That is deliberate and it is the uncomfortable
 * choice: a payment we cannot classify is more likely to be a real refund than a
 * partial one, and refusing to revoke a genuine refund means shipping the product
 * for free. A wrongly-revoked customer writes in and support restores them; a
 * wrongly-kept licence is never noticed.
 */
export function isFullRefund(order: ParsedOrder): boolean {
  if (order.status === "partial_refund") return false;
  if (order.status === "refunded") return true;

  const back = order.refundedAmountUsd;
  const total = order.priceUsd;
  if (back != null && total != null && total > 0) {
    // A hair of tolerance for currency conversion and rounding: Lemon Squeezy
    // reports in cents, and a refund of the full amount can land a cent short.
    return back >= total - 0.01;
  }
  return true;
}

/**
 * `custom_data` is untyped by contract — it is whatever the checkout put there,
 * echoed back by someone else's server.
 *
 * Deliberately string-only, even though Lemon Squeezy's docs are ambiguous about
 * whether numeric custom values round-trip as numbers: a WeLockIn user id is a
 * 24-hex ObjectId, which is never a JSON number, so coercing one would produce a
 * value `isObjectId` rejects a moment later. Same outcome, more code.
 */
function coerceCustomId(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * A timestamp we cannot parse must become `null`, never an Invalid Date.
 *
 * Prisma throws on an Invalid Date, the throw leaves the route as a 500, and a
 * 500 is an instruction to redeliver — so one malformed field would turn a single
 * order into a retry loop that never converges and never grants anything.
 */
function parseDate(value: unknown): Date | null {
  if (typeof value !== "string" || !value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Pull out what we need, or null when the payload is not something we can act on.
 *
 * Strict about the order id in particular: it is what the whole idempotency story
 * rests on, and a Purchase keyed on `undefined` would collapse every customer's
 * licence onto a single row.
 */
export function parseOrderEvent(body: LemonSqueezyWebhook): ParsedOrder | null {
  const event = body.meta?.event_name;
  const orderId = body.data?.id;
  const attrs = body.data?.attributes;
  if (!event || !orderId || !attrs) return null;

  const custom = body.meta?.custom_data ?? {};

  return {
    event,
    orderId: String(orderId),
    eventKey: `${event}:${orderId}`,
    status: typeof attrs.status === "string" ? attrs.status : null,
    email: typeof attrs.user_email === "string" ? attrs.user_email.trim().toLowerCase() : null,
    customUserId: coerceCustomId(custom.user_id) ?? coerceCustomId(custom.userId),
    refunded: attrs.refunded === true || attrs.status === "refunded",
    refundedAt: parseDate(attrs.refunded_at),
    refundedAmountUsd:
      typeof attrs.refunded_amount_usd === "number" ? attrs.refunded_amount_usd / 100 : null,
    // Falling back to "now" is right for a missing field and wrong for a broken
    // one, but both are better than storing a date arithmetic cannot use.
    purchasedAt: parseDate(attrs.created_at) ?? new Date(),
    // Lemon Squeezy reports money in cents.
    priceUsd: typeof attrs.total_usd === "number" ? attrs.total_usd / 100 : null,
    storeId: attrs.store_id != null ? String(attrs.store_id) : null,
    variantId: attrs.first_order_item?.variant_id != null ? String(attrs.first_order_item.variant_id) : null,
    // `data.attributes.test_mode` is the field the official example payloads
    // actually carry; `meta.test_mode` is undocumented, so it is the fallback
    // rather than the primary — but either one saying "test" is enough.
    testMode: attrs.test_mode === true || body.meta?.test_mode === true,
  };
}

export type SellableVerdict =
  | { ok: true }
  /**
   * `retryable` separates "this order is not for us" from "we were not ready for
   * it". The first is a permanent, correct refusal; the second is our own
   * misconfiguration, and recording it as permanent is how a paid order becomes
   * unrecoverable — see the route's `skipped` handling.
   */
  | { ok: false; reason: string; retryable: boolean };

/**
 * Is this an order for the thing we actually sell?
 *
 * A signature only proves the delivery came from our store — not that the buyer
 * bought the lifetime licence. Without this, any item ever added to the shop,
 * at any price, would mint one. Configuration is required rather than assumed:
 * an unset variant id means "sell nothing", not "sell everything".
 */
export function isSellableOrder(order: ParsedOrder): SellableVerdict {
  if (!env.lemonSqueezyStoreId || !env.lemonSqueezyVariantId) {
    // OUR fault, not the order's — and the customer has already been charged.
    // Retryable, so that fixing the config and redelivering from the dashboard
    // still grants the licence.
    return { ok: false, reason: "store or variant id not configured", retryable: true };
  }
  if (order.storeId && order.storeId !== env.lemonSqueezyStoreId) {
    return { ok: false, reason: `store ${order.storeId} is not ours`, retryable: false };
  }
  if (order.variantId !== env.lemonSqueezyVariantId) {
    return {
      ok: false,
      reason: `variant ${order.variantId ?? "?"} is not the lifetime licence`,
      retryable: false,
    };
  }
  return { ok: true };
}

/** MongoDB ObjectId shape. Anything else must never reach Prisma — see the route. */
export function isObjectId(value: string): boolean {
  return /^[0-9a-f]{24}$/i.test(value);
}
