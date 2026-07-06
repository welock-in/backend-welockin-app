import assert from "node:assert/strict";
import { test } from "node:test";
import { computeDayStreak } from "./analytics";

function daysAgo(now: Date, n: number): Date {
  const d = new Date(now);
  d.setDate(d.getDate() - n);
  return d;
}

test("empty history yields streak 0", () => {
  assert.equal(computeDayStreak([], new Date()), 0);
});

test("today + yesterday + two days ago = streak 3", () => {
  const now = new Date(2026, 6, 6, 12, 0, 0);
  const events = [daysAgo(now, 0), daysAgo(now, 1), daysAgo(now, 2)];
  assert.equal(computeDayStreak(events, now), 3);
});

test("gap breaks the streak", () => {
  const now = new Date(2026, 6, 6, 12, 0, 0);
  // today + two days ago (yesterday missing) => streak 1
  const events = [daysAgo(now, 0), daysAgo(now, 2)];
  assert.equal(computeDayStreak(events, now), 1);
});

test("no event today but event yesterday => streak 0", () => {
  const now = new Date(2026, 6, 6, 12, 0, 0);
  const events = [daysAgo(now, 1), daysAgo(now, 2)];
  assert.equal(computeDayStreak(events, now), 0);
});

test("multiple events same day count once", () => {
  const now = new Date(2026, 6, 6, 12, 0, 0);
  const events = [
    daysAgo(now, 0),
    new Date(2026, 6, 6, 8, 0, 0),
    daysAgo(now, 1),
  ];
  assert.equal(computeDayStreak(events, now), 2);
});
