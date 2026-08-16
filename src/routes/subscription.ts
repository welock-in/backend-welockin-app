import { Router } from "express";
import { prisma } from "../lib/prisma";
import { env } from "../lib/env";
import {
  hideTestRowsFor,
  subscriptionGrants,
  subscriptionIsLive,
  variantForPlan,
} from "../lib/subscription";
import { loadEligibilityInputs, purchaseEligibilityFrom } from "../lib/eligibility-io";
import { readDeviceId } from "../lib/device";
import { requireAuth } from "../middleware/auth";
import { asyncHandler } from "../middleware/async-handler";
import { badRequest, conflict, HttpError, subscriptionPortalRequired } from "../lib/http-error";
import { readLemonSqueezyError } from "../lib/lemonsqueezy";
import { changePlanSchema } from "../validation/schemas";
import { clientIp, consumeRateLimit } from "../lib/rate-limit";

export const subscriptionRouter = Router();

/** A hung outbound call on a serverless function bills until it is killed. */
const LS_TIMEOUT_MS = 10_000;

const PROVIDER = "lemonsqueezy";

/**
 * The portal page that CAN change a PayPal-backed subscription.
 *
 * Lemon Squeezy refuses to PATCH a subscription whose payment method is a
 * PayPal billing agreement — every update answers 422, because the change has
 * to go through PayPal's own consent flow — and instead exposes a signed
 * `customer_portal_update_subscription` URL on the subscription object.
 * Fetched at the moment it is needed, like `GET /portal`, because the
 * signature expires after 24 hours.
 *
 * Best-effort by design: null on any failure, and the caller falls back to the
 * generic refusal — a broken re-fetch must not bury the original error.
 */
