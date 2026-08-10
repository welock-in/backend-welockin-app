import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import request from "supertest";
import { Prisma } from "@prisma/client";
import { createApp } from "../app";
import { prisma } from "../lib/prisma";
import { env } from "../lib/env";
import { parseOrderEvent, parseSubscriptionEvent } from "../lib/lemonsqueezy";
import { subscriptionGrants } from "../lib/subscription";
import { REAL_ORDER_CREATED, REAL_ORDER_REFUNDED, REAL_USER_ID } from "./lemonsqueezy-fixtures";

/*
 * The order webhook is the only endpoint in this backend that turns money into
 * access, and every one of its branches is a way to lose a sale silently. These
 * tests exist to pin the two things that are invisible in production until a
 * customer complains: WHICH deliveries are refused, and WHETHER a refusal is
 * permanent.
 */

const app = createApp();
const SECRET = "whsec-test-secret";
const STORE = "364783";
const VARIANT = "1960881";
const USER = "507f1f77bcf86cd799439011";

type Ctx = { after: (fn: () => void) => void };

function stubMethod(
  t: Ctx,
  target: Record<string, any>,
  name: string,
  implementation: (...args: any[]) => any,
) {
  const original = target[name];
  const calls: any[][] = [];
  target[name] = (...args: any[]) => {
    calls.push(args);
    return implementation(...args);
  };
  t.after(() => {
    target[name] = original;
  });
  return calls;
}

function setEnv(t: Ctx, patch: Record<string, unknown>) {
  const before: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    before[k] = (env as any)[k];
    (env as any)[k] = v;
  }
  t.after(() => {
    for (const [k, v] of Object.entries(before)) (env as any)[k] = v;
  });
}

/** A store that is configured and live (test-mode orders refused). */
function configured(t: Ctx, extra: Record<string, unknown> = {}) {
  setEnv(t, {
    lemonSqueezyWebhookSecret: SECRET,
    lemonSqueezyStoreId: STORE,
    lemonSqueezyVariantId: VARIANT,
    lemonSqueezyVariantMonthly: "1986433",
    lemonSqueezyVariantYearly: "1986420",
    lemonSqueezyAllowTestMode: false,
    ...extra,
  });
}

/**
 * Every Prisma call the route can make, stubbed to the "nothing exists yet, every
 * write succeeds" baseline. Tests override only the call they are about.
 * Returns the recorded calls so assertions can read what was written.
 */
function stubDb(t: Ctx, overrides: Record<string, (...args: any[]) => any> = {}) {
  const pick = (name: string, fallback: (...args: any[]) => any) =>
    overrides[name] ?? fallback;

  return {
    eventCreate: stubMethod(t, prisma.webhookEvent as any, "create", pick("eventCreate", async () => ({}))),
    eventFind: stubMethod(t, prisma.webhookEvent as any, "findUnique", pick("eventFind", async () => null)),
    eventUpdate: stubMethod(t, prisma.webhookEvent as any, "update", pick("eventUpdate", async () => ({}))),
    // markEvent writes through updateMany (its WHERE carries the terminal-status
    // guard); the claim path's re-mark still uses plain update above.
    eventMark: stubMethod(t, prisma.webhookEvent as any, "updateMany", pick("eventMark", async () => ({ count: 1 }))),
    // The subscription write path: conditional updateMany, then create when no
    // row matched. Baseline mirrors "nothing exists yet": count 0, create lands.
    subWrite: stubMethod(t, prisma.subscription as any, "updateMany", pick("subWrite", async () => ({ count: 0 }))),
    subFind: stubMethod(t, prisma.subscription as any, "findUnique", pick("subFind", async () => null)),
    // A lifetime purchase cancels the buyer's live subscription
    // (cancelSubscriptionsForLifetimeBuyer). Baseline: none to cancel.
    subFindMany: stubMethod(t, prisma.subscription as any, "findMany", pick("subFindMany", async () => [])),
    subCreate: stubMethod(t, prisma.subscription as any, "create", pick("subCreate", async () => ({}))),
    purchaseUpsert: stubMethod(t, prisma.purchase as any, "upsert", pick("purchaseUpsert", async () => ({}))),
    purchaseFind: stubMethod(t, prisma.purchase as any, "findUnique", pick("purchaseFind", async () => null)),
    purchaseUpdate: stubMethod(t, prisma.purchase as any, "update", pick("purchaseUpdate", async () => ({}))),
    purchaseCreate: stubMethod(t, prisma.purchase as any, "create", pick("purchaseCreate", async () => ({}))),
    // The consumed-order tombstone (recordPaidOrder / mirrorSubscriptionState):
    // baseline = "never consumed before", so the grant proceeds and the upsert
    // is a no-op recorder. A test that wants the re-mint-refused path overrides
    // consumedFind to return a row.
    consumedFind: stubMethod(t, prisma.consumedOrder as any, "findUnique", pick("consumedFind", async () => null)),
    consumedUpsert: stubMethod(t, prisma.consumedOrder as any, "upsert", pick("consumedUpsert", async () => ({}))),
    userFind: stubMethod(t, prisma.user as any, "findUnique", pick("userFind", async () => ({ id: USER }))),
    userFirst: stubMethod(t, prisma.user as any, "findFirst", pick("userFirst", async () => null)),
  };
}

function orderBody(over: Record<string, any> = {}) {
  const { meta: metaOver, attributes: attrOver, ...rest } = over;
  return {
    meta: {
      event_name: "order_created",
      custom_data: { user_id: USER },
      ...metaOver,
    },
    data: {
      id: "9001",
      attributes: {
        user_email: "buyer@example.com",
        status: "paid",
        refunded: false,
        refunded_at: null,
        total_usd: 1999,
        created_at: "2026-07-30T10:00:00.000Z",
        test_mode: false,
        store_id: Number(STORE),
        first_order_item: { product_id: 1, variant_id: Number(VARIANT) },
        ...attrOver,
      },
    },
    ...rest,
  };
}

/** Post a body signed with `secret`, byte-for-byte as it was signed. */
function deliver(body: unknown, signature?: string, secret = SECRET) {
  const raw = JSON.stringify(body);
  const sig = signature ?? createHmac("sha256", secret).update(raw).digest("hex");
  return request(app)
    .post("/api/webhooks/lemonsqueezy")
    .set("Content-Type", "application/json")
    .set("X-Signature", sig)
    .send(raw);
}

/** What markEvent() finally recorded for this delivery. */
function finalStatus(eventUpdate: any[][]): string | undefined {
  const marks = eventUpdate.filter((c) => typeof c[0]?.data?.status === "string" && "processedAt" in c[0].data);
  return marks.at(-1)?.[0]?.data?.status;
}

/* ── The signature is the whole perimeter ─────────────────────────────── */

test("an unsigned delivery is refused before the body is looked at", async (t) => {
  configured(t);
  const db = stubDb(t);

  const res = await request(app)
    .post("/api/webhooks/lemonsqueezy")
    .set("Content-Type", "application/json")
    .send(JSON.stringify(orderBody()));

  assert.equal(res.status, 401);
  assert.equal(res.body.error.code, "INVALID_SIGNATURE");
  assert.equal(db.eventCreate.length, 0, "nothing may be claimed before the HMAC checks out");
  assert.equal(db.purchaseUpsert.length, 0);
});

