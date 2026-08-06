import { Router } from "express";
import { prisma } from "../lib/prisma";
import { env } from "../lib/env";
import { subscriptionGrants } from "../lib/subscription";
import { requireAuth } from "../middleware/auth";
import { asyncHandler } from "../middleware/async-handler";
import { badRequest, conflict } from "../lib/http-error";

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
    const subs = await prisma.subscription.findMany({
      where: { userId, provider: PROVIDER },
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
      console.error(
        `[subscription] Lemon Squeezy refused to end trial ${trial.externalId}: HTTP ${response.status}`,
      );
      throw badRequest("Could not take the payment. Please try again.");
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
