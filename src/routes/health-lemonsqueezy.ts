import { Router } from "express";
import { env, paymentConfig } from "../lib/env";

export const healthLemonSqueezyRouter = Router();

const TIMEOUT_MS = 10_000;

/**
 * Short-lived memo of the last answer, so a burst (an operator refreshing, or
 * the admin UI polling) collapses to ONE pair of outbound LS calls rather than
 * one pair per request. The data — which store/variants the key can see — moves
 * only when the env or the dashboard changes, so 30s of staleness is invisible
 * to a human and cheap insurance for the shared API quota.
 */
let memo: { at: number; body: unknown } | null = null;
const MEMO_MS = 30_000;
/** Test-only reset so the memo never leaks between cases. */
export function __resetHealthLemonMemo(): void {
  memo = null;
}

/**
 * Ask Lemon Squeezy, with the key this deploy actually holds, and report what it
 * can see.
 *
 * WHY THIS EXISTS. "Not Found — The related resource does not exist" is Lemon
 * Squeezy's answer when a checkout names a store or a variant the API KEY cannot
 * see. It never says WHICH, and it is indistinguishable from a typo, from a
 * variant that belongs to another store, and from the one that actually bites:
 * a TEST-mode key looking at LIVE variant ids, or the reverse. Test and live are
 * separate object graphs — the same product has different variant ids in each —
 * so ids copied from the dashboard in one mode are simply absent in the other.
 *
 * Rather than guess at that from a distance, this asks. It answers the only two
 * questions that matter: which store does this key belong to, and do the three
 * configured variant ids exist for it.
 *
 * SAFE TO EXPOSE. Store names and variant ids are public — they ride in every
 * checkout URL and every webhook delivery. The API key is used, never echoed,
 * and the one genuinely sensitive thing here would be the key's own value, which
 * is reported as a boolean by /api/health/config and not at all by this route.
 */
