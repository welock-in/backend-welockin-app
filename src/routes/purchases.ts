import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { env } from "../lib/env";
import { requireAuth } from "../middleware/auth";
import { asyncHandler } from "../middleware/async-handler";
import {
  accountGone,
  transactionForeign,
  transactionInvalid,
  transactionUnknownProduct,
} from "../lib/http-error";
import {
  LIFETIME_PRODUCT_ID,
  PLAN,
  TRIAL_DAYS,
  purchaseEffect,
  TRIAL_PRODUCT_ID,
  computeEntitlement,
} from "../lib/entitlement";
import { InvalidTransaction, verifySignedTransaction } from "../lib/apple-jws";

/* ─────────────────────────────────────────────────────────────
   POST /api/purchases — the app hands over a StoreKit 2 signed
   transaction; the server verifies Apple's signature and becomes the
   authority on what the user owns.

   Until this route existed, a purchase lived only on the phone: the
   backend could never answer "who paid", and the desktop clients —
   which read the same GET /api/entitlement — could never see a
   purchase made on iOS.

   TWO PRODUCTS, TWO EFFECTS:
     · the Price-Tier-0 trial  → stamps `trialEndsAt` from APPLE's
       purchase date, create-only (see below);
     · the lifetime unlock     → sets `plan = "lifetime"`.

   THE TRIAL IS NEVER EXTENDED. `trialEndsAt` is written only when it is
   null. Re-posting the same transaction (StoreKit re-delivers unfinished
   ones on every launch, and the app POSTs on each) must be inert, and a
   user must not be able to farm days by replaying it. Reinstalling
   cannot help either: the transaction is a non-consumable, so Apple
   hands back the ORIGINAL purchase date, not a fresh one.

   REVOCATION IS HONOURED. A refunded transaction arrives with
   `revocationDate`; access ends rather than silently persisting, which
   is both correct and what Apple expects of us.
   ───────────────────────────────────────────────────────────── */

export const purchasesRouter = Router();

const submitSchema = z.object({
  /** The `jws` / `purchaseToken` StoreKit gives the client, verbatim. */
  jws: z.string().trim().min(20).max(20_000),
});

const DAY_MS = 24 * 60 * 60 * 1000;

purchasesRouter.post(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { jws } = submitSchema.parse(req.body);

    let tx;
    try {
      tx = verifySignedTransaction(jws);
    } catch (err) {
      // A signature that does not verify is not a server error and must never be
      // recorded. The message is Apple-specific and safe (it names no user data).
      if (err instanceof InvalidTransaction) throw transactionInvalid(err.message);
      throw err;
    }

    // Someone else's app, or a transaction lifted from another bundle.
    if (tx.bundleId !== env.appleBundleId) {
      throw transactionForeign();
    }
    if (tx.productId !== TRIAL_PRODUCT_ID && tx.productId !== LIFETIME_PRODUCT_ID) {
      throw transactionUnknownProduct();
    }

    const userId = req.user!.id;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { plan: true, trialEndsAt: true },
    });
    if (!user) throw accountGone();

    const data = purchaseEffect(
      { productId: tx.productId, purchaseDate: tx.purchaseDate, revoked: tx.revocationDate != null },
      user,
      TRIAL_DAYS,
    );

    const updated =
      Object.keys(data).length > 0
        ? await prisma.user.update({ where: { id: userId }, data, select: { plan: true, trialEndsAt: true } })
        : user;

    const view = computeEntitlement({
      now: new Date(),
      hasActivePurchase: updated.plan === PLAN.lifetime,
      hasRefundedPurchase: updated.plan === PLAN.refunded,
      compActive: false,
      accessRevoked: false,
      trialEndsAt: updated.trialEndsAt,
      hasTrialClaim: updated.trialEndsAt != null,
      trialDurationDays: TRIAL_DAYS,
      productId: LIFETIME_PRODUCT_ID,
    });

    res.json(view);
  }),
);
