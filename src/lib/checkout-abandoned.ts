import { prisma } from "./prisma";
import { capture } from "./posthog";

/**
 * Checkouts that were started and never paid.
 *
 * WHY THIS NEEDS A SWEEP AT ALL. Every other analytics event in this backend is
 * emitted by a webhook, because something happened. This one is the opposite:
 * the fact worth recording is that nothing happened. Nobody delivers "the
 * customer opened the payment page and closed the tab", so the only way to see
 * it is to come back later and look at what never completed.
 *
 * WHY IT IS THE MOST VALUABLE NUMBER HERE. On Windows and macOS the payment
 * leaves the app entirely — a Lemon Squeezy page in the system browser — and
 * nothing between the click and the webhook has ever been measured. The ratio of
 * the app's own `checkout_started` to `checkout_confirmed` is the desktop
 * conversion rate, and this event is what makes the gap between them legible
 * rather than merely absent.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: write anything. There is no "reported"
 * marker on CheckoutIntent, and adding one would mean a schema change, a
 * migration, and the absent-versus-null Mongo trap that has already broken the
 * outbox in this codebase once. Instead the sweep is bounded to a window and the
 * event carries a deterministic uuid derived from the intent id, so a second run
 * over the same intent produces the same event rather than a second one. That
 * de-duplication is PostHog's, and PostHog's is eventual — hence the window,
 * which is the part that actually keeps the count honest.
 */

/** How far back to look. */
const WINDOW_MS = 24 * 60 * 60 * 1000;

/** Same hygiene as the trial reminder sweep: bounded, never "all of them". */
const CANDIDATES_PER_QUERY = 500;

export type AbandonedCheckoutReport = {
  candidates: number;
  emitted: number;
  failed: number;
};

export async function sweepAbandonedCheckouts(
  now: Date = new Date(),
): Promise<AbandonedCheckoutReport> {
  const floor = new Date(now.getTime() - WINDOW_MS);

  // `ready` is the state of an intent whose payable link exists and was handed
  // to the customer. `completed` is the paid ones and `failed` the refused ones;
  // neither is an abandonment. The [state, expiresAt] index already serves this
  // exact shape, so no index has to be created.
  const intents = await prisma.checkoutIntent.findMany({
    where: { state: "ready", expiresAt: { lt: now, gte: floor } },
    // Never `token` and never `checkoutUrl`: both carry the intent token, and a
    // payable link has no business in an analytics payload.
    select: { id: true, userId: true, plan: true, createdAt: true, expiresAt: true },
    take: CANDIDATES_PER_QUERY,
    orderBy: { expiresAt: "asc" },
  });

  const report: AbandonedCheckoutReport = { candidates: intents.length, emitted: 0, failed: 0 };

  for (const intent of intents) {
    const result = await capture({
      event: "checkout_abandoned",
      distinctId: intent.userId,
      dedupeKey: `ls:intent:abandoned:${intent.id}`,
      // The intent's OWN expiry, not the moment this sweep happened to run.
      // PostHog buckets its de-duplication by calendar day, so a stamp from the
      // clock would make the same abandonment count once per run.
      timestamp: intent.expiresAt,
      properties: {
        provider: "lemonsqueezy",
        plan: intent.plan,
        // How long the link stayed unused. The distribution of this is what says
        // whether people are hesitating or never arriving at all.
        seconds_alive: Math.max(
          0,
          Math.round((intent.expiresAt.getTime() - intent.createdAt.getTime()) / 1000),
        ),
      },
    }).catch(() => null);

    if (result?.ok) report.emitted += 1;
    else report.failed += 1;
  }

  return report;
}
