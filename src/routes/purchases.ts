import { Router, type Request } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { env } from "../lib/env";
import { ledgerHash } from "../lib/hash";
import { requireAuth } from "../middleware/auth";
import { asyncHandler } from "../middleware/async-handler";
import {
  accountGone,
  transactionForeign,
  transactionInvalid,
  transactionUnknownProduct,
} from "../lib/http-error";
import {
  APP_STORE,
  LIFETIME_PRODUCT_ID,
  TRIAL_DAYS,
  TRIAL_PRODUCT_ID,
  purchaseEffect,
} from "../lib/entitlement";
import { InvalidTransaction, verifySignedTransaction } from "../lib/apple-jws";
import { resolveAndCache } from "./entitlement";

/* ─────────────────────────────────────────────────────────────
   POST /api/purchases — the app hands over a StoreKit 2 signed
   transaction; the server verifies Apple's signature and becomes the
   authority on what the user owns.

   Until this route existed a purchase lived only on the phone: the
   backend could not answer "who paid", the desktop clients — which read
   the same GET /api/entitlement — could never see a purchase made on
   iOS, and a paying customer stayed behind the paywall for ever.

   TWO PRODUCTS, TWO EFFECTS:
     · the lifetime unlock    → a `Purchase` row (the existing model, so
       no migration), plus the `User.plan` mirror the desktop reads;
     · the Price-Tier-0 trial → a `TrialClaim`, bound to the Apple ID,
       the phone AND the account at once.

   WHY THE TRIAL IS BOUND TO THE APPLE ID. A non-consumable stays in the
   Apple ID's purchase history for ever, and Apple hands back the
   ORIGINAL transaction on every restore. So `originalTransactionId` is
   the one identifier here that survives a factory reset — which the
   Keychain device id does not. Binding to it is what turns "one trial
   per phone until they wipe it" into "one trial per Apple ID, full
   stop". The device and account legs stay as the second and third
   locks: one Apple ID cannot farm trials across phones either.

   IDEMPOTENT BY CONSTRUCTION. StoreKit re-delivers unfinished
   transactions on every launch and the app POSTs each one, so this route
   is called repeatedly with the same payload by design. The lifetime
   path upserts on `@@unique([provider, externalId])`; the trial path
   leans on the two unique indexes and treats a duplicate key as success.
   Neither can grant a second window.
   ───────────────────────────────────────────────────────────── */

export const purchasesRouter = Router();

const DEVICE_HEADER = "x-welockin-device-id";

const submitSchema = z.object({
  /** The `jws` / `purchaseToken` StoreKit gives the client, verbatim. */
  jws: z.string().trim().min(20).max(20_000),
  /** Apple's IDFV. Optional and WEAK — a correlation hint, never a key. */
  idfv: z.string().trim().min(1).max(200).optional(),
});

const isDuplicateKey = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";

/** The caller's stable install id, header first then body. */
function readDeviceId(req: Request): string {
  const header = req.header(DEVICE_HEADER);
  if (header && header.trim()) return header.trim();
  const body = (req.body as { deviceId?: unknown } | undefined)?.deviceId;
  return typeof body === "string" ? body.trim() : "";
}

purchasesRouter.post(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { jws, idfv } = submitSchema.parse(req.body);

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
    if (tx.bundleId !== env.appleBundleId) throw transactionForeign();
    if (tx.productId !== TRIAL_PRODUCT_ID && tx.productId !== LIFETIME_PRODUCT_ID) {
      throw transactionUnknownProduct();
    }

    const userId = req.user!.id;
    const deviceId = readDeviceId(req);
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!user) throw accountGone();

    const effect = purchaseEffect(
      {
        productId: tx.productId,
        purchaseDate: tx.purchaseDate,
        revoked: tx.revocationDate != null,
      },
      TRIAL_DAYS,
    );

    if (effect.kind === "lifetime") {
      await recordLifetime(userId, tx, effect.refunded, effect.plan);
    } else if (effect.kind === "trial") {
      await claimTrial(userId, tx.originalTransactionId, deviceId, idfv, effect);
    }

    // One resolver for every path, so this response and the one the client gets
    // from GET /api/entitlement can never disagree.
    res.json(await resolveAndCache(userId, deviceId));
  }),
);

/**
 * Record the lifetime unlock. Upsert, not create: the same transaction arrives
 * again after every relaunch until the app finishes it, and a restore on a new
 * phone replays it verbatim. `@@unique([provider, externalId])` makes all of
 * those land on one row.
 *
 * `isRefunded` is written on every pass rather than only on insert — a refund
 * reaches us as a REPLAY of the same transaction carrying `revocationDate`, so an
 * insert-only write would leave a refunded customer holding a live licence.
 */
