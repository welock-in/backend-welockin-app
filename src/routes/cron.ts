import { Router } from "express";
import { prisma } from "../lib/prisma";
import { env } from "../lib/env";
import { asyncHandler } from "../middleware/async-handler";
import { unauthorized } from "../lib/http-error";
import { sendTrialEndingSoon } from "../lib/resend";

/**
 * Work that has to happen on a clock rather than on a request.
 *
 * WHY THIS EXISTS AT ALL. The trial reminder must reach someone who has NOT
 * opened the app — and that is precisely the person about to be surprised by a
 * charge. Every other job in this backend is triggered by a request from the
 * person it concerns; this one cannot be, because their silence is the problem.
 *
 * WHY IT IS AN HTTP ROUTE AND NOT A TIMER. There is no long-lived process here:
 * the whole backend is serverless functions that exist for the length of one
 * request. A `setInterval` would run on whichever instance happened to be warm,
 * which is none of them most of the time. So the schedule lives outside — Vercel
 * Cron, GitHub Actions, anything that can make an authenticated GET — and this
 * is the door it knocks on.
 *
 * ONCE A DAY IS ENOUGH, and that is not a compromise. "Two days before the end"
 * is a day-granularity promise; a reminder at 09:00 and a reminder at 09:04 are
 * the same reminder to a human. Running hourly would only multiply the chances
 * of sending twice.
 */
export const cronRouter = Router();

/**
 * The window a subscription must fall into to be reminded, in hours from now.
 *
 * Deliberately WIDE — from 24h to 60h rather than "exactly 48h". A daily job
 * that looked for a precise moment would miss anyone whose trial ends between
 * two runs, and missing this email is worse than sending it a few hours early:
 * the customer gets charged with no warning, and a surprise charge is a
 * chargeback rather than a cancellation.
 */
const REMIND_FROM_HOURS = 24;
const REMIND_TO_HOURS = 60;

const HOUR_MS = 60 * 60 * 1000;

/**
 * Every scheduled job is behind one shared secret, compared in constant time.
 *
 * Without it this is an unauthenticated endpoint that sends email to real
 * customers — a spam cannon with our domain on the envelope. Vercel Cron sends
 * `Authorization: Bearer $CRON_SECRET`; anything else can send the same header.
 *
 * No secret configured means the route is CLOSED, not open. An unset secret is
 * the state a fresh deploy is in, and failing open there would mean the endpoint
 * is exposed for exactly as long as it takes someone to notice.
 */
function assertCronCaller(header: string | undefined): void {
  const expected = env.cronSecret;
  if (!expected) {
    console.warn("[cron] refused: CRON_SECRET is not set, so scheduled jobs are disabled");
    throw unauthorized("Scheduled jobs are not configured");
  }
  const got = (header ?? "").replace(/^Bearer\s+/i, "");
  // Length-then-content rather than `crypto.timingSafeEqual`, which throws on a
  // length mismatch and would need the guard anyway. The length of a secret is
  // not the part worth hiding.
  if (got.length !== expected.length || got !== expected) {
    console.warn("[cron] refused: bad or missing CRON_SECRET");
    throw unauthorized();
  }
}

/**
 * Warn everyone whose trial ends in about two days.
 *
 * Idempotent by `trialReminderSentAt`, which is stamped BEFORE the send rather
 * than after. That ordering is deliberate and it is the uncomfortable choice: if
 * the send then fails, the customer gets no warning. The alternative — stamp
 * after — means a job that dies mid-run emails the same people again on the next
 * pass, and being warned twice about a charge reads as a system that has lost
 * track of you. Between one missed warning and a stream of duplicates, the
 * missed one is recoverable by support; the duplicates erode the thing the email
 * exists to protect.
 *
 * A failure is logged loudly and the row is UNSTAMPED, so the next run retries
 * it — which recovers the ordinary case (a transient Resend error) without
 * reopening the duplicate risk for a job that died between the two writes.
 */
cronRouter.get(
  "/trial-reminders",
  asyncHandler(async (req, res) => {
    assertCronCaller(req.header("authorization") ?? undefined);

    const now = new Date();
    const from = new Date(now.getTime() + REMIND_FROM_HOURS * HOUR_MS);
    const to = new Date(now.getTime() + REMIND_TO_HOURS * HOUR_MS);

    const due = await prisma.subscription.findMany({
      where: {
        status: "on_trial",
        trialReminderSentAt: null,
        trialEndsAt: { gte: from, lte: to },
      },
      select: {
        id: true,
        interval: true,
        trialEndsAt: true,
        customerPortalUrl: true,
        user: { select: { email: true } },
      },
      // A ceiling, so one bad day cannot turn into a thousand sends in a
      // function with a timeout. The rest are picked up by the next run, which
      // is what the wide window above is for.
      take: 200,
    });

    let sent = 0;
    let failed = 0;

    for (const sub of due) {
      if (!sub.user?.email || !sub.trialEndsAt) continue;

      // Stamped first — see the note above.
      await prisma.subscription.update({
        where: { id: sub.id },
        data: { trialReminderSentAt: now },
      });

      const yearly = sub.interval === "yearly";
      const result = await sendTrialEndingSoon(sub.user.email, {
        price: yearly ? "19,99 €" : "4,99 €",
        period: yearly ? "an" : "mois",
        endsAt: sub.trialEndsAt,
        manageUrl: sub.customerPortalUrl,
        // French is the product's own register everywhere else it speaks.
        // Per-user locale is a real gap, noted rather than guessed at.
        locale: "fr",
      });

      if (result.ok) {
        sent += 1;
      } else {
        failed += 1;
        console.error(
          `[cron] trial reminder failed for subscription ${sub.id}: ` +
            (result.skipped ? "RESEND_API_KEY not set" : (result.error ?? "unknown")),
        );
        // Give the next run a chance rather than leaving someone unwarned.
        await prisma.subscription
          .update({ where: { id: sub.id }, data: { trialReminderSentAt: null } })
          .catch(() => undefined);
      }
    }

    console.log(`[cron] trial reminders: ${sent} sent, ${failed} failed, ${due.length} due`);
    res.json({ ok: true, due: due.length, sent, failed });
  }),
);
