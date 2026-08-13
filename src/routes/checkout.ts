import { Router } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { env } from "../lib/env";
import { checkoutConfirmSchema, checkoutSchema } from "../validation/schemas";
import { hideTestRowsFor, subscriptionGrants, variantForPlan } from "../lib/subscription";
import {
  parseOrderEvent,
  parseSubscriptionEvent,
  readLemonSqueezyError,
  suggestVariantForPlan,
  type LemonSqueezyWebhook,
} from "../lib/lemonsqueezy";
import { clientIp, consumeRateLimit } from "../lib/rate-limit";
import { readDeviceId, isReliableDeviceId } from "../lib/device";
import { ledgerHash } from "../lib/hash";
import { requireAuth } from "../middleware/auth";
import { asyncHandler } from "../middleware/async-handler";
import { accountGone, conflict, badRequest, notFound } from "../lib/http-error";
import { mirrorSubscriptionState, recordPaidOrder } from "./webhooks-lemonsqueezy";
import { resolveAndCache } from "./entitlement";

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

    // The NAME becomes an id here and nowhere else — via the shared helper, so
    // checkout and change-plan can never disagree about what "monthly" is. A
    // caller can ask for "monthly"; it can never ask for a variant of its
    // choosing. What is purchasable is fixed at deploy time, not at request time.
    const variantId = variantForPlan(plan, {
      monthly: env.lemonSqueezyVariantMonthly,
      yearly: env.lemonSqueezyVariantYearly,
      lifetime: env.lemonSqueezyVariantId,
    });

    if (!env.lemonSqueezyApiKey || !env.lemonSqueezyStoreId || !variantId) {
      // Configuration, not user error — and worth being loud about, because the
      // symptom otherwise is a paywall button that silently does nothing. Named
      // per plan: "purchasing is broken" and "the yearly id is missing" send an
      // operator to very different places.
      console.error(`[checkout] Lemon Squeezy is not configured for plan "${plan}"`);
      throw badRequest("Purchasing is not available right now.");
    }

    const userId = req.user!.id;
    // Minting a checkout is an authenticated outbound LS call; without a cap a
    // loop here drains the shared API-key quota and self-DoSes the payment path.
    // Generous enough that a human clicking Buy never meets it; the IP leg is the
    // anti-farm cap since accounts are cheap.
    await consumeRateLimit(`checkout:${userId}`, 30, 5 * 60_000);
    await consumeRateLimit(`checkout:ip:${clientIp(req)}`, 60, 5 * 60_000);

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });
    if (!user) throw accountGone();

    // Do not send someone to pay for what they already own. A lifetime licence
    // makes every plan pointless — a second purchase buys nothing, and refunding
    // it afterwards costs us the fee and them the goodwill.
    const owned = await prisma.purchase.findFirst({
      where: { userId, isRefunded: false, ...hideTestRowsFor(userId, env) },
      select: { id: true },
    });
    if (owned) throw conflict("You already own the lifetime licence.");

    // A live subscription blocks a SECOND subscription, but never the upgrade to
    // lifetime: someone paying monthly who wants to stop paying monthly is the
    // best possible customer, and refusing them is refusing money. Changing
    // between monthly and yearly is a Lemon Squeezy operation on the existing
    // subscription, not a new checkout — sending them here would leave them
    // holding two.
    // ONE FREE TRIAL, PER ACCOUNT *AND* PER MACHINE. Lemon Squeezy applies the
    // variant's trial to EVERY checkout for it — their docs are explicit that
    // repeat-trial prevention is the merchant's job — so a lapsed customer, or
    // someone who deletes their account and signs up again on the same PC, would
    // otherwise get a fresh free window every time. We refuse the second trial
    // in two independent ways, and EITHER is enough to trigger skip_trial:
    //
    //   • per ACCOUNT — this account already has a subscription row (any status);
    //   • per DEVICE  — this machine already has a TrialClaim (the same ledger
    //     that anchors one trial per machine forever, keyed on a KEYED hash of
    //     the device id, `deviceIdHash @unique`). The device leg is what closes
    //     the "new email on the same laptop" hole the account leg cannot see.
    //
    // Neither can stop a genuinely NEW machine with a NEW email and a NEW card —
    // that is LS's fraud territory, not ours — but together they close every
    // case reachable from one physical computer.
    // Only a device id we can safely key a per-machine decision on — a shared
    // "unidentified" fallback is treated as no id (see isReliableDeviceId).
    const rawDeviceId = readDeviceId(req);
    const deviceId = isReliableDeviceId(rawDeviceId) ? rawDeviceId : "";
    let skipTrial = false;
    if (plan !== "lifetime") {
      const subs = await prisma.subscription.findMany({
        where: { userId, ...hideTestRowsFor(userId, env) },
        select: { status: true, validUntil: true },
      });
      if (subs.some((sub) => subscriptionGrants(sub, new Date()))) {
        throw conflict("You already have an active subscription.");
      }
      const accountHadSubscription = subs.length > 0;

      // The device leg. A TrialClaim for this machine — written when its last
      // trial started (see the webhook), or by the legacy cardless-trial path —
      // means this computer has had its trial. Fails OPEN: no device id (an old
      // client, or a machine that could not identify itself) simply falls back
      // to the account leg, never a refusal.
      let deviceHadTrial = false;
      if (deviceId) {
        const claim = await prisma.trialClaim.findUnique({
          where: { deviceIdHash: ledgerHash(deviceId) },
          select: { id: true },
        });
        deviceHadTrial = claim != null;
      }

      skipTrial = accountHadSubscription || deviceHadTrial;
    }

    const body = {
      data: {
        type: "checkouts",
        attributes: {
          checkout_data: {
            email: user.email,
            // Read back verbatim by the webhook. `user_id` binds the order to
            // this account; `device_id` lets the webhook record that THIS
            // machine has now had its trial, so the next checkout from it skips
            // the trial (see the skip_trial logic above). Omitted when the
            // client sent no device id — an old build, or a machine that could
            // not identify itself.
            custom: deviceId ? { user_id: userId, device_id: deviceId } : { user_id: userId },
          },
          product_options: {
            // The RETURN PATH. Lemon Squeezy's confirmation modal shows a
            // "Continue" button pointing here — their docs are explicit that
            // this is a button, never an automatic redirect — and /thanks is a
            // bridge page on the marketing site that fires the desktop app's
            // `welockin://` deep link: the app comes to the foreground and
            // syncs its entitlement on the spot.
            //
            // An earlier version pointed this at a page that DID NOT EXIST, so
            // the last thing a paying customer saw was a 404; the version after
            // that removed the redirect entirely and leaned on polling. The
            // bridge page now ships together with this field — if /thanks ever
            // moves, move it via PUBLIC_SITE_URL, not by deleting the field,
            // because the desktop's deep-link handler is what makes the unlock
            // feel instant.
            //
            // `[order_id]` is a Lemon Squeezy LINK VARIABLE (docs: Link
            // Variables), substituted with the real order id when the button
            // renders. The bridge page threads it into the app's deep link and
            // the app hands it to POST /checkout/confirm, which verifies the
            // order against Lemon Squeezy's API with OUR key — so activation
            // works even when webhook delivery is broken or late.
            //
            // The deep link GRANTS NOTHING, order id included. It names an
            // order to VERIFY, server-side, against the caller's own account;
            // a forged welockin:// link — or a stranger opening /thanks by
            // hand — can at most cause one harmless verification of an order
            // that is not theirs, refused. The licence still arrives
            // exclusively via server-side writes and the Ed25519 receipt.
            redirect_url: `${env.publicSiteUrl}/thanks?order_id=[order_id]`,
            // The same bridge from the emailed receipt, for the customer who
            // finds it hours later with the app closed: the deep link cold-
            // starts the app, which confirms at boot.
            receipt_link_url: `${env.publicSiteUrl}/thanks?order_id=[order_id]`,
            receipt_button_text: "Open WeLockin",
            // NOT "has already unlocked". This is read the instant the card
            // clears, when the webhook may still be in flight, and stating
            // something has happened when it has not is how a working system
            // comes to look broken.
            receipt_thank_you_note:
              "Press Continue to jump back into welock — it unlocks by itself " +
              "within a few seconds.",
          },
          // Only ever present to REMOVE a trial (one-per-account, above); it can
          // never add one, so it is a no-op on the lifetime variant. Omitted
          // entirely for a first-time subscriber so they get the trial the
          // paywall promised.
          ...(skipTrial ? { checkout_options: { skip_trial: true } } : {}),
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

/** GET against the Lemon Squeezy API with our key, bounded like every LS call here. */
async function lemonFetch(path: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHECKOUT_TIMEOUT_MS);
  try {
    return await fetch(`${env.lemonSqueezyApiBase}${path}`, {
      headers: {
        Accept: "application/vnd.api+json",
        Authorization: `Bearer ${env.lemonSqueezyApiKey}`,
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Confirm a purchase the moment the buyer comes back — the ACTIVE half of
 * fulfilment, next to the webhook's passive half.
 *
 * WHY THIS EXISTS. The docs' own words on the confirmation button are
 * "customers might not click… use webhooks for fulfilling" — and the first
 * field test showed the mirror problem: a webhook can be misconfigured,
 * unregistered in one of the two mode graphs, or simply late, and then a paid
 * customer sits in front of a wall that says "unlocking…" for ever. So the
 * return path carries Lemon Squeezy's own `[order_id]` link variable, and this
 * endpoint VERIFIES it at the source: it asks the Lemon Squeezy API — with OUR
 * key, over TLS, server-side — what that order is, and only then writes,
 * through the exact same idempotent writers the webhook uses. Neither path
 * needs the other; whichever runs second finds nothing left to do.
 *
 * WHAT THE CALLER'S ORDER ID IS WORTH: nothing, and the design assumes it. It
 * crossed two user-editable URLs, so it is a CLAIM — "order N is mine" — and
 * every part of that claim is checked against Lemon Squeezy's record: the
 * order must belong to OUR store, be PAID, not be refunded, respect the
 * test-mode gate, and carry the CALLER'S OWN account email (the checkout
 * prefilled it; the webhook's custom user_id remains the strong key for the
 * path that has it). A stranger's order id names an order whose email is not
 * yours: refused, logged, nothing written.
 */
checkoutRouter.post(
  "/confirm",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { orderId } = checkoutConfirmSchema.parse(req.body ?? {});

    if (!env.lemonSqueezyApiKey || !env.lemonSqueezyStoreId) {
      console.error("[checkout-confirm] Lemon Squeezy is not configured");
      throw badRequest("Purchasing is not available right now.");
    }

    const userId = req.user!.id;
    // Bounded: every hit is 1-2 outbound LS calls, the desktop retries for a
    // minute by design, and LS rate-limits our key — 60/5min absorbs the whole
    // retry burst several times over without letting a loop drain the quota.
    // The IP leg is the anti-farm cap: accounts are cheap, so a per-user limit
    // alone lets one host multiply the outbound rate by spinning up accounts.
    await consumeRateLimit(`checkout-confirm:${userId}`, 60, 5 * 60_000);
    await consumeRateLimit(`checkout-confirm:ip:${clientIp(req)}`, 120, 5 * 60_000);

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });
    if (!user) throw accountGone();

    const orderRes = await lemonFetch(`/v1/orders/${orderId}`).catch((err) => {
      console.error(
        "[checkout-confirm] Lemon Squeezy unreachable:",
        err instanceof Error ? err.message : err,
      );
      throw badRequest("Could not reach the payment provider. Please try again.");
    });
    if (orderRes.status === 404) throw notFound("We can't find that order.");
    if (!orderRes.ok) {
      const why = await readLemonSqueezyError(orderRes);
      console.error(`[checkout-confirm] order ${orderId} lookup failed: HTTP ${orderRes.status} — ${why}`);
      throw badRequest("Could not verify the purchase. Please try again.");
    }

    const orderBody = (await orderRes.json()) as { data?: unknown };
    // The API order carries the same attribute names as the webhook's order
    // payload, so the webhook's own parser reads it — one parser, one shape.
    const order = parseOrderEvent({
      meta: { event_name: "api_order_lookup" },
      data: orderBody?.data,
    } as LemonSqueezyWebhook);
    if (!order) throw badRequest("Could not read that order.");

    // ── The ownership gate comes FIRST, and everything below it can only ever
    // describe the CALLER'S OWN order ──────────────────────────────────────
    //
    // Two checks, one answer. A guesser probing sequential order ids must not be
    // able to tell "your order, unpaid" from "someone else's paid order" from
    // "no such order" — that trio is an existence-and-revenue oracle. So BOTH a
    // foreign store AND an email that is not the caller's collapse to the exact
    // same 404 as a nonexistent order, and they are checked BEFORE the
    // informative test-mode / status branches. The result: those helpful errors
    // are only ever returned about an order the caller genuinely owns.
    //
    // The checkout prefilled the account email, so a real buyer always matches.
    // The rare legit miss — a buyer who typed a different email over the prefill
    // — is distinguished only in the LOG (for support), never in the response.
    const caller = user.email.trim().toLowerCase();
    const mine = order.storeId === env.lemonSqueezyStoreId && !!order.email && order.email === caller;
    if (!mine) {
      if (order.storeId === env.lemonSqueezyStoreId && order.email && order.email !== caller) {
        console.warn(
          `[checkout-confirm] order ${orderId} belongs to a different email than account ${userId} ` +
            `— returning 404 (support can attach it manually)`,
        );
      }
      throw notFound("We can't find that order.");
    }

    if (order.testMode && !env.lemonSqueezyAllowTestMode) {
      throw badRequest("That order was made in test mode.");
    }
    // "pending" settles on its own and the desktop retries; everything else
    // (failed, fraudulent) will never become a licence.
    if (order.status !== "paid") {
      throw conflict(
        order.status === "pending"
          ? "The payment hasn't settled yet — trying again in a few seconds usually does it."
          : "That order was not paid.",
      );
    }

    if (order.variantId && order.variantId === env.lemonSqueezyVariantId) {
      // The lifetime licence. Refunded is checked HERE because recordPaidOrder
      // mints isRefunded:false — the webhook never meets this case (its refund
      // events revoke), but this endpoint can be called about an old order.
      if (order.refunded) throw conflict("That order was refunded.");
      const wrote = await recordPaidOrder(order, userId, orderBody as Prisma.InputJsonValue);
      if (wrote === "already-consumed") {
        throw conflict("That order has already been used to activate an account.");
      }
    } else {
      // A subscription order: the grantable object is the subscription it
      // created, so fetch THAT and mirror it — state, dates, portal URLs —
      // exactly as a subscription_updated webhook would.
      const subsRes = await lemonFetch(
        `/v1/subscriptions?filter[order_id]=${orderId}&page[size]=10`,
      ).catch((err) => {
        console.error(
          "[checkout-confirm] Lemon Squeezy unreachable:",
          err instanceof Error ? err.message : err,
        );
        throw badRequest("Could not reach the payment provider. Please try again.");
      });
      if (!subsRes.ok) {
        const why = await readLemonSqueezyError(subsRes);
        console.error(
          `[checkout-confirm] subscriptions for order ${orderId} failed: HTTP ${subsRes.status} — ${why}`,
        );
        throw badRequest("Could not verify the subscription. Please try again.");
      }
      const subsBody = (await subsRes.json()) as { data?: Array<{ attributes?: { store_id?: number } }> };
      const subData =
        (subsBody.data ?? []).find(
          (d) => String(d?.attributes?.store_id ?? "") === env.lemonSqueezyStoreId,
        ) ?? null;
      if (!subData) {
        // Right after payment the subscription can trail the order by a
        // moment; the desktop's bounded retry absorbs that. If it never
        // appears, the order bought something that is neither the lifetime
        // variant nor a subscription — config drift worth a loud log.
        console.warn(
          `[checkout-confirm] order ${orderId} (variant ${order.variantId ?? "?"}) has no subscription yet`,
        );
        throw conflict("The subscription is still being set up — try again in a few seconds.");
      }
      // Read through the webhook's own parser: the API subscription object
      // carries the same attribute names as a subscription event's payload.
      // "subscription_updated" because that is semantically what this is — the
      // subscription's current state, fetched instead of delivered.
      const sub = parseSubscriptionEvent({
        meta: { event_name: "subscription_updated", webhook_id: `confirm-${orderId}` },
        data: subData,
      } as LemonSqueezyWebhook);
      if (!sub) throw badRequest("Could not read the subscription.");
      if (sub.testMode && !env.lemonSqueezyAllowTestMode) {
        throw badRequest("That order was made in test mode.");
      }
      const wrote = await mirrorSubscriptionState(sub, userId, subData as Prisma.InputJsonValue);
      if (wrote === "already-consumed") {
        throw conflict("That subscription has already been used to activate an account.");
      }
    }

    // The whole answer, receipt included, so the caller's very next paint can
    // be the unlocked app rather than a second round trip.
    res.json(await resolveAndCache(userId, readDeviceId(req)));
  }),
);