test("a signature from the wrong secret is refused", async (t) => {
  configured(t);
  stubDb(t);
  const res = await deliver(orderBody(), undefined, "not-the-secret");
  assert.equal(res.status, 401);
});

/*
 * The official Lemon Squeezy sample feeds the header straight into
 * timingSafeEqual, which THROWS a RangeError on a length mismatch. Here that
 * throw would surface as a 500, and a 500 tells Lemon Squeezy to redeliver — so
 * any script spraying junk signatures would generate an infinite retry storm.
 * A malformed signature must be a clean, cheap 401.
 */
test("a malformed signature is a clean 401, never a 500", async (t) => {
  configured(t);
  stubDb(t);

  for (const bogus of ["", "zz", "abc", "f".repeat(63), "f".repeat(65), "zz".repeat(32)]) {
    const res = await deliver(orderBody(), bogus);
    assert.equal(res.status, 401, `signature ${JSON.stringify(bogus)} must be rejected cleanly`);
  }
});

test("an unconfigured webhook secret refuses every delivery instead of accepting every delivery", async (t) => {
  configured(t, { lemonSqueezyWebhookSecret: "" });
  stubDb(t);
  const res = await deliver(orderBody(), "f".repeat(64));
  assert.equal(res.status, 401);
});

/* ── A signature is not an entitlement ────────────────────────────────── */

test("a paid order for our variant grants the licence to the account the checkout named", async (t) => {
  configured(t);
  const db = stubDb(t);

  const res = await deliver(orderBody());

  assert.equal(res.status, 200);
  assert.equal(db.purchaseUpsert.length, 1);
  const arg = db.purchaseUpsert[0][0];
  assert.equal(arg.where.provider_externalId.externalId, "9001");
  assert.equal(arg.create.userId, USER);
  assert.equal(arg.create.priceUsd, 19.99, "total_usd is cents");
  assert.equal(arg.create.isRefunded, false);
  // A replayed order_created must not resurrect a refunded licence.
  assert.ok(!("isRefunded" in arg.update));
  assert.equal(finalStatus(db.eventMark), "processed");
  // First grant records the consumed-order tombstone so it can never mint twice.
  assert.equal(db.consumedUpsert.length, 1);
  assert.equal(db.consumedUpsert[0][0].create.externalId, "9001");
});

/*
 * Buying lifetime while paying monthly must STOP the monthly billing — otherwise
 * the customer pays every month on top of a licence they now own for ever. The
 * webhook cancels the live subscription at Lemon Squeezy (DELETE), server-side,
 * so it happens even if the app never reopens.
 */
test("a lifetime purchase cancels the buyer's live subscription", async (t) => {
  // The API key is what lets the cancel call go out (the webhook itself needs
  // only the signing secret).
  configured(t, { lemonSqueezyApiKey: "test-key" });
  const db = stubDb(t, {
    subFindMany: async () => [
      { externalId: "sub-77001", status: "active", validUntil: new Date(Date.now() + 20 * 86_400_000) },
    ],
  });
  let cancelled = "";
  let method = "";
  const originalFetch = globalThis.fetch;
  (globalThis as any).fetch = async (u: string, i: any) => {
    method = i?.method ?? "GET";
    cancelled = String(u);
    return { ok: true, status: 200, json: async () => ({}) };
  };
  t.after(() => {
    (globalThis as any).fetch = originalFetch;
  });

  const res = await deliver(orderBody());

  assert.equal(res.status, 200);
  assert.equal(db.purchaseUpsert.length, 1, "the lifetime licence is still recorded");
  assert.equal(method, "DELETE");
  assert.ok(cancelled.endsWith("/v1/subscriptions/sub-77001"), cancelled);
});

/*
 * The recycled-email re-mint the audit found (2026-08-08): a buyer deletes their
 * account (Purchase cascades away), the email is freed, and a webhook redelivery
 * — or the /confirm path — would otherwise mint the licence again for whoever
 * now holds the email. The ConsumedOrder tombstone survives the deletion, so a
 * grant with no live Purchase for a spent order is refused, terminally.
 */
test("a spent order is never re-minted after its account was deleted", async (t) => {
  configured(t);
  const db = stubDb(t, {
    // The purchase row is gone (account deleted)…
    purchaseFind: async () => null,
    // …but the consumption tombstone remains.
    consumedFind: async () => ({ id: "consumed-9001" }),
  });

  const res = await deliver(orderBody());

  assert.equal(res.status, 200, "still 200 — Lemon Squeezy must not retry forever");
  assert.equal(db.purchaseUpsert.length, 0, "no new grant is written");
  assert.equal(finalStatus(db.eventMark), "skipped");
});

/*
 * `custom_data` is echoed back by someone else's server and is untyped by
 * contract, so it can hold anything. A non-string value must degrade to the email
 * fallback, not throw: a throw here is a 500, and a 500 asks Lemon Squeezy to
 * redeliver the same unparseable thing forever.
 */
test("a custom_data.user_id that is not a string degrades to the email match", async (t) => {
  configured(t);
  const db = stubDb(t, { userFirst: async () => ({ id: USER }) });

  for (const bogus of [507, null, { id: USER }, [USER], true]) {
    const res = await deliver(orderBody({ meta: { custom_data: { user_id: bogus } } }));
    assert.equal(res.status, 200, `custom user_id ${JSON.stringify(bogus)} must not throw`);
  }
  assert.equal(db.userFind.length, 0, "nothing that is not an ObjectId may reach Prisma");
  assert.equal(db.purchaseUpsert.length, 5, "and the order is still granted, via email");
});

/*
 * Variant mismatches split two ways, and the split IS the point. A subscription
 * checkout fires order_created too — one per monthly/yearly signup, for ever —
 * and those are terminally skipped (the grant comes from subscription_* events).
 * Any OTHER variant is far more likely OUR stale config than a foreign product,
 * and the customer has already paid — so it stays claimable for a dashboard
 * resend after the env is fixed.
 */
test("a subscription's own order_created is skipped; an unknown variant stays claimable", async (t) => {
  configured(t);
  const db = stubDb(t);

  const monthly = await deliver(
    orderBody({ attributes: { first_order_item: { variant_id: 1986433 } } }),
  );
  assert.equal(monthly.status, 200);
  assert.equal(finalStatus(db.eventMark), "skipped", "expected noise, never a to-do");

  const unknown = await deliver(
    orderBody({ attributes: { first_order_item: { variant_id: 999999 } } }),
  );
  assert.equal(unknown.status, 200);
  assert.equal(finalStatus(db.eventMark), "failed", "a paid order behind a stale env must stay claimable");
  assert.equal(db.purchaseUpsert.length, 0, "neither grants anything");
});

