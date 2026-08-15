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
import { APP_STORE, isSellableProductId, purchaseEffect } from "../lib/entitlement";
import { InvalidTransaction, verifySignedTransaction } from "../lib/apple-jws";
import { assertCanWrite } from "../lib/purchase-providers";
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
       no migration);
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
   looks the Apple leg up first and lets the unique `deviceIdHash` catch
   the rest, treating a duplicate key as success. Neither can grant a
   second window.
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
    // The shop must be open before anything is verified. Closed is not a
    // rejection of this request, it is the absence of this whole path — see
    // lib/purchase-providers.ts, which is also where iOS gets wired in.
    assertCanWrite(APP_STORE);

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
    if (!isSellableProductId(tx.productId)) throw transactionUnknownProduct();

    // A SANDBOX transaction is signed by the same Apple chain as a real one, and
    // carries the real bundle id and the real product id — every check above
    // passes on it. It is also free. Without this comparison the route was a
    // lifetime-licence tap that anyone with a developer account could open, and
    // `requireAuth` is no obstacle: it is reachable with curl from any platform.
    //
    // A MISSING environment is refused too. It is not a courtesy to old clients:
    // absence is indistinguishable from a payload trimmed to dodge the check, and
    // this is the money path. Apple has sent the field since StoreKit 2 shipped.
    if ((tx.environment ?? "").toLowerCase() !== env.appleEnvironment.toLowerCase()) {
      console.warn(
        `[purchases] refused: environment ${JSON.stringify(tx.environment ?? null)} ` +
          `!= ${JSON.stringify(env.appleEnvironment)} (product ${tx.productId})`,
      );
      throw transactionForeign("This purchase did not come from the App Store");
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
      env.trialDays,
    );

    if (effect.kind === "lifetime") {
      await recordLifetime(userId, tx, effect.refunded);
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

  // Deliberately NOT touching `User.plan`. The cache has ONE writer —
  // `resolveAndCache`, which the route calls right after this and which writes
  // the resolver's own vocabulary. A second writer here wrote a different word
  // ("lifetime") for the resolver to overwrite moments later ("active"), and a
  // mirror two writers disagree about is worse than no mirror.
}

/**
 * Claim the free trial, bound to the Apple ID, the phone and the account.
 *
 * CREATE-ONLY. Two legs carry it, and they are enforced differently:
 *   · `deviceIdHash`        — one trial per phone, a UNIQUE index, so a second
 *                             account on the same handset collides in the
 *                             database rather than racing check-then-act. A
 *                             duplicate key is the SUCCESS path.
 *   · `appleOriginalTxHash` — one trial per Apple ID, surviving a factory reset.
 *                             Enforced by the lookup below rather than by a
 *                             unique index: the column is null for every macOS
 *                             claim, and a MongoDB unique index admits only ONE
 *                             document with a missing field, so making it unique
 *                             would reject the second desktop claim ever
 *                             written. The residual race is two SIMULTANEOUS
 *                             first-claims from one Apple ID on two different
 *                             phones; the device leg still bounds each of them
 *                             to one window per handset.
 *
 * Either way the outcome is the same: an Apple ID or a phone that already had a
 * window gets that window back — elapsed or not — never a fresh one.
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

  // The Apple leg, checked before the insert because it carries no unique index
  // (see the note above). Finding a row here means this Apple ID has already had
  // its window on some phone: leave it alone and fall through to the stamp, which
  // is what carries that window onto this account.
  const claimedByAppleId = await prisma.trialClaim.findFirst({
    where: { appleOriginalTxHash },
    select: { id: true },
  });

  if (!claimedByAppleId) {
    try {
      await prisma.trialClaim.create({
        data: {
          appleOriginalTxHash,
          deviceIdHash,
          idfvHash: idfv ? ledgerHash(idfv) : null,
          firstUserId: userId,
          trialDays: env.trialDays,
          startedAt: window.startedAt,
          endsAt: window.endsAt,
          status: "active",
        },
      });
    } catch (err) {
      // Already claimed on this phone — exactly what the unique index is for, and
      // also how the residual Apple-leg race lands. Never rewrite the existing
      // row: rewriting it IS the farm.
      if (!isDuplicateKey(err)) throw err;
    }
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
  // `endsAt` is optional in the schema (a claim can exist before its window is
  // stamped), and a null one governs nothing — there is no date to narrow to.
  if (!governing?.endsAt) return;
  const governingEndsAt = governing.endsAt;

  // NARROWING ONLY: write when the account has no window, or one that ends LATER
  // than the ledger allows. The `gt` is what makes this safe to run on every
  // replayed transaction — it can pull a window in, never push it out.
  await prisma.user
    .updateMany({
      where: {
        id: userId,
        OR: [{ trialEndsAt: null }, { trialEndsAt: { gt: governingEndsAt } }],
      },
      // Deliberately not touching `plan` — the cache has one writer,
      // `resolveAndCache` (see recordLifetime above). A demotion to "trial"
      // written here on a replayed transaction would misreport a lifetime
      // owner to the desktop clients until the next resolve corrected it.
      data: { trialEndsAt: governingEndsAt },
    })
    .catch(() => {});
}
