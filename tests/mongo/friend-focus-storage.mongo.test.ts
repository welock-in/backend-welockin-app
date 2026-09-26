import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { PrismaClient } from "@prisma/client";
import { startMongo, stopMongo } from "./harness";
import { apply, inspect, indexes } from "../../scripts/friend-focus-events-migrate";

let db: PrismaClient;
before(async () => {
  const uri = await startMongo();
  assert.match(uri, /^mongodb:\/\/127\.0\.0\.1:/);
  db = new PrismaClient();
  // Start from the real pre-feature state in this isolated, disposable database.
  await db.$runCommandRaw({ drop: "FriendFocusEvent" });
});
after(async () => { await db?.$disconnect(); await stopMongo(); });

test("inspection is read-only and targeted migration provisions a new collection idempotently", async () => {
  assert.equal((await inspect(db)).exists, false);
  assert.equal((await inspect(db)).exists, false);
  const first = await apply(db);
  assert.equal(first.before.exists, false);
  assert.equal(first.after.documentCount, 0);
  assert.equal(first.after.indexes.find(i => i.name.endsWith("expiresAt_idx"))?.expireAfterSeconds, 0);
  assert.equal(first.after.indexes.find(i => i.name.endsWith("requestKey_key"))?.unique, true);
  assert.equal(first.after.indexes.length, 5);
  assert.deepEqual((await apply(db)).after.indexes, first.after.indexes);
});

test("an incompatible existing index fails without dropping or changing it", async () => {
  const name = "FriendFocusEvent_expiresAt_idx";
  await db.$runCommandRaw({ dropIndexes: "FriendFocusEvent", index: name });
  await db.$runCommandRaw({ createIndexes: "FriendFocusEvent", indexes: [{ key: { expiresAt: 1 }, name }] });
  await assert.rejects(() => apply(db));
  assert.equal((await inspect(db)).indexes.find(i => i.name === name)?.expireAfterSeconds, null);
  await db.$runCommandRaw({ dropIndexes: "FriendFocusEvent", index: name });
  await db.$runCommandRaw({ createIndexes: "FriendFocusEvent", indexes });
});
