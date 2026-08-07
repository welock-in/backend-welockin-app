import { Router } from "express";
import { prisma } from "../lib/prisma";
import { env } from "../lib/env";
import { checkoutSchema } from "../validation/schemas";
import { hideTestRows, subscriptionGrants } from "../lib/subscription";
import { readLemonSqueezyError, suggestVariantForPlan } from "../lib/lemonsqueezy";
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
    const { plan } = checkoutSchema.parse(req.body ?? {});

    // The NAME becomes an id here and nowhere else. A caller can ask for
    // "monthly"; it can never ask for a variant of its choosing — not a €0 test
    // variant, not another store's, not one belonging to a different product.
    // What is purchasable is fixed at deploy time, not at request time.
    const variantId =
      plan === "monthly"
        ? env.lemonSqueezyVariantMonthly
        : plan === "yearly"
          ? env.lemonSqueezyVariantYearly
          : env.lemonSqueezyVariantId;

    if (!env.lemonSqueezyApiKey || !env.lemonSqueezyStoreId || !variantId) {
      // Configuration, not user error — and worth being loud about, because the
      // symptom otherwise is a paywall button that silently does nothing. Named
      // per plan: "purchasing is broken" and "the yearly id is missing" send an
      // operator to very different places.
      console.error(`[checkout] Lemon Squeezy is not configured for plan "${plan}"`);
      throw badRequest("Purchasing is not available right now.");
    }

    const userId = req.user!.id;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });
    if (!user) throw accountGone();

    // Do not send someone to pay for what they already own. A lifetime licence
    // makes every plan pointless — a second purchase buys nothing, and refunding
    // it afterwards costs us the fee and them the goodwill.
    const owned = await prisma.purchase.findFirst({
      where: { userId, isRefunded: false, ...hideTestRows(env.lemonSqueezyAllowTestMode) },
      select: { id: true },
    });
    if (owned) throw conflict("You already own the lifetime licence.");

    // A live subscription blocks a SECOND subscription, but never the upgrade to
    // lifetime: someone paying monthly who wants to stop paying monthly is the
    // best possible customer, and refusing them is refusing money. Changing
    // between monthly and yearly is a Lemon Squeezy operation on the existing
    // subscription, not a new checkout — sending them here would leave them
    // holding two.
    if (plan !== "lifetime") {
      const subs = await prisma.subscription.findMany({
        where: { userId, ...hideTestRows(env.lemonSqueezyAllowTestMode) },
        select: { status: true, validUntil: true },
      });
      if (subs.some((sub) => subscriptionGrants(sub, new Date()))) {
        throw conflict("You already have an active subscription.");
      }
    }

    const body = {
      data: {
        type: "checkouts",
        attributes: {
          checkout_data: {
            email: user.email,
            // The whole point of this endpoint. Read back verbatim by the webhook.
            custom: { user_id: userId },
          },
          product_options: {
            // WHERE THE BROWSER LANDS AFTER PAYING. Without this the customer
            // finishes on Lemon Squeezy's own storefront with nothing pointing
            // back at the app they just bought — they paid, and the last thing
            // they see is a shop. The desktop notices the payment on its own
            // (focus + poll), but only if they think to switch back to it.
            redirect_url: `${env.publicSiteUrl}/purchase-complete`,
            receipt_link_url: `${env.publicSiteUrl}/purchase-complete`,
            receipt_button_text: "Return to welock",
            // NOT "has already unlocked". The webhook may still be in flight
            // when this is read, and stating something has happened when it has
            // not is how a working system comes to look broken.
            receipt_thank_you_note:
              "You can close this tab — welock unlocks by itself within a few seconds.",
          },
        },
        relationships: {
          store: { data: { type: "stores", id: env.lemonSqueezyStoreId } },
          variant: { data: { type: "variants", id: variantId } },
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
      const why = await readLemonSqueezyError(response);

      // A 404 here means the key cannot see the variant, the store, or both —
      // and Lemon Squeezy's own prose ("The related resource does not exist")
      // names none of them. The store holds the answer and we already have the
      // key, so ask, rather than leaving someone to diff two dashboards.
      const hint =
        response.status === 404
          ? await suggestVariantForPlan(
              plan,
              variantId,
              env.lemonSqueezyApiBase,
              env.lemonSqueezyApiKey,
              env.lemonSqueezyStoreId,
            )
          : null;

      // BOTH the log and the message. The log is for us; the message is for the
      // person staring at a button that did not work, and "please try again" is
      // false comfort when the cause is a variant id that will still be wrong on
      // the fifth try. Their prose ("Variant not found", "…is not published")
      // names the fix directly.
      console.error(
        `[checkout] Lemon Squeezy refused plan "${plan}" (variant ${variantId}, ` +
          `store ${env.lemonSqueezyStoreId}): HTTP ${response.status} — ${why}` +
          (hint ? ` — ${hint}` : ""),
      );

      // The hint names an environment variable, so it goes no further than a
      // deploy that is being exercised by us. On a live storefront the person
      // reading this is a CUSTOMER, and an env var name is both meaningless to
      // them and an invitation to think the price is negotiable.
      throw badRequest(
        hint && env.lemonSqueezyAllowTestMode
          ? `Could not start the purchase — ${why} — ${hint}`
          : `Could not start the purchase — ${why}`,
      );
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