test("an order from another store is refused permanently", async (t) => {
  configured(t);
  const db = stubDb(t);

  const res = await deliver(orderBody({ attributes: { store_id: 111111 } }));

  assert.equal(res.status, 200);
  assert.equal(db.purchaseUpsert.length, 0);
  assert.equal(finalStatus(db.eventMark), "skipped");
});

/*
 * The difference this test defends is worth a paragraph. `skipped` is terminal:
 * a later redelivery short-circuits on it and the work never runs again. That is
 * correct for an order that was never ours — and ruinous for one we simply were
 * not configured to recognise, because the customer has already been charged. Our
 * own misconfiguration must stay claimable so that fixing the config and hitting
 * "resend" in the dashboard still grants the licence.
 */
test("our own misconfiguration leaves a paid order claimable, not permanently dropped", async (t) => {
  configured(t, { lemonSqueezyVariantId: "" });
  const db = stubDb(t);

  const res = await deliver(orderBody());

  assert.equal(res.status, 200);
  assert.equal(db.purchaseUpsert.length, 0);
  assert.equal(finalStatus(db.eventMark), "failed", "must NOT be the terminal 'skipped'");
});

test("a test-mode order does not mint a real licence on a live backend", async (t) => {
  configured(t);
  const db = stubDb(t);

  const res = await deliver(orderBody({ attributes: { test_mode: true } }));

  assert.equal(res.status, 200);
  assert.equal(db.purchaseUpsert.length, 0);
  assert.equal(finalStatus(db.eventMark), "skipped");
});

test("meta.test_mode alone is enough to refuse a test order", async (t) => {
  configured(t);
  const db = stubDb(t);

  await deliver(orderBody({ meta: { test_mode: true, custom_data: { user_id: USER } } }));

  assert.equal(db.purchaseUpsert.length, 0);
});

test("a test-mode order IS honoured once the backend opts in explicitly", async (t) => {
  configured(t, { lemonSqueezyAllowTestMode: true });
  const db = stubDb(t);

  await deliver(orderBody({ attributes: { test_mode: true } }));

  assert.equal(db.purchaseUpsert.length, 1);
});

test("an order that has not been paid grants nothing", async (t) => {
  configured(t);
  const db = stubDb(t);

  for (const status of ["pending", "failed", "void"]) {
    const res = await deliver(orderBody({ attributes: { status } }));
    assert.equal(res.status, 200);
  }
  assert.equal(db.purchaseUpsert.length, 0);
});

/* ── Money taken, no account to give it to ────────────────────────────── */

test("an order matching no account is parked as unfinished business, not swallowed", async (t) => {
  configured(t);
  const db = stubDb(t, { userFind: async () => null, userFirst: async () => null });

  const res = await deliver(orderBody());

  assert.equal(res.status, 200, "retrying will not conjure a user");
  assert.equal(db.purchaseUpsert.length, 0);
  assert.equal(finalStatus(db.eventMark), "failed", "queryable, because a human has to finish it");
});

test("an order with no custom user id falls back to the buyer's email", async (t) => {
  configured(t);
  const db = stubDb(t, { userFirst: async () => ({ id: USER }) });

  await deliver(orderBody({ meta: { custom_data: {} } }));

  assert.equal(db.userFind.length, 0, "no id to look up");
  assert.equal(db.userFirst[0][0].where.email.equals, "buyer@example.com");
  assert.equal(db.purchaseUpsert[0][0].create.userId, USER);
});

test("a custom user id that is not an ObjectId never reaches Prisma", async (t) => {
  configured(t);
  // P2023 on MongoDB, not null — an odd payload would become a thrown request.
  const db = stubDb(t, { userFirst: async () => ({ id: USER }) });

  await deliver(orderBody({ meta: { custom_data: { user_id: "'; drop--" } } }));

  assert.equal(db.userFind.length, 0);
});

/* ── Refunds ─────────────────────────────────────────────────────────── */

test("a refund revokes the licence on the order we already recorded", async (t) => {
  configured(t);
  const db = stubDb(t, { purchaseFind: async () => ({ id: "purchase-1" }) });

  const res = await deliver(
    orderBody({
      meta: { event_name: "order_refunded", custom_data: { user_id: USER } },
      attributes: { refunded: true, refunded_at: "2026-07-31T09:00:00.000Z", status: "refunded" },
    }),
  );

  assert.equal(res.status, 200);
  assert.equal(db.purchaseUpdate[0][0].data.isRefunded, true);
  assert.equal(finalStatus(db.eventMark), "processed");
});

/*
 * A refund arriving for an order whose creation we never saw — a delivery lost
 * while the endpoint was down. Recording it refunded anyway is what stops the
 * later (or replayed) creation from granting what has already been given back.
 */
test("a refund for an order we never saw created is still recorded", async (t) => {
  configured(t);
  const db = stubDb(t, { purchaseFind: async () => null });

  await deliver(
    orderBody({
      meta: { event_name: "order_refunded", custom_data: { user_id: USER } },
      attributes: { refunded: true, status: "refunded" },
    }),
  );

  assert.equal(db.purchaseCreate.length, 1);
  assert.equal(db.purchaseCreate[0][0].data.isRefunded, true);
});

/*
 * Revoking is deliberately NOT gated on the test-mode opt-in. Handing out a
 * licence nobody paid for is the risk the guard exists for; taking one away has
 * no such downside, and guarding it would freeze a test order as "paid" forever
 * once the door closed.
 */
test("a refund is honoured even in test mode on a live backend", async (t) => {
  configured(t);
  const db = stubDb(t, { purchaseFind: async () => ({ id: "purchase-1" }) });

  await deliver(
    orderBody({
      meta: { event_name: "order_refunded", custom_data: { user_id: USER } },
      attributes: { refunded: true, status: "refunded", test_mode: true },
    }),
  );

  assert.equal(db.purchaseUpdate.length, 1);
});

/* ── Idempotency: claim, work, then mark done ─────────────────────────── */

const duplicateKey = () =>
  new Prisma.PrismaClientKnownRequestError("duplicate", { code: "P2002", clientVersion: "5" });
const writeConflict = () =>
  new Prisma.PrismaClientKnownRequestError("conflict", { code: "P2034", clientVersion: "5" });

test("a redelivery of an event already finished does no work at all", async (t) => {
  configured(t);
  const db = stubDb(t, {
    eventCreate: async () => {
      throw duplicateKey();
    },
    eventFind: async () => ({ status: "processed" }),
  });

  const res = await deliver(orderBody());

  assert.equal(res.status, 200);
  assert.equal(res.body.deduped, true);
  assert.equal(db.purchaseUpsert.length, 0);
});

/*
 * The bug this pins cost a licence: an earlier draft treated the mere EXISTENCE
 * of the dedupe row as "already handled", so anything that died mid-flight — a
 * thrown write, a killed serverless instance — meant the retry was answered
 * "done" and the customer's purchase was lost silently and permanently.
 */
test("a redelivery of an event left unfinished re-runs the work", async (t) => {
  configured(t);
  for (const priorStatus of ["processing", "failed"]) {
    const db = stubDb(t, {
      eventCreate: async () => {
        throw duplicateKey();
      },
      eventFind: async () => ({ status: priorStatus }),
    });

    const res = await deliver(orderBody());

    assert.equal(res.status, 200);
    assert.equal(db.purchaseUpsert.length, 1, `a ${priorStatus} row still owes an outcome`);
  }
});

