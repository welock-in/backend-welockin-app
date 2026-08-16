import { Router } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { toPublicUser } from "../lib/user";
import { notFound } from "../lib/http-error";
import { enqueueAndAttemptCancel } from "../lib/billing-tasks";
import { env } from "../lib/env";
import { hideTestRowsFor } from "../lib/subscription";
import { billingProviderFor } from "../lib/entitlement";
import { requireAuth } from "../middleware/auth";
import { asyncHandler } from "../middleware/async-handler";

export const meRouter = Router();

/* ── what deleting this account would do to its billing ─────────────────────
 *
 * ONE set of reads and ONE predicate, shared by GET /deletion-preview and
 * DELETE /. That sharing is the contract, not a convenience: the preview is a
 * PROMISE about what the deletion will do, and two copies of the query (or of
 * the "which rows get cancelled" rule) would drift exactly the way the
 * eligibility reads once did — the screen would announce an auto-cancel the
 * deletion never enqueues, or stay silent about one it does.
 */

/** Every column either consumer reads off a subscription row. DELETE / uses
 *  `provider`/`externalId`/`status`; the preview additionally renders the
 *  interval, the paid-up window and the stored management link. */
const DELETION_SUBSCRIPTION_SELECT = {
  provider: true,
  externalId: true,
  status: true,
  interval: true,
  validUntil: true,
  customerPortalUrl: true,
  updatePaymentUrl: true,
} as const;

type DeletionSubscription = {
  provider: string;
  externalId: string;
  status: string;
  interval: string | null;
  validUntil: Date | null;
  customerPortalUrl: string | null;
  updatePaymentUrl: string | null;
};

/**
 * The subscription rows a deletion acts on — ALL statuses, because DELETE /
 * tombstones every one of them (a cancelled subscription's id must still never
 * mint a second grant), under the same test-row gate as every other
 * subscription query. See DELETE / for why the admin test lab's synthetic rows
 * must never reach the cancellation outbox.
 */
async function subscriptionsForDeletion(userId: string): Promise<DeletionSubscription[]> {
  return prisma.subscription.findMany({
    where: { userId, ...hideTestRowsFor(userId, env) },
    select: DELETION_SUBSCRIPTION_SELECT,
  });
}

/** Can this row still take money? `cancelled` and `expired` cannot — Lemon
 *  Squeezy takes no further payment on either — so a deletion has nothing to
 *  say about them and the preview does not list them. */
function canStillBill(sub: { status: string }): boolean {
  return sub.status !== "expired" && sub.status !== "cancelled";
}

/**
 * Exactly the rows DELETE / enqueues outbox cancellations for. The outbox
 * speaks Lemon Squeezy only — an Apple subscription cannot be cancelled from
 * the server; the customer does that in their App Store settings, and
 * enqueueing it would only mint a dead-lettered task.
 */
function deleteWouldAutoCancel(sub: { provider: string; status: string }): boolean {
  return canStillBill(sub) && sub.provider === "lemonsqueezy";
}

meRouter.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
    });
    if (!user) {
      throw notFound("User not found");
    }
    res.json({ user: toPublicUser(user) });
  }),
);

/**
 * GET /api/me/deletion-preview — what deleting this account will do to its
 * billing, BEFORE the client shows the irreversible confirmation step.
 *
 * The delete flow's step-zero copy branches on this: a Lemon Squeezy
 * subscription "will be cancelled automatically" (the outbox guarantees it —
 * see DELETE /), an Apple one CANNOT be cancelled by us and the customer must
 * do it themselves in their App Store settings (`managementUrl` is the
 * RevenueCat management link the sync persists), and a lifetime licence is
 * lost for good. Read-only: nothing here reserves, enqueues or deletes.
 *
 * Built from the SAME reads and the SAME predicate the deletion itself uses
 * (above), so the preview can never announce a cancellation DELETE / would not
 * perform, nor hide one it would.
 */