async function portalUpdateSubscriptionUrl(externalId: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LS_TIMEOUT_MS);
  try {
    const response = await fetch(`${env.lemonSqueezyApiBase}/v1/subscriptions/${externalId}`, {
      method: "GET",
      headers: {
        Accept: "application/vnd.api+json",
        Authorization: `Bearer ${env.lemonSqueezyApiKey}`,
      },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const body = (await response.json()) as {
      data?: { attributes?: { urls?: { customer_portal_update_subscription?: string } } };
    };
    return body.data?.attributes?.urls?.customer_portal_update_subscription ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Turn a refused PATCH into the answer the client can act on, when there is one.
 *
 * A 422 is Lemon Squeezy refusing the OPERATION, not the request shape — and
 * for a PayPal-backed subscription it refuses every PATCH. When that is the
 * story, the subscription carries the portal page that can make the change,
 * and the client gets a 409 SUBSCRIPTION_PORTAL_REQUIRED with that URL instead
 * of a dead-end 400. Any other failure — or a 422 with no portal URL to offer
 * — falls through to the caller's generic error.
 */
async function throwPortalRequiredIfPayPal(status: number, externalId: string): Promise<void> {
  if (status !== 422) return;
  const url = await portalUpdateSubscriptionUrl(externalId);
  if (url) throw subscriptionPortalRequired(url);
}

/**
 * "Pay now" — end the free trial immediately and take the payment.
 *
 * WHY THIS ENDPOINT HAS TO EXIST. A customer on a card-backed trial has already
 * given us a card, so there is nothing for them to "buy" — the charge is
 * scheduled and will happen on its own. Lemon Squeezy's customer portal reflects
 * that: it can change plan, update the card, pause and cancel, and it has no
 * button that says pay me now. So a "Pay now" that opens the portal is a dead
 * end, and a "Pay now" that opens a fresh checkout is worse — it sells the same
 * person a SECOND subscription.
 *
 * The only thing that actually converts a trial early is Lemon Squeezy's own
 * update endpoint: move `trial_ends_at` to now, and ask for the invoice to be
 * raised immediately instead of at the next renewal.
 *
 * WHAT THE WEBHOOK'S JOB IS HERE, since it is easy to get backwards: the webhook
 * does not decide anything. This call is the decision; Lemon Squeezy charges the
 * card and then TELLS us, via `subscription_updated` (status leaves `on_trial`)
 * and `subscription_payment_success`. Our existing single handler mirrors
 * whatever arrives, so no new webhook branch is needed — which is exactly why
 * one handler for all twelve events was worth building.
 *
 * THE SUBSCRIPTION IS FOUND BY THE CALLER'S TOKEN, never named by the request.
 * A subscription id from the client would let anyone end — and charge — a
 * stranger's trial.
 */
subscriptionRouter.post(
  "/end-trial",
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!env.lemonSqueezyApiKey) {
      console.error("[subscription] cannot end a trial: no Lemon Squeezy API key");
      throw badRequest("Billing is not available right now.");
    }

    const userId = req.user!.id;
    // Test rows are hidden here for the same reason the resolver hides them:
    // once LEMONSQUEEZY_ALLOW_TEST_MODE goes off, a leftover test subscription
    // must stop existing everywhere at once — and this endpoint in particular
    // would otherwise try to INVOICE a test subscription through the live key.
    const subs = await prisma.subscription.findMany({
      where: { userId, provider: PROVIDER, ...hideTestRowsFor(userId, env) },
      select: {
        externalId: true,
        status: true,
        validUntil: true,
        trialEndsAt: true,
        trialCancelledAt: true,
        pauseMode: true,
        providerUpdatedAt: true,
        createdAt: true,
        variantId: true,
        updatedAt: true,
      },
    });

    const now = new Date();
    // Manageability, not access — with one condition kept from the access rules
    // because this endpoint TAKES MONEY: the trial window must still be open.
    // Converting a row whose window has lapsed would charge a customer on the
    // strength of a stale record, and the two ways to get here are both benign
    // (a second click, or a trial that converted between drawing the button and
    // pressing it). Everything else `subscriptionGrants` would refuse — an
    // unrecognised variant, a void pause — is about entitlement, not about
    // whether Lemon Squeezy will honour this charge.
    const trial = subs.find(
      (sub) =>
        sub.status === "on_trial" &&
        subscriptionIsLive(sub) &&
        (sub.validUntil == null || sub.validUntil.getTime() > now.getTime()),
    );
    if (!trial) {
      // Not an error worth a 500, and not something a retry fixes. The two ways
      // to get here are both benign: a second click, and a customer whose trial
      // converted between drawing the button and pressing it.
      throw conflict("There is no free trial to end on this account.");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LS_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(`${env.lemonSqueezyApiBase}/v1/subscriptions/${trial.externalId}`, {
        method: "PATCH",
        headers: {
          Accept: "application/vnd.api+json",
          "Content-Type": "application/vnd.api+json",
          Authorization: `Bearer ${env.lemonSqueezyApiKey}`,
        },
        body: JSON.stringify({
          data: {
            type: "subscriptions",
            id: String(trial.externalId),
            attributes: {
              // Now, not null. `null` also clears the trial, but it goes through
              // the billing-anchor path and the semantics of that are theirs to
              // change; an explicit timestamp says exactly what we mean.
              trial_ends_at: now.toISOString(),
              // Without this the trial ends and the charge still waits for the
              // next renewal — which is the whole thing the customer asked to
              // skip, and would leave them having pressed "Pay now" and paid
              // nothing.
              invoice_immediately: true,
            },
          },
        }),
        signal: controller.signal,
      });
    } catch (err) {
      // Never echo the failure verbatim: the request carried the API key in a
      // header, and some fetch errors quote the request back.
      console.error(
        "[subscription] Lemon Squeezy unreachable:",
        err instanceof Error ? err.message : err,
      );
      throw badRequest("Could not reach the payment provider. Please try again.");
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const why = await readLemonSqueezyError(response);
      console.error(
        `[subscription] Lemon Squeezy refused to end trial ${trial.externalId}: ` +
          `HTTP ${response.status} — ${why}`,
      );
      await throwPortalRequiredIfPayPal(response.status, trial.externalId);
      throw badRequest(`Could not take the payment — ${why}`);
    }

    // Deliberately NOT writing the Subscription row here. The webhook is the one
    // writer, and it carries `updated_at` — which the staleness guard compares
    // against. A write from this side would race it with no stamp to order by,
    // and the loser would be whichever arrived second rather than whichever is
    // newer. The client re-reads /api/entitlement, and the webhook lands within
    // seconds.
    res.status(202).json({ ok: true });
  }),
);

