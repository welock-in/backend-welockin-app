import { Router } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { env } from "../lib/env";
import { HttpError, accountGone } from "../lib/http-error";
import { readDeviceId } from "../lib/device";
import { clientIp, consumeRateLimit } from "../lib/rate-limit";
import { requireAuth } from "../middleware/auth";
import { asyncHandler } from "../middleware/async-handler";
import { assertCanWrite } from "../lib/purchase-providers";
import { RevenueCatApiError, syncUserFromRevenueCat, type RcSyncResult } from "../lib/revenuecat";
import { maskEmail } from "../lib/user";
import {
  isSellableOrder,
  parseOrderEvent,
  parseSubscriptionEvent,
  readLemonSqueezyError,
  type LemonSqueezyWebhook,
} from "../lib/lemonsqueezy";
import { lemonFetch } from "./checkout";
import { mirrorSubscriptionState, recordPaidOrder } from "./webhooks-lemonsqueezy";
import { resolveAndCache } from "./entitlement";

/*
 * /api/billing — the client-facing half of the RevenueCat integration, plus
 * the cross-provider resync.
 *
 * The webhook is the authoritative path; these routes exist for the moments a
 * client cannot wait for it: right after a purchase completes on-device (the
 * webhook may be seconds behind, and the paywall needs to dismiss NOW), and on
 * app start when a delivery might have been missed entirely.
 */

export const billingRouter = Router();

/**
 * The wire form of a sync's ownership conflict: `restoreConflict` rides ON TOP
 * of the normal EntitlementView in a 200 — the view is still the truth about
 * THIS account (which, after a conflict, holds no RC grant), and the extra
 * field is why the restore changed nothing. The iOS client renders its "this
 * purchase belongs to another account" copy from it, naming `maskedEmail` so
 * the owner can recognise their own account without the server handing a
 * stranger a full address. Null when the owner could not be looked up — the
 * copy then simply names no account.
 */
async function restoreConflictFor(
  conflict: NonNullable<RcSyncResult["conflict"]>,
): Promise<{ maskedEmail: string | null }> {
  const owner = await prisma.user
    .findUnique({ where: { id: conflict.ownerUserId }, select: { email: true } })
    .catch(() => null);
  return { maskedEmail: owner ? maskEmail(owner.email) : null };
}

/**
 * POST /api/billing/revenuecat/refresh — re-sync MY account from RevenueCat,
 * then answer with the freshly resolved entitlement.
 *
 * The subject is EXCLUSIVELY the authenticated caller. Deliberately no
 * userId from the body — accepting one would let any signed-in account
 * trigger fetches about arbitrary users, and the body is therefore not even
 * looked at.
 */
billingRouter.post(
  "/revenuecat/refresh",
  requireAuth,
  asyncHandler(async (req, res) => {
    // 503 PROVIDER_DISABLED while unconfigured — the registry's verdict, same
    // door-is-shut answer a client gets from any other closed provider.
    assertCanWrite("revenuecat");

    const userId = req.user!.id;
    let sync: RcSyncResult;
    try {
      sync = await syncUserFromRevenueCat(userId);
    } catch (err) {
      if (err instanceof RevenueCatApiError) {
        // OUR upstream failed, not the caller: a clean 502 the client can
        // retry, never a 500 that reads as a bug and never a 200 that would
        // dress a stale entitlement up as a fresh one.
        throw new HttpError(502, "RevenueCat could not be reached — try again shortly", {
          code: "UPSTREAM_UNAVAILABLE",
        });
      }
      throw err;
    }

    // A conflict is a 200, not an error: the refresh itself worked, and the
    // view below honestly says this account holds nothing. `restoreConflict`
    // is the WHY — see restoreConflictFor.
    res.json({
      ...(await resolveAndCache(userId, readDeviceId(req))),
      ...(sync.conflict ? { restoreConflict: await restoreConflictFor(sync.conflict) } : {}),
    });
  }),
);