/*
 * P2034 means the write CONFLICTED and did not land — distinct from P2002, where
 * someone else genuinely got there first. Nothing was claimed, so the delivery
 * must be asked for again rather than swallowed.
 */
test("a write conflict on the claim asks to be redelivered", async (t) => {
  configured(t);
  const db = stubDb(t, {
    eventCreate: async () => {
      throw writeConflict();
    },
  });

  const res = await deliver(orderBody());

  assert.equal(res.status, 503);
  assert.equal(db.purchaseUpsert.length, 0);
});

test("a failure while granting is left claimable and asks to be redelivered", async (t) => {
  configured(t);
  const db = stubDb(t, {
    purchaseUpsert: async () => {
      throw new Error("mongo is down");
    },
  });

  const res = await deliver(orderBody());

  assert.equal(res.status, 500, "a 500 is how we ask for the redelivery we need");
  assert.equal(finalStatus(db.eventMark), "failed", "non-terminal, so the retry re-runs the work");
});

/* ── Someone else's payload ───────────────────────────────────────────── */

test("an event we do not handle is acknowledged, not retried forever", async (t) => {
  configured(t);
  const db = stubDb(t);

  // Was `subscription_created` until subscriptions shipped. The property is
  // unchanged — an event we do not act on must be acknowledged rather than
  // redelivered for ever — so the example moved to one we genuinely ignore.
  const res = await deliver(orderBody({ meta: { event_name: "license_key_created", custom_data: {} } }));

  assert.equal(res.status, 200);
  assert.equal(db.purchaseUpsert.length, 0);
  assert.equal(finalStatus(db.eventMark), "skipped");
});

test("a signed delivery with no order id is acknowledged and dropped", async (t) => {
  configured(t);
  const db = stubDb(t);

  const res = await deliver({ meta: { event_name: "order_created" }, data: {} });

  assert.equal(res.status, 200);
  assert.equal(res.body.skipped, "unparsable");
  assert.equal(db.eventCreate.length, 0, "an order keyed on undefined would collapse every licence onto one row");
});

/*
 * Prisma throws on an Invalid Date, the throw becomes a 500, and a 500 is an
 * instruction to redeliver — so one malformed timestamp would turn a single order
 * into a retry loop that never converges and never grants anything.
 */
test("a malformed timestamp does not become a poison-pill retry loop", async (t) => {
  configured(t);
  const db = stubDb(t);

  const res = await deliver(orderBody({ attributes: { created_at: "not-a-date" } }));

  assert.equal(res.status, 200);
  assert.equal(db.purchaseUpsert.length, 1);
  const { purchasedAt } = db.purchaseUpsert[0][0].create;
  assert.ok(purchasedAt instanceof Date && !Number.isNaN(purchasedAt.getTime()));
});

test("a malformed refund timestamp still revokes the licence", async (t) => {
  configured(t);
  const db = stubDb(t, { purchaseFind: async () => ({ id: "purchase-1" }) });

  await deliver(
    orderBody({
      meta: { event_name: "order_refunded", custom_data: { user_id: USER } },
      attributes: { refunded: true, refunded_at: "", status: "refunded" },
    }),
  );

  const { isRefunded, refundedAt } = db.purchaseUpdate[0][0].data;
  assert.equal(isRefunded, true);
  assert.ok(refundedAt instanceof Date && !Number.isNaN(refundedAt.getTime()));
});

/* ── Partial refunds ─────────────────────────────────────────────────── */

/*
 * `order_refunded` fires for a PARTIAL refund too, and the two must not be
 * confused: a goodwill gesture of one euro on a twenty-euro order used to revoke
 * the licence of a customer who had paid in full and kept nineteen euros of it.
 * The branch had never run in production, so the bug was invisible.
 */
test("a PARTIAL refund keeps the licence", async (t) => {
  configured(t);
  const db = stubDb(t, { purchaseFind: async () => ({ id: "purchase-1" }) });

  const res = await deliver(
    orderBody({
      meta: { event_name: "order_refunded", custom_data: { user_id: USER } },
      attributes: {
        status: "partial_refund",
        refunded: true,
        refunded_at: "2026-07-31T09:00:00.000Z",
        total_usd: 1999,
        refunded_amount_usd: 100,
      },
    }),
  );

  assert.equal(res.status, 200);
  assert.equal(db.purchaseUpdate.length, 1, "the row is touched, to keep the payload");
  assert.equal(
    db.purchaseUpdate[0][0].data.isRefunded,
    undefined,
    "isRefunded must not be written at all on a partial refund",
  );
  assert.equal(finalStatus(db.eventMark), "processed");
});

/*
 * The amounts decide when the status does not. A refund equal to the total is a
 * full refund even if Lemon Squeezy labelled it something else.
 */
test("a refund of the whole amount revokes, whatever the status says", async (t) => {
  configured(t);
  const db = stubDb(t, { purchaseFind: async () => ({ id: "purchase-1" }) });

  await deliver(
    orderBody({
      meta: { event_name: "order_refunded", custom_data: { user_id: USER } },
      attributes: {
        status: "something-new",
        refunded: true,
        total_usd: 1999,
        refunded_amount_usd: 1999,
      },
    }),
  );

  assert.equal(db.purchaseUpdate[0][0].data.isRefunded, true);
});

/*
 * The uncomfortable default, pinned on purpose. A refund we cannot classify —
 * no status we know, no amounts — revokes. Shipping the product free to someone
 * who was refunded is never noticed; a wrongly-revoked customer writes in and
 * support restores them.
 */
test("an unclassifiable refund revokes rather than failing open", async (t) => {
  configured(t);
  const db = stubDb(t, { purchaseFind: async () => ({ id: "purchase-1" }) });

  await deliver(
    orderBody({
      meta: { event_name: "order_refunded", custom_data: { user_id: USER } },
      attributes: { status: "mystery", refunded: true, total_usd: undefined, refunded_amount_usd: undefined },
    }),
  );

  assert.equal(db.purchaseUpdate[0][0].data.isRefunded, true);
});


/* ── Subscriptions ───────────────────────────────────────────────────── */

function subBody(over: Record<string, any> = {}) {
  const { meta: metaOver, attributes: attrOver, ...rest } = over;
  return {
    meta: {
      event_name: "subscription_created",
      custom_data: { user_id: USER },
      ...metaOver,
    },
    data: {
      id: "77001",
      attributes: {
        user_email: "buyer@example.com",
        status: "on_trial",
        store_id: Number(STORE),
        // The configured MONTHLY variant. It used to be an arbitrary 5551, which
        // quietly made every subscription fixture a plan we do not sell — fine
        // while any variant granted, and misleading the moment that stopped
        // being true. Tests about unknown variants say so explicitly instead.
        variant_id: 1986433,
        trial_ends_at: "2026-08-11T10:00:00.000Z",
        renews_at: "2026-08-11T10:00:00.000Z",
        ends_at: null,
        updated_at: "2026-08-04T10:00:00.000Z",
        test_mode: false,
        urls: { update_payment_method: "https://x/pay", customer_portal: "https://x/portal" },
        ...attrOver,
      },
    },
    ...rest,
  };
}