/**
 * What this account is paying, so the settings screen can say it without
 * guessing. Read-only; the money endpoints are below.
 */
subscriptionRouter.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = req.user!.id;
    // ONE set of reads, shared with POST /api/checkout and the entitlement view
    // (lib/eligibility-io.ts) — and ALL providers' rows, which is the fix for a
    // real dead end: this screen used to read Lemon Squeezy only, so an Apple
    // subscriber was told monthly was purchasable and then 409'd at checkout,
    // which had been reading both providers all along.
    const io = await loadEligibilityInputs(userId, readDeviceId(req));

    const now = new Date();
    // The row the settings screen should describe: the GRANTING one first (the
    // plan the customer is living on), else any still-live one — what the
    // customer is PAYING is not the same as what grants them access, and a
    // screen that hides a subscription because it stopped granting is a screen
    // with no cancel button on a card that is still being charged.
    const live =
      io.subs.find((sub) => subscriptionGrants(sub, now)) ??
      io.subs.find(subscriptionIsLive) ??
      null;
    // Which store the row lives at, for the client's copy — and for the two
    // flags below, because the server can only ACT on Lemon Squeezy rows.
    const provider: "lemonsqueezy" | "revenuecat" =
      live?.provider === "revenuecat" ? "revenuecat" : "lemonsqueezy";

    res.json({
      // WHETHER THIS ACCOUNT MAY BUY, per plan, as codes the client branches on.
      //
      // Deliberately not derivable from the fields below, and deliberately not
      // one verdict for the whole account. A customer on a live monthly plan may
      // not buy yearly — Change plan is the route — yet may buy lifetime, and a
      // single `canPurchase` has to be wrong about one of them. Computed by the
      // SAME function, from the SAME reads, the checkout enforces, so this
      // cannot advertise a purchase that the next request refuses.
      purchaseEligibility: purchaseEligibilityFrom(io),
      subscription: live && {
        status: live.status,
        interval: live.interval,
        // Already cancelled: this is when it actually stops. Null otherwise.
        endsAt: live.endsAt?.toISOString() ?? null,
        renewsAt: live.renewsAt?.toISOString() ?? null,
        trialEndsAt: live.trialEndsAt?.toISOString() ?? null,
        validUntil: live.validUntil?.toISOString() ?? null,
        // ADDITIVE: the shipped desktop ignores fields it does not know.
        provider,
        // Whether "Cancel" should be offered. A row already cancelled is running
        // out its grace period and has nothing left to cancel; on trial it IS
        // cancellable — that is how the customer says "don't charge me". And an
        // Apple subscription is NEVER cancellable from here: only the customer
        // can cancel it, on the device, at Apple — offering the button would
        // promise an action the server cannot perform.
        cancellable: provider === "revenuecat" ? false : live.status !== "cancelled",
        // Whether "Reactivate" should be offered: a cancelled Lemon Squeezy
        // subscription still inside its paid-through window can be un-cancelled
        // (POST /reactivate). Same Apple rule as above — and an RC row is never
        // status "cancelled" anyway (see lib/revenuecat.ts).
        //
        // STILL GRANTING is part of the offer, not decoration. A cancelled row
        // PAST its window is still "live" (it has not flipped to `expired` yet),
        // so it is still the display row — but POST /reactivate filters on
        // `subscriptionGrants` and would answer 409. The flag must make the same
        // test, or this screen draws a button that leads to a guaranteed refusal.
        reactivatable:
          provider === "revenuecat"
            ? false
            : live.status === "cancelled" && subscriptionGrants(live, now),
      },
    });
  }),
);

/**
 * A LIVE customer-portal link, fetched from Lemon Squeezy at the moment it is
 * asked for.
 *
 * WHY IT CANNOT BE THE STORED ONE. Lemon Squeezy SIGNS the portal URL and it
 * expires after 24 hours. We persist it on every webhook, and the entitlement
 * response hands that stored copy out as `billingUrl` — which is fine for a
 * customer whose subscription changed today, and a dead link for everyone else.
 * Since most accounts go weeks between events, "Manage billing" was broken for
 * almost everyone almost always, in the way that is hardest to notice: the
 * button works, the page just refuses.
 *
 * So the row's copy stays (it is a useful last-known value for support) and this
 * endpoint is what the app opens. The fresh URLs are written back on the way
 * past, because a value we just learned is worth keeping.
 */
