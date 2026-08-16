import { Router } from "express";
import crypto from "node:crypto";
import { prisma } from "../lib/prisma";
import { env, variantGate } from "../lib/env";
import { asyncHandler } from "../middleware/async-handler";
import { requireAdmin } from "../middleware/admin-auth";
import { resolveAndCache } from "./entitlement";
import { hideTestRowsFor, isCurrentTrial, isLiveUnpaidTrial } from "../lib/subscription";
import {
  MAX_ATTEMPTS,
  drainCancels,
  enqueueAndAttemptCancel,
  queueCancelAndRevokeTrial,
  replayTask,
} from "../lib/billing-tasks";

import { signAdminToken } from "../lib/admin-jwt";
import { RC_PROVIDER, deleteSubscriber } from "../lib/revenuecat";
import { toPublicUser } from "../lib/user";
import { notFound, unauthorized, badRequest, conflict, HttpError } from "../lib/http-error";
import { clientIp, consumeRateLimit } from "../lib/rate-limit";
import { readLemonSqueezyError } from "../lib/lemonsqueezy";
import {
  adminActionSchema,
  adminCancelSubscriptionSchema,
  adminCompSchema,
  adminLoginSchema,
  adminReactivateSubscriptionSchema,
  adminRevokeSchema,
  adminSetPlanSchema,
  GRANTING_PLAN_NAMES,
  adminTestSubscriptionCreateSchema,
  adminSubscriptionTimeSchema,
  adminSubscriptionTransitionSchema,
  adminTestResetUserSchema,
  adminTrialResetSchema,
} from "../validation/schemas";
import {
  overview,
  usersList,
  computeUserStats,
  liveSessionWhere,
} from "../services/admin-stats";

/**
 * Which plan names the console may hand out as a complimentary grant. Anything
 * else ("free", "expired", …) removes the comp instead — it does NOT cancel a
 * real paid subscription, which is a money decision and has its own button.
 *
 * Defined next to the schema that validates against it, so the rule about which
 * plans need an end date cannot drift from the rule about which plans grant.
 */
const GRANTING_PLANS = GRANTING_PLAN_NAMES;

/**
 * Plan names that mean "take the complimentary grant away".
 *
 * Explicit, so that anything belonging to NEITHER set is an error rather than a
 * silent revocation — see the check in POST /users/:id/plan.
 */
const WITHDRAWING_PLANS = new Set(["free", "none", "expired", "revoked"]);

export const adminRouter = Router();

/** A hung outbound call on a serverless function bills until it is killed. */
const LS_TIMEOUT_MS = 10_000;

/** Constant-time-ish string compare (length may leak, acceptable for creds). */
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// ── auth ─────────────────────────────────────────────────────────────────────

/** Exchange env-configured admin credentials for a short-lived admin JWT. */
adminRouter.post(
  "/login",
  asyncHandler(async (req, res) => {
    if (!env.adminPassword) {
      // No password configured → admin console is disabled (never allow blank).
      throw new HttpError(503, "Admin console is not configured");
    }
    // Brute-force cap BEFORE the compare. The admin token grants comp/revoke/
    // plan/delete over EVERY account, so a grindable password is a grindable
    // route to hijacking any licence — the audit's top revocation-control risk.
    // Two legs: per-IP for the common case, and a coarse global leg because
    // clientIp reads spoofable headers and a distributed/rotating-IP attempt
    // would otherwise slip the per-IP cap. Counted on every attempt (a wrong
    // password still consumes budget); a correct login within budget is fine.
    await consumeRateLimit(`admin-login:ip:${clientIp(req)}`, 10, 15 * 60_000);
    await consumeRateLimit(`admin-login:global`, 100, 15 * 60_000);

    const { username, password } = adminLoginSchema.parse(req.body);
    const ok =
      safeEqual(username, env.adminUsername) && safeEqual(password, env.adminPassword);
    if (!ok) {
      throw unauthorized("Invalid credentials");
    }
    const token = signAdminToken(env.adminUsername);
    res.json({ token, username: env.adminUsername });
  }),
);

adminRouter.get(
  "/me",
  requireAdmin,
  asyncHandler(async (req, res) => {
    res.json({ username: req.admin!.username });
  }),
);

// ── dashboard ────────────────────────────────────────────────────────────────

adminRouter.get(
  "/overview",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    res.json(await overview());
  }),
);

/** Every focus session happening right now (fresh heartbeat), with its owner. */
adminRouter.get(
  "/live-sessions",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const rows = await prisma.liveSession.findMany({
      where: liveSessionWhere(),
      orderBy: { lastHeartbeatAt: "desc" },
      include: { user: { select: { email: true, plan: true, status: true } } },
    });
    res.json({ sessions: rows, count: rows.length });
  }),
);

// ── users ────────────────────────────────────────────────────────────────────

adminRouter.get(
  "/users",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const search = typeof req.query.search === "string" ? req.query.search : undefined;
    const skip = req.query.skip ? Number.parseInt(String(req.query.skip), 10) : 0;
    const take = req.query.take ? Number.parseInt(String(req.query.take), 10) : 25;
    const sortBy = req.query.sortBy === "email" ? "email" : "createdAt";
    const sortDir = req.query.sortDir === "asc" ? "asc" : "desc";
    res.json(
      await usersList({
        search,
        skip: Number.isFinite(skip) ? skip : 0,
        take: Number.isFinite(take) ? take : 25,
        sortBy,
        sortDir,
      }),
    );
  }),
);

/** Full profile: identity, devices, stat pack, synced plan data, live session. */
adminRouter.get(
  "/users/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) throw notFound("User not found");

    const [devices, snapshot, live, recentEvents, stats, purchases, subscriptions] =
      await Promise.all([
        prisma.device.findMany({ where: { userId: id }, orderBy: { lastSeenAt: "desc" } }),
        prisma.syncSnapshot.findUnique({ where: { userId: id } }),
        prisma.liveSession.findMany({
          where: { userId: id, ...liveSessionWhere() },
          orderBy: { lastHeartbeatAt: "desc" },
        }),
        prisma.focusEvent.findMany({
          where: { userId: id },
          orderBy: { startedAt: "desc" },
          take: 25,
        }),
        computeUserStats(id),
        // The real payment record, so an operator can see WHO PAID FOR WHAT
        // rather than inferring it from the entitlement cache. Test rows are
        // shown too (with the flag) — hiding them here would hide exactly what
        // an operator is checking before going live.
        prisma.purchase.findMany({
          where: { userId: id },
          orderBy: { purchasedAt: "desc" },
          select: {
            id: true, provider: true, externalId: true, productId: true,
            priceUsd: true, purchasedAt: true, isRefunded: true, refundedAt: true, testMode: true,
          },
        }),
        prisma.subscription.findMany({
          where: { userId: id },
          orderBy: { updatedAt: "desc" },
          select: {
            id: true, provider: true, externalId: true, variantId: true, interval: true,
            status: true, validUntil: true, trialEndsAt: true, renewsAt: true, endsAt: true,
            testMode: true, updatedAt: true,
          },
        }),
      ]);

    res.json({
      user: toPublicUser(user),
      devices,
      stats,
      purchases,
      subscriptions,
      // Whether the test lab (synthetic subscriptions) may be shown/used. The
      // console hides those controls unless this deploy allows test mode; the
      // endpoints 503 regardless of the UI, so this is presentation, not a gate.
      testTools: env.lemonSqueezyAllowTestMode,
      snapshot: snapshot
        ? {
            blocklists: snapshot.blocklists,
            sessions: snapshot.sessions,
            schedules: snapshot.schedules ?? [],
            revision: snapshot.revision,
            updatedAt: snapshot.updatedAt,
          }
        : null,
      liveSessions: live,
      recentEvents,
    });
  }),
);