test("a subscription is mirrored with the status Lemon Squeezy actually sent", async (t) => {
  configured(t);
  const db = stubDb(t, { userFirst: async () => ({ id: USER }) });
  stubMethod(t, prisma.subscription as any, "findUnique", async () => null);

  const res = await deliver(subBody());

  assert.equal(res.status, 200);
  assert.equal(db.subCreate.length, 1);
  assert.equal(db.subCreate[0][0].data.status, "on_trial", "their word, stored verbatim");
  // The ordering guard's clock rides along, parsed from the event itself.
  assert.equal(
    db.subCreate[0][0].data.providerUpdatedAt.toISOString(),
    "2026-08-04T10:00:00.000Z",
  );
  assert.equal(finalStatus(db.eventMark), "processed");
});

/*
 * One card-trial per MACHINE: when a trial subscription is created and our
 * checkout put a device id in the custom data, the device is recorded in the
 * trial ledger so its next checkout skips the trial.
 */
test("a trial subscription records the device that started it", async (t) => {
  configured(t);
  const db = stubDb(t, { userFirst: async () => ({ id: USER }) });
  stubMethod(t, prisma.subscription as any, "findUnique", async () => null);
  const claims = stubMethod(t, prisma.trialClaim as any, "upsert", async (a: any) => a.create);

  const res = await deliver(subBody({ meta: { custom_data: { user_id: USER, device_id: "win-abc" } } }));

  assert.equal(res.status, 200);
  assert.equal(claims.length, 1, "the device is recorded as having used its trial");
  assert.ok(claims[0][0].where.deviceIdHash, "keyed on the hashed device id");
  assert.deepEqual(claims[0][0].update, {}, "create-only: an existing claim is never moved");
});

test("the shared 'unidentified' device id is never written to the trial ledger", async (t) => {
  configured(t);
  const db = stubDb(t, { userFirst: async () => ({ id: USER }) });
  stubMethod(t, prisma.subscription as any, "findUnique", async () => null);
  const claims = stubMethod(t, prisma.trialClaim as any, "upsert", async (a: any) => a.create);

  await deliver(subBody({ meta: { custom_data: { user_id: USER, device_id: "win-unidentified" } } }));

  assert.equal(claims.length, 0, "one unreadable machine must not burn the trial for all of them");
});

test("a subscription created WITHOUT a trial records no device (skip_trial path)", async (t) => {
  configured(t);
  const db = stubDb(t, { userFirst: async () => ({ id: USER }) });
  stubMethod(t, prisma.subscription as any, "findUnique", async () => null);
  const claims = stubMethod(t, prisma.trialClaim as any, "upsert", async (a: any) => a.create);

  // No trial_ends_at → this checkout skipped the trial; nothing to record.
  await deliver(
    subBody({
      meta: { custom_data: { user_id: USER, device_id: "win-abc" } },
      attributes: { status: "active", trial_ends_at: null },
    }),
  );

  assert.equal(claims.length, 0, "only an actual trial consumes the machine's one trial");
});

/*
 * The date the resolver reads is derived ONCE here rather than chosen at read
 * time, because picking between three dates in four places is how the three
 * drift apart. On trial, the trial's end is the one that matters.
 */
test("validUntil is derived from the right one of the three dates", async (t) => {
  configured(t);
  const db = stubDb(t, { userFirst: async () => ({ id: USER }) });
  stubMethod(t, prisma.subscription as any, "findUnique", async () => null);

  await deliver(
    subBody({
      attributes: { status: "cancelled", ends_at: "2026-09-01T00:00:00.000Z", renews_at: "2026-10-01T00:00:00.000Z" },
    }),
  );

  // ends_at wins: it is the hard stop, and a cancelled subscription stays valid
  // until then rather than until the renewal that will never happen.
  assert.equal(
    db.subCreate[0][0].data.validUntil.toISOString(),
    "2026-09-01T00:00:00.000Z",
  );
});

/*
 * The same lesson the order path had to learn: a redelivery whose custom data
 * named a different account must not MOVE the subscription to it.
 */
test("a replayed subscription event never reassigns the account", async (t) => {
  configured(t);
  const db = stubDb(t, { userFirst: async () => ({ id: USER }) });
  stubMethod(t, prisma.subscription as any, "findUnique", async () => null);

  await deliver(subBody());

  // Ownership is decided at create and nowhere else: the conditional update
  // that lands on an existing row must not carry a userId at all.
  assert.equal(db.subWrite.length >= 1, true);
  assert.equal(db.subWrite[0][0].data.userId, undefined, "userId is not in the update data");
  assert.equal(db.subCreate[0][0].data.userId, USER, "create is where ownership lives");
});

test("a subscription from another store is refused", async (t) => {
  configured(t);
  const db = stubDb(t);

  await deliver(subBody({ attributes: { store_id: 999999 } }));

  assert.equal(db.subCreate.length, 0);
  assert.equal(db.subWrite.length, 0);
  assert.equal(finalStatus(db.eventMark), "skipped");
});

/*
 * Test-mode gating applies to GRANTING states only. Refusing to record an ending
 * is how a test row stays live for ever.
 */
test("a test-mode ENDING is still recorded, even though a test-mode start is not", async (t) => {
  configured(t);
  const db = stubDb(t, { userFirst: async () => ({ id: USER }) });
  stubMethod(t, prisma.subscription as any, "findUnique", async () => null);

  await deliver(subBody({ attributes: { test_mode: true, status: "expired" } }));
  assert.equal(db.subCreate.length, 1, "an expiry is written whatever mode it came from");

  await deliver(
    subBody({ meta: { event_name: "subscription_updated" }, attributes: { test_mode: true, status: "active" } }),
  );
  assert.equal(db.subCreate.length, 1, "but a granting state is not");
});

/*
 * ── A subscription for something we do not sell ─────────────────────────
 *
 * The store check was the ONLY gate on this path: any subscription bought in
 * our store granted full Pro, whatever variant it was for. Today the store
 * holds exactly the three products we sell, so nothing could be bought that
 * exploited it — but the shape is the hole, and it opens by itself the first
 * time a second subscription variant exists: a discounted "Lite" tier, a
 * grandfathered plan, an experiment, a pay-what-you-want variant. Each would
 * have been a full licence at its own price, on a public checkout URL, and
 * `checkout[custom][user_id]` lets the buyer name the account to credit.
 *
 * The state is still MIRRORED — refusing to record what Lemon Squeezy tells us
 * is how a row goes stale for ever — it simply does not grant.
 */
