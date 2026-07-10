import assert from "node:assert/strict";
import { test } from "node:test";
import { deterministicObjectId } from "./deterministic-id";

test("deterministicObjectId returns a stable Mongo ObjectId", () => {
  const first = deterministicObjectId("focus-event", "user-1", "event-1");
  const second = deterministicObjectId("focus-event", "user-1", "event-1");

  assert.match(first, /^[a-f0-9]{24}$/);
  assert.equal(first, second);
});

test("deterministicObjectId is scoped by namespace and identity", () => {
  const base = deterministicObjectId("focus-event", "user-1", "event-1");
  assert.notEqual(base, deterministicObjectId("device", "user-1", "event-1"));
  assert.notEqual(base, deterministicObjectId("focus-event", "user-2", "event-1"));
  assert.notEqual(base, deterministicObjectId("focus-event", "user-1", "event-2"));
});
