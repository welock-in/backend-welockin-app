import type { Request } from "express";
import { prisma } from "./prisma";
import { env } from "./env";
import { tooManyRequests } from "./http-error";

/**
 * A rolling-window rate limiter, backed by the database.
 *
 * It is in Mongo rather than in memory because this API runs on Vercel: every
 * serverless instance would keep its own counter, so an in-process limiter caps
 * roughly nothing while looking exactly like it caps something. That is worse
 * than no limiter, because it stops anyone from noticing there isn't one.
 *
 * The window is a fixed span from first hit, not a sliding log — the cheap kind.
 * A caller can therefore get up to `2 * max` across a window boundary, which is
 * the accepted trade everywhere else in this codebase (see the note in
 * routes/feedback.ts about accepting the check-then-act race). The increment
 * itself IS atomic, so parallel requests cannot share one count.
 */

/**
 * Best-effort client address.
 *
 * `trust proxy` is deliberately NOT enabled app-wide — flipping it changes
 * `req.ip`, `req.protocol` and `req.secure` for every existing route — so the
 * header is read here instead.
 *
 * `x-real-ip` is preferred because Vercel sets it from the connection it
 * actually accepted. `x-forwarded-for` is a client-APPENDED list, so its first
 * entry is whatever the caller claimed; the LAST entry is the hop nearest us and
 * the hardest to forge. Neither is a security boundary — which is why every
 * sensitive limit below is ALSO keyed on something the caller cannot choose,
 * such as the email address or the authenticated user id.
 */
export function clientIp(req: Request): string {
  const real = req.headers["x-real-ip"];
  if (typeof real === "string" && real.trim()) return real.trim();

  const fwd = req.headers["x-forwarded-for"];
  const raw = Array.isArray(fwd) ? fwd.join(",") : fwd;
  if (typeof raw === "string" && raw.trim()) {
    const parts = raw.split(",").map((p) => p.trim()).filter(Boolean);
    if (parts.length > 0) return parts[parts.length - 1];
  }

  return req.ip ?? req.socket.remoteAddress ?? "unknown";
}

/**
 * Count one hit against `key`, and throw 429 once `max` is exceeded within
 * `windowMs`.
 *
 * Throwing rather than returning a boolean is deliberate: a limiter you can
 * forget to check is a limiter that will eventually be forgotten.
 */
export async function consumeRateLimit(
  key: string,
  max: number,
  windowMs: number,
): Promise<void> {
  if (env.authRateLimitDisabled) return;

  let over = false;
  try {
    const now = new Date();
    const windowFloor = new Date(now.getTime() - windowMs);

    // Atomic: bump the counter only if the current window is still open. Doing
    // it as a conditional updateMany means N parallel callers each add exactly
    // one, instead of all reading the same value and all writing value+1.
    const bumped = await prisma.authThrottle.updateMany({
      where: { key, windowStartedAt: { gt: windowFloor } },
      data: { count: { increment: 1 } },
    });

    if (bumped.count === 0) {
      // No open window: either the first hit ever, or the previous window aged
      // out. Upsert covers both, and the unique index on `key` makes two
      // simultaneous openers collide rather than create a duplicate.
      await prisma.authThrottle.upsert({
        where: { key },
        create: { key, windowStartedAt: now, count: 1 },
        update: { windowStartedAt: now, count: 1 },
      });
      return;
    }

    const row = await prisma.authThrottle.findUnique({ where: { key } });
    over = Boolean(row && row.count > max);
  } catch (e) {
    // FAIL OPEN, loudly.
    //
    // A rate limiter is a safety valve, not an authorisation check: the request
    // was already allowed on its merits, and this only decides whether there
    // have been too many of them. If the counter itself is broken — a missing
    // collection, a replica-set hiccup — refusing every login and registration
    // on the platform is a far larger outage than briefly not counting.
    //
    // The trade is real and worth stating: anyone who can reliably break this
    // table also removes the limits. They would need write access to the same
    // database that stores the accounts, at which point the limiter is not what
    // is protecting anything.
    console.error(`[rate-limit] counter unavailable for "${key}" — allowing the request`, e);
    return;
  }

  if (over) throw tooManyRequests();
}

/**
 * Housekeeping for a table nothing else prunes.
 *
 * Called opportunistically rather than on a schedule — there is no cron here,
 * and a limiter row is ~100 bytes. The TTL index built by scripts/auth-migrate.ts
 * does the real work; this only matters on a deploy where that never ran.
 */
export async function pruneRateLimits(olderThanMs = 24 * 60 * 60 * 1000): Promise<number> {
  const { count } = await prisma.authThrottle.deleteMany({
    where: { windowStartedAt: { lt: new Date(Date.now() - olderThanMs) } },
  });
  return count;
}
