import crypto from "node:crypto";

import { env } from "./env";
import { forbiddenPropertyKeys, type ServerEvent } from "./posthog-events";

/**
 * Server-side emission to PostHog.
 *
 * WHY RAW FETCH AND NOT posthog-node. This package is `"type": "commonjs"` and
 * `expo-server-sdk` v6 was already refused for being ESM-only (expo-push.ts:3-9)
 * — a `require()` of an ESM module throws ERR_REQUIRE_ESM and takes the whole
 * Vercel function down with it. Beyond that, every Node SDK buffers and flushes
 * on an interval, and this deployment is one serverless function that is FROZEN
 * between invocations: a buffered event is not a delayed event, it is a lost
 * one. One request per event, awaited, is the only shape that survives here.
 *
 * WHAT THIS MODULE REFUSES TO DO. It never throws, never rejects, and never
 * makes its caller slower than two seconds. The reason is written in the header
 * of webhooks-lemonsqueezy.ts, rule 3: status codes are instructions. A throw
 * inside a webhook handler becomes a 500, a 500 tells Lemon Squeezy to redeliver,
 * a redelivery re-runs the whole job, and a Purchase row gets written twice.
 * An analytics outage must not be able to move money. Callers still add their own
 * `.catch()` at the call site — belt and braces, and it documents the intent.
 *
 * @see lib/posthog-events.ts for the registry, the anonymity contract and the
 *      kill switch — all of it pure, and copied verbatim into ios/windows/macos.
 */

/** The path PostHog's own docs give for a single server-side event. */
const CAPTURE_PATH = "/i/v0/e/";

/**
 * Two seconds, not the ten expo-push.ts uses.
 *
 * That ten guards a push heartbeat, where being late costs nothing. This one
 * sits inside a payment webhook that Lemon Squeezy will redeliver if we answer
 * slowly, so the timeout has to be shorter than anyone's patience for a
 * measurement that nobody is waiting for.
 */
const TIMEOUT_MS = 2_000;

/**
 * Namespace for the deterministic event uuids below. Any fixed UUID works —
 * what matters is that it never changes, because changing it would make every
 * future replay of an old event look new.
 */
const UUID_NAMESPACE = "b7f0e1c2-4a3d-4b8e-9c6f-2d1a5e7f30ab";

export type CaptureInput = {
  /** Constrained to the registry: a typo cannot compile. */
  event: ServerEvent;
  /** The backend userId. Never an email, never a RevenueCat anonymous id. */
  distinctId: string;
  /**
   * The provider's own event identifier — `order.eventKey`, `sub.eventKey`,
   * RevenueCat's `event.id`, composed with a row id where one delivery produces
   * several events. Stable across redeliveries; that is the whole point.
   */
  dedupeKey: string;
  /**
   * THE PROVIDER'S OWN EVENT TIME. Never `new Date()`, and this is the least
   * obvious rule in the file.
   *
   * PostHog de-duplicates on the quadruple (uuid, event, timestamp, distinct_id)
   * — and it buckets that timestamp by calendar day. A Lemon Squeezy redelivery
   * arrives after a backoff measured in hours, sometimes the next morning. Stamp
   * it at emission time and the two copies stop matching, the de-duplication
   * silently does nothing, and the order is counted twice.
   *
   * Note also that de-duplication there is *eventual* — it happens during
   * ClickHouse merges and the docs decline to guarantee it. The real first line
   * of defence stays the WebhookEvent claim/mark cycle; this is the net below.
   */
  timestamp: Date;
  properties?: Record<string, unknown>;
};

export type CaptureResult =
  /** Delivered. PostHog answered 2xx — which, be warned, it also does for a
   *  malformed event, so this is proof of transport and nothing more. */
  | { ok: true }
  /** Nothing was attempted. Not an error: no key configured, or nobody to
   *  attribute the event to. */
  | { ok: false; skipped: true; reason: "not_configured" | "no_distinct_id" }
  /** Attempted and failed. Already logged; the caller has nothing to do. */
  | { ok: false; skipped: false; reason: "http" | "network" };

/**
 * Warn once per lambda instance, not once per event.
 *
 * resend.ts warns on every send, which is right for an email — there are few of
 * them and each one matters. A webhook can emit several events, and a missing
 * key would put a line in the Vercel log for each. Same latch as
 * entitlement-receipt.ts:162.
 */
