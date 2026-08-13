/**
 * The gate in front of every real Lemon Squeezy call.
 *
 * There is deliberately no way past it. A smoke suite that can be talked into
 * running against Live is not a smoke suite, it is a way to cancel a paying
 * customer's subscription from a terminal — so each check below returns a
 * REASON rather than a boolean, and the runner prints the reason and stops.
 */
export type GuardResult = { ok: true } | { ok: false; reason: string };

export function checkEnvGuards(env: NodeJS.ProcessEnv): GuardResult {
  if (env.RUN_LS_SMOKE !== "1") {
    return { ok: false, reason: "RUN_LS_SMOKE is not 1" };
  }
  const required = [
    "LEMONSQUEEZY_API_KEY",
    "LEMONSQUEEZY_STORE_ID",
    "LEMONSQUEEZY_VARIANT_ID",
    "LEMONSQUEEZY_VARIANT_MONTHLY",
    "LEMONSQUEEZY_VARIANT_YEARLY",
    "LEMONSQUEEZY_WEBHOOK_SECRET",
    "SMOKE_BACKEND_URL",
    "DATABASE_URL",
  ];
  const missing = required.filter((k) => !env[k]);
  if (missing.length) return { ok: false, reason: `missing Test Mode credentials: ${missing.join(", ")}` };

  const backend = env.SMOKE_BACKEND_URL ?? "";
  const localOrStaging = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(backend) || /staging/i.test(backend);
  if (!localOrStaging) {
    return { ok: false, reason: `SMOKE_BACKEND_URL "${backend}" is neither local nor staging` };
  }

  const db = env.DATABASE_URL ?? "";
  if (/mongodb\+srv:\/\//i.test(db) || /prod/i.test(db)) {
    return { ok: false, reason: "DATABASE_URL looks like a hosted/production cluster" };
  }
  return { ok: true };
}

/**
 * The one guard that cannot be done from the environment: ASK Lemon Squeezy
 * whether this key is a test key. A live key with test-looking ids in .env would
 * pass every check above and then act on real money.
 */
export async function checkKeyIsTestMode(apiBase: string, apiKey: string): Promise<GuardResult> {
  const r = await fetch(`${apiBase}/v1/users/me`, {
    headers: { Accept: "application/vnd.api+json", Authorization: `Bearer ${apiKey}` },
  });
  if (!r.ok) return { ok: false, reason: `Lemon Squeezy refused the key (HTTP ${r.status})` };
  const body = (await r.json()) as { data?: { attributes?: { test_mode?: boolean } } };
  if (body.data?.attributes?.test_mode !== true) {
    return { ok: false, reason: "this API key is NOT a Test Mode key — refusing to continue" };
  }
  return { ok: true };
}