meRouter.get(
  "/deletion-preview",
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = req.user!.id;

    const [subs, lifetime] = await Promise.all([
      subscriptionsForDeletion(userId),
      // The non-refunded lifetime, any provider — the same "is this ownership"
      // read the eligibility inputs use (a refunded purchase is not ownership,
      // and a test-mode one stops existing when its provider's gate is shut).
      prisma.purchase.findFirst({
        where: { userId, isRefunded: false, ...hideTestRowsFor(userId, env) },
        select: { provider: true },
      }),
    ]);

    // Only the rows that can still bill: a deletion has nothing to warn about
    // on a subscription no further money can leave through.
    const live = subs.filter(canStillBill);
    const entry = (sub: DeletionSubscription) => ({
      // The client's two-world vocabulary, via the ONE shared mapping.
      // Unrecognised providers read as LEMON_SQUEEZY, the same default the
      // entitlement view's manageableSubscription documents.
      provider: billingProviderFor(sub.provider) ?? ("LEMON_SQUEEZY" as const),
      interval: sub.interval,
      status: sub.status,
      validUntil: sub.validUntil ? sub.validUntil.toISOString() : null,
      // Last-known, not live — for an Apple row this is the RevenueCat
      // management_url the sync persists (unsigned, does not expire).
      managementUrl: sub.customerPortalUrl ?? sub.updatePaymentUrl ?? null,
    });

    res.json({
      hasLifetime: lifetime != null,
      lifetimeProvider: lifetime ? billingProviderFor(lifetime.provider) : null,
      subscriptions: live.map(entry),
      // The split the confirmation copy branches on. `willAutoCancel` is
      // computed by the deletion's own predicate — these are exactly the rows
      // DELETE / will enqueue outbox cancellations for, no more and no fewer.
      willAutoCancel: live.filter(deleteWouldAutoCancel).map(entry),
      requiresManualCancel: live
        .filter((sub) => billingProviderFor(sub.provider) === "APPLE")
        .map(entry),
      serverTime: new Date().toISOString(),
    });
  }),
);

