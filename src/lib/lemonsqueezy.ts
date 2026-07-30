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
  purchasedAt: Date;
  priceUsd: number | null;
  storeId: string | null;
  variantId: string | null;
  testMode: boolean;
};

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
  const rawUserId = custom.user_id ?? custom.userId;

  return {
    event,
    orderId: String(orderId),
    eventKey: `${event}:${orderId}`,
    status: typeof attrs.status === "string" ? attrs.status : null,
    email: typeof attrs.user_email === "string" ? attrs.user_email.trim().toLowerCase() : null,
    customUserId: typeof rawUserId === "string" && rawUserId.trim() ? rawUserId.trim() : null,
    refunded: attrs.refunded === true || attrs.status === "refunded",
    refundedAt: attrs.refunded_at ? new Date(attrs.refunded_at) : null,
    purchasedAt: attrs.created_at ? new Date(attrs.created_at) : new Date(),
    // Lemon Squeezy reports money in cents.
    priceUsd: typeof attrs.total_usd === "number" ? attrs.total_usd / 100 : null,
    storeId: attrs.store_id != null ? String(attrs.store_id) : null,
    variantId: attrs.first_order_item?.variant_id != null ? String(attrs.first_order_item.variant_id) : null,
    testMode: body.meta?.test_mode === true || attrs.test_mode === true,
  };
}

/**
 * Is this an order for the thing we actually sell?
 *
 * A signature only proves the delivery came from our store — not that the buyer
 * bought the lifetime licence. Without this, any item ever added to the shop,
 * at any price, would mint one. Configuration is required rather than assumed:
 * an unset variant id means "sell nothing", not "sell everything".
 */
export function isSellableOrder(order: ParsedOrder): { ok: true } | { ok: false; reason: string } {
  if (!env.lemonSqueezyStoreId || !env.lemonSqueezyVariantId) {
    return { ok: false, reason: "store or variant id not configured" };
  }
  if (order.storeId && order.storeId !== env.lemonSqueezyStoreId) {
    return { ok: false, reason: `store ${order.storeId} is not ours` };
  }
  if (order.variantId !== env.lemonSqueezyVariantId) {
    return { ok: false, reason: `variant ${order.variantId ?? "?"} is not the lifetime licence` };
  }
  return { ok: true };
}

/** MongoDB ObjectId shape. Anything else must never reach Prisma — see the route. */
export function isObjectId(value: string): boolean {
  return /^[0-9a-f]{24}$/i.test(value);
}
