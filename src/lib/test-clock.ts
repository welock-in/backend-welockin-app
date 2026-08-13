/**
 * A frozen clock for tests, and the two shapes it comes in.
 *
 * Billing logic is almost entirely date arithmetic — "is this trial still
 * running?", "has the backoff elapsed?", "is this event older than what we
 * recorded?" — so a test that reads the wall clock is a test that can pass at
 * 09:59 and fail at 10:00. This file exists because that already happened here:
 * a webhook fixture with a hard-coded `renews_at` went red exactly when the
 * instant it named went past, and the failure looked like a code defect.
 *
 * TEST-ONLY. Nothing in `src/` outside a `.test.ts` may import it.
 */

/**
 * The instant every test pretends it is.
 *
 * Arbitrary but fixed, and deliberately not "now minus something": a constant
 * makes the fixtures in a failing test readable — a date in 2026-08 is inside the
 * window, one in 2026-07 is behind it, and nobody has to do arithmetic against
 * whenever the suite happened to run.
 */
export const FROZEN_NOW = new Date("2026-08-11T12:00:00.000Z");

/** Milliseconds in a day, so fixtures read as days rather than as digits. */
export const DAY_MS = 24 * 60 * 60 * 1000;

/** `days` after the frozen instant. Negative for before it. */
export function fromFrozen(days: number): Date {
  return new Date(FROZEN_NOW.getTime() + days * DAY_MS);
}

type ClockCtx = {
  mock: {
    timers: {
      enable(opts: { apis: string[]; now: number }): void;
      reset(): void;
    };
  };
  after(fn: () => void): void;
};

/**
 * Freeze `Date` for the duration of one test.
 *
 * ONLY `Date` — `setTimeout` and friends are left real on purpose. Supertest
 * drives a genuine HTTP server over a genuine socket, and a mocked timer stack
 * means its request never completes and the test hangs instead of failing. Date
 * is the only clock the billing rules read, so it is the only one worth taking.
 *
 * DO NOT use this in `tests/mongo/`. Those talk to a real replica set, and the
 * MongoDB driver times its own heartbeats and server selection off `Date.now()`;
 * freezing it underneath the driver stalls the connection pool. Those tests get
 * determinism a different way — every fixture date is derived from `FROZEN_NOW`
 * rather than from the wall clock, which removes the flakiness without lying to
 * the driver about what time it is.
 */
export function freezeClock(t: ClockCtx, at: Date = FROZEN_NOW): Date {
  t.mock.timers.enable({ apis: ["Date"], now: at.getTime() });
  t.after(() => t.mock.timers.reset());
  return at;
}
