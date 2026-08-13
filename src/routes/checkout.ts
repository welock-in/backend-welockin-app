import { Router } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { env } from "../lib/env";
import { checkoutConfirmSchema, checkoutSchema } from "../validation/schemas";
import {
  ELIGIBILITY_MESSAGES,
  hideTestRowsFor,
  planEligibility,
  variantForPlan,
} from "../lib/subscription";
import { cancellationStates } from "../lib/billing-tasks";
import {
  CHECKOUT_TTL_MS,
  conflictingKeyPlan,
  EXPIRY_MARGIN_MS,
  IdempotencyConflict,
  markFailed,
  markReady,
  markUncertain,
  outstandingAcquisition,
  reserveAcquisition,
} from "../lib/checkout-intent";
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
import { HttpError, accountGone, badRequest, conflict, notFound } from "../lib/http-error";
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

    // OPTIONAL, and verified so rather than assumed: the Tauri desktop is the
    // only caller of this endpoint and sends exactly three headers, none of them
    // this one. Requiring it would break the entire installed base for no gain —
    // the per-account lock below already makes a double checkout impossible.
    // Bounded because it becomes a database key.
    const rawKey = req.header("Idempotency-Key");
    const idempotencyKey =
      typeof rawKey === "string" && rawKey.trim() ? rawKey.trim().slice(0, 200) : null;

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
    // ONE DECISION, SHARED WITH THE PAYWALL.
    //
    // `planEligibility` is exactly what `GET /api/subscription` renders from, so
    // this endpoint cannot refuse a purchase the status call has just advertised
    // — nor refuse it for a reason the screen never mentioned. Two copies of
    // this rule is how an API ends up saying "you may buy yearly" and then
    // answering 409 with something else.
    //
    // EVERY PLAN is evaluated, not just the requested one, because the answers
    // are not independent: a lifetime licence already owned refuses all three,
    // while a pending recurring cancellation refuses monthly and yearly and
    // leaves lifetime alone (it is not a subscription, so it cannot become a
    // second one — see the saga note on `planEligibility`).
    const subs = await prisma.subscription.findMany({
      where: { userId, ...hideTestRowsFor(userId, env) },
      select: {
        externalId: true,
        status: true,
        validUntil: true,
        // Mixed-provider query: without this, the Lemon Squeezy variant
        // allowlist inside `subscriptionGrants` would judge RevenueCat rows
        // too (see SubscriptionLike.provider).
        provider: true,
        trialEndsAt: true,
        trialCancelledAt: true,
        pauseMode: true,
        providerUpdatedAt: true,
        createdAt: true,
        variantId: true,
        updatedAt: true,
      },
    });

    // The device leg. A TrialClaim for this machine — written when its last
    // trial started (see the webhook), or by the legacy cardless-trial path —
    // means this computer has had its trial. Fails OPEN: no device id (an old
    // client, or a machine that could not identify itself) simply falls back to
    // the account leg, never a refusal.
    const [cancellations, deviceClaim, outstanding] = await Promise.all([
      cancellationStates(subs.map((sub) => sub.externalId)),
      deviceId
        ? prisma.trialClaim.findUnique({
            where: { deviceIdHash: ledgerHash(deviceId) },
            select: { id: true },
          })
        : Promise.resolve(null),
      // What the paywall would advertise. The LOCK below is what enforces it —
      // two simultaneous callers both read "nothing outstanding" here and only
      // one can win the reservation. This read exists so the refusal a second
      // request gets is the same one the status screen was already showing.
      outstandingAcquisition(userId),
    ]);

    // BEFORE the eligibility gate: a key that no longer matches its payload is a
    // broken request, not an ineligible account, and conflating the two hands the
    // client a reason code about a lock its own first call created.
    if (idempotencyKey) {
      const otherPlan = await conflictingKeyPlan(userId, idempotencyKey, plan);
      if (otherPlan) {
        throw new HttpError(409, "This Idempotency-Key was already used for a different plan.", {
          code: "IDEMPOTENCY_CONFLICT",
          details: { existingPlan: otherPlan },
        });
      }
    }

    const decision = planEligibility({
      subs,
      cancellations,
      ownsLifetime: owned != null,
      deviceHadTrial: deviceClaim != null,
      trialDays: {
        monthly: env.lemonSqueezyTrialDaysMonthly,
        yearly: env.lemonSqueezyTrialDaysYearly,
      },
      outstanding: outstanding
        ? {
            plan: outstanding.plan,
            state: outstanding.state,
            resumable: outstanding.state === "ready" && outstanding.checkoutUrl != null,
          }
        : null,
    })[plan];

    if (!decision.canPurchase) {
      throw new HttpError(409, ELIGIBILITY_MESSAGES[decision.reasonCode], {
        code: decision.reasonCode,
      });
    }
    const skipTrial = decision.trialMode === "skip";

    // ── one payable acquisition per account ──────────────────────────────────
    //
    // Taken BEFORE the provider is called and committed before it, because the
    // whole point is that a second request must find the lock already held. The
    // transaction is short and touches only our own rows: an HTTP call inside it
    // would hold a database transaction open across a network round trip, and a
    // slow provider would become a stalled database.
    const now = new Date();
    let reservation;
    try {
      reservation = await reserveAcquisition({
        userId,
        plan,
        idempotencyKey,
        now,
      });
    } catch (e) {
      if (e instanceof IdempotencyConflict) {
        // The key promised "this exact request again" and the request changed.
        // Answering with the first intent would sell the wrong plan; minting a
        // second would break the promise. Refusing is the only honest option.
        throw new HttpError(
          409,
          "This Idempotency-Key was already used for a different plan.",
          { code: "IDEMPOTENCY_CONFLICT" },
        );
      }
      throw e;
    }

    if (reservation.outcome === "reused") {
      // Already minted, still payable, same plan. Handing back the same link is
      // what makes a double-submit harmless — and it costs the provider nothing.
      res.status(201).json({
        url: reservation.intent.checkoutUrl,
        reused: true,
        intentToken: reservation.intent.token,
        expiresAt: reservation.intent.expiresAt.toISOString(),
      });
      return;
    }

    if (reservation.outcome === "uncertain") {
      // We do not know whether a payable link exists. Creating another one is
      // exactly the double payment this guards against, so the customer waits
      // until the invisible one can no longer be paid — or support settles it.
      throw new HttpError(
        409,
        "A previous checkout could not be confirmed with the payment provider. " +
          "Please wait a few minutes or contact support.",
        {
          code: "CHECKOUT_STATE_UNCERTAIN",
          details: { retryAfter: reservation.intent.expiresAt.toISOString() },
        },
      );
    }

    if (reservation.outcome === "busy") {
      throw new HttpError(
        409,
        // The client branches on `code`; this prose is the fallback. It must not
        // name an action the product cannot perform - see subscription.ts.
        "Another plan already has a payment page open. Continue that one, or " +
        "choose a different plan once it expires.",
        {
          code: "CHECKOUT_IN_PROGRESS",
          details: { plan: reservation.intent.plan },
        },
      );
    }

    const intent = reservation.intent;
    // The instant we and the provider agree the link dies. Sent to Lemon Squeezy
    // and stored locally with a margin on top, so our row never says "free"
    // while the link is still payable — that gap IS the double payment.
    const linkExpiresAt = new Date(now.getTime() + CHECKOUT_TTL_MS);
    const localExpiresAt = new Date(linkExpiresAt.getTime() + EXPIRY_MARGIN_MS);

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
            // `checkout_intent_id` comes back on the webhook and is how a
            // payment is matched to the exact intent that minted it — so a late
            // delivery closes ITS OWN acquisition and can never release a newer
            // one the customer has since started.
            custom: {
              user_id: userId,
              checkout_intent_id: intent.token,
              ...(deviceId ? { device_id: deviceId } : {}),
            },
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
          // NOT OPTIONAL FOR US, however optional the API makes it.
          //
          // Lemon Squeezy documents `expires_at` as nullable and defaulting to
          // null — "checkout URLs without an expires_at value can be used
          // indefinitely" — and it publishes NO way to invalidate a checkout
          // afterwards: the Checkouts resource has POST, GET one and GET many,
          // and nothing else. So a link minted without this is payable for ever,
          // and an account lock could never be released without risking a second
          // payable link beside a first one that still works.
          //
          // Sending it makes the death of the link a fact we know in advance —
          // including for a checkout we never saw the response to.
          expires_at: linkExpiresAt.toISOString(),
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
      // AMBIGUOUS, NOT FAILED — and the distinction is the whole safety of this.
      // A timeout or a dropped socket does not prove the checkout was not
      // created: the request may have arrived and the reply been lost. The lock
      // is kept until the link we cannot see stops being payable.
      await markUncertain(intent.id, now);
      throw new HttpError(
        503,
        "We could not confirm the checkout with the payment provider. " +
          "Please wait a few minutes before trying again.",
        { code: "CHECKOUT_STATE_UNCERTAIN" },
      );
    } finally {
      clearTimeout(timer);
    }

    // A 5xx has the same problem as a timeout: Lemon Squeezy may have created
    // the checkout and failed while telling us. Only a 4xx is a decision we can
    // read, and only a decision releases the lock.
    if (!response.ok && response.status >= 500) {
      console.error(`[checkout] Lemon Squeezy answered HTTP ${response.status} — outcome unknown`);
      await markUncertain(intent.id, now);
      throw new HttpError(
        503,
        "We could not confirm the checkout with the payment provider. " +
          "Please wait a few minutes before trying again.",
        { code: "CHECKOUT_STATE_UNCERTAIN" },
      );
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
      // A 4xx is an answer we can read: Lemon Squeezy looked at the request and
      // refused it, so no checkout exists to collide with. Releasing the lock at
      // once is safe, and making someone wait out a timeout because of a typo
      // would be gratuitous. Anything 5xx took the ambiguous path above.
      await markFailed(intent.id);
      throw badRequest(
        hint && env.lemonSqueezyAllowTestMode
          ? `Could not start the purchase — ${why} — ${hint}`
          : `Could not start the purchase — ${why}`,
      );
    }

    const payload = (await response.json()) as {
      data?: { id?: string; attributes?: { url?: string } };
    };
    const url = payload.data?.attributes?.url;
    const providerCheckoutId = payload.data?.id ?? null;
    if (!url) {
      // The provider accepted the request, so a payable checkout very likely
      // exists — we simply cannot read its link. That is the ambiguous case, not
      // a failure: releasing here would allow a second link beside it.
      console.error("[checkout] Lemon Squeezy returned no checkout url");
      await markUncertain(intent.id, now);
      throw new HttpError(
        503,
        "We could not confirm the checkout with the payment provider. " +
          "Please wait a few minutes before trying again.",
        { code: "CHECKOUT_STATE_UNCERTAIN" },
      );
    }

    // The provider agreed to our expiry, so both rows now describe the same
    // instant — plus a margin here, never less, so our side is the last to
    // consider the link dead.
    await markReady({
      intentId: intent.id,
      providerCheckoutId: providerCheckoutId ?? null,
      checkoutUrl: url,
      expiresAt: localExpiresAt,
    });
    res.status(201).json({
      url,
      reused: false,
      intentToken: intent.token,
      expiresAt: localExpiresAt.toISOString(),
    });
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

    // WHICH BRANCH, and the test is deliberately inverted.
    //
    // It used to be `order.variantId === env.lemonSqueezyVariantId` — the one
    // configured lifetime id and nothing else. A price change in Lemon Squeezy
    // mints a NEW variant id, so every order placed on the OLD one fell through
    // to the subscription branch, found no subscription for it, and answered 409
    // for ever. The customer had paid.
    //
    // So the question asked is "is this a variant we sell a SUBSCRIPTION for?".
    // Anything else is the one-time product, whatever id it happens to carry
    // today — the same reasoning `isSellableOrder` already applies on the webhook
    // side, where an unknown non-subscription variant is called "far more likely
    // OUR configuration than a foreign product". The store and the buyer's email
    // have both been verified above, so this is an order in our shop, paid by
    // this customer; the only one-time thing it can be is the lifetime licence.
    const subscriptionVariants = [
      env.lemonSqueezyVariantMonthly,
      env.lemonSqueezyVariantYearly,
      ...env.lemonSqueezyVariantsGranting,
    ].filter(Boolean);
    const isSubscriptionOrder = order.variantId != null && subscriptionVariants.includes(order.variantId);

    if (!isSubscriptionOrder) {
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