/** Paginated focus-event history for a user. */
adminRouter.get(
  "/users/:id/events",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    const skipRaw = req.query.skip ? Number.parseInt(String(req.query.skip), 10) : 0;
    // Clamp to >= 0: a negative skip is finite, so it would otherwise reach Prisma
    // and throw a PrismaClientValidationError (no `code` → uncaught 500).
    const skip = Math.max(Number.isFinite(skipRaw) ? skipRaw : 0, 0);
    const takeRaw = req.query.take ? Number.parseInt(String(req.query.take), 10) : 50;
    const take = Math.min(Math.max(Number.isFinite(takeRaw) ? takeRaw : 50, 1), 200);

    const [total, events] = await Promise.all([
      prisma.focusEvent.count({ where: { userId: id } }),
      prisma.focusEvent.findMany({
        where: { userId: id },
        orderBy: { startedAt: "desc" },
        skip,
        take,
      }),
    ]);
    res.json({ events, total, skip, take });
  }),
);

// ── moderation (write) ───────────────────────────────────────────────────────

adminRouter.post(
  "/users/:id/suspend",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const before = await getUserOr404(req.params.id);
    const { reason } = adminActionSchema.parse(req.body ?? {});
    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: { status: "suspended" },
    });
    await audit(req, "suspend", user.id, reason ?? "", { status: before.status }, { status: "suspended" });
    res.json({ user: toPublicUser(user) });
  }),
);

adminRouter.post(
  "/users/:id/unsuspend",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const before = await getUserOr404(req.params.id);
    const { reason } = adminActionSchema.parse(req.body ?? {});
    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: { status: "active" },
    });
    await audit(req, "unsuspend", user.id, reason ?? "", { status: before.status }, { status: "active" });
    res.json({ user: toPublicUser(user) });
  }),
);

adminRouter.post(
  "/users/:id/plan",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const before = await getUserOr404(req.params.id);
    const { plan, reason, until, confirmUserId } = adminSetPlanSchema.parse(req.body);

    // A grant with NO END DATE is the one nobody ever notices again: it does not
    // appear in an expiry sweep, it does not turn up in a renewal report, and the
    // only way it ends is if a human remembers it exists. So it is the one that
    // has to be typed out rather than clicked — same shape as the trial reset's
    // confirmation, which guards the other irreversible-by-mis-click action here.
    const permanent = plan.toLowerCase() === "lifetime" && until == null;
    if (permanent && confirmUserId !== req.params.id) {
      throw badRequest(
        "A lifetime grant with no end date must be confirmed by repeating the user id in confirmUserId.",
      );
    }

    // THIS USED TO DO NOTHING, convincingly. It wrote `User.plan`, which is a
    // CACHE: `resolveAndCache` overwrites it from the real rows on the very next
    // /api/entitlement call, i.e. within minutes. The console showed the new
    // plan, the audit log recorded a change, the customer's access never moved,
    // and the row quietly reverted. An admin action that reports success without
    // acting is worse than no button at all.
    //
    // So it is routed to the lever that actually decides — the complimentary
    // grant `computeEntitlement` reads — and the response carries the RESOLVED
    // entitlement rather than the row we just wrote, so the console cannot show
    // a state the resolver disagrees with.
    // AN UNKNOWN PLAN NAME IS REFUSED, not quietly treated as "withdraw".
    //
    // The console's dropdown offers "trial" while the backend spells the granting
    // status "trialing" — so picking it validated cleanly, skipped the end-date
    // requirement, and wrote compActive:false. The operator read that as "give
    // them a trial"; it REVOKED their grant, and looked like success.
    const wanted = plan.toLowerCase();
    const grants = GRANTING_PLANS.has(wanted);
    if (!grants && !WITHDRAWING_PLANS.has(wanted)) {
      throw badRequest(
        `Unknown plan "${plan}". Grant one of: ${[...GRANTING_PLANS].join(", ")}. ` +
          `To withdraw a grant use: ${[...WITHDRAWING_PLANS].join(", ")}.`,
      );
    }
    await prisma.user.update({
      where: { id: req.params.id },
      data: grants
        ? {
            compActive: true,
            // The requested plan is kept in the reason because the LEVER has no
            // notion of "which plan" — a comp is a comp. Without this, an
            // operator who picked "lifetime" and an operator who picked "pro"
            // leave identical rows, and support can never tell what was meant.
            compReason: reason ? `set plan ${plan}: ${reason}` : `admin: set plan ${plan}`,
            // Time-boxable, and permanent only when nobody asked for an end. A
            // grant that quietly expired would be worse than one that lasts.
            compedUntil: until ?? null,
          }
        : { compActive: false, compedUntil: null },
    });

    // No device id: this is a server-side recompute for the console, not a
    // client asking whether IT may run.
    const view = await resolveAndCache(req.params.id, "");
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.params.id } });

    await audit(
      req,
      "set_plan",
      user.id,
      reason ?? "",
      { plan: before.plan, compActive: before.compActive },
      { plan, compActive: grants, compedUntil: until ?? null, permanent, resolved: view.status },
    );
    res.json({ user: toPublicUser(user), entitlement: view });
  }),
);

/**
 * STOP CHARGING THE CARD — enqueue (and immediately attempt) a Lemon Squeezy
 * cancel for every still-billing subscription of one account. Extracted from
 * DELETE /users/:id so the test reset below unwinds billing through the SAME
 * outbox machinery instead of a second, driftable copy. Returns how many
 * cancellations are now owed.
 *
 * Test rows filtered — the lab's synthetic ids would dead-letter a task for a
 * subscription Lemon Squeezy has never heard of. Lemon Squeezy rows only: the
 * outbox cannot cancel an Apple subscription (the customer does that in their
 * App Store settings), so enqueueing one would only mint a dead-lettered task.
 */
async function enqueueLiveLsCancels(userId: string, reason: string): Promise<number> {
  const liveSubs = await prisma.subscription.findMany({
    where: {
      userId,
      provider: "lemonsqueezy",
      ...hideTestRowsFor(userId, env),
    },
    select: { externalId: true, status: true },
  });
  let enqueued = 0;
  for (const s of liveSubs) {
    if (s.status === "expired" || s.status === "cancelled") continue;
    await enqueueAndAttemptCancel(s.externalId, reason);
    enqueued += 1;
  }
  return enqueued;
}

/**
 * The one deleter of an account row. Prisma's emulated cascades take every
 * relation-bearing collection with it (devices, focusEvents, snapshot,
 * authProviders, liveSessions, …). ConsumedOrder, TrialClaim and
 * RcSubscriberClaim have NO user relation on purpose and survive — each is a
 * ledger that must outlive the account it describes (see schema.prisma).
 * Shared by the console delete and the test reset so the two can never
 * cascade differently.
 */
async function deleteAccountRow(userId: string): Promise<void> {
  await prisma.user.delete({ where: { id: userId } });
}

