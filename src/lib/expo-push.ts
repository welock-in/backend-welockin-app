import { env } from "./env";

/* ─────────────────────────────────────────────────────────────
   Expo Push send path — implemented directly against the Expo Push
   HTTP API (no expo-server-sdk). expo-server-sdk v6 is ESM-only and
   this backend compiles to CommonJS on Vercel, so `require()`-ing it
   throws ERR_REQUIRE_ESM and crashes the whole function. The Expo
   Push API is a plain JSON POST — Node's global fetch (18+) covers it.
   Docs: https://docs.expo.dev/push-notifications/sending-notifications/
   ───────────────────────────────────────────────────────────── */

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const CHUNK = 100; // Expo accepts up to 100 messages per request.

// Accepts both the modern "ExponentPushToken[...]" and legacy "ExpoPushToken[...]".
const EXPO_TOKEN_RE = /^Expo(nent)?PushToken\[[^\]]+\]$/;
export const isExpoPushToken = (t: string): boolean => EXPO_TOKEN_RE.test(t);

export interface PushPayload {
  title: string;
  body: string;
  data?: Record<string, unknown>;
  sound?: string | null; // default "default"; null = silent
  badge?: number;
}

export interface PushResult {
  token: string;
  status: "sent" | "invalid" | "error";
  ticketId?: string;
  error?: string;
  /** Expo error code (e.g. "DeviceNotRegistered") — caller prunes the token. */
  errorCode?: string;
}

type ExpoTicket =
  | { status: "ok"; id: string }
  | { status: "error"; message: string; details?: { error?: string } };

async function postChunk(messages: Array<Record<string, unknown>>): Promise<ExpoTicket[]> {
  const res = await fetch(EXPO_PUSH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(env.expoAccessToken ? { Authorization: `Bearer ${env.expoAccessToken}` } : {}),
    },
    body: JSON.stringify(messages),
    // Bound the call so an awaited dispatch (e.g. on the session heartbeat) can
    // never hang the request if Expo is slow/unreachable.
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Expo push HTTP ${res.status}`);
  const json = (await res.json()) as { data?: ExpoTicket[] };
  return json.data ?? [];
}

/**
 * Send one payload to many push tokens. Chunks per Expo's 100/request limit and
 * returns a per-token result. Invalid tokens are reported (never sent); a
 * ticket-level "DeviceNotRegistered" surfaces as `errorCode` so the caller can
 * mark that PushToken invalid. (Full delivery confirmation needs a later receipts
 * poll — out of P1 scope.)
 */
export async function sendExpoPush(tokens: string[], payload: PushPayload): Promise<PushResult[]> {
  const out: PushResult[] = tokens.map((token) => ({
    token,
    status: isExpoPushToken(token) ? "sent" : "invalid",
  }));

  const validIdx = tokens.map((_, i) => i).filter((i) => isExpoPushToken(tokens[i]));
  if (validIdx.length === 0) return out;

  const messages = validIdx.map((i) => ({
    to: tokens[i],
    title: payload.title,
    body: payload.body,
    data: payload.data ?? {},
    ...(payload.sound === null ? {} : { sound: payload.sound ?? "default" }),
    ...(payload.badge !== undefined ? { badge: payload.badge } : {}),
  }));

  // Order is preserved, so concatenated tickets align 1:1 with `messages` / `validIdx`.
  const tickets: ExpoTicket[] = [];
  for (let i = 0; i < messages.length; i += CHUNK) {
    const chunk = messages.slice(i, i + CHUNK);
    try {
      tickets.push(...(await postChunk(chunk)));
    } catch (err) {
      const message = err instanceof Error ? err.message : "send failed";
      for (let k = 0; k < chunk.length; k++) tickets.push({ status: "error", message });
    }
  }

  validIdx.forEach((origIdx, k) => {
    const t = tickets[k];
    if (!t) return;
    if (t.status === "ok") {
      out[origIdx] = { token: tokens[origIdx], status: "sent", ticketId: t.id };
    } else {
      out[origIdx] = {
        token: tokens[origIdx],
        status: "error",
        error: t.message,
        errorCode: t.details?.error,
      };
    }
  });

  return out;
}
