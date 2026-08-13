import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { PrismaClient } from "@prisma/client";
import { startMongo, stopMongo, dbName, runId } from "./harness";

/**
 * The billing assertions that a stub cannot make.
 *
 * Everything in `npm test` runs without a database on purpose — `prisma` is
 * stubbed per method and an unstubbed call fails loudly. That is the right shape
 * for logic, and useless for the four questions below, all of which are about
 * what MongoDB itself does:
 *
 *   · does the unique index actually exist, and does it actually reject?
 *   · is the outbox claim atomic when two workers arrive together?
 *   · does a concurrent double-checkout reserve exactly one trial?
 *   · do the tombstones really survive the cascade they are supposed to outlive?
 *
 * Separate command (`npm run test:billing:mongo`) because it starts a real
 * replica set and costs seconds, not milliseconds.
 */

let prisma: PrismaClient;

before(async () => {
  const uri = await startMongo();
  prisma = new PrismaClient({ datasources: { db: { url: uri } } });
  await prisma.$connect();
  console.info(`[qa] disposable database ${dbName} (runId ${runId})`);
});

after(async () => {
  await prisma?.$disconnect();
  await stopMongo();
});

/* ── the indexes are real ────────────────────────────────────────────────── */

test("BillingTask (provider, externalId, kind) is genuinely unique", async () => {
  const row = { provider: "lemonsqueezy", externalId: `sub-${runId}-1`, kind: "cancel", reason: "qa", doneAt: null, lockedAt: null };
  await prisma.billingTask.create({ data: row });

  await assert.rejects(
    () => prisma.billingTask.create({ data: { ...row, reason: "qa duplicate" } }),
    (e: any) => e.code === "P2002",
    "a second outbox row for the same cancellation must be refused by the database, not merely avoided by our code",
  );
});

test("ConsumedOrder (provider, externalId) is genuinely unique", async () => {
  const row = { provider: "lemonsqueezy", externalId: `order-${runId}-1`, kind: "order" };
  await prisma.consumedOrder.create({ data: row });
  await assert.rejects(
    () => prisma.consumedOrder.create({ data: row }),
    (e: any) => e.code === "P2002",
    "the tombstone that stops a spent order being re-minted must be enforced by the index",
  );
});

test("TrialClaim.deviceIdHash is genuinely unique — one trial per machine", async () => {
  const hash = `hash-${runId}-A`;
  await prisma.trialClaim.create({
    data: { deviceIdHash: hash, endsAt: new Date(Date.now() + 3 * 86_400_000), trialDays: 3 },
  });
  await assert.rejects(
    () => prisma.trialClaim.create({
      data: { deviceIdHash: hash, endsAt: new Date(Date.now() + 7 * 86_400_000), trialDays: 7 },
    }),
    (e: any) => e.code === "P2002",
    "the whole anti-farm design rests on this index existing",
  );
});

/* ── the outbox claim is atomic ──────────────────────────────────────────── */

/*
 * The unit tests prove the claim's LOGIC against an in-memory double. This
 * proves the thing the double cannot: that MongoDB's conditional update really
 * is atomic, so two cron runs starting in the same millisecond cannot both take
 * the same task and send the cancellation twice.
 */
test("two workers racing for the same task: exactly one wins", async () => {
  const task = await prisma.billingTask.create({
    data: { provider: "lemonsqueezy", externalId: `sub-${runId}-race`, kind: "cancel", reason: "qa", doneAt: null, lockedAt: null },
  });

  const claim = () =>
    prisma.billingTask.updateMany({
      where: {
        id: task.id,
        AND: [
          { OR: [{ doneAt: null }, { doneAt: { isSet: false } }] },
          { OR: [{ lockedAt: null }, { lockedAt: { isSet: false } }, { lockedAt: { lt: new Date(Date.now() - 300_000) } }] },
        ],
      },
      data: { lockedAt: new Date() },
    });

  const results = await Promise.all([claim(), claim(), claim(), claim(), claim()]);
  const winners = results.filter((r) => r.count === 1).length;

  assert.equal(winners, 1, `exactly one worker may claim a task (got ${winners})`);
});

test("a lock older than the TTL can be re-claimed, so a dead worker strands nothing", async () => {
  const task = await prisma.billingTask.create({
    data: {
      provider: "lemonsqueezy",
      externalId: `sub-${runId}-stale`,
      kind: "cancel",
      reason: "qa",
      doneAt: null,
      lockedAt: new Date(Date.now() - 60 * 60_000),
    },
  });

  const { count } = await prisma.billingTask.updateMany({
    where: {
      id: task.id,
      AND: [
        { OR: [{ doneAt: null }, { doneAt: { isSet: false } }] },
        { OR: [{ lockedAt: null }, { lockedAt: { isSet: false } }, { lockedAt: { lt: new Date(Date.now() - 300_000) } }] },
      ],
    },
    data: { lockedAt: new Date() },
  });

  assert.equal(count, 1, "an abandoned lock must not be honoured for ever");
});

/* ── the cascade, for real ───────────────────────────────────────────────── */

/*
 * `BillingTask` has NO relation to User, which is what is supposed to make it
 * survive an account deletion. That is a schema claim, and this is the only
 * place it can actually be checked.
 */