adminRouter.delete(
  "/users/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const before = await getUserOr404(req.params.id);
    const { reason } = adminActionSchema.parse(req.body ?? {});
    // Audit BEFORE the cascade: the delete erases the user and every row keyed
    // to it, so a row written afterwards would have nothing to point at. Snapshot
    // the identity that is about to vanish.
    await audit(
      req,
      "delete_user",
      before.id,
      reason ?? "",
      { email: before.email, plan: before.plan, createdAt: before.createdAt },
      { deleted: true },
    );
    // STOP CHARGING THE CARD, before the rows that name the subscription go.
    // Deleting from the console had exactly the same hole as DELETE /api/me: the
    // account vanished, Lemon Squeezy was never told, and the customer kept
    // being billed for something nobody could see any more. Enqueued first so an
    // unreachable provider postpones the cancellation instead of losing it.
    await enqueueLiveLsCancels(req.params.id, "account-deleted-by-admin");

    // Relations (devices, focusEvents, snapshot, authProviders, liveSessions)
    // all cascade on delete in the schema. ConsumedOrder does NOT — it has no
    // user relation on purpose, so a paid order stays spent after the account
    // is gone (see schema.prisma + the audit's recycled-email finding).
    await deleteAccountRow(req.params.id);
    res.json({ deleted: true });
  }),
);

/**
 * Work off the billing actions we still owe Lemon Squeezy, by hand.
 *
 * The scheduled run at `/api/cron/billing-tasks` is what normally does this; this
 * is the same drain behind the admin gate, for an operator who has just fixed the
 * cause and does not want to wait for the next tick.
 *
 * Safe to press twice, and safe to press while the cron is running: each task is
 * claimed by an atomic conditional update before the provider is touched, and
 * cancelling an already-cancelled subscription is a no-op anyway.
 */
adminRouter.post(
  "/billing-tasks/drain",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    res.json(await drainCancels());
  }),
);

/**
 * What is still owed — split into what is still being retried and what has given
 * up.
 *
 * The split is the point. A dead-lettered task is no longer picked up by the
 * drain, so it is exactly the row that will sit there for ever if nobody is shown
 * it: a customer whose card is still being charged and whose cancellation the
 * automatic machinery has stopped trying to send.
 */
adminRouter.get(
  "/billing-tasks",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const columns = {
      id: true,
      externalId: true,
      kind: true,
      reason: true,
      attempts: true,
      lastError: true,
      lockedAt: true,
      nextAttemptAt: true,
      createdAt: true,
    } as const;

    const [pending, deadLetter] = await Promise.all([
      prisma.billingTask.findMany({
        where: { attempts: { lt: MAX_ATTEMPTS }, OR: [{ doneAt: null }, { doneAt: { isSet: false } }] },
        orderBy: { nextAttemptAt: "asc" },
        take: 100,
        select: columns,
      }),
      prisma.billingTask.findMany({
        where: { attempts: { gte: MAX_ATTEMPTS }, OR: [{ doneAt: null }, { doneAt: { isSet: false } }] },
        orderBy: { createdAt: "asc" },
        take: 100,
        select: columns,
      }),
    ]);

    res.json({
      owed: pending.length + deadLetter.length,
      pending,
      deadLetter,
      maxAttempts: MAX_ATTEMPTS,
    });
  }),
);

/**
 * Put a dead-lettered task back in the queue.
 *
 * What makes the dead letter safe to have. A task exhausts its attempts for
 * reasons an operator fixes — an expired API key, a subscription Lemon Squeezy
 * refused to touch — and without a way back the only remedy would be editing the
 * database by hand. Audited like every other money action, because "who put this
 * back and why" is the first question when it fails again.
 */
adminRouter.post(
  "/billing-tasks/:id/replay",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { reason } = adminActionSchema.parse(req.body ?? {});
    const task = await prisma.billingTask.findUnique({
      where: { id: req.params.id },
      select: { id: true, externalId: true, attempts: true, doneAt: true, lastError: true },
    });
    if (!task) throw notFound("Billing task not found");
    if (task.doneAt) throw conflict("That billing task is already settled.");

    const ok = await replayTask(task.id);
    await audit(
      req,
      "billing_task_replay",
      // Not a user action: the outbox is deliberately keyed on the PROVIDER's id
      // and carries no user, because the account it belonged to may be deleted.
      "",
      reason ?? "",
      { attempts: task.attempts, lastError: task.lastError },
      { externalId: task.externalId, requeued: ok },
    );
    res.json({ requeued: ok });
  }),
);

/**
 * Every subscription variant this database has ever seen, and whether it grants.
 *
 * THE PRE-DEPLOY SAFETY CHECK for `LEMONSQUEEZY_VARIANTS_GRANTING`. The variant
 * allowlist refuses anything it does not recognise, and the way that goes wrong
 * is silent: a price change in Lemon Squeezy mints a NEW variant id, existing
 * subscribers stay on the OLD one, and the deploy that updates the environment
 * cuts every one of them off with no error anywhere.
 *
 * So before deploying, read this list. Anything marked `grants: false` with a
 * live subscriber on it belongs in LEMONSQUEEZY_VARIANTS_GRANTING — and this
 * endpoint is the only place that can tell you, because it is the only place
 * that knows what people are actually subscribed to.
 */
adminRouter.get(
  "/billing/variants",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const rows = await prisma.subscription.findMany({
      // Lemon Squeezy rows only: this report exists to feed
      // LEMONSQUEEZY_VARIANTS_GRANTING, and a RevenueCat row's Apple product id
      // would show up as permanently "at risk" — and poison the suggested env
      // value with an id the boot check rejects as non-numeric.
      where: { provider: "lemonsqueezy" },
      select: { variantId: true, interval: true, status: true },
    });

    const now = new Date();
    const seen = new Map<string, { variantId: string; total: number; live: number; statuses: Record<string, number> }>();
    for (const row of rows) {
      const id = row.variantId || "(none)";
      const entry = seen.get(id) ?? { variantId: id, total: 0, live: 0, statuses: {} };
      entry.total += 1;
      entry.statuses[row.status] = (entry.statuses[row.status] ?? 0) + 1;
      // "Live" in the loose sense that matters here: a status that would grant if
      // the variant were allowed. Deliberately NOT subscriptionGrants — that
      // already applies the allowlist, and would report zero for exactly the
      // variants this endpoint exists to find.
      if (!["expired", "unpaid"].includes(row.status)) entry.live += 1;
      seen.set(id, entry);
    }

    const granting = new Set(variantGate.granting);
    const variants = [...seen.values()]
      .map((v) => ({
        ...v,
        grants: !variantGate.armed || v.variantId === "(none)" || granting.has(v.variantId),
      }))
      .sort((a, b) => b.live - a.live);

    // The one line an operator needs: what would break if this deployed now.
    const atRisk = variants.filter((v) => !v.grants && v.live > 0);

    res.json({
      gateArmed: variantGate.armed,
      granting: variantGate.granting,
      variants,
      atRisk,
      // Copy-paste ready. Existing retired ids plus everything at risk, so the
      // fix is one environment variable away rather than a manual transcription.
      suggestedVariantsGranting: [
        ...new Set([...env.lemonSqueezyVariantsGranting, ...atRisk.map((v) => v.variantId)]),
      ].join(","),
      checkedAt: now.toISOString(),
    });
  }),
);

