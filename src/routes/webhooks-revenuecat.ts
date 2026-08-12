import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { Router, type Request } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { env } from "../lib/env";
import { asyncHandler } from "../middleware/async-handler";
import { isObjectId } from "../lib/lemonsqueezy";
import { prisma } from "../lib/prisma";
import { claimWebhookEvent, markWebhookEvent } from "../lib/webhook-events";
import { RC_KNOWN_PRODUCT_IDS, RC_PROVIDER, syncUserFromRevenueCat } from "../lib/revenuecat";
import { resolveAndCache } from "./entitlement";

export const revenueCatWebhookRouter = Router();

/*
 * The RevenueCat webhook — iOS money arriving.
 *
 * Same four rules as the Lemon Squeezy webhook next door (verify before
 * anything; claim → work → mark; status codes are instructions; a valid
 * delivery is not an entitlement), plus ONE structural difference that
 * simplifies everything: the event is only ever a DOORBELL. Whatever it says
 * happened — INITIAL_PURCHASE, RENEWAL, CANCELLATION, UNCANCELLATION,
 * EXPIRATION, BILLING_ISSUE, PRODUCT_CHANGE, TRANSFER, NON_RENEWING_PURCHASE,
 * REFUND, all of them — the handler answers by re-fetching the subscriber's
 * FULL current state from the RevenueCat API and mirroring that. Out-of-order
 * deliveries, duplicates and event types invented after this shipped all
 * converge on the same snapshot for free.
 *
 * The perimeter is the Authorization header (RevenueCat does not sign
 * deliveries): the exact value configured in their dashboard, compared in
 * constant time. SANDBOX events are deliberately PROCESSED, not skipped — the
 * rows they write carry testMode, and whether a testMode row GRANTS is decided
 * at read time by REVENUECAT_ALLOW_SANDBOX (see hideTestRows). Skipping them
 * here would mean TestFlight testers could never be granted at all, however
 * the flag was set.
 */

/**
 * Constant-time equality over inputs of ANY length: both sides are hashed to a
 * fixed 32 bytes first, so the length of the configured token never leaks
 * through the early-exit that a naive length check would be.
 */
function safeEqual(a: string, b: string): boolean {
  const da = createHash("sha256").update(a, "utf8").digest();
  const db = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(da, db);
}

/**
 * Does the Authorization header carry the configured token?
 *
 * RevenueCat sends the dashboard value VERBATIM — whatever the operator typed,
 * "Bearer x" or bare "x". Both spellings are accepted on both sides so a token
 * pasted with or without the prefix keeps working; the comparison itself stays
 * constant-time either way. Fails CLOSED on a missing header or an unset token.
 */
function verifyAuthorization(header: string | undefined): boolean {
  const expected = env.revenuecatWebhookAuthToken;
  if (!header || !expected) return false;
  const strip = (v: string) => (v.startsWith("Bearer ") ? v.slice("Bearer ".length) : v);
  return safeEqual(strip(header), strip(expected));
}

/**
 * The OPTIONAL second factor. RevenueCat does not sign webhooks natively today
 * — this hook exists for a signing proxy in front of us, and is enforced only
 * while REVENUECAT_WEBHOOK_HMAC_SECRET is set: hex HMAC-SHA256 of the raw
 * request bytes in `X-RevenueCat-Signature`, verified exactly the way the
 * Lemon Squeezy signature is (shape-checked before decoding, constant-time,
 * fail-closed). The Authorization token above remains the real barrier.
 */