subscriptionRouter.get(
  "/portal",
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!env.lemonSqueezyApiKey) {
      console.error("[subscription] cannot fetch a portal link: no Lemon Squeezy API key");
      throw badRequest("Billing is not available right now.");
    }

    // Every request here is an authenticated outbound Lemon Squeezy call plus a
    // write, and — unlike /cancel or /end-trial — it never transitions into a
    // state that refuses a repeat, so a loop is unbounded. Same two-leg cap the
    // sibling money routes use: generous for a human pressing a button, fatal to
    // a script draining the shared API quota.
    await consumeRateLimit(`portal:${req.user!.id}`, 30, 5 * 60_000);
    await consumeRateLimit(`portal:ip:${clientIp(req)}`, 60, 5 * 60_000);

    const subs = await prisma.subscription.findMany({
      where: { userId: req.user!.id, provider: PROVIDER, ...hideTestRowsFor(req.user!.id, env) },
      select: {
        id: true,
        externalId: true,
        status: true,
        validUntil: true,
        trialEndsAt: true,
        trialCancelledAt: true,
        pauseMode: true,
        providerUpdatedAt: true,
        createdAt: true,
        variantId: true,
        updatedAt: true,
        customerPortalUrl: true,
        updatePaymentUrl: true,
      },
      orderBy: { updatedAt: "desc" },
    });

    // Found from the TOKEN, never named by the request — a subscription id in
    // the query would hand anyone a portal link into a stranger's billing.
    const now = new Date();
    const live = subs.find(subscriptionIsLive) ?? subs[0];
    if (!live) throw conflict("There is no subscription on this account.");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LS_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(`${env.lemonSqueezyApiBase}/v1/subscriptions/${live.externalId}`, {
        method: "GET",
        headers: {
          Accept: "application/vnd.api+json",
          Authorization: `Bearer ${env.lemonSqueezyApiKey}`,
        },
        signal: controller.signal,
      });
    } catch (err) {
      console.error(
        "[subscription] Lemon Squeezy unreachable while fetching a portal link:",
        err instanceof Error ? err.message : err,
      );
      // Fall back to the stored copy rather than leaving them with nothing: it
      // may be expired, but "possibly stale" beats "no link at all".
      if (live.customerPortalUrl ?? live.updatePaymentUrl) {
        res.json({ url: live.customerPortalUrl ?? live.updatePaymentUrl, fresh: false });
        return;
      }
      throw badRequest("Could not reach the payment provider. Please try again.");
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const why = await readLemonSqueezyError(response);
      console.error(
        `[subscription] Lemon Squeezy refused to describe ${live.externalId}: ` +
          `HTTP ${response.status} — ${why}`,
      );
      if (live.customerPortalUrl ?? live.updatePaymentUrl) {
        res.json({ url: live.customerPortalUrl ?? live.updatePaymentUrl, fresh: false });
        return;
      }
      throw badRequest(`Could not open billing — ${why}`);
    }

    let portal: string | null = null;
    let payment: string | null = null;
    try {
      const body = (await response.json()) as {
        data?: { attributes?: { urls?: { customer_portal?: string; update_payment_method?: string } } };
      };
      portal = body.data?.attributes?.urls?.customer_portal ?? null;
      payment = body.data?.attributes?.urls?.update_payment_method ?? null;
    } catch {
      /* handled by the null check below */
    }

    const url = portal ?? payment ?? live.customerPortalUrl ?? live.updatePaymentUrl;
    if (!url) throw badRequest("Could not open billing right now.");

    // Keep what we just learned. Best-effort: a failed write costs the next
    // request a round trip, not this one its answer. `providerUpdatedAt` is left
    // alone so this cannot outrank a real event in the staleness guard.
    if (portal || payment) {
      await prisma.subscription
        .update({
          where: { id: live.id },
          data: {
            ...(portal ? { customerPortalUrl: portal } : {}),
            ...(payment ? { updatePaymentUrl: payment } : {}),
          },
        })
        .catch((e) => console.error("[subscription] could not cache the portal URLs:", e));
    }

    res.json({ url, fresh: portal != null || payment != null });
  }),
);

