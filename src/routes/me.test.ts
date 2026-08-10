import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import request from "supertest";
import { createApp } from "../app";
import { prisma } from "../lib/prisma";
import { env } from "../lib/env";
import { signToken } from "../lib/jwt";

/**
 * DELETE /api/me, and the one thing it used to get catastrophically wrong.
 *
 * It removed the account and let the Subscription rows cascade away without ever
 * telling Lemon Squeezy to stop — so the card kept being charged for an account
 * that no longer existed, and the row that would have explained it was gone too.
 * What is pinned here is that the cancellation is RECORDED BEFORE anything is
 * destroyed, and that nothing about the deletion can lose it.
 */

const app = createApp();
const USER = "507f1f77bcf86cd799439011";

function stub(t: TestContext, target: Record<string, any>, name: string, impl: (...a: any[]) => any) {
  const original = target[name];
  const calls: any[][] = [];
  target[name] = (...args: any[]) => {
    calls.push(args);
    return impl(...args);
  };
  t.after(() => {
    target[name] = original;
  });
  return calls;
}

/**
 * Everything the delete path touches, at the "nothing exists, every write
 * succeeds" baseline. `order` records the sequence of the two operations whose
 * relative order is the actual guarantee.
 */
function stubDelete(
  t: TestContext,
  subs: { provider: string; externalId: string; status: string }[],
) {
  const order: string[] = [];
  const noop = async () => ({ count: 0 });

  for (const model of [
    "focusEvent", "device", "liveSession", "authProvider", "syncSnapshot", "vote",
    "pushToken", "notificationDelivery", "emailVerification", "passwordReset",
    "featureRequest", "break",
  ]) {
    stub(t, (prisma as any)[model], "deleteMany", noop);
  }
  stub(t, prisma.trialClaim as any, "updateMany", noop);
  stub(t, prisma.purchase as any, "findMany", async () => []);
  stub(t, prisma.subscription as any, "findMany", async () => subs);
  stub(t, prisma.consumedOrder as any, "upsert", async () => ({}));

  // The outbox, at the level billing-tasks.ts actually uses it.
  const enqueued: any[] = [];
  stub(t, prisma.billingTask as any, "findUnique", async () => null);
  stub(t, prisma.billingTask as any, "create", async (a: any) => {
    order.push(`enqueue:${a.data.externalId}`);
    enqueued.push(a.data);
    return a.data;
  });
  stub(t, prisma.billingTask as any, "updateMany", async () => ({ count: 1 }));
  stub(t, prisma.billingTask as any, "update", async () => ({}));

  const deleted = stub(t, prisma.user as any, "delete", async () => {
    order.push("delete-account");
    return {};
  });

  // What requireAuth / requireVerifiedAccount actually select (middleware/auth.ts).
  stub(t, prisma.user as any, "findUnique", async () => ({
    id: USER,
    email: "user@example.com",
    emailVerified: true,
    passwordChangedAt: null,
  }));

  return { order, enqueued, deleted };
}

function auth() {
  return { authorization: `Bearer ${signToken({ sub: USER, email: "user@example.com" })}` };
}

function withKey(t: TestContext) {
  const before = env.lemonSqueezyApiKey;
  (env as any).lemonSqueezyApiKey = "test-key";
  t.after(() => {
    (env as any).lemonSqueezyApiKey = before;
  });
}

function stubFetch(t: TestContext, impl: (...a: any[]) => any) {
  const original = globalThis.fetch;
  (globalThis as any).fetch = impl;
  t.after(() => {
    (globalThis as any).fetch = original;
  });
}

/*
 * THE ORDER IS THE GUARANTEE. Once the user row goes, the Subscription rows go
 * with it and there is nothing left to read the Lemon Squeezy id from — so an
 * instruction written afterwards could never be written at all.
 */
test("a live subscription is queued for cancellation BEFORE the account is destroyed", async (t) => {
  withKey(t);
  const db = stubDelete(t, [{ provider: "lemonsqueezy", externalId: "sub-1", status: "active" }]);
  stubFetch(t, async () => ({ ok: true, status: 200 }));

  const res = await request(app).delete("/api/me").set(auth());

  assert.equal(res.status, 204);
  assert.deepEqual(db.order, ["enqueue:sub-1", "delete-account"]);
  assert.equal(db.enqueued[0].reason, "account-deleted");
});

