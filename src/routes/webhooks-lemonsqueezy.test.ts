import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import request from "supertest";
import { Prisma } from "@prisma/client";
import { createApp } from "../app";
import { prisma } from "../lib/prisma";
import { env } from "../lib/env";

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
    purchaseUpsert: stubMethod(t, prisma.purchase as any, "upsert", pick("purchaseUpsert", async () => ({}))),
    purchaseFind: stubMethod(t, prisma.purchase as any, "findUnique", pick("purchaseFind", async () => null)),
    purchaseUpdate: stubMethod(t, prisma.purchase as any, "update", pick("purchaseUpdate", async () => ({}))),
    purchaseCreate: stubMethod(t, prisma.purchase as any, "create", pick("purchaseCreate", async () => ({}))),
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
  assert.equal(finalStatus(db.eventUpdate), "processed");
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

test("an order for another variant is refused permanently", async (t) => {
  configured(t);
  const db = stubDb(t);

  const res = await deliver(orderBody({ attributes: { first_order_item: { variant_id: 999999 } } }));

  assert.equal(res.status, 200, "understood and declined — redelivering it would change nothing");
  assert.equal(db.purchaseUpsert.length, 0);
  assert.equal(finalStatus(db.eventUpdate), "skipped");
});

test("an order from another store is refused permanently", async (t) => {
  configured(t);
  const db = stubDb(t);

  const res = await deliver(orderBody({ attributes: { store_id: 111111 } }));

  assert.equal(res.status, 200);
  assert.equal(db.purchaseUpsert.length, 0);
  assert.equal(finalStatus(db.eventUpdate), "skipped");
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
  assert.equal(finalStatus(db.eventUpdate), "failed", "must NOT be the terminal 'skipped'");
});

test("a test-mode order does not mint a real licence on a live backend", async (t) => {
  configured(t);
  const db = stubDb(t);

  const res = await deliver(orderBody({ attributes: { test_mode: true } }));

  assert.equal(res.status, 200);
  assert.equal(db.purchaseUpsert.length, 0);
  assert.equal(finalStatus(db.eventUpdate), "skipped");
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
  assert.equal(finalStatus(db.eventUpdate), "failed", "queryable, because a human has to finish it");
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
  assert.equal(finalStatus(db.eventUpdate), "processed");
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
  assert.equal(finalStatus(db.eventUpdate), "failed", "non-terminal, so the retry re-runs the work");
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
  assert.equal(finalStatus(db.eventUpdate), "skipped");
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
  assert.equal(finalStatus(db.eventUpdate), "processed");
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
        variant_id: 5551,
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
  const upserts = stubMethod(t, prisma.subscription as any, "upsert", async () => ({}));
  stubMethod(t, prisma.subscription as any, "findUnique", async () => null);

  const res = await deliver(subBody());

  assert.equal(res.status, 200);
  assert.equal(upserts.length, 1);
  assert.equal(upserts[0][0].create.status, "on_trial", "their word, stored verbatim");
  assert.equal(finalStatus(db.eventUpdate), "processed");
});

/*
 * The date the resolver reads is derived ONCE here rather than chosen at read
 * time, because picking between three dates in four places is how the three
 * drift apart. On trial, the trial's end is the one that matters.
 */
test("validUntil is derived from the right one of the three dates", async (t) => {
  configured(t);
  stubDb(t, { userFirst: async () => ({ id: USER }) });
  const upserts = stubMethod(t, prisma.subscription as any, "upsert", async () => ({}));
  stubMethod(t, prisma.subscription as any, "findUnique", async () => null);

  await deliver(
    subBody({
      attributes: { status: "cancelled", ends_at: "2026-09-01T00:00:00.000Z", renews_at: "2026-10-01T00:00:00.000Z" },
    }),
  );

  // ends_at wins: it is the hard stop, and a cancelled subscription stays valid
  // until then rather than until the renewal that will never happen.
  assert.equal(
    upserts[0][0].create.validUntil.toISOString(),
    "2026-09-01T00:00:00.000Z",
  );
});

/*
 * The same lesson the order path had to learn: a redelivery whose custom data
 * named a different account must not MOVE the subscription to it.
 */
test("a replayed subscription event never reassigns the account", async (t) => {
  configured(t);
  stubDb(t, { userFirst: async () => ({ id: USER }) });
  const upserts = stubMethod(t, prisma.subscription as any, "upsert", async () => ({}));
  stubMethod(t, prisma.subscription as any, "findUnique", async () => null);

  await deliver(subBody());

  assert.equal(upserts[0][0].update.userId, undefined, "userId is not in the update branch");
});

test("a subscription from another store is refused", async (t) => {
  configured(t);
  const db = stubDb(t);
  const upserts = stubMethod(t, prisma.subscription as any, "upsert", async () => ({}));

  await deliver(subBody({ attributes: { store_id: 999999 } }));

  assert.equal(upserts.length, 0);
  assert.equal(finalStatus(db.eventUpdate), "skipped");
});

/*
 * Test-mode gating applies to GRANTING states only. Refusing to record an ending
 * is how a test row stays live for ever.
 */
test("a test-mode ENDING is still recorded, even though a test-mode start is not", async (t) => {
  configured(t);
  stubDb(t, { userFirst: async () => ({ id: USER }) });
  const upserts = stubMethod(t, prisma.subscription as any, "upsert", async () => ({}));
  stubMethod(t, prisma.subscription as any, "findUnique", async () => null);

  await deliver(subBody({ attributes: { test_mode: true, status: "expired" } }));
  assert.equal(upserts.length, 1, "an expiry is written whatever mode it came from");

  await deliver(
    subBody({ meta: { event_name: "subscription_updated" }, attributes: { test_mode: true, status: "active" } }),
  );
  assert.equal(upserts.length, 1, "but a granting state is not");
});
