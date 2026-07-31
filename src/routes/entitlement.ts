import { Router } from "express";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/auth";
import { asyncHandler } from "../middleware/async-handler";
import { accountGone } from "../lib/http-error";
import {
  LIFETIME_PRODUCT_ID,
  PLAN,
  TRIAL_DAYS,
  computeEntitlement,
} from "../lib/entitlement";

/* ─────────────────────────────────────────────────────────────
   GET /api/entitlement — the server's answer to "may this user
   use the app right now, and until when".

   The client caches this offline-first and anchors its countdown to
   `serverTime`, never to the phone's clock (a phone set to 1990 must
   not extend a trial). This route is therefore the ONLY authority on
   when a trial ends; the mobile app mirrors TRIAL_DAYS for paywall
   copy alone.

   READ-ONLY BY DESIGN, and deliberately narrower than the fuller
   entitlement service drafted on the `mobile-integration` branch:

   · No `POST /trial`. That endpoint claims a DEVICE-bound trial and
     needs `requireBoundDevice`, which lives in the unmerged device
     work. It is also unnecessary here — `POST /api/auth/register`
     and `/api/auth/apple` already stamp `User.trialEndsAt` at account
     creation (auth.ts), so every account starts its trial the moment
     it exists. Nothing to claim.
   · `hasActivePurchase` / `hasRefundedPurchase` are read from
     `User.plan`, which POST /api/purchases writes after verifying
     Apple's signature. No Purchase table yet — a String column that
     main already had is what keeps this migration-free.
   · `compActive` / `accessRevoked` are hard `false`: the admin
     comp/revoke columns live on the unmerged branch too.

   A user whose trial has elapsed and who has not bought resolves to
   `expired`. That is now actionable: POST /api/purchases exists, so the
   paywall has something to sell.
   ───────────────────────────────────────────────────────────── */

export const entitlementRouter = Router();

entitlementRouter.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: { trialEndsAt: true, plan: true },
    });
    // A valid JWT for a deleted account reaches here (stateless verification).
    if (!user) throw accountGone();

    // One query settles both flags. Separate counts would read the same
    // collection twice on what is the app's hottest boot-path call, and a user
    // has at most a handful of rows here — this is a lifetime licence, not a
    // subscription ledger.
    const purchases = await prisma.purchase.findMany({
      where: { userId: req.user!.id },
      select: { isRefunded: true },
    });

    const view = computeEntitlement({
      now: new Date(),
      hasActivePurchase: purchases.some((p) => !p.isRefunded),
      // Only decides anything when nothing is live: computeEntitlement ranks an
      // active purchase above a refunded one, so someone who bought twice and was
      // refunded once keeps their access.
      hasRefundedPurchase: purchases.some((p) => p.isRefunded),
      compActive: false,
      accessRevoked: false,
      trialEndsAt: user.trialEndsAt,
      // The account HAS a trial window iff one was ever stamped. Keeping this
      // honest matters: `canStartTrial` is derived from it, and reporting
      // "you may start a trial" to a user who is mid-trial would be a lie.
      hasTrialClaim: user.trialEndsAt != null,
      trialDurationDays: TRIAL_DAYS,
      productId: LIFETIME_PRODUCT_ID,
    });

    res.json(view);
  }),
);
