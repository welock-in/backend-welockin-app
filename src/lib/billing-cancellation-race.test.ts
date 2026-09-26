import assert from "node:assert/strict";
import { test } from "node:test";
import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { queueCancelAndRevokeTrial } from "./billing-tasks";

const conflict = () => new Prisma.PrismaClientKnownRequestError("Write conflict", { code: "P2034", clientVersion: "test" });
const input = { externalId: "fixture", subscriptionId: "fixture-sub", reason: "test" };

test("cancellation retry leaves time for the competing transaction to commit", async (t) => {
  let winnerCommitted = false;
  let calls = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  t.after(() => { if (timer) clearTimeout(timer); });
  t.mock.method(prisma, "$transaction", async () => {
    calls++;
    if (calls === 1) timer = setTimeout(() => { winnerCommitted = true; }, 80);
    if (!winnerCommitted) throw conflict();
  });
  await queueCancelAndRevokeTrial(input);
  assert.ok(winnerCommitted);
  assert.ok(calls > 1 && calls <= 5);
});

test("persistent transaction contention remains bounded and propagates failure", async (t) => {
  let calls = 0;
  t.mock.method(prisma, "$transaction", async () => { calls++; throw conflict(); });
  await assert.rejects(() => queueCancelAndRevokeTrial(input), { code: "P2034" });
  assert.equal(calls, 5);
});

test("a non-race database failure is never retried", async (t) => {
  let calls = 0;
  t.mock.method(prisma, "$transaction", async () => { calls++; throw new Error("storage unavailable"); });
  await assert.rejects(() => queueCancelAndRevokeTrial(input), /storage unavailable/);
  assert.equal(calls, 1);
});