/** Request a force-stop of a live session; the client ends it on its next beat. */
adminRouter.post(
  "/live-sessions/:id/force-end",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const row = await prisma.liveSession.findUnique({ where: { id: req.params.id } });
    if (!row) throw notFound("Live session not found");
    const updated = await prisma.liveSession.update({
      where: { id: req.params.id },
      data: { forceEnd: true },
    });
    await audit(req, "force_end_session", row.userId, "", { forceEnd: row.forceEnd }, { forceEnd: true });
    res.json({ liveSession: updated });
  }),
);

/** Remove a live-session row outright (e.g. a stale ghost the client never cleared). */
adminRouter.delete(
  "/live-sessions/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const row = await prisma.liveSession.findUnique({ where: { id: req.params.id } });
    const result = await prisma.liveSession.deleteMany({ where: { id: req.params.id } });
    if (result.count === 0) throw notFound("Live session not found");
    if (row) await audit(req, "delete_session", row.userId, "", { id: row.id }, { deleted: true });
    res.json({ deleted: true });
  }),
);

async function getUserOr404(id: string) {
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) throw notFound("User not found");
  return user;
}

/* ── Entitlement overrides ────────────────────────────────────────────────
 *
 * The two ways a human can overrule the resolver, plus the one way to undo the
 * machine rule. They exist because the alternative is editing Mongo by hand:
 * the "one trial per machine" ledger WILL produce false positives — a shared
 * family PC, a resold laptop, a replaced motherboard — and a rule with no
 * recourse is a rule that turns a support ticket into a lost customer.
 *
 * Every write lands in AdminAuditLog with a mandatory reason and the before/after,
 * because an override nobody can explain later is indistinguishable from a
 * mistake.
 */

/** The admin identity is an env credential, not a user row — hence a fixed id. */
const ADMIN_ACTOR = "000000000000000000000000";

async function audit(
  req: { admin?: { username: string } },
  action: string,
  targetUserId: string,
  reason: string,
  before: unknown,
  after: unknown,
  /** Structured extras that fit neither snapshot — e.g. the test reset's
   *  per-leg report. Omitted from the row entirely when not given. */
  meta?: unknown,
): Promise<void> {
  await prisma.adminAuditLog
    .create({
      data: {
        actorId: ADMIN_ACTOR,
        actorEmail: `admin:${req.admin?.username ?? "unknown"}`,
        action,
        targetUserId,
        reason,
        before: before as never,
        after: after as never,
        ...(meta !== undefined ? { meta: meta as never } : {}),
      },
    })
    // Best-effort: losing the audit row must not cost the operator the action
    // they came to perform. It is logged loudly instead.
    .catch((e) => console.error("[admin] audit row failed:", e));
}

/**
 * Grant access without a payment: a lifetime comp, or a time-boxed one.
 *
 * Also how support extends someone's trial — there is no separate "extend"
 * verb, because a time-boxed comp already is one and a second mechanism would
 * be a second thing to reason about.
 */
adminRouter.post(
  "/users/:id/comp",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const before = await getUserOr404(req.params.id);
    const { reason, until } = adminCompSchema.parse(req.body);

    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: {
        compActive: true,
        compReason: reason,
        compedUntil: until ?? null,
        compedAt: new Date(),
      },
    });

    await audit(req, "comp", user.id, reason, {
      compActive: before.compActive,
      compedUntil: before.compedUntil,
    }, { compActive: true, compedUntil: until ?? null });

    res.json({ user: toPublicUser(user) });
  }),
);

/** Withdraw a comp. Does NOT revoke access — a paid licence still stands. */
adminRouter.delete(
  "/users/:id/comp",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const before = await getUserOr404(req.params.id);
    const { reason } = adminRevokeSchema.parse(req.body ?? {});

    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: { compActive: false, compReason: reason, compedUntil: null },
    });

    await audit(req, "comp_withdraw", user.id, reason, {
      compActive: before.compActive,
      compedUntil: before.compedUntil,
    }, { compActive: false });

    res.json({ user: toPublicUser(user) });
  }),
);

/**
 * The hard stop. Outranks everything in the resolver, INCLUDING a live purchase
 * — which is the point: a chargeback or a terms breach must not be survivable by
 * having paid once.
 */
adminRouter.post(
  "/users/:id/revoke",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const before = await getUserOr404(req.params.id);
    const { reason } = adminRevokeSchema.parse(req.body);

    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: { accessRevoked: true, revokedReason: reason, revokedAt: new Date() },
    });

    await audit(req, "revoke", user.id, reason, { accessRevoked: before.accessRevoked }, {
      accessRevoked: true,
    });

    res.json({ user: toPublicUser(user) });
  }),
);

/** Undo a revocation. Whatever the account was entitled to before comes back. */
adminRouter.delete(
  "/users/:id/revoke",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const before = await getUserOr404(req.params.id);
    const { reason } = adminRevokeSchema.parse(req.body ?? {});

    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: { accessRevoked: false, revokedReason: reason, revokedAt: null },
    });

    await audit(req, "revoke_undo", user.id, reason, { accessRevoked: before.accessRevoked }, {
      accessRevoked: false,
    });

    res.json({ user: toPublicUser(user) });
  }),
);

/**
 * Give a machine its trial back.
 *
 * This is deliberately the most awkward route in the file, because it performs
 * the exact operation the ledger exists to prevent: it deletes a claim so the
 * hardware can earn a fresh window. It is the ONLY recourse for someone the
 * machine rule got wrong, and it must never be reachable by a mis-click — hence
 * `confirmUserId` in the body having to match the path.
 *
 * The DeviceSignal rows go with the claim. Leaving them would keep the hardware
 * pointing at a claim that no longer exists, which is worse than either state.
 */
adminRouter.post(
  "/users/:id/trial-reset",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const user = await getUserOr404(req.params.id);
    const { reason, confirmUserId } = adminTrialResetSchema.parse(req.body);
    if (confirmUserId !== req.params.id) {
      throw new HttpError(400, "confirmUserId does not match the account being reset");
    }

    const claims = await prisma.trialClaim.findMany({
      where: { firstUserId: user.id },
      select: { id: true, endsAt: true, deviceIdHash: true },
    });
    if (claims.length === 0) {
      res.json({ user: toPublicUser(user), claimsDeleted: 0 });
      return;
    }

    const ids = claims.map((c) => c.id);
    await prisma.deviceSignal.deleteMany({ where: { claimId: { in: ids } } });
    await prisma.trialClaim.deleteMany({ where: { id: { in: ids } } });
    // The legacy per-account window has to go too, or the resolver keeps
    // answering from it and the reset appears to have done nothing.
    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { trialEndsAt: null },
    });

    await audit(req, "reset_trial", user.id, reason, {
      claims: claims.map((c) => ({ endsAt: c.endsAt })),
      trialEndsAt: user.trialEndsAt,
    }, { claimsDeleted: ids.length });

    res.json({ user: toPublicUser(updated), claimsDeleted: ids.length });
  }),
);

/**
 * Cancel a customer's subscription FROM THE ADMIN CONSOLE — the operator-side
 * mirror of the in-app cancel.
 *
 * Same contract as the user's own cancel (routes/subscription.ts): Lemon Squeezy
 * stops future payments and keeps the customer valid until the end of the period
 * already paid for, then the row flips to `expired` on its own. The WEBHOOK
 * remains the sole writer of the Subscription row — this call only asks Lemon
 * Squeezy to cancel and records the intent; the state change lands via
 * subscription_updated/cancelled seconds later.
 *
 * The subscription is named by its externalId in the body AND verified to belong
 * to the account in the path, so a fat-fingered id cannot cancel a stranger's
 * plan. To take access away outright and immediately, use /revoke instead — this
 * is the graceful, refund-nothing path.
 */