/**
 * POST /api/billing/resync — "I've already paid": pull MY purchases from every
 * configured provider and re-run them through the normal fulfilment writers,
 * then answer with the freshly resolved entitlement.
 *
 * The case it exists for is N8: a customer paid on the website, the webhook
 * was lost or late, the /thanks deep link never fired (app closed, browser on
 * another machine), and they are staring at a paywall with no order id to type
 * anywhere. This endpoint needs nothing from them but their session.
 *
 * The subject is EXCLUSIVELY the authenticated caller, like the refresh above
 * — and here that rule is also the security model of the Lemon Squeezy leg:
 * the lookup email is the ACCOUNT's, never one from the body (the body is not
 * read at all), so a caller can only ever pull orders Lemon Squeezy itself
 * says were placed under the address they have already proven they control.
 *
 * Everything found goes through the SAME pipeline the webhook and
 * POST /checkout/confirm use — the webhook's own parsers, `recordPaidOrder`
 * and `mirrorSubscriptionState` — so a resync can never write a row those
 * paths would have written differently. The ConsumedOrder tombstones and the
 * idempotent upserts inside those writers are what make hammering this
 * endpoint safe: a re-run re-records facts, it never re-mints a grant.
 */
billingRouter.post(
  "/resync",
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = req.user!.id;

    // Tight, unlike checkout's: every hit is up to two outbound LS calls plus
    // an RC subscriber fetch against shared API-key quotas, and the legitimate
    // use is a human pressing "I've already paid" a handful of times. The IP
    // leg is the anti-farm cap — accounts are cheap.
    await consumeRateLimit(`resync:user:${userId}`, 5, 15 * 60_000);
    await consumeRateLimit(`resync:ip:${clientIp(req)}`, 10, 15 * 60_000);

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });
    if (!user) throw accountGone();

    // Only when the storefront is actually configured — the same env facts the
    // checkout guards on. Unlike checkout, silence rather than a 400: the
    // resync's other leg may still have something to say, and "this deploy
    // sells nothing through Lemon Squeezy" is a zero, not an error.
    let lemonsqueezy = 0;
    if (env.lemonSqueezyApiKey && env.lemonSqueezyStoreId) {
      lemonsqueezy = await resyncLemonSqueezy(userId, user.email.trim().toLowerCase());
    }

    // The RevenueCat leg: the same full sync the refresh route runs. An RC
    // outage makes the answer PARTIAL, never failed — the LS leg's work has
    // already landed, and throwing here would report it as lost.
    let revenuecat = false;
    let rcConflict: RcSyncResult["conflict"];
    if (env.revenuecatEnabled) {
      try {
        rcConflict = (await syncUserFromRevenueCat(userId)).conflict;
        revenuecat = true;
      } catch (err) {
        if (!(err instanceof RevenueCatApiError)) throw err;
        console.error(`[resync] RevenueCat leg failed for ${userId}: ${err.message}`);
      }
    }

    res.json({
      ...(await resolveAndCache(userId, readDeviceId(req))),
      // What was actually pulled through, so the client can say "found your
      // purchase" versus "nothing new — contact support" versus "Apple could
      // not be reached, try again".
      resynced: { lemonsqueezy, revenuecat },
      // Same field, same copy, as the refresh: the RC leg ran and found the
      // Apple purchase funding ANOTHER live account.
      ...(rcConflict ? { restoreConflict: await restoreConflictFor(rcConflict) } : {}),
    });
  }),
);

/**
 * The Lemon Squeezy leg: list this email's orders and subscriptions with OUR
 * key, and replay each through the webhook's own pipeline. Returns how many
 * actually WROTE — skips and stale/consumed refusals do not count, so the
 * number means "facts recorded", not "objects seen".
 *
 * Best-effort per call, like the RC leg: an unreachable provider logs and
 * contributes zero rather than failing a response the other leg may have
 * earned. Nothing is lost by that — the writers are idempotent and the button
 * can be pressed again.
 */
