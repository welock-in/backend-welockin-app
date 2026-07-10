import { Router } from "express";
import { Prisma, type FeatureRequest } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/auth";
import { asyncHandler } from "../middleware/async-handler";
import {
  createFeedbackSchema,
  listFeedbackQuerySchema,
  reportFeedbackSchema,
  updateFeedbackHiddenSchema,
  updateFeedbackStatusSchema,
} from "../validation/schemas";
import { forbidden, notFound, tooManyRequests } from "../lib/http-error";

export const feedbackRouter = Router();

// Anti-spam: at most this many posts per author per rolling hour. Enforced with a
// DB count window; we accept the small check-then-act race as a soft limit.
const MAX_POSTS_PER_HOUR = 5;
const POST_WINDOW_MS = 60 * 60 * 1000;
// Community moderation: once this many distinct users report a request it is
// auto-hidden (drops out of GET /). Keeps obviously-bad UGC off the board without
// waiting for an admin — an Apple 1.2 requirement.
const REPORT_HIDE_THRESHOLD = 3;
const LIST_LIMIT = 100;

const isDuplicateKey = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";

// Interactive-transaction write conflict (Mongo). Two concurrent transactions
// racing the same unique key can abort one with this INSTEAD of P2002 (which only
// fires once the winner has committed) — treat both as a raced duplicate.
const isWriteConflict = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2034";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The wire shape every request-returning endpoint sends to the client. */
interface FeedbackDto {
  id: string;
  title: string;
  body: string;
  status: FeatureRequest["status"];
  voteCount: number;
  commentCount: number;
  hasVoted: boolean;
  isMine: boolean;
  createdAt: string;
}

function toDto(fr: FeatureRequest, hasVoted: boolean, userId: string): FeedbackDto {
  return {
    id: fr.id,
    title: fr.title,
    body: fr.body,
    status: fr.status,
    voteCount: fr.voteCount,
    commentCount: fr.commentCount,
    hasVoted,
    isMine: fr.authorId === userId,
    createdAt: fr.createdAt.toISOString(),
  };
}

/** Admin DTO = the wire shape + moderation fields (hidden, reportCount). */
function toAdminDto(fr: FeatureRequest, hasVoted: boolean, userId: string) {
  return { ...toDto(fr, hasVoted, userId), hidden: fr.hidden, reportCount: fr.reportCount };
}

/** Throw 403 unless the caller is an admin (User.isAdmin — never an email allowlist). */
async function requireAdmin(userId: string): Promise<void> {
  const me = await prisma.user.findUnique({ where: { id: userId }, select: { isAdmin: true } });
  if (!me?.isAdmin) throw forbidden("Admin only");
}

/** Does `userId` have a vote on `featureRequestId`? */
async function callerHasVoted(featureRequestId: string, userId: string): Promise<boolean> {
  const vote = await prisma.vote.findFirst({
    where: { featureRequestId, userId },
    select: { id: true },
  });
  return vote !== null;
}

/**
 * Load a request or throw a 404. A malformed :id surfaces as Prisma P2023, which
 * the error middleware maps to 400; a genuinely missing row → 404 here.
 */
async function loadOr404(id: string): Promise<FeatureRequest> {
  const fr = await prisma.featureRequest.findUnique({ where: { id } });
  if (!fr) throw notFound("Feature request not found");
  return fr;
}

/**
 * GET /api/feedback?sort=top|new
 * Server-side sort (so "new" can't lie past the 100-item window), hidden rows
 * excluded, caller's votes hydrated into `hasVoted`.
 */
feedbackRouter.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { sort } = listFeedbackQuerySchema.parse(req.query);
    const userId = req.user!.id;

    const orderBy =
      sort === "new"
        ? [{ createdAt: "desc" as const }]
        : [{ voteCount: "desc" as const }, { createdAt: "desc" as const }];

    const requests = await prisma.featureRequest.findMany({
      where: { hidden: false },
      orderBy,
      take: LIST_LIMIT,
    });

    // Hydrate hasVoted for the caller in one query.
    const votedIds = new Set<string>();
    if (requests.length > 0) {
      const votes = await prisma.vote.findMany({
        where: { userId, featureRequestId: { in: requests.map((r) => r.id) } },
        select: { featureRequestId: true },
      });
      for (const v of votes) votedIds.add(v.featureRequestId);
    }

    res.json({ requests: requests.map((r) => toDto(r, votedIds.has(r.id), userId)) });
  }),
);