adminRouter.post(
  "/users/:id/cancel-subscription",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const user = await getUserOr404(req.params.id);
    const { reason, externalId } = adminCancelSubscriptionSchema.parse(req.body);

    if (!env.lemonSqueezyApiKey) {
      throw new HttpError(503, "Billing is not configured on this deployment");
    }

    // Named by id, but ownership is proven against the account in the path — the
    // id in the body can never reach a subscription that is not this user's.
    const sub = await prisma.subscription.findFirst({
      where: { userId: user.id, provider: "lemonsqueezy", externalId },
      select: { id: true, externalId: true, status: true, trialEndsAt: true, trialCancelledAt: true },
    });
    if (!sub) throw notFound("No such subscription on this account");
    if (sub.status === "cancelled" || sub.status === "expired") {
      throw conflict(`Subscription is already ${sub.status}`);
    }

    // CANCELLING A TRIAL ENDS ACCESS AT ONCE, and that rule is armed by the
    // `trialCancelledAt` tombstone `subscriptionGrants` reads. The webhook writes
    // it, and so does the customer's own /cancel — this route wrote neither, so
    // an operator cancelling a trial left the customer with access until a
    // delivery happened to arrive. On the queued path there is no delivery
    // coming at all, and the trial would have run its full window for free.
    //
    // Set-once, and never on a paid subscription: the window must still be open,
    // which is the same test the predicate itself applies.
    // TWO questions, deliberately separate.
    //
    // `cancellingALiveTrial` — is there still a tombstone to write? False on a
    // retry, because the first call already wrote one.
    //
    // `isTrialRow` — is this row a trial at all? Still TRUE on that retry, which
    // is what lets the response keep saying `entitlementRevoked: true` instead of
    // reclassifying an already-revoked trial as a non-trial and reporting that
    // nothing was cut off.
    const cancellingALiveTrial = isLiveUnpaidTrial(sub);
    const isTrialRow = isCurrentTrial(sub);

    /**
     * Write the tombstone, and THROW if it does not land.
     *
     * This used to end in `.catch(e => console.error(...))`, which turned a
     * failed security write into an HTTP 200: Lemon Squeezy had cancelled, our
     * own revocation had not, and the operator was told the job was done. A
     * write that decides access cannot be best-effort — the caller must learn
     * that the two halves disagree.
     */
    const markTrialCancelled = async (): Promise<void> => {
      if (!cancellingALiveTrial) return;
      await prisma.subscription.updateMany({
        where: {
          id: sub.id,
          OR: [{ trialCancelledAt: null }, { trialCancelledAt: { isSet: false } }],
        },
        data: { trialCancelledAt: new Date() },
      });
    };

    /** Honest when only half of it worked. */
    const revocationFailed = (providerCancelled: boolean, queued: boolean, e: unknown): never => {
      console.error("[admin] cancellation recorded at the provider but NOT revoked locally:", e);
      throw new HttpError(
        503,
        "The subscription was actioned at the payment provider, but access could not be revoked here. Retry.",
        {
          code: "REVOCATION_NOT_PERSISTED",
          details: { providerCancelled, queued, entitlementRevoked: false },
        },
      );
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LS_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(`${env.lemonSqueezyApiBase}/v1/subscriptions/${sub.externalId}`, {
        method: "DELETE",
        headers: {
          Accept: "application/vnd.api+json",
          "Content-Type": "application/vnd.api+json",
          Authorization: `Bearer ${env.lemonSqueezyApiKey}`,
        },
        signal: controller.signal,
      });
    } catch (err) {
      // Never echo the failure verbatim: the request carried the API key.
      console.error("[admin] Lemon Squeezy unreachable:", err instanceof Error ? err.message : err);
      // NOT simply a 400. Deleting a user through this console enqueues the
      // cancellation so a provider outage postpones it instead of losing it
      // (see DELETE /users/:id); this route used to throw and remember nothing,
      // so an operator who pressed Cancel during an outage left the customer
      // being charged with no record that anyone had tried.
      // 202 ACCEPTED, not 400. The instruction was understood and durably
      // recorded; only the provider is late. A 400 tells the caller their
      // request was invalid — about a request we accepted — and forced the
      // console to read an English sentence to find out whether a customer's
      // renewal had actually stopped. The status code is the contract.
      // ONE transaction. Owing the cancellation and revoking the trial are the
      // two halves of the 202 promise; separately, a failure between them left
      // either a task nobody revoked for or a revoked customer nothing would
      // ever cancel. If it does not commit, nothing is claimed.
      try {
        await queueCancelAndRevokeTrial({
          externalId: sub.externalId,
          reason: "admin-cancel",
          subscriptionId: cancellingALiveTrial ? sub.id : null,
        });
      } catch (e) {
        revocationFailed(false, false, e);
      }
      await audit(req, "cancel_subscription", user.id, reason, { externalId, status: sub.status }, { cancelled: false, queued: true });
      res.status(202).json({ cancelled: false, queued: true, entitlementRevoked: isTrialRow });
      return;
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const why = await readLemonSqueezyError(response);
      console.error(`[admin] cancel ${sub.externalId} failed: HTTP ${response.status} — ${why}`);
      // Same reasoning as the unreachable branch above: a 5xx or a rate limit
      // from Lemon Squeezy is a "come back later", not a decision.
      if (response.status === 429 || response.status >= 500) {
        // Same reasoning: "come back later" is not a client error — and the
        // same two writes as the unreachable branch. This branch used to queue
        // the provider call and answer `entitlementRevoked: true` while writing
        // NO tombstone, so the response told an operator access had stopped
        // while the trial went on granting for the rest of its window.
        try {
          await queueCancelAndRevokeTrial({
            externalId: sub.externalId,
            reason: "admin-cancel",
            subscriptionId: cancellingALiveTrial ? sub.id : null,
          });
        } catch (e) {
          revocationFailed(false, false, e);
        }
        await audit(req, "cancel_subscription", user.id, reason, { externalId, status: sub.status }, { cancelled: false, queued: true });
        res.status(202).json({ cancelled: false, queued: true, entitlementRevoked: isTrialRow });
        return;
      }
      throw badRequest(`Could not cancel the subscription — ${why}`);
    }

    let endsAt: string | null = null;
    try {
      const body = (await response.json()) as { data?: { attributes?: { ends_at?: string | null } } };
      endsAt = body.data?.attributes?.ends_at ?? null;
    } catch {
      /* the cancellation still happened */
    }

    // THE TOMBSTONE FIRST, THE AUDIT SECOND — and the order is the point.
    //
    // Written the other way round, a failed revocation answered 503
    // REVOCATION_NOT_PERSISTED while leaving behind an audit row that said the
    // subscription was cancelled. The operator was told the write did not land;
    // the log said it did. An audit that can contradict the response it belongs
    // to is worse than no audit, because it is the record people trust later.
    try {
      await markTrialCancelled();
    } catch (e) {
      revocationFailed(true, false, e);
    }

    await audit(req, "cancel_subscription", user.id, reason, { externalId, status: sub.status }, {
      status: "cancelled",
      endsAt,
    });

    // 200 with a STRUCTURED result: the provider confirmed, nothing is owed.
    // 202 is reserved for "accepted, still to do" — conflating the two is what
    // made the console read prose to find out what had happened.
    res.status(200).json({
      cancelled: true,
      queued: false,
      // Explicit, so the console never has to infer whether access actually
      // stopped: a paid subscription keeps its period, a trial does not.
      entitlementRevoked: isTrialRow,
      endsAt,
    });
  }),
);