test("deleting a user cascades its subscriptions but NOT the cancellations it still owes", async () => {
  const user = await prisma.user.create({
    data: { email: `qa-${runId}@example.test`, plan: "trial" },
  });
  await prisma.subscription.create({
    data: {
      userId: user.id,
      provider: "lemonsqueezy",
      externalId: `sub-${runId}-cascade`,
      variantId: "1986433",
      status: "active",
    },
  });
  await prisma.billingTask.create({
    data: { provider: "lemonsqueezy", externalId: `sub-${runId}-cascade`, kind: "cancel", reason: "account-deleted", doneAt: null, lockedAt: null },
  });

  await prisma.user.delete({ where: { id: user.id } });

  assert.equal(
    await prisma.subscription.count({ where: { externalId: `sub-${runId}-cascade` } }),
    0,
    "the subscription row goes with the account",
  );
  assert.equal(
    await prisma.billingTask.count({
      where: { externalId: `sub-${runId}-cascade`, OR: [{ doneAt: null }, { doneAt: { isSet: false } }] },
    }),
    1,
    "but the cancellation we owe Lemon Squeezy must outlive it — otherwise the card keeps being charged",
  );
});

test("a TrialClaim is unlinked, never deleted, when its first owner goes", async () => {
  const user = await prisma.user.create({ data: { email: `qa-${runId}-b@example.test`, plan: "trial" } });
  await prisma.trialClaim.create({
    data: {
      deviceIdHash: `hash-${runId}-B`,
      firstUserId: user.id,
      endsAt: new Date(Date.now() + 3 * 86_400_000),
      trialDays: 3,
    },
  });

  await prisma.trialClaim.updateMany({ where: { firstUserId: user.id }, data: { firstUserId: null } });
  await prisma.user.delete({ where: { id: user.id } });

  const claim = await prisma.trialClaim.findUnique({ where: { deviceIdHash: `hash-${runId}-B` } });
  assert.ok(claim, "deleting an account must not be the trial reset button");
  assert.equal(claim?.firstUserId, null, "but the link to the person who asked to be forgotten must go");
});

/**
 * The 202 promise is two writes, and a real transaction is the only thing that
 * makes them one.
 *
 * A stub cannot make this assertion: it can prove the code CALLS `$transaction`,
 * but not that MongoDB rolls the first write back when the second one fails. So
 * this one drives a genuine replica set and kills the transaction in the middle,
 * then checks the halves that a partial commit would have left behind — a task
 * nobody revoked for, or a revoked customer nothing would ever cancel.
 */
test("a transaction that fails halfway leaves neither half behind", async () => {
  const user = await prisma.user.create({
    data: { email: `qa-${runId}-tx@example.test`, plan: "trial" },
  });
  const trialEndsAt = new Date(Date.now() + 3 * 86_400_000);
  const sub = await prisma.subscription.create({
    data: {
      userId: user.id,
      provider: "lemonsqueezy",
      externalId: `sub-${runId}-tx`,
      variantId: "1986433",
      status: "on_trial",
      trialEndsAt,
    },
  });

  const boom = new Error("deliberate failure after the first write");
  await assert.rejects(
    prisma.$transaction(async (tx) => {
      await tx.billingTask.create({
        data: {
          provider: "lemonsqueezy",
          externalId: sub.externalId,
          kind: "cancel",
          reason: "admin-cancel",
        },
      });
      await tx.subscription.updateMany({
        where: { id: sub.id },
        data: { trialCancelledAt: new Date() },
      });
      throw boom; // both writes are staged; neither may survive
    }),
    /deliberate failure/,
  );

  assert.equal(
    await prisma.billingTask.count({
      where: { provider: "lemonsqueezy", externalId: sub.externalId, kind: "cancel" },
    }),
    0,
    "the rolled-back transaction must owe nothing",
  );
  const after = await prisma.subscription.findUnique({ where: { id: sub.id } });
  assert.equal(after!.trialCancelledAt, null, "and must have revoked nothing");

  // The same two writes, allowed to commit — then replayed.
  const commit = async () =>
    prisma.$transaction(async (tx) => {
      const existing = await tx.billingTask.findUnique({
        where: {
          provider_externalId_kind: {
            provider: "lemonsqueezy",
            externalId: sub.externalId,
            kind: "cancel",
          },
        },
      });
      if (!existing) {
        await tx.billingTask.create({
          data: {
            provider: "lemonsqueezy",
            externalId: sub.externalId,
            kind: "cancel",
            reason: "admin-cancel",
          },
        });
      }
      await tx.subscription.updateMany({
        where: {
          id: sub.id,
          OR: [{ trialCancelledAt: null }, { trialCancelledAt: { isSet: false } }],
        },
        data: { trialCancelledAt: new Date() },
      });
    });

  await commit();
  const first = await prisma.subscription.findUnique({ where: { id: sub.id } });
  assert.ok(first!.trialCancelledAt, "the committed transaction revokes");

  await commit(); // the retry an operator's second click produces
  assert.equal(
    await prisma.billingTask.count({
      where: { provider: "lemonsqueezy", externalId: sub.externalId, kind: "cancel" },
    }),
    1,
    "a retry owes the cancellation once, not twice",
  );
  const second = await prisma.subscription.findUnique({ where: { id: sub.id } });
  assert.equal(
    second!.trialCancelledAt!.getTime(),
    first!.trialCancelledAt!.getTime(),
    "and must not move the first revocation's timestamp",
  );
});
