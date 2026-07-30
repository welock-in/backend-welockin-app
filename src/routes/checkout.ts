import { Router } from "express";
import { prisma } from "../lib/prisma";
import { env } from "../lib/env";
import { requireAuth } from "../middleware/auth";
import { asyncHandler } from "../middleware/async-handler";
import { accountGone, conflict, badRequest } from "../lib/http-error";

export const checkoutRouter = Router();

/** A hung outbound call on a serverless function bills until it is killed. */
const CHECKOUT_TIMEOUT_MS = 10_000;

/**
 * Mint a Lemon Squeezy checkout for the signed-in account — the sending half of
 * the desktop purchase flow, whose receiving half is the order webhook.
 *
 * WHY THE SERVER CREATES IT
 *
 * The webhook learns which account an order belongs to from
 * `meta.custom_data.user_id`, which comes back exactly as the checkout carried
 * it. If the desktop app built that URL itself, the buyer would be naming the
 * account to credit: anyone could pay once and have the licence land on someone
 * else's account, or on a throwaway they later sold. Minting it here binds the
 * order to the caller's own token before the payment page ever exists.
 *
 * The email is prefilled from the account for the same reason it is not trusted
 * later: it makes the common case match on the strong key rather than falling
 * through to the weak one.
 */
checkoutRouter.post(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!env.lemonSqueezyApiKey || !env.lemonSqueezyStoreId || !env.lemonSqueezyVariantId) {
      // Configuration, not user error — and worth being loud about, because the
      // symptom otherwise is a paywall button that silently does nothing.
      console.error("[checkout] Lemon Squeezy is not configured (api key / store / variant)");
      throw badRequest("Purchasing is not available right now.");
    }

    const userId = req.user!.id;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });
    if (!user) throw accountGone();

    // Do not send someone to pay for what they already own. This is a lifetime
    // licence: a second purchase buys nothing, and refunding it afterwards costs
    // us the fee and them the goodwill.
    const owned = await prisma.purchase.findFirst({
      where: { userId, isRefunded: false },
      select: { id: true },
    });
    if (owned) throw conflict("You already own the lifetime licence.");

    const body = {
      data: {
        type: "checkouts",
        attributes: {
          checkout_data: {
            email: user.email,
            // The whole point of this endpoint. Read back verbatim by the webhook.
            custom: { user_id: userId },
          },
        },
        relationships: {
          store: { data: { type: "stores", id: env.lemonSqueezyStoreId } },
          variant: { data: { type: "variants", id: env.lemonSqueezyVariantId } },
        },
      },
    };

    // Test vs live is decided by WHICH API KEY is configured, not by anything we
    // send: a test key can only ever create test checkouts. Saying it here too
    // would just be a second place to get it wrong.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CHECKOUT_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(`${env.lemonSqueezyApiBase}/v1/checkouts`, {
        method: "POST",
        headers: {
          Accept: "application/vnd.api+json",
          "Content-Type": "application/vnd.api+json",
          Authorization: `Bearer ${env.lemonSqueezyApiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      // Never echo the failure verbatim: the request carried the API key in a
      // header, and some fetch errors quote the request back.
      console.error("[checkout] Lemon Squeezy unreachable:", err instanceof Error ? err.message : err);
      throw badRequest("Could not reach the payment provider. Please try again.");
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      console.error(`[checkout] Lemon Squeezy refused the checkout: HTTP ${response.status}`);
      throw badRequest("Could not start the purchase. Please try again.");
    }

    const payload = (await response.json()) as { data?: { attributes?: { url?: string } } };
    const url = payload.data?.attributes?.url;
    if (!url) {
      console.error("[checkout] Lemon Squeezy returned no checkout url");
      throw badRequest("Could not start the purchase. Please try again.");
    }

    res.status(201).json({ url });
  }),
);
