import { Router } from "express";
import { prisma } from "../lib/prisma";
import { env } from "../lib/env";
import { hideTestRows, subscriptionGrants, variantForPlan } from "../lib/subscription";
import { requireAuth } from "../middleware/auth";
import { asyncHandler } from "../middleware/async-handler";
import { badRequest, conflict } from "../lib/http-error";
import { readLemonSqueezyError } from "../lib/lemonsqueezy";
import { changePlanSchema } from "../validation/schemas";

export const subscriptionRouter = Router();

/** A hung outbound call on a serverless function bills until it is killed. */
const LS_TIMEOUT_MS = 10_000;

const PROVIDER = "lemonsqueezy";

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
      where: { userId, provider: PROVIDER, ...hideTestRows(env.lemonSqueezyAllowTestMode) },
      select: { externalId: true, status: true, validUntil: true, trialEndsAt: true },
    });

    const now = new Date();
    const trial = subs.find((sub) => sub.status === "on_trial" && subscriptionGrants(sub, now));
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
    const subs = await prisma.subscription.findMany({
      where: {
        userId: req.user!.id,
        provider: PROVIDER,
        ...hideTestRows(env.lemonSqueezyAllowTestMode),
      },
      select: {
        status: true,
        interval: true,
        validUntil: true,
        trialEndsAt: true,
        renewsAt: true,
        endsAt: true,
      },
      orderBy: { updatedAt: "desc" },
    });

    const now = new Date();
    // The one that still grants, if any — an account can carry old expired rows
    // and the settings screen must describe the live one, not the first one.
    const live = subs.find((sub) => subscriptionGrants(sub, now)) ?? null;

    res.json({
      subscription: live && {
        status: live.status,
        interval: live.interval,
        // Already cancelled: this is when it actually stops. Null otherwise.
        endsAt: live.endsAt?.toISOString() ?? null,
        renewsAt: live.renewsAt?.toISOString() ?? null,
        trialEndsAt: live.trialEndsAt?.toISOString() ?? null,
        validUntil: live.validUntil?.toISOString() ?? null,
        // Whether "Cancel" should be offered. A row already cancelled is running
        // out its grace period and has nothing left to cancel. On trial it IS
        // cancellable — that is how the customer says "don't charge me".
        cancellable: live.status !== "cancelled",
        // Whether "Reactivate" should be offered: a cancelled subscription still
        // inside its paid-through window can be un-cancelled (POST /reactivate).
        // `live` is already the granting row, so being cancelled here means
        // cancelled-but-not-yet-expired — exactly the resumable window.
        reactivatable: live.status === "cancelled",
      },
    });
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
      where: { userId, provider: PROVIDER, ...hideTestRows(env.lemonSqueezyAllowTestMode) },
      select: { externalId: true, status: true, validUntil: true },
    });

    const now = new Date();
    // Same rule as everywhere else: found from the TOKEN, never named by the
    // request. A subscription id in the body would let anyone cancel a
    // stranger's plan.
    const live = subs.find((sub) => subscriptionGrants(sub, now) && sub.status !== "cancelled");
    if (!live) {
      throw conflict("There is no active subscription to cancel on this account.");
    }
    // Cancelling DURING a trial is allowed, and is the point of a trial: it means
    // "don't charge me when it ends". Lemon Squeezy keeps the trial valid until
    // its end date and then lets it expire instead of converting — the customer
    // keeps what they were trying, and pays nothing. (Changing PLAN mid-trial is
    // the thing that is refused, over in /change-plan, because there is no paid
    // amount to prorate against.)

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

    res.status(202).json({ ok: true, endsAt });
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
 * Found from the TOKEN, never named by the request, exactly like /cancel. The
 * webhook remains the sole writer of the row; this only asks LS to resume and
 * reports the new renews_at so the client can repaint immediately.
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
      where: { userId, provider: PROVIDER, ...hideTestRows(env.lemonSqueezyAllowTestMode) },
      select: { externalId: true, status: true, validUntil: true, endsAt: true },
    });

    const now = new Date();
    // Resumable = cancelled AND still granting (before ends_at). A row already
    // expired cannot be resumed — Lemon Squeezy would refuse, and the honest
    // answer is "start a new plan", not a confusing provider error.
    const resumable = subs.find(
      (sub) => sub.status === "cancelled" && subscriptionGrants(sub, now),
    );
    if (!resumable) {
      throw conflict("There is no cancelled subscription to reactivate on this account.");
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

    // Best-effort read of the new renewal date, like /cancel reads ends_at. The
    // webhook is still the writer; this just lets the client say it now.
    let renewsAt: string | null = null;
    try {
      const body = (await response.json()) as {
        data?: { attributes?: { renews_at?: string | null } };
      };
      renewsAt = body.data?.attributes?.renews_at ?? null;
    } catch {
      /* the reactivation still happened */
    }

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
    const subs = await prisma.subscription.findMany({
      where: { userId, provider: PROVIDER, ...hideTestRows(env.lemonSqueezyAllowTestMode) },
      select: { externalId: true, status: true, validUntil: true, variantId: true },
    });

    const now = new Date();
    // Found from the TOKEN, never named by the request — like every money action.
    const live = subs.find((sub) => subscriptionGrants(sub, now) && sub.status !== "cancelled");
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