/**
 * Cancel the subscription.
 *
 * WHAT CANCELLING MEANS HERE, because the word suggests something more abrupt
 * than what happens: Lemon Squeezy stops future payments and sets `ends_at` to
 * the end of the period ALREADY PAID FOR. The customer keeps everything until
 * then — `subscriptionGrants` ranks `cancelled` as granting for exactly this
 * reason — and the row flips to `expired` on its own afterwards, at which point
 * the client's paywall takes over. Nobody loses time they have paid for, and
 * nobody has to be refunded for the days they did not use.
 *
 * There is ALWAYS a way out. This endpoint exists so cancelling never depends
 * on finding a portal link, remembering a password on a website, or writing to
 * support — a subscription you cannot leave from inside the app is a
 * subscription people are right not to start.
 */
subscriptionRouter.post(
  "/cancel",
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!env.lemonSqueezyApiKey) {
      console.error("[subscription] cannot cancel: no Lemon Squeezy API key");
      throw badRequest("Billing is not available right now.");
    }

    const userId = req.user!.id;
    const subs = await prisma.subscription.findMany({
      where: { userId, provider: PROVIDER, ...hideTestRowsFor(userId, env) },
      select: {
        id: true,
        externalId: true,
        status: true,
        validUntil: true,
        trialEndsAt: true,
        trialCancelledAt: true,
        pauseMode: true,
        providerUpdatedAt: true,
        createdAt: true,
        variantId: true,
        updatedAt: true,
      },
    });

    const now = new Date();
    // Same rule as everywhere else: found from the TOKEN, never named by the
    // request. A subscription id in the body would let anyone cancel a
    // stranger's plan.
    // THERE IS ALWAYS A WAY OUT. Read as a billing question on purpose: a
    // subscription that stopped granting access but is still being charged is
    // exactly the one a customer most needs to cancel, and gating this on the
    // access predicate would have refused them.
    const live = subs.find((sub) => subscriptionIsLive(sub) && sub.status !== "cancelled");
    if (!live) {
      throw conflict("There is no active subscription to cancel on this account.");
    }
    // Cancelling DURING a trial is allowed — it is what a trial is for. What it
    // does NOT do here is leave the trial running: a trial buys no grace (see
    // `subscriptionGrants`), so access ends the moment it is cancelled. The
    // client's copy says so before the confirm, because a customer who expected
    // to keep the days they had left would otherwise be simply cut off.
    const wasTrial = live.status === "on_trial";

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LS_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(`${env.lemonSqueezyApiBase}/v1/subscriptions/${live.externalId}`, {
        method: "DELETE",
        headers: {
          Accept: "application/vnd.api+json",
          "Content-Type": "application/vnd.api+json",
          Authorization: `Bearer ${env.lemonSqueezyApiKey}`,
        },
        signal: controller.signal,
      });
    } catch (err) {
      console.error(
        "[subscription] Lemon Squeezy unreachable:",
        err instanceof Error ? err.message : err,
      );
      throw badRequest("Could not reach the payment provider. Please try again.");
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const why = await readLemonSqueezyError(response);
      console.error(
        `[subscription] Lemon Squeezy refused to cancel ${live.externalId}: ` +
          `HTTP ${response.status} — ${why}`,
      );
      throw badRequest(`Could not cancel the subscription — ${why}`);
    }

    // When access actually stops, read from the response so the client can say
    // it immediately rather than waiting for the webhook. Best-effort: the
    // webhook is still the writer, and a shape we cannot read costs a sentence
    // of copy, not the cancellation.
    let endsAt: string | null = null;
    try {
      const body = (await response.json()) as {
        data?: { attributes?: { ends_at?: string | null } };
      };
      endsAt = body.data?.attributes?.ends_at ?? null;
    } catch {
      /* the cancellation still happened */
    }

    // Mirror the new status NOW rather than waiting for the webhook.
    //
    // The webhook is normally the sole writer, and it still is for anything it
    // decides — this writes only what we just asked for and are about to be told
    // again, so the two cannot disagree. It matters because of the trial rule:
    // the customer pressed cancel expecting to lose access, and if the row still
    // said `on_trial` until a delivery landed, the very next screen would show
    // them still inside a trial they just ended. `providerUpdatedAt` is left
    // untouched, so the real event still applies over this on arrival.
    await prisma.subscription
      .update({
        where: { id: live.id },
        data: {
          status: "cancelled",
          // The tombstone, written here too rather than left to the webhook: the
          // customer could reach the Lemon Squeezy portal and press Resume before
          // the delivery lands, and the whole point of the tombstone is that no
          // resume gives back a trial that was refused.
          ...(wasTrial ? { trialCancelledAt: now } : {}),
          ...(endsAt ? { endsAt: new Date(endsAt), validUntil: new Date(endsAt) } : {}),
        },
      })
      .catch((e) => console.error("[subscription] optimistic cancel write failed:", e));

    res.status(202).json({ ok: true, endsAt, endedNow: wasTrial });
  }),
);