test("the queued task carries the provider reference and no personal data", async (t) => {
  withKey(t);
  const db = stubDelete(t, [{ provider: "lemonsqueezy", externalId: "sub-1", status: "on_trial" }]);
  stubFetch(t, async () => ({ ok: true, status: 200 }));

  await request(app).delete("/api/me").set(auth());

  const task = db.enqueued[0];
  assert.equal(task.externalId, "sub-1", "enough to call DELETE /v1/subscriptions/:id");
  assert.equal(task.provider, "lemonsqueezy");
  // The person asked to be forgotten. Carrying their identity into a row that
  // deliberately OUTLIVES the account would defeat the point of deleting it.
  assert.ok(!("userId" in task), "no user id");
  assert.ok(!("email" in task), "no email");
});

/*
 * Every status that can still result in a charge must be queued. `cancelled` and
 * `expired` cannot: Lemon Squeezy takes no further payment on either, so asking
 * it to cancel them again is a wasted call.
 */
test("statuses that can still bill are all queued; the two that cannot are not", async (t) => {
  withKey(t);
  const db = stubDelete(t, [
    { provider: "lemonsqueezy", externalId: "s-active", status: "active" },
    { provider: "lemonsqueezy", externalId: "s-trial", status: "on_trial" },
    { provider: "lemonsqueezy", externalId: "s-paused", status: "paused" },
    { provider: "lemonsqueezy", externalId: "s-pastdue", status: "past_due" },
    { provider: "lemonsqueezy", externalId: "s-cancelled", status: "cancelled" },
    { provider: "lemonsqueezy", externalId: "s-expired", status: "expired" },
  ]);
  stubFetch(t, async () => ({ ok: true, status: 200 }));

  await request(app).delete("/api/me").set(auth());

  const ids = db.enqueued.map((e) => e.externalId).sort();
  assert.deepEqual(ids, ["s-active", "s-pastdue", "s-paused", "s-trial"]);
});

/*
 * Deleting an account is a compliance obligation. It may not be held hostage by
 * a payment provider being down — the whole reason the instruction is written to
 * the outbox first is so the deletion can proceed without it.
 */
test("Lemon Squeezy being unreachable does not stop the account being deleted", async (t) => {
  withKey(t);
  const db = stubDelete(t, [{ provider: "lemonsqueezy", externalId: "sub-1", status: "active" }]);
  stubFetch(t, async () => {
    throw new Error("ECONNREFUSED");
  });

  const res = await request(app).delete("/api/me").set(auth());

  assert.equal(res.status, 204, "the person asked to be forgotten; that still happens");
  assert.equal(db.enqueued.length, 1, "and the cancellation is still owed, not lost");
  assert.equal(db.deleted.length, 1);
});

test("an account with no subscription queues nothing", async (t) => {
  const db = stubDelete(t, []);

  const res = await request(app).delete("/api/me").set(auth());

  assert.equal(res.status, 204);
  assert.equal(db.enqueued.length, 0);
});

/*
 * The last line of defence. We are one statement away from deleting the only
 * record of a live subscription — so if the instruction could not be written
 * down, stopping is the lesser harm. The customer retries and is deleted a
 * moment later; continuing would orphan a live charge with nothing anywhere
 * pointing at it. Deletion is DEFERRED here, never refused.
 */
test("if the cancellation cannot be recorded, the account is not destroyed", async (t) => {
  withKey(t);
  const db = stubDelete(t, [{ provider: "lemonsqueezy", externalId: "sub-1", status: "active" }]);
  const realError = console.error;
  console.error = () => {};
  t.after(() => {
    console.error = realError;
  });
  // The outbox write fails outright.
  stub(t, prisma.billingTask as any, "create", async () => {
    throw new Error("mongo is down");
  });

  const res = await request(app).delete("/api/me").set(auth());

  assert.equal(res.status, 500, "so the client retries rather than losing the subscription");
  assert.equal(db.deleted.length, 0, "and the account is still there to try again with");
});
