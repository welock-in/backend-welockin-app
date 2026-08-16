import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { resolveAndCache } from "../routes/entitlement";
import { isFrenchLocale, sendTrialEndingReminder, trialEndParts } from "./resend";
import { deliver } from "../services/notifications/deliver";

/**
 * Trial-end reminders — "make sure a trial reminder goes out by email and
 * notifications."
 *
 * WHO IS REMINDED. Anyone whose CURRENT entitlement is `trialing` and whose
 * window ends within the next day. Three places can put a user in that state —
 * a Lemon Squeezy `on_trial` subscription, a RevenueCat trial (mirrored with
 * the same status), and the machine trial (TrialClaim, or the legacy
 * `User.trialEndsAt` stamp) — so three cheap queries nominate CANDIDATES, and
 * then the entitlement resolver decides. The resolver, not the rows: a
 * candidate who also owns a lifetime, or is comped, or whose trial was
 * tombstone-cancelled resolves as something other than `trialing` and is
 * skipped, which is exactly the rule "active/paid users never get trial mail"
 * without re-deriving any of it here.
 *
 * ONCE, DURABLY. One reminder per (user, trial end), enforced by the unique
 * `TrialReminderSent` marker — see the model comment for why the marker is
 * written only AFTER the mail provider accepts the email (a failed send leaves
 * nothing behind, so the next hourly run retries until the window closes).
 *
 * PUSH RIDES ALONG. The email is the durable leg; the push goes through the
 * same `deliver` primitive every other notification uses (audit rows, token
 * pruning), keyed with a dedupe key so a retry after an email-only failure can
 * never double-push. Best-effort by design: a push failure neither blocks the
 * marker nor fails the run.
 */

/** How far ahead the reminder looks. ONE window, one reminder per trial end. */
export const TRIAL_REMINDER_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Per-run ceiling on each candidate query. Hygiene, not policy: the window
 * already bounds the set to "trials ending today", and anything a truncated run
 * misses is picked up next hour as markers accumulate.
 */
const CANDIDATES_PER_QUERY = 500;

export type TrialReminderReport = {
  /** Distinct users nominated by the three candidate queries. */
  candidates: number;
  /** Reminder emails the mail provider accepted this run. */
  sent: number;
  /** Of those, how many also reached at least one push token. */
  pushed: number;
  /** Skipped because this (user, trial end) was already reminded. */
  alreadySent: number;
  /** Skipped because the resolver says they are not trialing into this window. */
  notTrialing: number;
  /** Email refused/unsendable — nothing marked, retried next run. */
  failed: number;
};

export async function sendTrialReminders(): Promise<TrialReminderReport> {
  const now = new Date();
  const windowEnd = new Date(now.getTime() + TRIAL_REMINDER_WINDOW_MS);
  const inWindow = { gt: now, lte: windowEnd };

  // The three places a trial's end can live. These only NOMINATE — every
  // verdict below comes from the resolver, so a stale or superseded row here
  // costs one resolve, never a wrong email.
  const [subs, claims, legacy] = await Promise.all([
    // Lemon Squeezy `on_trial` verbatim; RevenueCat trials are mirrored with
    // the SAME status (see lib/revenuecat.ts statusForSubscription), so one
    // query covers both stores.
    prisma.subscription.findMany({
      where: { status: "on_trial", validUntil: inWindow },
      select: { userId: true },
      take: CANDIDATES_PER_QUERY,
    }),
    prisma.trialClaim.findMany({
      where: { endsAt: inWindow, firstUserId: { not: null } },
      select: { firstUserId: true },
      take: CANDIDATES_PER_QUERY,
    }),
    // The legacy per-account stamp, read-only since the ledger — accounts that
    // predate it are still inside windows only this column knows about.
    prisma.user.findMany({
      where: { trialEndsAt: inWindow },
      select: { id: true },
      take: CANDIDATES_PER_QUERY,
    }),
  ]);

  const ids = [
    ...new Set([
      ...subs.map((s) => s.userId),
      ...claims.map((c) => c.firstUserId).filter((v): v is string => v != null),
      ...legacy.map((u) => u.id),
    ]),
  ];

  const report: TrialReminderReport = {
    candidates: ids.length,
    sent: 0,
    pushed: 0,
    alreadySent: 0,
    notTrialing: 0,
    failed: 0,
  };

  for (const userId of ids) {
    try {
      await remindOne(userId, now, windowEnd, report);
    } catch (e) {
      // One broken account must not sink the rest of the run.
      report.failed += 1;
      console.error(`[trial-reminders] ${userId}:`, e instanceof Error ? e.message : e);
    }
  }
  return report;
}