/**
 * Reactivate (un-cancel) a subscription that is still inside its grace period.
 *
 * The mirror of /cancel, and the gap the audit + the subscription-map both
 * flagged: once cancelled, a customer who changes their mind during the paid-
 * through window had NO in-app way back — only the Lemon Squeezy portal. Lemon
 * Squeezy supports it directly: PATCH the subscription with `cancelled: false`
 * WHILE it is `cancelled` and BEFORE `ends_at`; the status returns to active and
 * `ends_at` clears. After `ends_at` the subscription is `expired` and there is
 * nothing to resume — the customer starts a fresh checkout instead.
 *
 * Found from the TOKEN, never named by the request, exactly like /cancel — and
 * mirrored optimistically, exactly like /cancel: the desktop re-reads
 * GET /subscription the instant this answers, and a row still saying
 * `cancelled` until the webhook lands redrew the very button the customer had
 * just pressed. The webhook stays the authority (providerUpdatedAt untouched);
 * this writes only what was asked for and is about to be confirmed.
 */
subscriptionRouter.post(
  "/reactivate",
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!env.lemonSqueezyApiKey) {
      console.error("[subscription] cannot reactivate: no Lemon Squeezy API key");
      throw badRequest("Billing is not available right now.");
    }

    const userId = req.user!.id;
    const subs = await prisma.subscription.findMany({
      where: { userId, provider: PROVIDER, ...hideTestRowsFor(userId, env) },
      select: {
        id: true,
        externalId: true,
        status: true,
        validUntil: true,
        endsAt: true,
        // Not decoration. Without it `subscriptionGrants` cannot see that this
        // cancellation happened during a TRIAL, and this endpoint would happily
        // resume a trial the customer had ended — handing back free access that
        // was never paid for, as many times as they liked.
        trialEndsAt: true,
        trialCancelledAt: true,
        pauseMode: true,
        providerUpdatedAt: true,
        createdAt: true,
        variantId: true,
        updatedAt: true,
      },
    });

    const now = new Date();
    // Resumable = cancelled AND still granting (before ends_at). A row already
    // expired cannot be resumed — Lemon Squeezy would refuse, and the honest
    // answer is "start a new plan", not a confusing provider error. A cancelled
    // TRIAL is deliberately not resumable either: it stopped granting the moment
    // it was cancelled, so there is nothing left to resume.
    const resumable = subs.find(
      (sub) => sub.status === "cancelled" && subscriptionGrants(sub, now),
    );
    if (!resumable) {
      // A STABLE CODE, not just prose. Every reason a resume is refused lands
      // here — no cancelled row, a window that already closed, a variant we no
      // longer sell, and the one that matters most: a trial an operator revoked,
      // which `subscriptionGrants` keeps out of this filter via the tombstone. A
      // console that has to string-match the sentence to tell those apart breaks
      // the day someone rewords it.
      throw new HttpError(
        409,
        "There is no cancelled subscription to reactivate on this account.",
        { code: "SUBSCRIPTION_NOT_REACTIVATABLE" },
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LS_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(`${env.lemonSqueezyApiBase}/v1/subscriptions/${resumable.externalId}`, {
        method: "PATCH",
        headers: {
          Accept: "application/vnd.api+json",
          "Content-Type": "application/vnd.api+json",
          Authorization: `Bearer ${env.lemonSqueezyApiKey}`,
        },
        body: JSON.stringify({
          data: {
            type: "subscriptions",
            id: String(resumable.externalId),
            // The whole operation: un-cancel. LS clears ends_at and returns the
            // subscription to active on its own.
            attributes: { cancelled: false },
          },
        }),
        signal: controller.signal,
      });
    } catch (err) {
      console.error("[subscription] Lemon Squeezy unreachable:", err instanceof Error ? err.message : err);
      throw badRequest("Could not reach the payment provider. Please try again.");
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const why = await readLemonSqueezyError(response);
      console.error(
        `[subscription] Lemon Squeezy refused to reactivate ${resumable.externalId}: ` +
          `HTTP ${response.status} — ${why}`,
      );
      throw badRequest(`Could not reactivate the subscription — ${why}`);
    }

    // Best-effort read of the new renewal date, like /cancel reads ends_at.
    let renewsAt: string | null = null;
    try {
      const body = (await response.json()) as {
        data?: { attributes?: { renews_at?: string | null } };
      };
      renewsAt = body.data?.attributes?.renews_at ?? null;
    } catch {
      /* the reactivation still happened */
    }

    // Mirror the new status NOW rather than waiting for the webhook — the same
    // move, for the same reason, as /cancel a page up. The desktop re-reads
    // GET /subscription the moment this answers, and while the row still said
    // `cancelled` that re-read drew the exact screen the customer had just acted
    // on — Reactivate button included. A button that survives its own success
    // is indistinguishable from a button that does nothing.
    //
    // Only what we just asked for and are about to be told again is written:
    // status back to active, the paid-through stop cleared, and the renewal date
    // when Lemon Squeezy said it (without one, the old validUntil is still a
    // true lower bound on access, so it is kept rather than guessed at).
    // `providerUpdatedAt` is left untouched, so the real event still applies
    // over this on arrival.
    await prisma.subscription
      .update({
        where: { id: resumable.id },
        data: {
          status: "active",
          endsAt: null,
          ...(renewsAt ? { renewsAt: new Date(renewsAt), validUntil: new Date(renewsAt) } : {}),
        },
      })
      .catch((e) => console.error("[subscription] optimistic reactivate write failed:", e));

    res.status(202).json({ ok: true, renewsAt });
  }),
);