/**
 * GET /api/feedback/admin — admin only. ALL requests (incl. hidden), most-reported
 * first, with moderation fields. Powers the external admin dashboard (/admin).
 */
feedbackRouter.get(
  "/admin",
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = req.user!.id;
    await requireAdmin(userId);

    const requests = await prisma.featureRequest.findMany({
      orderBy: [{ reportCount: "desc" }, { voteCount: "desc" }, { createdAt: "desc" }],
      take: 200,
    });

    const votedIds = new Set<string>();
    if (requests.length > 0) {
      const votes = await prisma.vote.findMany({
        where: { userId, featureRequestId: { in: requests.map((r) => r.id) } },
        select: { featureRequestId: true },
      });
      for (const v of votes) votedIds.add(v.featureRequestId);
    }

    res.json({ requests: requests.map((r) => toAdminDto(r, votedIds.has(r.id), userId)) });
  }),
);

/**
 * POST /api/feedback  { title, body?, clientRequestId }
 * Rate-limited, idempotent on (authorId, clientRequestId). Creates the request
 * with the author's own vote (voteCount:1) atomically.
 */
feedbackRouter.post(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { title, body, clientRequestId } = createFeedbackSchema.parse(req.body);
    const userId = req.user!.id;

    // Idempotency fast-path: a retry with the same key returns the prior result.
    const prior = await prisma.featureRequest.findFirst({
      where: { authorId: userId, clientRequestId },
    });
    if (prior) {
      const hasVoted = await callerHasVoted(prior.id, userId);
      res.status(200).json(toDto(prior, hasVoted, userId));
      return;
    }

    // Soft rate limit (DB window). Accept the check-then-act race.
    const recentCount = await prisma.featureRequest.count({
      where: { authorId: userId, createdAt: { gte: new Date(Date.now() - POST_WINDOW_MS) } },
    });
    if (recentCount >= MAX_POSTS_PER_HOUR) {
      throw tooManyRequests("You're posting too fast — try again in a bit.");
    }

    try {
      const created = await prisma.$transaction(async (tx) => {
        const fr = await tx.featureRequest.create({
          data: { authorId: userId, title, body, voteCount: 1, clientRequestId },
        });
        await tx.vote.create({ data: { featureRequestId: fr.id, userId } });
        return fr;
      });
      res.status(201).json(toDto(created, true, userId));
    } catch (err) {
      // Concurrent retry with the same clientRequestId raced us. Inside a Mongo
      // transaction the unique clash can surface as P2002 (winner committed) OR
      // P2034 (write-conflict, winner still committing) — treat both as idempotent
      // success and return the winning row. A short retry covers the window where
      // the winner hasn't committed yet.
      if (isDuplicateKey(err) || isWriteConflict(err)) {
        for (let attempt = 0; attempt < 4; attempt += 1) {
          const existing = await prisma.featureRequest.findFirst({
            where: { authorId: userId, clientRequestId },
          });
          if (existing) {
            const hasVoted = await callerHasVoted(existing.id, userId);
            res.status(200).json(toDto(existing, hasVoted, userId));
            return;
          }
          await sleep(60);
        }
      }
      throw err;
    }
  }),
);

/**
 * POST /api/feedback/:id/vote — idempotent add. A double-tap or concurrent race
 * NEVER surfaces a 409/500: we swallow P2002 and return the authoritative count.
 */
feedbackRouter.post(
  "/:id/vote",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const userId = req.user!.id;
    const fr = await loadOr404(id);

    let created = false;
    try {
      await prisma.vote.create({ data: { featureRequestId: id, userId } });
      created = true;
    } catch (err) {
      // Already voted (or a concurrent add won) — treat as success, no double count.
      if (!isDuplicateKey(err)) throw err;
    }

    // Atomic $inc (not read-count-then-write) so concurrent voters never lose an
    // update: voteCount stays == count(votes). A crash between the two writes is
    // healed by the reconcile script. A concurrent delete → P2025 → 404 (mapped).
    const voteCount = created
      ? (await prisma.featureRequest.update({ where: { id }, data: { voteCount: { increment: 1 } } }))
          .voteCount
      : fr.voteCount;
    res.json({ id, voteCount, hasVoted: true });
  }),
);

