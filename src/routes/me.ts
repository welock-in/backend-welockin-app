import { Router } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { toPublicUser } from "../lib/user";
import { notFound } from "../lib/http-error";
import { enqueueAndAttemptCancel } from "../lib/billing-tasks";
import { env } from "../lib/env";
import { hideTestRowsFor } from "../lib/subscription";
import { requireAuth } from "../middleware/auth";
import { asyncHandler } from "../middleware/async-handler";

export const meRouter = Router();

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
      prisma.subscription.findMany({
        // Test rows filtered like every other subscription query. The admin test
        // lab mints synthetic rows with ids Lemon Squeezy has never heard of, and
        // asking it to cancel one would fail every attempt until the task
        // dead-lettered — a permanent red mark for a subscription that never
        // existed, sitting next to the real ones that do need attention.
        where: { userId, ...hideTestRowsFor(userId, env) },
        select: { provider: true, externalId: true, status: true },
      }),
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
      if (s.status === "expired" || s.status === "cancelled") continue; // nothing left to stop
      // The outbox speaks Lemon Squeezy only. An Apple subscription cannot be
      // cancelled from the server — the customer does that in their App Store
      // settings — so enqueueing it would only mint a dead-lettered task.
      if (s.provider !== "lemonsqueezy") continue;
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