/**
 * Turn auto-renewal back ON — the operator mirror of the user's own reactivate.
 *
 * A REAL Lemon Squeezy resume (PATCH `cancelled:false`), valid only while the
 * subscription is cancelled but still inside its grace window; once expired,
 * only a fresh checkout restores it. Ownership-checked against the account in
 * the path. NOT test-gated: re-enabling a customer's renewal is a legitimate
 * support action, exactly like the cancel above.
 */
adminRouter.post(
  "/users/:id/reactivate-subscription",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const user = await getUserOr404(req.params.id);
    const { reason, externalId } = adminReactivateSubscriptionSchema.parse(req.body);

    if (!env.lemonSqueezyApiKey) {
      throw new HttpError(503, "Billing is not configured on this deployment");
    }

    const sub = await prisma.subscription.findFirst({
      where: { userId: user.id, provider: "lemonsqueezy", externalId },
      select: { externalId: true, status: true, validUntil: true },
    });
    if (!sub) throw notFound("No such subscription on this account");
    if (sub.status !== "cancelled") {
      throw conflict(`Subscription is ${sub.status}, not cancelled — nothing to resume`);
    }
    // A synthetic row never lives at Lemon Squeezy; resuming it there is a 404.
    if (sub.externalId.startsWith("sim_")) {
      throw badRequest("That is a simulated subscription — edit it in the test lab, not at Lemon Squeezy.");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LS_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(`${env.lemonSqueezyApiBase}/v1/subscriptions/${sub.externalId}`, {
        method: "PATCH",
        headers: {
          Accept: "application/vnd.api+json",
          "Content-Type": "application/vnd.api+json",
          Authorization: `Bearer ${env.lemonSqueezyApiKey}`,
        },
        body: JSON.stringify({
          data: { type: "subscriptions", id: String(sub.externalId), attributes: { cancelled: false } },
        }),
        signal: controller.signal,
      });
    } catch (err) {
      console.error("[admin] Lemon Squeezy unreachable:", err instanceof Error ? err.message : err);
      throw badRequest("Could not reach the payment provider. Please try again.");
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const why = await readLemonSqueezyError(response);
      console.error(`[admin] reactivate ${sub.externalId} failed: HTTP ${response.status} — ${why}`);
      throw badRequest(`Could not resume the subscription — ${why}`);
    }

    let renewsAt: string | null = null;
    try {
      const body = (await response.json()) as { data?: { attributes?: { renews_at?: string | null } } };
      renewsAt = body.data?.attributes?.renews_at ?? null;
    } catch {
      /* the resume still happened */
    }

    await audit(req, "reactivate_subscription", user.id, reason, { externalId, status: sub.status }, {
      status: "active",
      renewsAt,
    });

    res.status(202).json({ ok: true, renewsAt });
  }),
);

/* ── Test lab: synthetic subscriptions ──────────────────────────────────────
 *
 * A conjuring tool for the operator's OWN testing, never a real payment. Lemon
 * Squeezy cannot set an arbitrary remaining-day count or an arbitrary status on
 * a subscription, so to exercise our resolver and the desktop gate across every
 * state — mid-active, past_due, unpaid, expired, cancelled-with-grace — the
 * operator writes a synthetic `Subscription` row directly.
 *
 * TWO GATES stop this from ever becoming a production bypass, and either alone
 * would suffice:
 *   1. Every write here answers 503 unless LEMONSQUEEZY_ALLOW_TEST_MODE is on.
 *   2. The row is FORCED `testMode:true` (never taken from the request), so the
 *      day test mode is switched off, `hideTestRows` drops it from the resolver,
 *      both checkout guards, and every money endpoint at once — no cleanup.
 * The id is `sim_<uuid>`; Lemon Squeezy ids are numeric, so a real webhook can
 * never select or overwrite one of these, and these can never shadow a real sub.
 */
function requireTestTools(): void {
  if (!env.lemonSqueezyAllowTestMode) {
    throw new HttpError(503, "Test tools are disabled on this deployment");
  }
}

/** The horizon column that must agree with `status`, mirroring validUntilFrom. */
function synthDates(status: string, validUntil: Date): {
  validUntil: Date;
  trialEndsAt: Date | null;
  renewsAt: Date | null;
  endsAt: Date | null;
} {
  if (status === "on_trial") return { validUntil, trialEndsAt: validUntil, renewsAt: validUntil, endsAt: null };
  if (status === "cancelled" || status === "expired")
    return { validUntil, trialEndsAt: null, renewsAt: null, endsAt: validUntil };
  return { validUntil, trialEndsAt: null, renewsAt: validUntil, endsAt: null };
}

adminRouter.post(
  "/users/:id/test-subscription",
  requireAdmin,
  asyncHandler(async (req, res) => {
    requireTestTools();
    const user = await getUserOr404(req.params.id);
    const { reason, status, interval, remainingDays, validUntil } =
      adminTestSubscriptionCreateSchema.parse(req.body);

    const horizon = validUntil ?? new Date(Date.now() + (remainingDays ?? 0) * 86_400_000);
    const variantId =
      interval === "yearly" ? env.lemonSqueezyVariantYearly : env.lemonSqueezyVariantMonthly;

    const row = await prisma.subscription.create({
      data: {
        userId: user.id,
        provider: "lemonsqueezy",
        externalId: `sim_${crypto.randomUUID()}`,
        variantId: variantId || "",
        interval,
        status,
        ...synthDates(status, horizon),
        // FORCED, never from the request: this is the second, independent gate.
        testMode: true,
        providerUpdatedAt: null,
      },
    });

    await audit(req, "test_subscription_create", user.id, reason, null, {
      externalId: row.externalId,
      status,
      interval,
      validUntil: horizon,
    });

    res.status(201).json({ subscription: row });
  }),
);

/** Load a SYNTHETIC row for this account, or 404 — never a webhook-owned one. */
async function getSimOr404(userId: string, subId: string) {
  const row = await prisma.subscription.findUnique({ where: { id: subId } });
  if (!row || row.userId !== userId || row.testMode !== true || !row.externalId.startsWith("sim_")) {
    throw notFound("No such simulated subscription on this account");
  }
  return row;
}

adminRouter.delete(
  "/users/:id/test-subscription/:subId",
  requireAdmin,
  asyncHandler(async (req, res) => {
    requireTestTools();
    const before = await getSimOr404(req.params.id, req.params.subId);
    const { reason } = adminActionSchema.parse(req.body ?? {});
    await prisma.subscription.delete({ where: { id: before.id } });
    await audit(req, "test_subscription_delete", req.params.id, reason ?? "", {
      externalId: before.externalId,
    }, { deleted: true });
    res.json({ deleted: true });
  }),
);

/* ── Driving a subscription through its lifecycle ───────────────────────────
 *
 * The two controls that make the states testable in seconds instead of days.
 * Both work on ANY subscription of the account — a real Lemon Squeezy one or a
 * synthetic one — and the difference is deliberately visible in what they do
 * and in what they report back:
 *
 *   REAL row  → ask Lemon Squeezy, and let the webhook write the answer. That
 *               exercises the whole chain (LS → webhook → row → resolver),
 *               which is the only test worth trusting.
 *   SIM row   → write the row, because there is nothing at Lemon Squeezy to ask.
 *
 * Both are test-gated: LS cannot do some of these at all (there is no "expire
 * now"), so the honest ones are faithful and the rest are simulations, and a
 * simulation must never be reachable on a live storefront.
 */

