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
  expiration?: number;
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

class ExpoHttpError extends Error {
  constructor(public status: number) { super(`Expo push HTTP ${status}`); }
}

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
    signal: AbortSignal.timeout(4_000),
  });
  if (!res.ok) throw new ExpoHttpError(res.status);
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
    ...(payload.expiration !== undefined ? { expiration: payload.expiration } : {}),
  }));

  // Order is preserved, so concatenated tickets align 1:1 with `messages` / `validIdx`.
  const tickets: ExpoTicket[] = [];
  for (let i = 0; i < messages.length; i += CHUNK) {
    const chunk = messages.slice(i, i + CHUNK);
    try {
      let returned: ExpoTicket[];
      try {
        returned = await postChunk(chunk);
      } catch (err) {
        // One bounded retry for transport outages/429/5xx. Never retry a
        // configuration error, and never hold a session request indefinitely.
        if (err instanceof ExpoHttpError && err.status !== 429 && err.status < 500) throw err;
        await new Promise((resolve) => setTimeout(resolve, 300));
        returned = await postChunk(chunk);
      }
      // Pad WITHIN each chunk; otherwise a short response shifts every later
      // ticket onto the wrong device during an admin broadcast >100 tokens.
      for (let k = 0; k < chunk.length; k++) {
        tickets.push(returned[k] ?? { status: "error", message: "no ticket returned" });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "send failed";
      for (let k = 0; k < chunk.length; k++) tickets.push({ status: "error", message });
    }
  }

  validIdx.forEach((origIdx, k) => {
    const t = tickets[k];
    if (!t) {
      // Fewer tickets than messages — a malformed 200 from Expo. The "sent"
      // this result was initialized with was only ever optimistic, and a
      // phantom "sent" delivery row would dedupe every retry away (deliver's
      // dedupe treats "sent" as proof the push went out). No ticket = not sent.
      out[origIdx] = { token: tokens[origIdx], status: "error", error: "no ticket returned" };
      return;
    }
    if (t.status === "ok") {
      out[origIdx] = typeof t.id === "string" && t.id.length > 0
        ? { token: tokens[origIdx], status: "sent", ticketId: t.id }
        : { token: tokens[origIdx], status: "error", error: "no ticket id returned" };
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

export type ExpoReceipt = { status: "ok" | "error"; message?: string; details?: { error?: string } };

export async function getExpoReceipts(ids: string[]): Promise<Record<string, ExpoReceipt>> {
  if (ids.length === 0) return {};
  const res = await fetch("https://exp.host/--/api/v2/push/getReceipts", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(env.expoAccessToken ? { Authorization: `Bearer ${env.expoAccessToken}` } : {}),
    },
    body: JSON.stringify({ ids }),
    signal: AbortSignal.timeout(4_000),
  });
  if (!res.ok) throw new ExpoHttpError(res.status);
  const json = await res.json() as { data?: Record<string, ExpoReceipt> };
  return json.data ?? {};
}
