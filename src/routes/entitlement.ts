import { Router } from "express";
import { prisma } from "../lib/prisma";
import { env } from "../lib/env";
import { ledgerHash } from "../lib/hash";
import { issueReceipt } from "../lib/entitlement-receipt";
import { readDeviceId } from "../lib/device";
import { parseFingerprint } from "../lib/fingerprint";
import { claimTrial, findClaim } from "../lib/trial-claim";
import { requireAuth } from "../middleware/auth";
import { asyncHandler } from "../middleware/async-handler";
import { accountGone, badRequest } from "../lib/http-error";
import { startTrialSchema } from "../validation/schemas";
import {
  LIFETIME_PRODUCT_ID,
  computeEntitlement,
  type EntitlementView,
} from "../lib/entitlement";

/* ─────────────────────────────────────────────────────────────
   The server's answer to "may this user use the app right now,
   and until when".

   A trial belongs to a MACHINE, not to an account. That is the
   whole design, and it is a correction: `POST /api/auth/register`
   used to stamp `User.trialEndsAt`, which made the trial as cheap
   as an email address. A new address was a new fortnight, and
   `DELETE /api/me` freed the old address so even the same one
   could go round again. The ledger (`TrialClaim`) moves the anchor
   to something that costs money to duplicate, and OUTLIVES the
   account so deleting it changes nothing.

   `User.trialEndsAt` is still read, and only read: every account
   that existed before the ledger keeps the window it is inside.

   The client MUST anchor its countdown to `serverTime`, never to
   its own clock — a Mac set to 1990 must not extend a trial. This
   route is the only authority on when a trial ends.
   ───────────────────────────────────────────────────────────── */

export const entitlementRouter = Router();

/**
 * Resolve effective access on the SERVER clock, and mirror it onto the user row.
 *
 * The mirror is a CACHE and never an input: `GET /api/me` and the admin console
 * read it so they do not each have to re-derive the status, but every gating
 * decision goes through `computeEntitlement` against the live rows. A cache that
 * decides access is a bug that only ever shows up in production.
 */
export async function resolveAndCache(userId: string, deviceId: string): Promise<EntitlementView> {
  const now = new Date();
  const deviceIdHash = deviceId ? ledgerHash(deviceId) : null;

  const [user, purchases, claim] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: {
        trialEndsAt: true,
        compActive: true,
        compedUntil: true,
        accessRevoked: true,
      },
    }),
    prisma.purchase.findMany({ where: { userId }, select: { isRefunded: true } }),
    // This machine's claim OR this account's, oldest first so a later row can
    // never rewind the window. Both legs matter, in opposite directions: the
    // device leg is what stops a second account on one Mac, and the account leg
    // is what lets someone's SECOND Mac see the trial they are already inside
    // rather than being handed a fresh one.
    findClaim(deviceIdHash, userId),
  ]);

  // A valid JWT for a deleted account reaches here (stateless verification).
  if (!user) throw accountGone();

  const compActive =
    user.compActive === true &&
    (user.compedUntil == null || user.compedUntil.getTime() > now.getTime());

  const view = computeEntitlement({
    now,
    hasActivePurchase: purchases.some((p) => !p.isRefunded),
    // Only decides anything when nothing is live: an active purchase outranks a
    // refunded one, so someone who bought twice and was refunded once keeps access.
    hasRefundedPurchase: purchases.some((p) => p.isRefunded),
    compActive,
    accessRevoked: user.accessRevoked === true,
    // The ledger first; the legacy column only for accounts that predate it.
    trialEndsAt: claim?.endsAt ?? user.trialEndsAt,
    hasTrialClaim: claim != null || user.trialEndsAt != null,
    trialDurationDays: claim?.trialDays ?? env.trialDays,
    productId: LIFETIME_PRODUCT_ID,
    // Echo-only: the resolver never gates on this, the client does.
    enforced: env.entitlementEnforced,
  });

  await cacheOnUser(userId, view, now);

  // The signed half. Everything above is advice a patched client may ignore;
  // this is the part it cannot forge, and therefore the only part it may still
  // believe once the network is gone. Null when no key is configured, which
  // clients read as "this server does not issue receipts" rather than as a
  // refusal — that is what lets the field appear on a deploy without every
  // client in the field understanding it the same day.
  //
  // Bound to the deviceId, so a receipt cannot be carried to another machine.
  return {
    ...view,
    receipt: issueReceipt({
      userId,
      deviceId,
      status: view.status,
      isPro: view.isPro,
      trialEndsAt: view.trialEndsAt ? new Date(view.trialEndsAt) : null,
      serverTime: now,
    }),
  };
}

/**
 * Best-effort denormalisation. Deliberately swallowing failures: this is the one
 * write on the app's hottest boot-path call, and a cache that could not be
 * written must never turn a correct answer into a 500.
 */
async function cacheOnUser(userId: string, view: EntitlementView, now: Date): Promise<void> {
  await prisma.user
    .update({
      where: { id: userId },
      data: {
        entitlementStatus: view.status,
        isProCached: view.isPro,
        entitlementUpdatedAt: now,
        // The legacy column the admin console still renders. It used to be
        // written once at registration and then go permanently stale — showing
        // "trial" next to a customer who had paid months ago.
        plan: view.status,
      },
    })
    .catch(() => undefined);
}

/**
 * GET /api/entitlement — read the caller's effective access.
 *
 * Reads `X-WeLockIn-Device-Id`. Side-effect free apart from the cache write, and
 * in particular it NEVER creates a claim: seeing your status must not be the
 * thing that consumes your trial.
 */
entitlementRouter.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json(await resolveAndCache(req.user!.id, readDeviceId(req)));
  }),
);

/**
 * POST /api/entitlement/trial — claim the free trial for this machine.
 *
 * CREATE-ONLY and idempotent. A caller that already has a claim gets the existing
 * one back, elapsed or not — never a fresh window. There is deliberately no way
 * to reset a claim from here; that lives behind the admin surface, because the
 * legitimate cases (a replaced logic board, a resold Mac) need a human and an
 * audit row, and the illegitimate ones are exactly what this endpoint is for.
 *
 * The check-then-act window between "is there a prior claim" and "create one" is
 * closed by the GLOBAL unique index on `deviceIdHash`, not by the read: two
 * simultaneous claims for one machine collide in the database rather than both
 * proceeding.
 */
entitlementRouter.post(
  "/trial",
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = req.user!.id;
    const deviceId = readDeviceId(req);
    if (!deviceId) throw badRequest("A device id is required to start a trial");

    const opts = startTrialSchema.parse(req.body ?? {});

    // The hardware signals, which this route did not read before — and its whole
    // job is to create claims. A claim written with no DeviceSignal rows is
    // INVISIBLE to `matchClaimByFingerprint` for ever, so the machine can never
    // be recognised again once its stored device id is wiped. The damage
    // accumulated silently: every claim minted here widened the hole.
    const fp = parseFingerprint(req);
    await claimTrial(userId, deviceId, {
      ...opts,
      signals: fp.signals,
      // Only when the client actually sent a fingerprint. Absent means "this
      // client says nothing", which must stay distinct from "this client looked
      // and failed" — see ClaimOptions.
      ...(fp.signals.length > 0 ? { hardwareBacked: fp.hardwareBacked } : {}),
    });

    res.json(await resolveAndCache(userId, deviceId));
  }),
);
