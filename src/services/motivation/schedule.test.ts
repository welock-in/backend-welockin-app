import assert from "node:assert/strict";
import test from "node:test";
import { chosenLocalMinute, localDateKey, localDayBounds, nextMotivationAt } from "./schedule";

test("daily time is stable, in the agreed window, and never on :00 or :30", () => {
  for (let day = 1; day <= 31; day++) {
    const key = `2026-10-${String(day).padStart(2, "0")}`;
    const minute = chosenLocalMinute("one-user", key);
    assert.ok(minute >= 17 * 60 + 35 && minute <= 19 * 60 + 15);
    assert.notEqual(minute % 30, 0);
    assert.equal(chosenLocalMinute("one-user", key), minute);
  }
  const times = new Set(Array.from({ length: 14 }, (_, day) =>
    chosenLocalMinute("one-user", `2026-10-${String(day + 1).padStart(2, "0")}`)));
  assert.equal(times.size, 14, "the same account gets a different time on consecutive days");
});

test("selected weekdays and local calendar dates govern scheduling", () => {
  // Thursday evening in Paris. Friday=4 is the only selected day.
  const due = nextMotivationAt(new Date("2026-10-08T18:00:00Z"), "Europe/Paris", [4], "one-user");
  assert.ok(due);
  assert.equal(localDateKey(due, "Europe/Paris"), "2026-10-09");
  assert.equal(nextMotivationAt(new Date(), "Europe/Paris", [], "one-user"), null);
});

test("local day bounds adapt across the autumn daylight-saving change", () => {
  const date = new Date("2026-10-25T12:00:00Z");
  const { from, to } = localDayBounds(date, "Europe/Paris");
  assert.equal(localDateKey(from, "Europe/Paris"), "2026-10-25");
  assert.equal(to.getTime() - from.getTime(), 25 * 60 * 60 * 1000);
  const due = nextMotivationAt(new Date("2026-10-25T08:00:00Z"), "Europe/Paris", [6], "one-user");
  assert.ok(due);
  assert.equal(localDateKey(due, "Europe/Paris"), "2026-10-25");
});

test("local day bounds adapt across the spring daylight-saving change", () => {
  const { from, to } = localDayBounds(new Date("2027-03-28T12:00:00Z"), "Europe/Paris");
  assert.equal(to.getTime() - from.getTime(), 23 * 60 * 60 * 1000);
});