/**
 * DELETE /api/feedback/:id/vote — idempotent remove. deleteMany is a no-op when
 * the vote is already gone (no P2025), so repeated calls stay 200.
 */
feedbackRouter.delete(
  "/:id/vote",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const userId = req.user!.id;
    const fr = await loadOr404(id);

    // deleteMany → idempotent (no P2025 on a double-remove); decrement only when a
    // row was actually removed, mirroring the atomic $inc on add.
    const { count } = await prisma.vote.deleteMany({ where: { featureRequestId: id, userId } });
    const voteCount =
      count > 0
        ? (await prisma.featureRequest.update({ where: { id }, data: { voteCount: { decrement: 1 } } }))
            .voteCount
        : fr.voteCount;
    res.json({ id, voteCount: Math.max(0, voteCount), hasVoted: false });
  }),
);

/**
 * POST /api/feedback/:id/report  { reason } — one report per reporter (upsert),
 * auto-hides the request once REPORT_HIDE_THRESHOLD distinct users report it.
 */
feedbackRouter.post(
  "/:id/report",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const userId = req.user!.id;
    const { reason } = reportFeedbackSchema.parse(req.body);
    await loadOr404(id);

    try {
      await prisma.featureReport.upsert({
        where: { featureRequestId_reporterId: { featureRequestId: id, reporterId: userId } },
        create: { featureRequestId: id, reporterId: userId, reason },
        update: { reason },
      });
    } catch (err) {
      // Prisma emulates upsert as find-then-write on Mongo, so a concurrent
      // double-report by the same user can race into a duplicate insert. The
      // report already exists → treat P2002 as success (never 409 a re-report).
      if (!isDuplicateKey(err)) throw err;
    }

    const reportCount = await prisma.featureReport.count({ where: { featureRequestId: id } });
    await prisma.featureRequest.update({
      where: { id },
      data: { reportCount, ...(reportCount >= REPORT_HIDE_THRESHOLD ? { hidden: true } : {}) },
    });

    res.json({ ok: true });
  }),
);

/**
 * PATCH /api/feedback/:id/status  { status } — admin only (User.isAdmin, never an
 * email allowlist). Returns the DTO with the caller's REAL hasVoted (an admin can
 * also be a voter — never hard-code false or we'd flip their pill).
 */
feedbackRouter.patch(
  "/:id/status",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const userId = req.user!.id;
    await requireAdmin(userId);

    const { status } = updateFeedbackStatusSchema.parse(req.body);
    await loadOr404(id);
    const updated = await prisma.featureRequest.update({ where: { id }, data: { status } });
    const hasVoted = await callerHasVoted(id, userId);
    res.json(toAdminDto(updated, hasVoted, userId));
  }),
);

/**
 * PATCH /api/feedback/:id/hidden  { hidden } — admin only. Hide (moderate) or
 * un-hide (un-do an auto-hide / restore) a request.
 */
feedbackRouter.patch(
  "/:id/hidden",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const userId = req.user!.id;
    await requireAdmin(userId);

    const { hidden } = updateFeedbackHiddenSchema.parse(req.body);
    await loadOr404(id);
    const updated = await prisma.featureRequest.update({ where: { id }, data: { hidden } });
    const hasVoted = await callerHasVoted(id, userId);
    res.json(toAdminDto(updated, hasVoted, userId));
  }),
);

/**
 * DELETE /api/feedback/:id — author or admin only. Prisma's emulated cascade
 * (onDelete: Cascade on Vote/FeatureReport) removes the children.
 */
feedbackRouter.delete(
  "/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const userId = req.user!.id;

    const fr = await loadOr404(id);
    if (fr.authorId !== userId) {
      const me = await prisma.user.findUnique({ where: { id: userId }, select: { isAdmin: true } });
      if (!me?.isAdmin) throw forbidden("You can only delete your own requests");
    }

    // deleteMany (not delete) → idempotent even if a concurrent delete raced us
    // (no unmapped P2025 → 500). Prisma's emulated cascade still removes children.
    await prisma.featureRequest.deleteMany({ where: { id } });
    res.json({ ok: true });
  }),
);