let warnedMissingKey = false;

/** RFC 4122 v5 (SHA-1, namespaced). Deterministic: same key, same uuid, forever. */
export function eventUuid(dedupeKey: string): string {
  const namespaceBytes = Buffer.from(UUID_NAMESPACE.replace(/-/g, ""), "hex");
  const digest = crypto
    .createHash("sha1")
    .update(namespaceBytes)
    .update(Buffer.from(dedupeKey, "utf8"))
    .digest();

  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant

  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

/**
 * Remove the properties the anonymity contract forbids, and say so loudly.
 *
 * STRIPPING RATHER THAN DROPPING THE EVENT, deliberately. Both failures are
 * real: a leaked email breaks the promise the privacy policy makes, and a
 * dropped revenue event breaks the one reconciliation that proves the numbers
 * are right (PostHog `purchase_completed` counted against `Purchase` rows).
 * Stripping is the only option that avoids both — the leak never leaves the
 * process, the count stays correct, and `console.error` names the keys so it
 * gets fixed. The test suite catches it long before production anyway.
 */
function scrub(
  event: string,
  properties: Record<string, unknown>,
): Record<string, unknown> {
  const offenders = forbiddenPropertyKeys(properties);
  if (offenders.length === 0) return properties;

  // The KEYS, never the values — logging the value would put the very thing we
  // just refused to send into the log instead.
  console.error(
    `[posthog] ${event}: dropped forbidden propert${offenders.length > 1 ? "ies" : "y"} ${offenders.join(", ")}`,
  );

  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (!offenders.includes(key)) clean[key] = value;
  }
  return clean;
}

/**
 * Send one event. Awaited by the caller, never fatal to it.
 *
 * Reads `env` on every call rather than at module load, for two reasons that
 * have both already bitten this repo: `env` mutates itself after validation
 * (env.ts blanks the storefront keys when the payment config is degraded), and
 * the test suites patch the `env` object in place after the modules are loaded.
 * A captured `const KEY = env.posthogApiKey` would be frozen at boot and
 * impossible to switch on in a test.
 */
export async function capture(input: CaptureInput): Promise<CaptureResult> {
  // BEFORE ANY FETCH. The RevenueCat and Lemon Squeezy suites replace
  // `globalThis.fetch` and assert on the exact number of calls a delivery makes
  // ("one delivery's worth of API traffic, not two"). With no key configured —
  // which is every test — this module must be invisible to them.
  if (!env.posthogApiKey) {
    if (!warnedMissingKey) {
      warnedMissingKey = true;
      console.warn("[posthog] POSTHOG_API_KEY not set — analytics disabled for this instance");
    }
    return { ok: false, skipped: true, reason: "not_configured" };
  }

  // An event with nobody to attribute it to is worse than no event: PostHog
  // answers 200 to an empty distinct_id and files it under a phantom person.
  if (!input.distinctId) return { ok: false, skipped: true, reason: "no_distinct_id" };

  const properties = scrub(input.event, input.properties ?? {});

  try {
    const res = await fetch(`${env.posthogHost}${CAPTURE_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_key: env.posthogApiKey,
        event: input.event,
        // PostHog truncates past 200 characters. A Mongo ObjectId is 24, so this
        // is a guard against a future caller, not against today's.
        distinct_id: input.distinctId.slice(0, 200),
        uuid: eventUuid(input.dedupeKey),
        timestamp: input.timestamp.toISOString(),
        properties,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) {
      // The status and nothing else. The request body carried the project key,
      // and this repo's rule is that such an error is never echoed verbatim
      // (billing-tasks.ts:177, checkout.ts:351, lemonsqueezy.ts:530).
      console.error(`[posthog] ${input.event}: HTTP ${res.status}`);
      return { ok: false, skipped: false, reason: "http" };
    }
    return { ok: true };
  } catch (err) {
    // Includes the AbortError from the timeout above. Swallowed on purpose: see
    // the header. Nothing upstream may learn that this failed.
    console.error(`[posthog] ${input.event}: ${err instanceof Error ? err.message : "send failed"}`);
    return { ok: false, skipped: false, reason: "network" };
  }
}

/** Test seam only — the warn latch is module state and outlives a single test. */
export function resetPostHogWarnLatchForTests(): void {
  warnedMissingKey = false;
}