test("a subscription for a variant we do not sell is recorded, but grants nothing", async (t) => {
  configured(t);
  const db = stubDb(t, { userFirst: async () => ({ id: USER }) });
  stubMethod(t, prisma.subscription as any, "findUnique", async () => null);

  await deliver(subBody({ attributes: { variant_id: 999999, status: "active" } }));

  assert.equal(db.subCreate.length, 1, "we still record what the provider told us");
  assert.equal(
    subscriptionGrants(
      {
        status: "active",
        variantId: "999999",
        validUntil: new Date(Date.now() + 30 * 86_400_000),
        trialEndsAt: null,
        trialCancelledAt: null,
        updatedAt: new Date(),
      },
      new Date(),
    ),
    false,
    "but a plan we never sold is not a licence",
  );
});

/*
 * ── The REAL deliveries, verbatim ───────────────────────────────────────
 *
 * Everything above tests payloads we wrote. These four run the two deliveries
 * the store ACTUALLY sent for order 9090213 (captured 2026-08-06, byte content
 * preserved in lemonsqueezy-fixtures.ts) through the whole route — signature,
 * claim, handle — so "the webhook works" is pinned against Lemon Squeezy's real
 * output rather than our idea of it. The fixtures carry the traps a hand-written
 * body never would: microsecond timestamps, tax_rate flipping between number
 * and string across events, meta.test_mode and attributes.test_mode both set.
 */

test("the real order_created is refused while test mode is closed", async (t) => {
  configured(t); // lemonSqueezyAllowTestMode: false — the production posture
  const db = stubDb(t);

  const res = await deliver(REAL_ORDER_CREATED);

  assert.equal(res.status, 200, "understood and deliberately ignored — never retried");
  assert.equal(db.purchaseUpsert.length, 0, "no licence for money never really paid");
  assert.equal(finalStatus(db.eventMark), "skipped");
});

test("the real order_created grants the lifetime licence when test mode is open", async (t) => {
  configured(t, { lemonSqueezyAllowTestMode: true });
  const db = stubDb(t, {
    // Answer ONLY for the account the checkout stamped into custom_data, so the
    // assertion below proves the id was read from the payload, not defaulted.
    userFind: async (args: any) =>
      args?.where?.id === REAL_USER_ID ? { id: REAL_USER_ID } : null,
  });

  const res = await deliver(REAL_ORDER_CREATED);

  assert.equal(res.status, 200);
  assert.equal(finalStatus(db.eventMark), "processed");
  assert.equal(db.purchaseUpsert.length, 1);
  const written = db.purchaseUpsert[0][0].create;
  assert.equal(written.userId, REAL_USER_ID);
  assert.equal(written.productId, "1960881", "recorded against the real lifetime variant");
  assert.equal(written.priceUsd, 22.92);
  // The load-bearing detail: Lemon Squeezy timestamps carry MICROSECONDS
  // ("...T12:07:50.000000Z"), which the date spec does not describe. If parsing
  // ever regressed, parseDate's fallback would silently stamp the purchase with
  // the DELIVERY time — and this assertion is what would catch it.
  assert.equal(written.purchasedAt.toISOString(), "2026-07-30T12:07:50.000Z");
  assert.equal(written.isRefunded, false);
});

test("the real order_refunded revokes even though test mode is closed", async (t) => {
  configured(t); // allow=false — revoking is never gated
  const db = stubDb(t, {
    purchaseFind: async () => ({ id: "purchase-9090213" }),
  });

  const res = await deliver(REAL_ORDER_REFUNDED);

  assert.equal(res.status, 200);
  assert.equal(finalStatus(db.eventMark), "processed");
  const revokes = db.purchaseUpdate.filter((c) => c[0]?.data?.isRefunded === true);
  assert.equal(revokes.length, 1, "a full refund must revoke the licence");
  // status "refunded" + refunded_amount_usd === total_usd: both signals agree,
  // and the string tax_rate riding alongside broke nothing on the way.
  assert.equal(
    revokes[0][0].data.refundedAt.toISOString(),
    "2026-07-31T17:03:13.000Z",
    "stamped with Lemon Squeezy's refund time, not ours",
  );
});

test("the real refund converges even if its order_created was never seen", async (t) => {
  // The deliveries can arrive in any order across serverless instances, and a
  // refund for an order we never recorded must still make the later (replayed)
  // creation unable to grant. The fixture is a TEST order, so test mode has to
  // be open for it to be minted at all — see the pair of tests below.
  configured(t, { lemonSqueezyAllowTestMode: true });
  const db = stubDb(t, {
    purchaseFind: async () => null,
    userFind: async (args: any) =>
      args?.where?.id === REAL_USER_ID ? { id: REAL_USER_ID } : null,
  });

  const res = await deliver(REAL_ORDER_REFUNDED);

  assert.equal(res.status, 200);
  assert.equal(db.purchaseCreate.length, 1);
  const created = db.purchaseCreate[0][0].data;
  assert.equal(created.userId, REAL_USER_ID);
  assert.equal(created.isRefunded, true, "born revoked, so a replayed creation cannot resurrect it");
  assert.equal(created.testMode, true, "and marked, so it can be excluded once test mode is shut");
});

/*
 * The mint-from-unseen branch CREATES a row, so it needs the same test-mode
 * gate the grant path has — otherwise a test refund for an order this deploy
 * never recorded writes a permanent test-graph Purchase into the production
 * table: a row for a sale that never happened here. Revoking an EXISTING row
 * stays ungated, which is the whole point of the asymmetry.
 */
test("a test-mode refund for an unseen order mints nothing on a live backend", async (t) => {
  configured(t); // allowTestMode: false
  const db = stubDb(t, { purchaseFind: async () => null });

  const res = await deliver(REAL_ORDER_REFUNDED);

  assert.equal(res.status, 200);
  assert.equal(db.purchaseCreate.length, 0);
  assert.equal(finalStatus(db.eventMark), "skipped");
});

test("but a test-mode refund still REVOKES a row we already have", async (t) => {
  configured(t); // allowTestMode: false — revoking is never gated
  const db = stubDb(t, { purchaseFind: async () => ({ id: "purchase-9090213" }) });

  await deliver(REAL_ORDER_REFUNDED);

  assert.equal(
    db.purchaseUpdate.filter((c) => c[0]?.data?.isRefunded === true).length,
    1,
    "taking access away must never wait for a flag",
  );
});

/* Every granted row is marked, so the live switch can exclude them. */
test("a granted purchase records which mode it came from", async (t) => {
  configured(t, { lemonSqueezyAllowTestMode: true });
  const db = stubDb(t, {
    userFind: async (args: any) =>
      args?.where?.id === REAL_USER_ID ? { id: REAL_USER_ID } : null,
  });

  await deliver(REAL_ORDER_CREATED);

  assert.equal(db.purchaseUpsert[0][0].create.testMode, true);
});

test("a subscription records which mode it came from", async (t) => {
  configured(t);
  const db = stubDb(t, { userFirst: async () => ({ id: USER }) });
  stubMethod(t, prisma.subscription as any, "findUnique", async () => null);

  await deliver(subBody({ attributes: { test_mode: true, status: "expired" } }));

  assert.equal(db.subCreate[0][0].data.testMode, true);
});

/*
 * The dedupe key must separate two DIFFERENT refunds on one order, while still
 * collapsing redeliveries of the same one. Before `updated_at` joined the order
 * eventKey, a partial refund (terminal `processed`) swallowed the later full
 * refund as a duplicate — money returned, licence never revoked.
 */
