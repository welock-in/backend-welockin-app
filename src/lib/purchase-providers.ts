/**
 * Where a lifetime licence may come from — the one list, and the one place a new
 * platform is wired in.
 *
 * WHY THIS EXISTS. `Purchase` rows carry a `provider`, and until now nothing
 * read it: `hasActivePurchase` was `purchases.some((p) => !p.isRefunded)`, so ANY
 * row from ANY source unlocked every platform. That is not a bug in one route,
 * it is a missing concept — there was no answer to "which shops are we open to
 * today?", so every shop that had ever existed was open forever, including one
 * that turned out to accept free Apple sandbox transactions.
 *
 * THE RULE, and the asymmetry is the whole design:
 *
 *   WRITING is gated. A provider that is not enabled cannot create a purchase.
 *     Closing a door is how a hole stops widening.
 *
 *   READING is NOT gated. A row that exists keeps granting, whatever the flag
 *     says today. Turning a provider off must never retroactively revoke people
 *     who genuinely paid — a billing system that can silently un-sell things is
 *     worse than one with an extra door. Cleaning up rows that should not exist
 *     is a data job with a human attached, not a boolean.
 *
 * WIRING IN A NEW PLATFORM — this is the entry point, and it is deliberately the
 * only one. Add an entry to PROVIDERS below with:
 *
 *   id       what goes in `Purchase.provider`. Half of the unique key
 *            (provider, externalId), so it must never change once rows exist.
 *   store    what goes in `Purchase.store` — where the money was taken.
 *   enabled  may this provider write TODAY? Read from the environment so it can
 *            be turned off without a deploy.
 *
 * Then have that platform's route call `assertCanWrite(id)` before it writes.
 * Nothing else in the entitlement path needs to know the platform exists: the
 * resolver counts rows, and the rows describe themselves.
 *
 * ONE ROUTE DELIBERATELY DOES NOT CALL IT: the Lemon Squeezy webhook. Money has
 * already changed hands by the time a delivery arrives, so refusing to record it
 * would mean a customer who paid and got nothing — the one failure worse than
 * the hole this file closes. It is also unnecessary: that endpoint already fails
 * closed on the signature, which cannot verify without the secret that makes the
 * provider enabled in the first place. The gate belongs on routes a CLIENT can
 * call, not on ones a payment processor calls after taking the money.
 *
 * macOS needs NO entry. A Mac bought outside the App Store pays through Lemon
 * Squeezy, which is the same `lemonsqueezy` provider as Windows — same webhook,
 * same row, same licence. The account is what owns the licence, not the machine.
 */

import { env } from "./env";
import { HttpError } from "./http-error";

export type PurchaseProvider = {
  /** Stored in `Purchase.provider`. Immutable once rows exist. */
  id: string;
  /** Stored in `Purchase.store`. */
  store: string;
  /** May this provider create NEW purchases right now? */
  enabled: boolean;
  /** Shown in errors and logs. */
  label: string;
};

export const PROVIDERS: readonly PurchaseProvider[] = [
  {
    id: "lemonsqueezy",
    store: "lemonsqueezy",
    label: "Lemon Squeezy",
    // Enabled whenever the storefront is actually configured. A half-configured
    // one is already blanked by checkPaymentConfig, so this follows it rather
    // than adding a second switch that could disagree with the first.
    enabled: Boolean(env.lemonSqueezyApiKey && env.lemonSqueezyWebhookSecret),
  },
  {
    id: "app_store",
    store: "app_store",
    label: "Apple App Store",
    /**
     * OFF until an iOS build actually ships.
     *
     * The route that writes these verifies a StoreKit JWS, and a SANDBOX
     * transaction is signed by the same Apple chain as a real one — free, and
     * indistinguishable to every check except the environment field. The
     * environment is compared now, but a door nobody uses should not be open at
     * all: while there is no iOS client, every request to it is either a mistake
     * or an attempt.
     *
     * ⭐ THIS IS THE iOS ENTRY POINT. To wire iOS in: set
     * APPLE_PURCHASES_ENABLED=true, confirm APPLE_ENVIRONMENT matches the build
     * (Sandbox for TestFlight, Production for the App Store), and nothing else
     * changes — `POST /api/purchases` already verifies the signature, the chain,
     * the bundle id, the product id and the environment, and writes a row this
     * registry recognises.
     */
    enabled: env.applePurchasesEnabled,
  },
] as const;

const BY_ID = new Map(PROVIDERS.map((p) => [p.id, p]));

export const getProvider = (id: string): PurchaseProvider | undefined => BY_ID.get(id);

/**
 * Refuse to write a purchase for a provider that is closed.
 *
 * A 503 rather than a 400: the request is well-formed and may well be honest —
 * it is the shop that is shut. That distinction matters to a client deciding
 * whether to retry or to give up.
 */
export function assertCanWrite(id: string): PurchaseProvider {
  const provider = BY_ID.get(id);
  if (!provider) {
    throw new HttpError(500, "Unknown purchase provider", { code: "PROVIDER_UNKNOWN" });
  }
  if (!provider.enabled) {
    console.warn(`[purchases] refused a write for disabled provider ${id}`);
    throw new HttpError(503, `${provider.label} purchases are not available`, {
      code: "PROVIDER_DISABLED",
    });
  }
  return provider;
}