/**
 * Change plan between monthly and yearly on the EXISTING subscription.
 *
 * WHY A PATCH, NOT A CHECKOUT. Switching the variant is one operation on the
 * subscription the customer already has; a second checkout would leave them
 * holding two (the exact trap checkout.ts guards against). Moving TO lifetime is
 * the opposite — a one-off purchase, not a subscription state — so it is NOT
 * handled here: the client sends it through checkout, and the webhook then
 * cancels this subscription (see recordPaidOrder) so nobody pays both.
 *
 * THE on_trial RULE. Refused while the subscription is on trial, on purpose: no
 * money has moved yet, so there is nothing to prorate against and Lemon
 * Squeezy's behaviour for a variant swap mid-trial is undefined. The honest path
 * is "pay now, then change" — POST /subscription/end-trial exists for the first
 * half. A change is allowed once the subscription is `active` (or `past_due`).
 *
 * PRORATION. An UPGRADE (monthly→yearly) is a price rise, charged pro rata
 * immediately (`invoice_immediately`) — it takes money, so the client confirms
 * first. A DOWNGRADE (yearly→monthly) does not bill now: `disable_prorations`
 * switches the plan and simply bills the new price at the next renewal, so
 * nobody is charged for downgrading and no confusing credit is minted.
 *
 * The webhook remains the sole writer of the row (subscription_updated re-derives
 * variantId + interval); this only asks Lemon Squeezy and refreshes.
 */