/** A subscription of this account, named by its external id. */
async function getSubOr404(userId: string, externalId: string) {
  const row = await prisma.subscription.findFirst({
    where: { userId, provider: "lemonsqueezy", externalId },
  });
  if (!row) throw notFound("No such subscription on this account");
  return row;
}

const isSim = (externalId: string) => externalId.startsWith("sim_");

/** PATCH a real subscription at Lemon Squeezy; throws a clean 400 on refusal. */
async function lemonPatch(externalId: string, attributes: Record<string, unknown>): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LS_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${env.lemonSqueezyApiBase}/v1/subscriptions/${externalId}`, {
      method: "PATCH",
      headers: {
        Accept: "application/vnd.api+json",
        "Content-Type": "application/vnd.api+json",
        Authorization: `Bearer ${env.lemonSqueezyApiKey}`,
      },
      body: JSON.stringify({ data: { type: "subscriptions", id: String(externalId), attributes } }),
      signal: controller.signal,
    });
  } catch (err) {
    console.error("[admin] Lemon Squeezy unreachable:", err instanceof Error ? err.message : err);
    throw badRequest("Could not reach the payment provider. Please try again.");
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    const why = await readLemonSqueezyError(response);
    console.error(`[admin] LS PATCH ${externalId} failed: HTTP ${response.status} — ${why}`);
    throw badRequest(`Lemon Squeezy refused it — ${why}`);
  }
}

/** DELETE (cancel) a real subscription at Lemon Squeezy. */
async function lemonCancel(externalId: string): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LS_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${env.lemonSqueezyApiBase}/v1/subscriptions/${externalId}`, {
      method: "DELETE",
      headers: {
        Accept: "application/vnd.api+json",
        "Content-Type": "application/vnd.api+json",
        Authorization: `Bearer ${env.lemonSqueezyApiKey}`,
      },
      signal: controller.signal,
    });
  } catch (err) {
    console.error("[admin] Lemon Squeezy unreachable:", err instanceof Error ? err.message : err);
    throw badRequest("Could not reach the payment provider. Please try again.");
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok && response.status !== 404) {
    const why = await readLemonSqueezyError(response);
    throw badRequest(`Lemon Squeezy refused the cancel — ${why}`);
  }
}

/**
 * Move a subscription to `active`, `cancelled` or `expired`.
 *
 *   → active     a trial converts NOW (LS charges the card on file, which in a
 *                test store is the test card); a cancelled-but-granting row is
 *                resumed. Both are real Lemon Squeezy operations.
 *   → cancelled  a real LS cancel. Note our own rule: a subscription cancelled
 *                while its trial is still running stops granting at once.
 *   → expired    LS has no "end it now", so this one is always a local write.
 */
adminRouter.post(
  "/users/:id/subscription-transition",
  requireAdmin,
  asyncHandler(async (req, res) => {
    requireTestTools();
    const user = await getUserOr404(req.params.id);
    const { reason, externalId, to } = adminSubscriptionTransitionSchema.parse(req.body);
    const row = await getSubOr404(user.id, externalId);
    const sim = isSim(row.externalId);

    const now = new Date();
    let via: "lemonsqueezy" | "local" = sim ? "local" : "lemonsqueezy";

    // Only the paths that actually TALK to Lemon Squeezy need a key. Expiring a
    // row is a local write even for a real subscription (LS has no "end it
    // now"), so requiring one there would refuse an operation it is not used for.
    const needsLemon = !sim && to !== "expired";
    if (needsLemon && !env.lemonSqueezyApiKey) {
      throw new HttpError(503, "Billing is not configured on this deployment");
    }

    if (to === "active") {
      if (sim) {
        await prisma.subscription.update({
          where: { id: row.id },
          data: {
            status: "active",
            ...synthDates("active", row.validUntil ?? new Date(Date.now() + 30 * 86_400_000)),
          },
        });
      } else if (row.status === "cancelled") {
        await lemonPatch(row.externalId, { cancelled: false });
      } else if (row.status === "on_trial") {
        // Convert the trial now: end it and raise the invoice immediately —
        // exactly what the customer's own "Pay now" does.
        await lemonPatch(row.externalId, {
          trial_ends_at: now.toISOString(),
          invoice_immediately: true,
        });
      } else {
        throw conflict(`Nothing to do: the subscription is already ${row.status}`);
      }
    } else if (to === "cancelled") {
      if (row.status === "cancelled") throw conflict("Already cancelled");
      if (sim) {
        await prisma.subscription.update({
          where: { id: row.id },
          data: { status: "cancelled", ...synthDates("cancelled", row.validUntil ?? now) },
        });
      } else {
        await lemonCancel(row.externalId);
      }
    } else {
      // `expired` — no Lemon Squeezy equivalent, so always a local write, even
      // for a real row. Reported as such so nobody mistakes it for a real end.
      via = "local";
      await prisma.subscription.update({
        where: { id: row.id },
        data: { status: "expired", ...synthDates("expired", now) },
      });
    }

    await audit(req, "subscription_transition", user.id, reason, {
      externalId,
      status: row.status,
    }, { to, via });

    res.status(202).json({ ok: true, to, via });
  }),
);

/**
 * Set how long a subscription has left — days AND hours.
 *
 * On a REAL trial this is a genuine Lemon Squeezy write (`trial_ends_at`), so
 * the whole chain runs and the trial really does end when it says. On anything
 * else Lemon Squeezy has no writable end date, so the row is set locally and the
 * response says `via: "local"` — a real webhook would later correct it, which is
 * exactly the honest caveat.
 */
adminRouter.post(
  "/users/:id/subscription-time",
  requireAdmin,
  asyncHandler(async (req, res) => {
    requireTestTools();
    const user = await getUserOr404(req.params.id);
    const { reason, externalId, days, hours } = adminSubscriptionTimeSchema.parse(req.body);
    const row = await getSubOr404(user.id, externalId);

    const horizon = new Date(Date.now() + days * 86_400_000 + hours * 3_600_000);
    const sim = isSim(row.externalId);
    let via: "lemonsqueezy" | "local" = "local";

    if (!sim && row.status === "on_trial") {
      if (!env.lemonSqueezyApiKey) throw new HttpError(503, "Billing is not configured");
      await lemonPatch(row.externalId, { trial_ends_at: horizon.toISOString() });
      via = "lemonsqueezy";
      // The webhook will mirror it; write it now so the console repaints without
      // waiting for a delivery.
      await prisma.subscription
        .update({ where: { id: row.id }, data: synthDates("on_trial", horizon) })
        .catch(() => undefined);
    } else {
      await prisma.subscription.update({
        where: { id: row.id },
        data: synthDates(row.status, horizon),
      });
    }

    await audit(req, "subscription_time", user.id, reason, {
      externalId,
      validUntil: row.validUntil,
    }, { validUntil: horizon, days, hours, via });

    res.status(202).json({ ok: true, validUntil: horizon, via });
  }),
);

