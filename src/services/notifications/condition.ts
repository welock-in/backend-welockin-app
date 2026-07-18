/**
 * Evaluate a rule's `condition` JSON against the event context. Small, safe DSL:
 *   { field: value }            → ctx.field === value
 *   { field: { $in: [...] } }   → ctx.field is in the list
 *   { field: { $ne: value } }   → ctx.field !== value
 * An empty/absent condition always matches. An unknown operator fails closed
 * (no match) so a typo can't accidentally fire a notification at everyone.
 */
export function matchCondition(condition: unknown, ctx: Record<string, unknown>): boolean {
  if (!condition || typeof condition !== "object") return true;
  for (const [field, expected] of Object.entries(condition as Record<string, unknown>)) {
    const actual = ctx[field];
    if (expected && typeof expected === "object" && !Array.isArray(expected)) {
      const op = expected as Record<string, unknown>;
      if ("$in" in op) {
        if (!Array.isArray(op.$in) || !op.$in.includes(actual)) return false;
      } else if ("$ne" in op) {
        if (actual === op.$ne) return false;
      } else {
        return false; // unknown operator → fail closed
      }
    } else if (actual !== expected) {
      return false;
    }
  }
  return true;
}