function verifyHmacIfConfigured(rawBody: Buffer | undefined, signature: string | undefined): boolean {
  if (!env.revenuecatWebhookHmacSecret) return true;
  if (!rawBody || rawBody.length === 0) return false;
  if (!signature || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  const expected = createHmac("sha256", env.revenuecatWebhookHmacSecret).update(rawBody).digest();
  const received = Buffer.from(signature, "hex");
  if (received.length !== expected.length) return false;
  return timingSafeEqual(received, expected);
}

/**
 * The envelope we rely on. `passthrough` everywhere: this is someone else's
 * payload, and a field they add tomorrow must not start bouncing deliveries.
 */
const rcWebhookSchema = z
  .object({
    api_version: z.string().optional(),
    event: z
      .object({
        id: z.string().min(1),
        type: z.string().min(1),
        app_user_id: z.string().optional(),
        event_timestamp_ms: z.number().optional(),
        environment: z.enum(["SANDBOX", "PRODUCTION"]).optional(),
        store: z.string().optional(),
        app_id: z.string().optional(),
        product_id: z.string().optional(),
        transferred_from: z.array(z.string()).optional(),
        transferred_to: z.array(z.string()).optional(),
      })
      .passthrough(),
  })
  .passthrough();

type RcWebhook = z.infer<typeof rcWebhookSchema>;

/** Event families that legitimately arrive without a store/product. */
const STORELESS_TYPES = new Set(["TRANSFER", "TEST"]);

/**
 * Is this delivery about things we sell, in the store we sell them in?
 * Returns the skip reason, or null to proceed. Every refusal here is a
 * TERMINAL 200 — redelivering someone else's event changes nothing.
 */
function allowListVerdict(event: RcWebhook["event"]): string | null {
  const type = event.type.toUpperCase();

  // Only the App Store sells our iOS products. Absent is tolerated for the
  // families that genuinely carry no store (TRANSFER, TEST) — anything else
  // that cannot say where the money moved is not ours to act on.
  if (event.store) {
    if (event.store.toUpperCase() !== "APP_STORE") return `store ${event.store} is not ours`;
  } else if (!STORELESS_TYPES.has(type)) {
    return `event ${event.type} carries no store`;
  }

  // Someone else's RevenueCat app, when the deploy says which apps are ours.
  if (
    env.revenuecatAllowedAppIds.length > 0 &&
    event.app_id &&
    !env.revenuecatAllowedAppIds.includes(event.app_id)
  ) {
    return `app ${event.app_id} is not ours`;
  }

  // A product we do not sell. Absent is tolerated (TRANSFER/TEST carry none);
  // present-but-unknown is refused, exactly like isSellableOrder's variant
  // check — a valid delivery proves where it came from, never what it is for.
  if (event.product_id && !RC_KNOWN_PRODUCT_IDS.includes(event.product_id)) {
    return `product ${event.product_id} is not one we sell`;
  }

  return null;
}

/**
 * Which of our accounts this event touches.
 *
 * app_user_id IS our Mongo user id — the app logs into RevenueCat with it
 * before any purchase — plus, on a TRANSFER, both sides of the move: the
 * receiving account gains access and the LOSING one must lose it, so both are
 * re-synced. Anything that is not a 24-hex ObjectId (RevenueCat's
 * `$RCAnonymousID:` in particular) is logged WITHOUT the id itself and
 * dropped; malformed ids must never reach Prisma (P2023 throws — see the
 * Lemon Squeezy resolvers).
 */
function candidateUserIds(event: RcWebhook["event"]): { ids: string[]; anonymous: number } {
  const raw = [
    ...(event.app_user_id ? [event.app_user_id] : []),
    ...(event.transferred_to ?? []),
    ...(event.transferred_from ?? []),
  ];
  const ids: string[] = [];
  let anonymous = 0;
  for (const candidate of raw) {
    if (isObjectId(candidate)) {
      if (!ids.includes(candidate)) ids.push(candidate);
    } else {
      anonymous += 1;
    }
  }
  return { ids, anonymous };
}

revenueCatWebhookRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    // A disabled integration answers 503, not 200: RevenueCat will retry, and
    // the day the deploy is configured the queued deliveries land instead of
    // having been swallowed while nothing could act on them.
    if (!env.revenuecatEnabled) {
      res.status(503).json({ error: { code: "PROVIDER_DISABLED" } });
      return;
    }

    // VERIFY BEFORE ANYTHING — no body reads, no logs of its content, no
    // database. Logged without payload content, like the Lemon Squeezy 401:
    // an unauthorized caller gets no help, but a misconfigured token must not
    // be invisible either.
    if (!verifyAuthorization(req.header("authorization") ?? undefined)) {
      console.warn("[revenuecat] rejected delivery: bad or missing Authorization");
      res.status(401).json({ error: { code: "INVALID_AUTHORIZATION" } });
      return;
    }

    const raw = (req as Request & { rawBody?: Buffer }).rawBody;
    if (!verifyHmacIfConfigured(raw, req.header("x-revenuecat-signature") ?? undefined)) {
      console.warn("[revenuecat] rejected delivery: bad or missing HMAC signature");
      res.status(401).json({ error: { code: "INVALID_SIGNATURE" } });
      return;
    }

    const parsed = rcWebhookSchema.safeParse(req.body);
    if (!parsed.success) {
      // 400, not 200-skipped: an authorized delivery whose envelope we cannot
      // read is a contract change worth surfacing in RevenueCat's dashboard,
      // not something to acknowledge and silently drop.
      console.warn("[revenuecat] authorized delivery we cannot parse");
      res.status(400).json({ error: { code: "INVALID_PAYLOAD" } });
      return;
    }
    const { event } = parsed.data;

    // A replay from beyond RevenueCat's own retry horizon (~72h; ours is 96 by
    // default). Acknowledged, never processed: the state it announced has been
    // superseded by every sync since, and re-syncing from the current API
    // state would be harmless but is not worth doing on an attacker-replayable
    // trigger.
    if (
      typeof event.event_timestamp_ms === "number" &&
      Date.now() - event.event_timestamp_ms > env.revenuecatMaxEventAgeHours * 60 * 60 * 1000
    ) {
      res.status(200).json({ ok: true, skipped: "stale event" });
      return;
    }

    const refused = allowListVerdict(event);
    if (refused) {
      res.status(200).json({ ok: true, skipped: refused });
      return;
    }

    // NOTE: environment SANDBOX deliberately proceeds. Isolation happens at
    // READ time (hideTestRows + REVENUECAT_ALLOW_SANDBOX), not by refusing to
    // record — a sandbox ending must be written for the same reason a Lemon
    // Squeezy test-mode ending is, and TestFlight testers must be grantable
    // at all on a deploy that opens the flag.

    // CLAIM. RevenueCat's event id is unique per event and stable across
    // redeliveries, so it is the dedupe key as-is — no composite needed.
    const claim = await claimWebhookEvent(
      RC_PROVIDER,
      event.id,
      event.type,
      parsed.data as Prisma.InputJsonValue,
    );
    if (claim === "done") {
      res.status(200).json({ ok: true, deduped: true });
      return;
    }
    if (claim === "retry") {
      res.status(503).json({ error: { code: "IN_FLIGHT" } });
      return;
    }

    try {
      const { ids, anonymous } = candidateUserIds(event);
      if (anonymous > 0) {
        // Never the id itself: an anonymous RevenueCat id is still a stable
        // pseudonymous identifier, i.e. PII we have no reason to keep in logs.
        console.info(
          `[revenuecat] ${event.type}: ${anonymous} non-account app_user_id(s) ignored`,
        );
      }

      // Only accounts that exist: an app_user_id shaped like an ObjectId but
      // matching nobody (a deleted account, another environment's id space)
      // is understood and will never be actionable — terminal, like every
      // "not ours" above.
      const known: string[] = [];
      for (const id of ids) {
        const user = await prisma.user.findUnique({ where: { id }, select: { id: true } });
        if (user) known.push(id);
      }

      if (known.length === 0) {
        await markWebhookEvent(RC_PROVIDER, event.id, "skipped", "no account to sync");
        res.status(200).json({ ok: true, status: "skipped", note: "no account to sync" });
        return;
      }

      // THE WORK: re-fetch each touched subscriber and mirror the snapshot.
      // The event's own claims are never written — see the header comment.
      for (const userId of known) {
        await syncUserFromRevenueCat(userId);
        // Refresh the denormalized cache so GET /api/me agrees without waiting
        // for the next entitlement read. Best-effort: the rows are already
        // written, and a cache miss must not turn a recorded purchase into a
        // redelivery loop.
        await resolveAndCache(userId, "").catch((e) =>
          console.error(`[revenuecat] could not refresh entitlement cache for ${userId}:`, e),
        );
      }

      await markWebhookEvent(RC_PROVIDER, event.id, "processed");
      res.status(200).json({ ok: true, status: "processed" });
    } catch (err) {
      // Leave the row non-terminal so the redelivery re-runs the work, then
      // let the error surface as a 500 so there IS a redelivery — a subscriber
      // state we failed to mirror is a customer whose access is about to be
      // wrong. (The usual cause is the RevenueCat API itself being down, which
      // their retry-with-backoff is exactly shaped for.)
      await markWebhookEvent(
        RC_PROVIDER,
        event.id,
        "failed",
        err instanceof Error ? err.message : "unknown error",
      );
      throw err;
    }
  }),
);