/* ── Test lab: reset a test user ────────────────────────────────────────────
 *
 * THE RESET BUTTON for the tester's own accounts: make an email reusable for a
 * fresh signup without hand-deleting half a database and leaving the orphaned
 * states partial deletions create. One call unwinds everything WE control —
 * outstanding sessions, the RevenueCat subscriber, Lemon Squeezy billing, the
 * account row, the trial ledger, the RC order tombstones — and reports each
 * leg separately, because the tool's whole value is TRUST: a reset that claims
 * more than it did costs an afternoon of confused re-testing.
 *
 * WHAT IT NEVER CLAIMS: Apple. Deleting the RevenueCat subscriber removes
 * RevenueCat's record, never the sandbox receipt in the Apple ID's purchase
 * history — a Restore re-creates the subscriber from it. The report says so in
 * as many words on EVERY response (`appleSide`), so nobody reads `ok: true` as
 * "Apple is clean too".
 *
 * Every leg is individually try/caught: one provider being down must not stop
 * the others from being cleaned, and the report names exactly which legs
 * failed. LS ORDER TOMBSTONES STAY — a spent Lemon Squeezy order must remain
 * spent whoever takes this email next (ConsumedOrder exists precisely to
 * survive account churn); only the RevenueCat tombstones keyed `${userId}:…`
 * go, because that userId dies with the account and can never be minted again
 * — after the delete they are pure orphans.
 */

/**
 * The one thing this tool cannot clean, said on every response. Static on
 * purpose: it is documentation, not state, and it must never be omittable.
 */
const APPLE_SIDE_NOTE =
  "NOT cleared — Apple sandbox purchase history can only be cleared in App Store Connect (Users and Access → Sandbox → Clear Purchase History), and an active TestFlight subscription keeps renewing until it expires.";

adminRouter.post(
  "/test/reset-user",
  requireAdmin,
  asyncHandler(async (req, res) => {
    requireTestTools();
    const { email } = adminTestResetUserSchema.parse(req.body);

    // Case-insensitive, the same idiom as the Lemon Squeezy webhook's owner
    // lookup: registration lowercases, but older rows and hand-edits may not.
    const user = await prisma.user.findFirst({
      where: { email: { equals: email, mode: "insensitive" } },
      select: { id: true, email: true },
    });
    // Not found is a 404, not a partial sweep: every remaining leg is keyed on
    // the userId, and "clean whatever matches nothing" would either no-op or —
    // worse — invite a variant that touches other accounts' device-keyed rows.
    if (!user) throw notFound("No account with that email");
    const userId = user.id;

    // One entry per leg that FAILED, named so the console can render it next
    // to the legs that ran. A leg failure never aborts the reset — the whole
    // point is to clean what CAN be cleaned and say honestly what could not.
    const failures: { step: string; error: string }[] = [];
    const leg = async <T>(step: string, fallback: T, fn: () => Promise<T>): Promise<T> => {
      try {
        return await fn();
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.error(`[admin] test reset: ${step} leg failed:`, message);
        failures.push({ step, error: message });
        return fallback;
      }
    };

    // (1) End every outstanding session NOW — the same lever a password reset
    // pulls: requireCurrentSession compares each token's iat to this stamp, so
    // bumping it strands every JWT minted before this instant at every gate
    // that reads the database.
    const sessionsRevoked = await leg("sessions", false, async () => {
      await prisma.user.update({
        where: { id: userId },
        data: { passwordChangedAt: new Date() },
      });
      return true;
    });

    // (2) RevenueCat: delete the subscriber(s) so the tester's next account has
    // no history to inherit and no claim to conflict with. Keys: every claim
    // registered to this account, plus the account id itself — the id every
    // sync fetches by, claim or no claim. Per-key outcome reported; a claim row
    // is removed only once RevenueCat actually released its subscriber (404 =
    // already gone = released), so a failed delete keeps its claim visible and
    // retryable instead of becoming an untracked orphan.
    const rcSubscribersDeleted: string[] = [];
    const rcSubscriberFailures: { appUserId: string; error: string }[] = [];
    await leg("revenuecat", undefined, async () => {
      const claims = await prisma.rcSubscriberClaim.findMany({
        where: { userId },
        select: { originalAppUserId: true },
      });
      const keys = [...new Set([userId, ...claims.map((c) => c.originalAppUserId)])];
      for (const appUserId of keys) {
        try {
          await deleteSubscriber(appUserId);
          rcSubscribersDeleted.push(appUserId);
        } catch (e) {
          rcSubscriberFailures.push({
            appUserId,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
      if (rcSubscribersDeleted.length > 0) {
        await prisma.rcSubscriberClaim.deleteMany({
          where: { userId, originalAppUserId: { in: rcSubscribersDeleted } },
        });
      }
    });

    // (3) STOP CHARGING THE CARD — the exact outbox machinery the console
    // delete uses, so an unreachable provider postpones the cancellation
    // instead of losing it.
    const lsCancelsEnqueued = await leg("lemonsqueezy", 0, () =>
      enqueueLiveLsCancels(userId, "test-reset-user"),
    );

    // (4) The account itself, through the SAME deleter as DELETE /users/:id —
    // one cascade, never two that drift.
    const accountDeleted = await leg("account", false, async () => {
      await deleteAccountRow(userId);
      return true;
    });

    // (5) The trial ledger. The claims deliberately have no relation, so the
    // delete above never touches them — and unlike every ordinary deletion
    // flow, a TEST reset wants the machine's window back: handing it back is
    // this tool's job, exactly like /users/:id/trial-reset. Runs keyed on the
    // captured userId, which the account delete cannot invalidate (firstUserId
    // is a raw id, not a relation).
    const trialClaimsDeleted = await leg("trial-ledger", 0, async () => {
      const claims = await prisma.trialClaim.findMany({
        where: { firstUserId: userId },
        select: { id: true },
      });
      if (claims.length === 0) return 0;
      const ids = claims.map((c) => c.id);
      // The DeviceSignal rows go with the claims — leaving them would keep the
      // hardware pointing at claims that no longer exist.
      await prisma.deviceSignal.deleteMany({ where: { claimId: { in: ids } } });
      const out = await prisma.trialClaim.deleteMany({ where: { id: { in: ids } } });
      return out.count;
    });

    // (6) RevenueCat order tombstones ONLY, and only THIS user's: every RC
    // externalId this backend mints is `${userId}:…`, and the userId dies with
    // the account. Lemon Squeezy tombstones are keyed on LS's OWN order ids
    // and STAY — a spent LS order must remain spent.
    const consumedOrdersDeleted = await leg("consumed-orders", 0, async () => {
      const out = await prisma.consumedOrder.deleteMany({
        where: { provider: RC_PROVIDER, externalId: { startsWith: `${userId}:` } },
      });
      return out.count;
    });

    const report = {
      sessionsRevoked,
      rcSubscribersDeleted,
      rcSubscriberFailures,
      lsCancelsEnqueued,
      accountDeleted,
      trialClaimsDeleted,
      consumedOrdersDeleted,
      failures,
    };

    // The audit carries the per-leg report as meta — minus the static Apple
    // sentence, which is documentation rather than something that happened.
    await audit(
      req,
      "test_reset_user",
      userId,
      `test reset of ${user.email}`,
      { email: user.email },
      { accountDeleted },
      report,
    );

    res.json({
      // `ok` means EVERY leg landed. A partial reset still answers 200 with
      // ok:false — the caller's request was fine; the report says what is left.
      ok: failures.length === 0 && rcSubscriberFailures.length === 0,
      report: { ...report, appleSide: APPLE_SIDE_NOTE },
    });
  }),
);