async function recordLifetime(
  userId: string,
  tx: { originalTransactionId: string; productId: string; purchaseDate: number },
  refunded: boolean,
  plan: string,
): Promise<void> {
  await prisma.purchase.upsert({
    where: {
      provider_externalId: { provider: APP_STORE, externalId: tx.originalTransactionId },
    },
    create: {
      userId,
      provider: APP_STORE,
      store: APP_STORE,
      productId: tx.productId,
      externalId: tx.originalTransactionId,
      purchasedAt: new Date(tx.purchaseDate),
      isRefunded: refunded,
      ...(refunded ? { refundedAt: new Date() } : {}),
    },
    update: {
      isRefunded: refunded,
      ...(refunded ? { refundedAt: new Date() } : { refundedAt: null }),
    },
  });

  // Denormalized mirror for the desktop clients and GET /api/me, which have always
  // read `plan`. Best-effort: the Purchase row above is the authority.
  await prisma.user.update({ where: { id: userId }, data: { plan } }).catch(() => {});
}

/**
 * Claim the free trial, bound to the Apple ID, the phone and the account.
 *
 * CREATE-ONLY, enforced by the database rather than by a read-then-write. Two
 * unique indexes carry it:
 *   · `appleOriginalTxHash` — one trial per Apple ID, surviving a factory reset;
 *   · `deviceIdHash`        — one trial per phone, so a second account on the
 *                             same handset collides here.
 * A duplicate key on either is the SUCCESS path: it means this Apple ID or this
 * phone already had its window, and the resolver will now hand back that window —
 * elapsed or not — instead of a fresh one.
 *
 * Every identifier is stored peppered-hashed, never in the clear.
 */
async function claimTrial(
  userId: string,
  originalTransactionId: string,
  deviceId: string,
  idfv: string | undefined,
  window: { startedAt: Date; endsAt: Date },
): Promise<void> {
  const appleOriginalTxHash = ledgerHash(originalTransactionId);
  // A client that somehow sends no device id still gets a claim: the Apple leg is
  // the strong one, and refusing here would deny a legitimate trial over a missing
  // header. Reusing the transaction hash keeps the required column populated and
  // unique without pretending to be a device.
  const deviceIdHash = deviceId ? ledgerHash(deviceId) : appleOriginalTxHash;

  try {
    await prisma.trialClaim.create({
      data: {
        appleOriginalTxHash,
        deviceIdHash,
        idfvHash: idfv ? ledgerHash(idfv) : null,
        firstUserId: userId,
        trialDays: TRIAL_DAYS,
        startedAt: window.startedAt,
        endsAt: window.endsAt,
        status: "active",
      },
    });
  } catch (err) {
    // Already claimed by this Apple ID or on this phone — exactly what the indexes
    // are for. Never rewrite the existing row: rewriting it IS the farm.
    if (!isDuplicateKey(err)) throw err;
  }

  // ── materialize the governing window onto the account ────────────────────
  //
  // This is not bookkeeping, it is the Apple leg's ONLY route into the resolver.
  //
  // `GET /api/entitlement` knows a userId and a deviceId; it never sees an Apple
  // ID, because the phone only hands one over when a transaction is posted. So a
  // claim found here by `appleOriginalTxHash` would be written and then never
  // read again — and a fresh account on a NEW phone with the SAME Apple ID would
  // fall through to the signup stamp and collect another 14 days. Which is the
  // farm, one hop further out.
  //
  // Stamping the account closes it: the account carries the ledger's answer, and
  // the resolver's legacy fallback now returns the truth instead of a fiction.
  const governing = await prisma.trialClaim.findFirst({
    where: { OR: [{ appleOriginalTxHash }, { deviceIdHash }, { firstUserId: userId }] },
    orderBy: { createdAt: "asc" }, // oldest wins — a later row must never rewind it
    select: { endsAt: true },
  });
  if (!governing) return;

  // NARROWING ONLY: write when the account has no window, or one that ends LATER
  // than the ledger allows. The `gt` is what makes this safe to run on every
  // replayed transaction — it can pull a window in, never push it out.
  await prisma.user
    .updateMany({
      where: {
        id: userId,
        OR: [{ trialEndsAt: null }, { trialEndsAt: { gt: governing.endsAt } }],
      },
      // Deliberately not touching `plan`: a user who already owns the lifetime
      // unlock can replay a trial transaction, and demoting their mirror to
      // "trial" would misreport them to the desktop clients and /api/me.
      data: { trialEndsAt: governing.endsAt },
    })
    .catch(() => {});
}