async function remindOne(
  userId: string,
  now: Date,
  windowEnd: Date,
  report: TrialReminderReport,
): Promise<void> {
  // The resolver is the ONE authority on effective access (and it refreshes the
  // user's cache as a side effect, which is a small bonus). An empty device id
  // resolves on the account leg alone — the same call the admin console makes.
  let view: Awaited<ReturnType<typeof resolveAndCache>>;
  try {
    view = await resolveAndCache(userId, "");
  } catch {
    // The account vanished between the candidate query and here.
    report.notTrialing += 1;
    return;
  }
  if (view.status !== "trialing") {
    report.notTrialing += 1;
    return;
  }

  // WHICH instant the reminder is about, in the resolver's own precedence: a
  // subscription trial counts down against the granting row's validUntil, the
  // machine/legacy trial against trialEndsAt. Re-checked against the window
  // because the AUTHORITATIVE end may differ from the candidate row's — a claim
  // extended by support, say — and a reminder about a date outside the window
  // belongs to a later run.
  const endIso = view.validUntil ?? view.trialEndsAt;
  const endsAt = endIso ? new Date(endIso) : null;
  if (!endsAt || endsAt.getTime() <= now.getTime() || endsAt.getTime() > windowEnd.getTime()) {
    report.notTrialing += 1;
    return;
  }

  // Already reminded about THIS end? The read is the cheap fast path; the
  // unique index on the create below is what makes the answer race-proof.
  const existing = await prisma.trialReminderSent.findUnique({
    where: { userId_endsAt: { userId, endsAt } },
    select: { id: true },
  });
  if (existing) {
    report.alreadySent += 1;
    return;
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, onboarding: { select: { locale: true } } },
  });
  if (!user?.email) {
    report.failed += 1;
    return;
  }
  const locale = user.onboarding?.locale ?? null;

  // The EMAIL is the durable leg, and it goes first: only an accepted send may
  // write the marker, so a refusal here (provider down, key unset) leaves the
  // reminder owed and the next run retries.
  const result = await sendTrialEndingReminder(user.email, {
    endsAt,
    willRenew: view.willRenew === true,
    billingProvider: view.billingProvider ?? "NONE",
    locale,
  });
  if (!result.ok) {
    report.failed += 1;
    if (!result.skipped) {
      console.warn(`[trial-reminders] email to user ${userId} failed: ${result.error}`);
    }
    return;
  }
  report.sent += 1;

  // The push leg — real sender, shared primitive (Expo dispatch + delivery
  // audit rows + dead-token pruning). Its own dedupe key means a run that
  // emailed, pushed, and then failed to write the marker cannot push twice.
  // Best-effort: the reminder went out by email either way.
  let pushedTokens = 0;
  try {
    const tokens = await prisma.pushToken.findMany({
      where: { userId, valid: true },
      select: { token: true },
    });
    if (tokens.length > 0) {
      const fr = isFrenchLocale(locale);
      const { date, time } = trialEndParts(endsAt, fr);
      const converts = view.willRenew === true && (view.billingProvider ?? "NONE") !== "NONE";
      const summary = await deliver(
        tokens.map((t) => ({ token: t.token, userId })),
        fr
          ? {
              title: "Votre essai se termine bientôt",
              body:
                `Votre essai WeLockin se termine le ${date} à ${time} (UTC). ` +
                (converts
                  ? "Votre premier paiement sera prélevé à ce moment-là."
                  : "Votre accès s'arrête à ce moment-là."),
              data: { type: "trial_reminder", endsAt: endsAt.toISOString() },
            }
          : {
              title: "Your trial ends soon",
              body:
                `Your WeLockin trial ends on ${date} at ${time} (UTC). ` +
                (converts ? "Your first payment happens then." : "Your access ends then."),
              data: { type: "trial_reminder", endsAt: endsAt.toISOString() },
            },
        { source: "cron:trial-reminder", dedupeKey: `trial-reminder:${userId}:${endsAt.toISOString()}` },
      );
      pushedTokens = summary.sent;
      if (summary.sent > 0) report.pushed += 1;
    }
  } catch (e) {
    console.warn(`[trial-reminders] push to user ${userId} failed:`, e instanceof Error ? e.message : e);
  }

  // The durable marker, LAST — written only about a reminder that actually
  // went out. A duplicate key here means a concurrent run just recorded the
  // same reminder; theirs stands, and this one is not an error.
  try {
    await prisma.trialReminderSent.create({
      data: { userId, endsAt, channels: pushedTokens > 0 ? "email+push" : "email" },
    });
  } catch (e) {
    if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")) throw e;
  }
}
