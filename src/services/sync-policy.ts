import type { SyncPushInput } from "../validation/schemas";

/**
 * Current PC clients send schedules with their complete snapshot. Existing
 * mobile clients send events after a pull and omit schedules; treating that
 * shape as append-only prevents them from restoring stale PC state.
 */
export function shouldReplaceSnapshot(input: SyncPushInput): boolean {
  const hasEvents = (input.events?.length ?? 0) > 0;
  return input.replaceSnapshot || !hasEvents || input.schedules !== undefined;
}