test("a full refund after a partial refund still revokes", async (t) => {
  configured(t);

  // A tiny in-memory webhookEvent table, so the claim/dedupe path runs for real
  // instead of being stubbed to "always fresh".
  const rows = new Map<string, { status: string }>();
  const db = stubDb(t, {
    eventCreate: async (args: any) => {
      if (rows.has(args.data.eventId)) throw duplicateKey();
      rows.set(args.data.eventId, { status: "processing" });
      return {};
    },
    eventFind: async (args: any) => rows.get(args.where.provider_eventId.eventId) ?? null,
    eventUpdate: async (args: any) => {
      const row = rows.get(args.where.provider_eventId.eventId);
      if (row && typeof args.data.status === "string") row.status = args.data.status;
      return {};
    },
    eventMark: async (args: any) => {
      const row = rows.get(args.where.eventId);
      if (!row || ["processed", "skipped"].includes(row.status)) return { count: 0 };
      row.status = args.data.status;
      return { count: 1 };
    },
    purchaseFind: async () => ({ id: "purchase-9090213" }),
  });

  // Day 1: a partial goodwill refund. Licence deliberately kept.
  const partial = JSON.parse(JSON.stringify(REAL_ORDER_REFUNDED));
  partial.data.attributes.status = "partial_refund";
  partial.data.attributes.refunded_amount = 500;
  partial.data.attributes.refunded_amount_usd = 573;
  partial.data.attributes.updated_at = "2026-07-30T15:00:00.000000Z";
  const first = await deliver(partial);
  assert.equal(first.status, 200);
  assert.equal(
    db.purchaseUpdate.filter((c) => c[0]?.data?.isRefunded === true).length,
    0,
    "a partial refund must not revoke",
  );

  // Day 2: the FULL refund — same order, same event name, later updated_at.
  const second = await deliver(REAL_ORDER_REFUNDED);
  assert.equal(second.status, 200);
  assert.equal(
    db.purchaseUpdate.filter((c) => c[0]?.data?.isRefunded === true).length,
    1,
    "the full refund is a NEW event, not a redelivery of the partial one",
  );

  // And an actual redelivery of that same full refund is still collapsed.
  const replay = await deliver(REAL_ORDER_REFUNDED);
  assert.equal(replay.body.deduped, true);
  assert.equal(
    db.purchaseUpdate.filter((c) => c[0]?.data?.isRefunded === true).length,
    1,
    "byte-identical redeliveries still land exactly once",
  );
});

/*
 * ── What the adversarial review of the real payloads changed ────────────
 *
 * Ten findings survived verification (20 agents, each defect independently
 * refutation-tested). The tests below pin the seven that changed code; the
 * refuted ones need no pinning — they were wrong about the code as it stands.
 */

// Finding: revocation was gated behind isSellableOrder, so rotating the variant
// id (a price change) would have made every refund of the OLD variant refuse
// terminally — money returned, licence live. A Purchase we recorded is ours to
// revoke whatever the env says today.
test("a refund still revokes after the variant id has been rotated", async (t) => {
  configured(t, { lemonSqueezyVariantId: "7777777" }); // the env moved on
  const db = stubDb(t, {
    purchaseFind: async () => ({ id: "purchase-9090213" }),
  });

  const res = await deliver(REAL_ORDER_REFUNDED); // still carries variant 1960881

  assert.equal(res.status, 200);
  assert.equal(finalStatus(db.eventMark), "processed");
  assert.equal(
    db.purchaseUpdate.filter((c) => c[0]?.data?.isRefunded === true).length,
    1,
    "the licence we granted must be revocable whatever the env says today",
  );
});

// The sellable question a refund DOES raise: an order we never saw created must
// not mint a row when it is not even ours.
test("an orphan refund from a foreign store mints nothing", async (t) => {
  configured(t);
  const db = stubDb(t, { purchaseFind: async () => null });

  const body = JSON.parse(JSON.stringify(REAL_ORDER_REFUNDED));
  body.data.attributes.store_id = 999999;
  const res = await deliver(body);

  assert.equal(res.status, 200);
  assert.equal(db.purchaseCreate.length, 0);
  assert.equal(finalStatus(db.eventMark), "skipped");
});

// Finding: the orphan branch ignored the partial/full verdict and stamped every
// refund born-revoked — so a customer whose order_created was lost and who then
// received a small goodwill refund lost the licence they had paid in full for.
test("an orphan PARTIAL refund is parked for a human, not written as a revoke", async (t) => {
  configured(t);
  const db = stubDb(t, { purchaseFind: async () => null });

  const body = JSON.parse(JSON.stringify(REAL_ORDER_REFUNDED));
  body.data.attributes.status = "partial_refund";
  body.data.attributes.refunded_amount = 500;
  body.data.attributes.refunded_amount_usd = 573;
  const res = await deliver(body);

  assert.equal(res.status, 200);
  assert.equal(db.purchaseCreate.length, 0, "born-revoked would punish a paying customer");
  assert.equal(db.purchaseUpdate.length, 0, "and there is nothing to update");
  assert.equal(finalStatus(db.eventMark), "failed", "claimable: redeliver the order_created");
});

/*
 * Finding: the money fields were read type-strictly, and the real fixtures prove
 * Lemon Squeezy mutates numeric fields into decimal strings between events
 * (tax_rate: 0 then "0.00"). A string total nulled priceUsd — and then a partial
 * refund with an unhelpful status fell through isFullRefund's deliberate
 * fail-toward-revoke fallback, revoking a customer who had paid in full.
 */
test("money delivered as strings still parses, and still protects a partial refund", async (t) => {
  configured(t, { lemonSqueezyAllowTestMode: true });
  const db = stubDb(t, {
    userFind: async (args: any) =>
      args?.where?.id === REAL_USER_ID ? { id: REAL_USER_ID } : null,
  });

  // The grant leg: a string total must not lose the price.
  const created = JSON.parse(JSON.stringify(REAL_ORDER_CREATED));
  created.data.attributes.total_usd = "2292";
  await deliver(created);
  assert.equal(db.purchaseUpsert[0][0].create.priceUsd, 22.92);

  // The revoke leg: a PARTIAL refund whose status is unhelpfully "paid" and
  // whose amounts arrive as strings. Before toCents, both amounts parsed to
  // null, the comparison was impossible, and the fallback revoked.
  stubMethod(t, prisma.purchase as any, "findUnique", async () => ({ id: "purchase-9090213" }));
  const partial = JSON.parse(JSON.stringify(REAL_ORDER_REFUNDED));
  partial.data.attributes.status = "paid";
  partial.data.attributes.refunded = false;
  partial.data.attributes.refunded_amount_usd = "573";
  partial.data.attributes.total_usd = "2292";
  await deliver(partial);

  assert.equal(
    db.purchaseUpdate.filter((c) => c[0]?.data?.isRefunded === true).length,
    0,
    "573 of 2292 back is a partial refund, string typing notwithstanding",
  );
});