subscriptionRouter.post(
  "/change-plan",
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!env.lemonSqueezyApiKey) {
      console.error("[subscription] cannot change plan: no Lemon Squeezy API key");
      throw badRequest("Billing is not available right now.");
    }

    const { plan } = changePlanSchema.parse(req.body ?? {});
    // The NAME → variant id, through the SAME shared helper checkout uses. A
    // caller names "monthly"/"yearly"; it can never name a variant of its own.
    const targetVariant = variantForPlan(plan, {
      monthly: env.lemonSqueezyVariantMonthly,
      yearly: env.lemonSqueezyVariantYearly,
      lifetime: env.lemonSqueezyVariantId,
    });
    if (!targetVariant) {
      console.error(`[subscription] change-plan: no variant configured for "${plan}"`);
      throw badRequest("That plan is not available right now.");
    }

    const userId = req.user!.id;
    // The only money route here with no self-limiting state: /cancel and
    // /end-trial each 409 on a second call, but monthly<->yearly can be
    // alternated for ever — and every upgrade leg PATCHes with
    // `invoice_immediately: true`. Same two-leg cap as /checkout and /portal.
    await consumeRateLimit(`change-plan:${userId}`, 10, 5 * 60_000);
    await consumeRateLimit(`change-plan:ip:${clientIp(req)}`, 30, 5 * 60_000);

    const subs = await prisma.subscription.findMany({
      where: { userId, provider: PROVIDER, ...hideTestRowsFor(userId, env) },
      select: {
        externalId: true,
        status: true,
        validUntil: true,
        variantId: true,
        trialEndsAt: true,
        trialCancelledAt: true,
        pauseMode: true,
        providerUpdatedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    const now = new Date();
    // Found from the TOKEN, never named by the request — like every money action.
    // Billing question, like /cancel above.
    const live = subs.find((sub) => subscriptionIsLive(sub) && sub.status !== "cancelled");
    if (!live) {
      throw conflict("There is no active subscription to change.");
    }
    if (live.status === "on_trial") {
      throw conflict("End your trial before changing plan.");
    }
    if (live.variantId === targetVariant) {
      throw conflict("You are already on that plan.");
    }

    // Upgrade = to the yearly (dearer) plan; downgrade = to monthly. The variant
    // ids decide, not the price, so this stays correct if the prices move.
    const isUpgrade = plan === "yearly";

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LS_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(`${env.lemonSqueezyApiBase}/v1/subscriptions/${live.externalId}`, {
        method: "PATCH",
        headers: {
          Accept: "application/vnd.api+json",
          "Content-Type": "application/vnd.api+json",
          Authorization: `Bearer ${env.lemonSqueezyApiKey}`,
        },
        body: JSON.stringify({
          data: {
            type: "subscriptions",
            id: String(live.externalId),
            attributes: {
              variant_id: Number(targetVariant),
              // Upgrade: charge the prorated difference now. Downgrade: no charge
              // now, just the new price next renewal (disable_prorations overrides
              // invoice_immediately, so the two are mutually exclusive by design).
              ...(isUpgrade ? { invoice_immediately: true } : { disable_prorations: true }),
            },
          },
        }),
        signal: controller.signal,
      });
    } catch (err) {
      console.error("[subscription] Lemon Squeezy unreachable:", err instanceof Error ? err.message : err);
      throw badRequest("Could not reach the payment provider. Please try again.");
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const why = await readLemonSqueezyError(response);
      console.error(
        `[subscription] Lemon Squeezy refused to change ${live.externalId} to ${plan}: ` +
          `HTTP ${response.status} — ${why}`,
      );
      await throwPortalRequiredIfPayPal(response.status, live.externalId);
      throw badRequest(`Could not change the plan — ${why}`);
    }

    // Best-effort read of the new renewal date so the UI can say when the change
    // lands (immediately for an upgrade, at renews_at for a downgrade). The
    // webhook is still the writer.
    let renewsAt: string | null = null;
    try {
      const body = (await response.json()) as {
        data?: { attributes?: { renews_at?: string | null } };
      };
      renewsAt = body.data?.attributes?.renews_at ?? null;
    } catch {
      /* the change still happened */
    }

    res.status(202).json({ ok: true, plan, immediate: isUpgrade, renewsAt });
  }),
);