async function resyncLemonSqueezy(userId: string, email: string): Promise<number> {
  // `page[size]=10` bounds the work: this is a "find my recent payment"
  // affordance, not a bulk import — an account with more billing history than
  // that has its rows already, via the webhook.
  const filters =
    `filter[store_id]=${encodeURIComponent(env.lemonSqueezyStoreId)}` +
    `&filter[user_email]=${encodeURIComponent(email)}&page[size]=10`;
  let written = 0;

  for (const data of await listFromLemon(`/v1/orders?${filters}`, "orders")) {
    // The API order carries the same attribute names as the webhook's payload,
    // so the webhook's own parser reads it — exactly as /checkout/confirm does.
    const order = parseOrderEvent({
      meta: { event_name: "api_order_lookup" },
      data,
    } as LemonSqueezyWebhook);
    if (!order) continue;
    // The confirm path's gates, in its order: ownership, test mode, paid,
    // refunded — plus the webhook's sellable verdict, which is what routes a
    // subscription's own order_created to the subscriptions leg below instead
    // of minting a lifetime Purchase from it.
    if (order.email !== email) continue; // belt over the API filter — never record a stranger's order
    if (order.testMode && !env.lemonSqueezyAllowTestMode) continue;
    if (order.status !== "paid" || order.refunded) continue;
    if (!isSellableOrder(order).ok) continue;
    const wrote = await recordPaidOrder(order, userId, data as Prisma.InputJsonValue);
    if (wrote === "written") written += 1;
  }

  for (const data of await listFromLemon(`/v1/subscriptions?${filters}`, "subscriptions")) {
    // "subscription_updated" because that is semantically what this is — the
    // subscription's current state, fetched instead of delivered (the same
    // envelope /checkout/confirm builds).
    const sub = parseSubscriptionEvent({
      meta: {
        event_name: "subscription_updated",
        webhook_id: `resync-${String((data as { id?: unknown } | null)?.id ?? "")}`,
      },
      data,
    } as LemonSqueezyWebhook);
    if (!sub) continue;
    // The webhook's own store gate — a payload with no store id is not ours.
    if (sub.storeId !== env.lemonSqueezyStoreId) continue;
    if (sub.email !== email) continue;
    if (sub.testMode && !env.lemonSqueezyAllowTestMode) continue;
    const wrote = await mirrorSubscriptionState(sub, userId, data as Prisma.InputJsonValue);
    if (wrote === "written") written += 1;
  }

  return written;
}

/** One bounded LS list call → the `data` array, or [] on any failure (logged). */
async function listFromLemon(path: string, what: string): Promise<unknown[]> {
  let response: Response;
  try {
    response = await lemonFetch(path);
  } catch (err) {
    // Never echo the failure verbatim: the request carried the API key in a
    // header, and some fetch errors quote the request back.
    console.error(
      `[resync] Lemon Squeezy unreachable while listing ${what}:`,
      err instanceof Error ? err.message : err,
    );
    return [];
  }
  if (!response.ok) {
    console.error(
      `[resync] listing ${what} failed: HTTP ${response.status} — ${await readLemonSqueezyError(response)}`,
    );
    return [];
  }
  const body = (await response.json().catch(() => null)) as { data?: unknown[] } | null;
  return Array.isArray(body?.data) ? body.data : [];
}

/**
 * GET /api/billing/entitlement — the same view GET /api/entitlement serves,
 * under the billing namespace the mobile client reads. A thin alias on
 * purpose: two routes computing entitlement differently is how two screens
 * disagree about whether someone has paid. The original contract stays
 * untouched where it is.
 */
billingRouter.get(
  "/entitlement",
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json(await resolveAndCache(req.user!.id, readDeviceId(req)));
  }),
);