healthLemonSqueezyRouter.get("/", async (_req, res) => {
  // A half-configured storefront BLANKS all four values in memory (env.ts), so
  // without this check the route would report "no API key" to an operator whose
  // dashboard visibly carries one — a misleading answer from the one route that
  // exists to explain checkout failures. Name the real cause instead.
  if (paymentConfig.degraded) {
    res.json({ ok: false, reason: paymentConfig.problems.join(" / ") });
    return;
  }
  if (!env.lemonSqueezyApiKey) {
    res.json({ ok: false, reason: "No LEMONSQUEEZY_API_KEY on this deployment." });
    return;
  }

  // Serve the memo if fresh — one pair of outbound calls per 30s, not per hit.
  if (memo && Date.now() - memo.at < MEMO_MS) {
    res.json(memo.body);
    return;
  }

  const call = async (path: string): Promise<{ ok: boolean; body: any; status: number }> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const r = await fetch(`${env.lemonSqueezyApiBase}${path}`, {
        headers: {
          Accept: "application/vnd.api+json",
          Authorization: `Bearer ${env.lemonSqueezyApiKey}`,
        },
        signal: controller.signal,
      });
      const body = await r.json().catch(() => null);
      return { ok: r.ok, body, status: r.status };
    } catch (e) {
      // Never echo the error: the request carried the key in a header and some
      // fetch errors quote the request back.
      return { ok: false, body: { networkError: true }, status: 0 };
    } finally {
      clearTimeout(timer);
    }
  };

  // Memoize whatever we are about to answer, so the next burst is served without
  // another outbound pair. Applied to every post-fetch answer, including a bad
  // key, so a wrong key is not re-hammered either.
  const answer = (body: unknown) => {
    memo = { at: Date.now(), body };
    res.json(body);
  };

  const [stores, variants] = await Promise.all([
    call("/v1/stores"),
    // 100 is the page ceiling; nobody sells enough plans for this to truncate,
    // and a truncated list would be worse than none because a missing id would
    // read as "does not exist".
    call("/v1/variants?page[size]=100"),
  ]);

  if (!stores.ok) {
    answer({
      ok: false,
      // A 401 here is the whole answer: the key is wrong or revoked, and every
      // checkout will fail whatever the ids say.
      reason:
        stores.status === 401
          ? "Lemon Squeezy rejected the API key (401). Check LEMONSQUEEZY_API_KEY / LEMON_API_KEY."
          : `Could not list stores (HTTP ${stores.status}).`,
    });
    return;
  }

  const storeList = (stores.body?.data ?? []).map((s: any) => ({
    id: String(s.id),
    name: s.attributes?.name ?? null,
  }));

  const variantList = (variants.body?.data ?? []).map((v: any) => {
    const a = v.attributes ?? {};
    return {
      id: String(v.id),
      name: a.name ?? null,
      // "pending" is the NORMAL status of the single Default variant a product
      // gets when it has no explicit variants, and it sells perfectly well so
      // long as the PRODUCT is published. Lemon Squeezy's own sync example
      // skips pending only when a product has several variants. An earlier
      // comment here called it unsellable; that was wrong, and acting on it
      // would have sent someone hunting a publish button they did not need.
      status: a.status ?? null,
      // Cents, so 499 is EUR 4.99. The surest way to tell which plan a variant
      // is when every one of them is called "Default".
      price: a.price ?? null,
      productId: a.product_id != null ? String(a.product_id) : null,
      // Subscription or one-off, and on what cadence: this is what says which
      // id belongs in MONTHLY, which in YEARLY, and which is the lifetime.
      isSubscription: a.is_subscription ?? null,
      interval: a.interval ?? null,
      intervalCount: a.interval_count ?? null,
      // Whether the trial the paywall promises is actually configured on the
      // variant. A plan sold as "7 days free" whose variant carries no trial
      // charges on day one.
      hasFreeTrial: a.has_free_trial ?? null,
      trialInterval: a.trial_interval ?? null,
      trialIntervalCount: a.trial_interval_count ?? null,
    };
  });

  const findVariant = (id: string) => variantList.find((v: any) => v.id === id) ?? null;

  const configuredIds = [
    env.lemonSqueezyVariantId,
    env.lemonSqueezyVariantMonthly,
    env.lemonSqueezyVariantYearly,
  ].filter(Boolean);
  const missing = configuredIds.filter((id) => !variantList.some((v: any) => v.id === id));

  answer({
    ok: true,
    // The sentence someone can act on, rather than three nulls to interpret.
    // Every configured id absent from a store that otherwise matches is the
    // signature of a test/live graph mismatch, and nothing else looks like it.
    summary:
      configuredIds.length > 0 && missing.length === configuredIds.length
        ? "None of the configured variant ids exist for this API key. Test and live are " +
          "separate object graphs — these ids almost certainly come from the other mode. " +
          "Copy the ids listed below."
        : missing.length > 0
          ? `Configured but not visible to this key: ${missing.join(", ")}.`
          : "Every configured id exists for this key.",
    // Which store the key belongs to, versus the one we are configured to sell
    // from. A mismatch here explains every "related resource does not exist".
    storeConfigured: env.lemonSqueezyStoreId || null,
    storesVisibleToThisKey: storeList,
    storeMatches: storeList.some((s: any) => s.id === env.lemonSqueezyStoreId),
    variantsConfigured: {
      lifetime: {
        id: env.lemonSqueezyVariantId || null,
        found: env.lemonSqueezyVariantId ? findVariant(env.lemonSqueezyVariantId) : null,
      },
      monthly: {
        id: env.lemonSqueezyVariantMonthly || null,
        found: env.lemonSqueezyVariantMonthly ? findVariant(env.lemonSqueezyVariantMonthly) : null,
      },
      yearly: {
        id: env.lemonSqueezyVariantYearly || null,
        found: env.lemonSqueezyVariantYearly ? findVariant(env.lemonSqueezyVariantYearly) : null,
      },
    },
    // The list to copy the right ids from when the configured ones are absent.
    variantsVisibleToThisKey: variantList,
  });
});
