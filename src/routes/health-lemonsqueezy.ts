import { Router } from "express";
import { env } from "../lib/env";

export const healthLemonSqueezyRouter = Router();

const TIMEOUT_MS = 10_000;

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
  if (!env.lemonSqueezyApiKey) {
    res.json({ ok: false, reason: "No LEMONSQUEEZY_API_KEY on this deployment." });
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

  const [stores, variants] = await Promise.all([
    call("/v1/stores"),
    // 100 is the page ceiling; nobody sells enough plans for this to truncate,
    // and a truncated list would be worse than none because a missing id would
    // read as "does not exist".
    call("/v1/variants?page[size]=100"),
  ]);

  if (!stores.ok) {
    res.json({
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

  const variantList = (variants.body?.data ?? []).map((v: any) => ({
    id: String(v.id),
    name: v.attributes?.name ?? null,
    status: v.attributes?.status ?? null,
    price: v.attributes?.price ?? null,
    productId: v.attributes?.product_id != null ? String(v.attributes.product_id) : null,
  }));

  const findVariant = (id: string) => variantList.find((v: any) => v.id === id) ?? null;

  res.json({
    ok: true,
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