// Self-serve account deletion — required by Google Play (User Data policy) and
// Apple. Removes the account and every record keyed to it. Idempotent: a second
// call after the user row is gone still returns 204. Related collections are
// deleted explicitly (MongoDB has no real FK cascade; Prisma's onDelete only
// covers models with a back-relation, and we want a hard guarantee).
meRouter.delete(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = req.user!.id;
    const del = (model: { deleteMany: (a: { where: { userId: string } }) => Promise<unknown> }) =>
      model.deleteMany({ where: { userId } }).catch(() => undefined);

    // Best-effort explicit cleanup of models that ALSO cascade from user.delete
    // (belt-and-suspenders — a swallowed failure here is still covered by Prisma's
    // emulated onDelete: Cascade when the user row goes).
    await Promise.all([
      del(prisma.focusEvent),
      del(prisma.device),
      del(prisma.liveSession),
      del(prisma.authProvider),
      del(prisma.syncSnapshot),
      del(prisma.vote),
      del(prisma.pushToken),
      del(prisma.notificationDelivery),
      del(prisma.trialReminderSent),
      // Both hold the address the person asked to be forgotten, so they go with
      // the account rather than waiting for a TTL sweep to notice them.
      del(prisma.emailVerification),
      del(prisma.passwordReset),
    ]);
    // Feature requests authored by the user (authorId, not userId) — also cascades.
    await prisma.featureRequest.deleteMany({ where: { authorId: userId } }).catch(() => undefined);

    // The trial claim is UNLINKED, never deleted, and that asymmetry is the whole
    // anti-abuse story: deleting it would make "delete your account" the reset
    // button, which is exactly the loop the ledger was built to close. What must
    // go is the link to a person who asked to be forgotten — the row that stays
    // behind is a keyed hash of a machine and a date, naming nobody.
    await prisma.trialClaim
      .updateMany({ where: { firstUserId: userId }, data: { firstUserId: null } })
      .catch(() => undefined);

    // Same asymmetry for PAID orders. The Purchase/Subscription rows carry the
    // buyer's identity and cascade away with the account below — but a payment,
    // once turned into a grant, must never mint a second one, and after deletion
    // the (provider, externalId) uniqueness that guaranteed that is gone with the
    // row. So before the cascade, leave an identity-free tombstone keyed on the
    // order id: whoever next takes over this freed email cannot re-confirm the
    // old order for a free licence (audit 2026-08-08). New grants already write
    // this at purchase time; this covers the rows that predate the ledger.
    const [oldPurchases, oldSubs] = await Promise.all([
      prisma.purchase.findMany({ where: { userId }, select: { provider: true, externalId: true } }),
      // The SHARED read (see the top of this file): the deletion preview reads
      // the same rows through the same query, which is what makes the preview a
      // promise rather than a guess. Test rows filtered like every other
      // subscription query — the admin test lab mints synthetic rows with ids
      // Lemon Squeezy has never heard of, and asking it to cancel one would
      // fail every attempt until the task dead-lettered: a permanent red mark
      // for a subscription that never existed, sitting next to the real ones
      // that do need attention.
      subscriptionsForDeletion(userId),
    ]);

    // STOP CHARGING THE CARD. Deleting the account here removed our record of the
    // subscription and told Lemon Squeezy nothing at all — so the customer went
    // on being billed every month for an account that no longer existed, and the
    // row that would have explained it had cascaded away.
    //
    // Enqueued BEFORE the cascade, deliberately: once the rows are gone there is
    // nothing left to read the subscription ids from, so the instruction has to
    // outlive them. The outbox is keyed on the provider's id for the same reason
    // — by the time it is retried, the account it belonged to will not exist.
    for (const s of oldSubs) {
      // The SHARED predicate (see the top of this file): live Lemon Squeezy
      // rows only. `cancelled`/`expired` have nothing left to stop, and Apple
      // rows cannot be cancelled from the server — the preview says the same
      // thing for the same reason, because it calls the same function.
      if (!deleteWouldAutoCancel(s)) continue;
      const recorded = await enqueueAndAttemptCancel(s.externalId, "account-deleted");
      // We are one line away from deleting the only record of this subscription.
      // If the instruction did not land, stopping here is the lesser harm: the
      // customer retries and is deleted a moment later, whereas continuing would
      // orphan a live charge with nothing anywhere pointing at it. Deletion is
      // deferred, never refused.
      if (!recorded) {
        throw new Error(
          `could not record the cancellation for subscription ${s.externalId}; deletion aborted`,
        );
      }
    }
    for (const p of oldPurchases) {
      await prisma.consumedOrder
        .upsert({
          where: { provider_externalId: { provider: p.provider, externalId: p.externalId } },
          create: { provider: p.provider, externalId: p.externalId, kind: "order" },
          update: {},
        })
        .catch(() => undefined);
    }
    for (const s of oldSubs) {
      await prisma.consumedOrder
        .upsert({
          where: { provider_externalId: { provider: s.provider, externalId: s.externalId } },
          create: { provider: s.provider, externalId: s.externalId, kind: "subscription" },
          update: {},
        })
        .catch(() => undefined);
    }

    // Break has NO User back-relation, so nothing cascades it: its deletion must
    // actually succeed, or a transient failure would leave rows orphaned to a
    // deleted user — a data-deletion gap. Fail loud (→ 500 → the client retries;
    // deleteMany is idempotent).
    await prisma.break.deleteMany({ where: { userId } });

    // The account row itself is the deletion that MUST succeed — do NOT swallow a
    // real failure (returning 204 while the account and its credentials survive is
    // both a lie to the user and an App/Play data-deletion compliance gap). Only a
    // P2025 "already gone" (an idempotent repeat) counts as success.
    try {
      await prisma.user.delete({ where: { id: userId } });
    } catch (err) {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025")) {
        throw err;
      }
    }

    res.status(204).end();
  }),
);
