import { Router } from "express";
import crypto from "node:crypto";
import { env } from "../lib/env";
import { asyncHandler } from "../middleware/async-handler";
import { unauthorized, HttpError } from "../lib/http-error";
import { drainCancels } from "../lib/billing-tasks";

/**
 * Scheduled work.
 *
 * WHY THIS EXISTS AT ALL. The billing outbox records cancellations we owe Lemon
 * Squeezy and retries them until they land — but this deployment is a single
 * Vercel function with no worker and no queue, so "retries them" needed something
 * to actually push it. Without this route the outbox is a table that fills up
 * while a deleted customer's card keeps being charged: the durable record was
 * only ever half the fix.
 *
 * HOW IT IS PROTECTED. Vercel sends `Authorization: Bearer $CRON_SECRET` on every
 * cron invocation, and that is the only credential this route accepts. It matters
 * more than it looks: the drain spends our Lemon Squeezy API quota, so an open
 * endpoint is a free way for anyone to burn it — and to make the billing pipeline
 * fail exactly when it is needed.
 *
 * AN UNSET SECRET REFUSES. Not "allows everyone", which is how this kind of guard
 * usually fails: the safe reading of a missing secret is a cron that does not
 * run, which is visible in the console within a tick, rather than one anybody on
 * the internet can run, which is visible never.
 */
export const cronRouter = Router();

/** Constant-time compare; length may leak, which tells an attacker nothing useful. */
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function requireCronSecret(header: string | undefined): void {
  if (!env.cronSecret) {
    console.error("[cron] CRON_SECRET is not set — scheduled runs are disabled");
    throw new HttpError(503, "Scheduled tasks are not configured");
  }
  const presented = (header ?? "").replace(/^Bearer\s+/i, "");
  if (!presented || !safeEqual(presented, env.cronSecret)) {
    console.warn("[cron] rejected a scheduled run: bad or missing secret");
    throw unauthorized("Invalid cron credentials");
  }
}

/**
 * Send the cancellations we still owe Lemon Squeezy.
 *
 * Safe to call twice, and safe to call while a manual drain is running: each task
 * is claimed by an atomic conditional update before the provider is touched, so
 * two overlapping runs divide the work rather than duplicating it. Even if they
 * did duplicate it, cancelling an already-cancelled subscription is a no-op —
 * the lock saves quota and log noise, not correctness.
 *
 * Answers 200 with a report even when tasks failed. A cron that 500s is a cron
 * that gets retried by the platform on its own schedule, which fights with the
 * backoff this file already implements; the report is where failure is visible.
 */
cronRouter.post(
  "/billing-tasks",
  asyncHandler(async (req, res) => {
    requireCronSecret(req.header("authorization") ?? undefined);
    const report = await drainCancels();
    // One line per run, so the platform's log view is a usable history of
    // whether the billing pipeline is healthy.
    console.info(
      `[cron] billing drain: due=${report.due} settled=${report.settled} ` +
        `contended=${report.contended} owed=${report.stillOwed} dead=${report.deadLettered}`,
    );
    res.json(report);
  }),
);

// Vercel's scheduler issues GET for cron paths; the same work, same guard. POST
// stays for manual invocation with curl, which is what an operator reaches for
// during an incident.
cronRouter.get(
  "/billing-tasks",
  asyncHandler(async (req, res) => {
    requireCronSecret(req.header("authorization") ?? undefined);
    const report = await drainCancels();
    console.info(
      `[cron] billing drain: due=${report.due} settled=${report.settled} ` +
        `contended=${report.contended} owed=${report.stillOwed} dead=${report.deadLettered}`,
    );
    res.json(report);
  }),
);