/*
 * Finding: the subscription dedupe key fell back to "" when updated_at was not
 * a string — so one type mutation from Lemon Squeezy would collapse every
 * future renewal of that subscription onto one terminal key, silently ending a
 * paying customer's access at their first period. The stamp now survives any
 * type, then falls to the delivery-unique webhook_id.
 */
test("the dedupe keys survive a type-mutated or missing updated_at", () => {
  const base = subBody();

  const numeric = JSON.parse(JSON.stringify(base));
  numeric.data.attributes.updated_at = 1786000000;
  const n = parseSubscriptionEvent(numeric)!;
  assert.equal(n.eventKey, "subscription_created:77001:1786000000", "never collapsed to ''");

  const absent = JSON.parse(JSON.stringify(base));
  delete absent.data.attributes.updated_at;
  absent.meta.webhook_id = "wh-abc-123";
  const a = parseSubscriptionEvent(absent)!;
  assert.equal(a.eventKey, "subscription_created:77001:wh-abc-123", "webhook_id is the fallback");

  // Orders use the same stamp — the partial-then-full regression must not be
  // reintroducible by a type flip.
  const order = JSON.parse(JSON.stringify(REAL_ORDER_REFUNDED));
  order.data.attributes.updated_at = 1786000001;
  assert.equal(parseOrderEvent(order)!.eventKey, "order_refunded:9090213:1786000001");
});

/*
 * Finding: handleSubscription was pure last-writer-wins, and Lemon Squeezy
 * retries failed deliveries over HOURS — so a stale retry could resurrect a
 * cancelled state or roll validUntil back a month. The write is now conditional
 * on nothing newer being recorded.
 */
test("a stale subscription event cannot overwrite a newer recorded state", async (t) => {
  configured(t);
  const db = stubDb(t, {
    userFirst: async () => ({ id: USER }),
    // The conditional update matches nothing: the stored row is NEWER.
    subWrite: async () => ({ count: 0 }),
  });
  stubMethod(t, prisma.subscription as any, "findUnique", async (args: any) =>
    args?.select?.id ? { id: "sub-row-1" } : { userId: USER },
  );

  const res = await deliver(
    subBody({ meta: { event_name: "subscription_updated" }, attributes: { status: "active" } }),
  );

  assert.equal(res.status, 200);
  assert.equal(db.subCreate.length, 0, "the row exists — a stale event must not clone it");
  assert.equal(finalStatus(db.eventMark), "skipped");
  // And the guard itself: the WHERE only matches rows not newer than this event.
  const where = db.subWrite[0][0].where;
  assert.ok(where.OR, "the write carries the staleness condition");
  assert.equal(
    where.OR[1].providerUpdatedAt.lte.toISOString(),
    "2026-08-04T10:00:00.000Z",
  );
});

// Finding: the order upsert's update branch carried userId, so a replay whose
// custom data resolved differently could MOVE a licence between accounts —
// the exact hazard the subscription path documents avoiding.
test("a replayed order never reassigns the licence's owner", async (t) => {
  configured(t);
  const db = stubDb(t);

  await deliver(orderBody());

  const arg = db.purchaseUpsert[0][0];
  assert.equal(arg.create.userId, USER, "ownership is decided at create");
  assert.ok(!("userId" in arg.update), "and never re-decided on a replay");
});

/*
 * subscription_plan_changed is the dashboard's twelfth subscription event (it
 * postdates the original list of eleven). A monthly <-> yearly switch must land
 * as the new plan NOW — not at the next renewal, up to a year away — because
 * the checkout guard and the profile screen both read the row's interval.
 */
test("a plan change is mirrored immediately, not at the next renewal", async (t) => {
  configured(t);
  const db = stubDb(t, { userFirst: async () => ({ id: USER }) });
  stubMethod(t, prisma.subscription as any, "findUnique", async () => null);

  const res = await deliver(
    subBody({
      meta: { event_name: "subscription_plan_changed" },
      attributes: { status: "active", variant_id: 1986420 }, // switched to yearly
    }),
  );

  assert.equal(res.status, 200);
  assert.equal(finalStatus(db.eventMark), "processed", "not 'unhandled event'");
  assert.equal(db.subCreate[0][0].data.variantId, "1986420");
  assert.equal(db.subCreate[0][0].data.interval, "yearly", "the row says the NEW plan");
});

/* ── the trial tombstone, and the delivery order that nearly lost it ──────
 *
 * Cancelling a trial ends access at once. The tombstone is what makes that
 * survive a RESUME in the Lemon Squeezy customer portal, which puts the status
 * back to `on_trial` with the same trial_ends_at and takes no payment.
 *
 * The subtlety is WHERE it is written. The staleness guard drops any event older
 * than what we already recorded — correct for state, catastrophic for this fact:
 * Lemon Squeezy retries with backoff over hours, so a `subscription_cancelled`
 * arriving after a newer event is exactly the case the guard exists for, and
 * inside the guarded write the tombstone would simply be discarded. The trial
 * would then still be resumable for free.
 */
test("a cancelled trial is tombstoned even when its delivery arrives late", async (t) => {
  configured(t);
  stubDb(t, {
    userFirst: async () => ({ id: USER }),
    // Every guarded write is rejected as stale — the out-of-order retry.
    subWrite: async () => ({ count: 0 }),
  });
  stubMethod(t, prisma.subscription as any, "findUnique", async () => ({ id: "row-1" }));

  const writes: any[] = [];
  const realUpdateMany = (prisma.subscription as any).updateMany;
  (prisma.subscription as any).updateMany = async (a: any) => {
    writes.push(a);
    return realUpdateMany(a);
  };
  t.after(() => {
    (prisma.subscription as any).updateMany = realUpdateMany;
  });

  await deliver(
    subBody({
      meta: { event_name: "subscription_cancelled" },
      attributes: {
        status: "cancelled",
        trial_ends_at: new Date(Date.now() + 3 * 86_400_000).toISOString(),
      },
    }),
  );

  const tombstone = writes.find((w) => w.data?.trialCancelledAt && w.where?.trialCancelledAt === null);
  assert.ok(tombstone, "the tombstone is written on its own, outside the staleness guard");
  assert.equal(
    tombstone.where.trialCancelledAt,
    null,
    "set-once: a second delivery cannot move the timestamp",
  );
});

/*
 * `trial_ends_at` is what the tombstone RULE reads to know the window is still
 * running. A later payload that simply omits it would blank the column and
 * disarm the tombstone — after which Resume hands the trial back for free.
 */
test("a payload that omits trial_ends_at does not clear it", async (t) => {
  configured(t);
  const db = stubDb(t, { userFirst: async () => ({ id: USER }) });
  stubMethod(t, prisma.subscription as any, "findUnique", async () => null);

  await deliver(
    subBody({
      meta: { event_name: "subscription_updated" },
      attributes: { status: "active", trial_ends_at: null },
    }),
  );

  assert.equal(db.subCreate.length, 1);
  assert.ok(
    !("trialEndsAt" in db.subCreate[0][0].data),
    "an absent field means 'not mentioned', never 'cleared'",
  );
});
