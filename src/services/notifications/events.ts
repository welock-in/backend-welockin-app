/**
 * The notification EVENT catalog. Producers (routes / services) call
 * `emit(name, ctx)` — they know nothing about templates or audiences. Adding a
 * trigger is a single `emit()`; wiring it to a message is data (a NotificationRule).
 *
 * `ctx` MUST carry `userId` (audience resolution needs it) and SHOULD carry
 * `deviceId` (the originating device, so "sameUserOtherDevices" can exclude it).
 * Every other field is available to rule conditions ({{$in}} …) and to templates
 * ({{variables}}).
 */
export interface NotificationContext {
  userId: string;
  deviceId?: string;
  [key: string]: unknown;
}

/** Known event names (free-form strings at the boundary — rules match by name). */
export const NotificationEvents = {
  /** A focus session's first heartbeat landed (fires once per session). */
  SESSION_STARTED: "session.started",
} as const;
