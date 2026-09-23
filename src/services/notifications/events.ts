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

/** Known event names (free-form strings at the boundary — rules match by name).
 *
 * NOT here: the focus-invite push. It used to be the event "focus.invited",
 * but the rule engine only fires when a NotificationRule + NotificationTemplate
 * were seeded into the database — and a database where the seed never ran drops
 * the push silently. Whether a phone gets invited is a product guarantee, not
 * configuration, so routes/focus-invites.ts now sends it directly (the same
 * resolveAudience + deliver primitives the admin console send uses). */
export const NotificationEvents = {
  /** A focus session's first heartbeat landed (fires once per session). */
  SESSION_STARTED: "session.started",
} as const;
