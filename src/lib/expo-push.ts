import { Expo, type ExpoPushMessage, type ExpoPushTicket } from "expo-server-sdk";
import { env } from "./env";

// One shared client. An access token is optional (recommended for higher limits /
// enhanced security); sends work without it via the open Expo Push API.
const expo = new Expo(env.expoAccessToken ? { accessToken: env.expoAccessToken } : {});

export const isExpoPushToken = (token: string): boolean => Expo.isExpoPushToken(token);

export interface PushPayload {
  title: string;
  body: string;
  data?: Record<string, unknown>;
  sound?: string | null; // default "default"; pass null for a silent notification
  badge?: number;
}

/** Per-token send outcome (index-aligned semantics via the returned `token`). */
export interface PushResult {
  token: string;
  status: "sent" | "invalid" | "error";
  ticketId?: string;
  error?: string;
  /** Expo error code (e.g. "DeviceNotRegistered") — caller prunes the token. */
  errorCode?: string;
}

/**
 * Send one payload to many push tokens. Chunks per Expo limits, sends each chunk,
 * and returns a per-token result. Invalid tokens are reported (never sent); a
 * ticket-level "DeviceNotRegistered" surfaces as `errorCode` so the caller can
 * mark that PushToken invalid. (Full delivery confirmation needs a later receipts
 * poll — out of P1 scope.)
 */
export async function sendExpoPush(tokens: string[], payload: PushPayload): Promise<PushResult[]> {
  const out: PushResult[] = tokens.map((token) => ({
    token,
    status: Expo.isExpoPushToken(token) ? "sent" : "invalid",
  }));

  const validIdx = tokens.map((_, i) => i).filter((i) => Expo.isExpoPushToken(tokens[i]));
  if (validIdx.length === 0) return out;

  const messages: ExpoPushMessage[] = validIdx.map((i) => ({
    to: tokens[i],
    title: payload.title,
    body: payload.body,
    data: payload.data ?? {},
    sound: payload.sound === null ? undefined : (payload.sound ?? "default"),
    ...(payload.badge !== undefined ? { badge: payload.badge } : {}),
  }));

  // chunkPushNotifications preserves order, so concatenated tickets align 1:1 with
  // `messages` (hence with `validIdx`).
  const tickets: ExpoPushTicket[] = [];
  for (const chunk of expo.chunkPushNotifications(messages)) {
    try {
      tickets.push(...(await expo.sendPushNotificationsAsync(chunk)));
    } catch (err) {
      const message = err instanceof Error ? err.message : "send failed";
      for (let k = 0; k < chunk.length; k++) {
        tickets.push({ status: "error", message } as ExpoPushTicket);
      }
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
        errorCode: typeof t.details?.error === "string" ? t.details.error : undefined,
      };
    }
  });

  return out;
}
