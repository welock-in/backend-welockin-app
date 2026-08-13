import { Router } from "express";
import { HttpError } from "../lib/http-error";
import { readDeviceId } from "../lib/device";
import { requireAuth } from "../middleware/auth";
import { asyncHandler } from "../middleware/async-handler";
import { assertCanWrite } from "../lib/purchase-providers";
import { RevenueCatApiError, syncUserFromRevenueCat } from "../lib/revenuecat";
import { resolveAndCache } from "./entitlement";

/*
 * /api/billing — the client-facing half of the RevenueCat integration.
 *
 * The webhook is the authoritative path; these routes exist for the moments a
 * client cannot wait for it: right after a purchase completes on-device (the
 * webhook may be seconds behind, and the paywall needs to dismiss NOW), and on
 * app start when a delivery might have been missed entirely.
 */

export const billingRouter = Router();

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
    try {
      await syncUserFromRevenueCat(userId);
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

    res.json(await resolveAndCache(userId, readDeviceId(req)));
  }),
);

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
