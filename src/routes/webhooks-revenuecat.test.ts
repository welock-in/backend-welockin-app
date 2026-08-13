import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import request from "supertest";
import { Prisma } from "@prisma/client";
import { createApp } from "../app";
import { prisma } from "../lib/prisma";
import { env } from "../lib/env";
import {
  RC_LIFETIME_PRODUCT_IDS,
  RC_PRODUCT_MONTHLY,
  RC_PRODUCT_YEARLY,
  type RcSubscriber,
} from "../lib/revenuecat";

/*
 * The RevenueCat webhook turns iOS money into access, and its perimeter is an
 * Authorization header rather than a payload signature. What these tests pin:
 * WHICH deliveries are refused (and that refusals happen before any work),
 * that every accepted event converges on the re-fetched subscriber state, and
 * that SANDBOX is recorded-but-flagged rather than either dropped or honoured.
 */

const app = createApp();
const TOKEN = "rc-webhook-token-test";
const USER = "507f1f77bcf86cd799439011";
const OTHER_USER = "507f1f77bcf86cd799439022";
const FUTURE = "2026-09-01T00:00:00.000Z";

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

/** A deploy on which RevenueCat is configured and live (sandbox rows hidden). */
function configured(t: Ctx, extra: Record<string, unknown> = {}) {
  setEnv(t, {
    revenuecatEnabled: true,
    revenuecatWebhookAuthToken: TOKEN,
    revenuecatSecretApiKey: "sk_test_secret",
    revenuecatWebhookHmacSecret: "",
    revenuecatAllowedAppIds: [],
    revenuecatAllowSandbox: false,
    revenuecatMaxEventAgeHours: 96,
    ...extra,
  });
}

/** A subscriber whose monthly is live and paid. Tests override what they test. */
function subscriber(over: Partial<RcSubscriber> = {}): RcSubscriber {
  return {
    subscriptions: {
      [RC_PRODUCT_MONTHLY]: { expires_date: FUTURE, period_type: "normal", is_sandbox: false },
    },
    entitlements: { pro: { product_identifier: RC_PRODUCT_MONTHLY, expires_date: FUTURE } },
    management_url: "https://apps.apple.com/account/subscriptions",
    original_app_user_id: USER,
    ...over,
  };
}

/** Mock the RevenueCat API. Returns the recorded calls. */
function stubFetch(
  t: Ctx,
  respond: (url: string) => RcSubscriber | { boom: true } = () => subscriber(),
) {
  return stubMethod(t, globalThis as any, "fetch", async (url: any) => {
    const answer = respond(String(url));
    if ("boom" in answer && answer.boom) throw new Error("network down");
    return new Response(JSON.stringify({ subscriber: answer }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
}

/**
 * Every Prisma call the route can make, stubbed to "nothing exists yet, every
 * write succeeds" — including the resolver reads that run after a sync,
 * because the webhook refreshes the entitlement cache best-effort.
 */
function stubDb(t: Ctx, overrides: Record<string, (...args: any[]) => any> = {}) {
  const pick = (name: string, fallback: (...args: any[]) => any) => overrides[name] ?? fallback;

  return {
    eventCreate: stubMethod(t, prisma.webhookEvent as any, "create", pick("eventCreate", async () => ({}))),
    eventFind: stubMethod(t, prisma.webhookEvent as any, "findUnique", pick("eventFind", async () => null)),
    eventUpdate: stubMethod(t, prisma.webhookEvent as any, "update", pick("eventUpdate", async () => ({}))),
    eventMark: stubMethod(t, prisma.webhookEvent as any, "updateMany", pick("eventMark", async () => ({ count: 1 }))),
    subUpsert: stubMethod(t, prisma.subscription as any, "upsert", pick("subUpsert", async () => ({}))),
    subFindMany: stubMethod(t, prisma.subscription as any, "findMany", pick("subFindMany", async () => [])),
    // The authoritative sweep: revoke this user's RC rows the fresh snapshot
    // no longer names. Baseline "nothing to revoke".
    subSweep: stubMethod(t, prisma.subscription as any, "updateMany", pick("subSweep", async () => ({ count: 0 }))),
    purchaseUpsert: stubMethod(t, prisma.purchase as any, "upsert", pick("purchaseUpsert", async () => ({}))),
    purchaseFindMany: stubMethod(t, prisma.purchase as any, "findMany", pick("purchaseFindMany", async () => [])),
    purchaseSweep: stubMethod(t, prisma.purchase as any, "updateMany", pick("purchaseSweep", async () => ({ count: 0 }))),
    claimFindFirst: stubMethod(t, prisma.trialClaim as any, "findFirst", pick("claimFindFirst", async () => null)),
    userFind: stubMethod(
      t,
      prisma.user as any,
      "findUnique",
      pick("userFind", async (args: any) => ({
        id: args?.where?.id,
        trialEndsAt: null,
        compActive: false,
        compedUntil: null,
        accessRevoked: false,
      })),
    ),
    userUpdate: stubMethod(t, prisma.user as any, "update", pick("userUpdate", async () => ({}))),
  };
}

function eventBody(over: Record<string, any> = {}) {
  return {
    api_version: "1.0",
    event: {
      id: "evt-0001",
      type: "INITIAL_PURCHASE",
      app_user_id: USER,
      event_timestamp_ms: Date.now(),
      environment: "PRODUCTION",
      store: "APP_STORE",
      app_id: "app1234",
      product_id: RC_PRODUCT_MONTHLY,
      ...over,
    },
  };
}

function deliver(body: unknown, headers: Record<string, string> = {}) {
  return request(app)
    .post("/api/webhooks/revenuecat")
    .set("Content-Type", "application/json")
    .set({ Authorization: TOKEN, ...headers })
    .send(JSON.stringify(body));
}

/** What markWebhookEvent finally recorded for this delivery. */
function finalStatus(eventMark: any[][]): string | undefined {
  return eventMark.at(-1)?.[0]?.data?.status;
}

/* ── the perimeter ──────────────────────────────────────────────────────── */

test("an unconfigured integration answers 503 so deliveries queue instead of vanishing", async (t) => {
  configured(t, { revenuecatEnabled: false });
  const db = stubDb(t);
  stubFetch(t);

  const res = await deliver(eventBody());

  assert.equal(res.status, 503);
  assert.equal(res.body.error.code, "PROVIDER_DISABLED");
  assert.equal(db.eventCreate.length, 0);
});

test("a missing or wrong Authorization is refused before anything is claimed", async (t) => {
  configured(t);
  const db = stubDb(t);
  const fetches = stubFetch(t);

  for (const headers of [{ Authorization: "" }, { Authorization: "not-the-token" }]) {
    const res = await deliver(eventBody(), headers);
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, "INVALID_AUTHORIZATION");
  }
  assert.equal(db.eventCreate.length, 0, "nothing may be claimed before the token checks out");
  assert.equal(fetches.length, 0);
});

test("the dashboard token is accepted with or without a Bearer prefix", async (t) => {
  configured(t);
  stubDb(t);
  stubFetch(t);

  const res = await deliver(eventBody(), { Authorization: `Bearer ${TOKEN}` });
  assert.equal(res.status, 200);
});

test("with an HMAC secret configured, a missing or wrong signature is a clean 401", async (t) => {
  configured(t, { revenuecatWebhookHmacSecret: "proxy-secret" });
  const db = stubDb(t);
  stubFetch(t);

  const body = eventBody();
  for (const sig of [undefined, "zz", "f".repeat(63), "f".repeat(64)]) {
    const res = await deliver(body, sig === undefined ? {} : { "X-RevenueCat-Signature": sig });
    assert.equal(res.status, 401, `signature ${JSON.stringify(sig)} must be rejected cleanly`);
    assert.equal(res.body.error.code, "INVALID_SIGNATURE");
  }
  assert.equal(db.eventCreate.length, 0);

  // …and the genuine signature over the exact bytes passes.
  const raw = JSON.stringify(body);
  const good = createHmac("sha256", "proxy-secret").update(raw).digest("hex");
  const ok = await request(app)
    .post("/api/webhooks/revenuecat")
    .set("Content-Type", "application/json")
    .set({ Authorization: TOKEN, "X-RevenueCat-Signature": good })
    .send(raw);
  assert.equal(ok.status, 200);
});

test("an authorized delivery we cannot parse is a 400, not a silent 200", async (t) => {
  configured(t);
  const db = stubDb(t);
  stubFetch(t);

  for (const body of [{}, { event: {} }, { event: { id: "x" } }, { event: { type: "RENEWAL" } }]) {
    const res = await deliver(body);
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "INVALID_PAYLOAD");
  }
  assert.equal(db.eventCreate.length, 0);
});

/* ── replays and allow-lists ────────────────────────────────────────────── */

test("an event older than the age window is acknowledged and skipped", async (t) => {
  configured(t, { revenuecatMaxEventAgeHours: 96 });
  const db = stubDb(t);
  const fetches = stubFetch(t);

  const res = await deliver(
    eventBody({ event_timestamp_ms: Date.now() - 97 * 60 * 60 * 1000 }),
  );

  assert.equal(res.status, 200);
  assert.equal(res.body.skipped, "stale event");
  assert.equal(fetches.length, 0, "a replay must not trigger API traffic");
  assert.equal(db.eventCreate.length, 0);
});

test("a product we do not sell is acknowledged and skipped", async (t) => {
  configured(t);
  const db = stubDb(t);
  const fetches = stubFetch(t);

  const res = await deliver(eventBody({ product_id: "com.someone.else.pro" }));

  assert.equal(res.status, 200);
  assert.match(res.body.skipped, /not one we sell/);
  assert.equal(fetches.length, 0);
  assert.equal(db.subUpsert.length, 0);
});

test("the RETIRED lifetime spelling is refused by the allow-list, like any foreign id", async (t) => {
  // `….life` is the ONE lifetime Product ID and no purchase of the longer
  // spelling exists anywhere — so a delivery naming it is not history to
  // honour, it is a product we do not sell. Concatenated rather than written
  // out so `git grep` can keep proving the purge (see lib/revenuecat.test.ts).
  configured(t);
  const db = stubDb(t);
  const fetches = stubFetch(t);

  for (const productId of [`${RC_LIFETIME_PRODUCT_IDS[0]}time`, "com.evil.app.pro"]) {
    const res = await deliver(eventBody({ id: `evt-${productId}`, product_id: productId }));

    assert.equal(res.status, 200, "a refusal is terminal — redelivering changes nothing");
    assert.match(res.body.skipped, /not one we sell/);
  }
  // Not a single row, and not even a subscriber fetch: the refusal lands
  // before the claim, so there is nothing to write and nothing to retry.
  assert.equal(fetches.length, 0);
  assert.equal(db.eventCreate.length, 0);
  assert.equal(db.subUpsert.length, 0);
  assert.equal(db.purchaseUpsert.length, 0);
  assert.equal(db.subSweep.length, 0);
  assert.equal(db.purchaseSweep.length, 0);
});

test("the lifetime product IS sold: it is claimed, fetched and written", async (t) => {
  // The other half of the allow-list test above — proof that the id the purge
  // settled on is the one that actually works end to end.
  configured(t);
  const lifetime = RC_LIFETIME_PRODUCT_IDS[0];
  stubFetch(t, () =>
    subscriber({
      subscriptions: {},
      non_subscriptions: {
        [lifetime]: [{ id: "txn1", purchase_date: "2026-08-01T00:00:00.000Z", is_sandbox: false }],
      },
      entitlements: { pro: { product_identifier: lifetime } },
    }),
  );
  const db = stubDb(t);

  const res = await deliver(
    eventBody({ id: "evt-lifetime", type: "NON_RENEWING_PURCHASE", product_id: lifetime }),
  );

  assert.equal(res.status, 200);
  assert.equal(res.body.status, "processed");
  assert.equal(db.purchaseUpsert.length, 1);
  const written = db.purchaseUpsert[0][0];
  assert.equal(written.create.userId, USER);
  assert.equal(written.create.externalId, `${USER}:${lifetime}`);
  assert.equal(written.update.productId, lifetime);
  assert.equal(written.update.isRefunded, false, "a live lifetime grants");
  assert.equal(written.update.testMode, false);
});

test("someone else's app is refused once an allow-list is configured", async (t) => {
  configured(t, { revenuecatAllowedAppIds: ["ourapp1"] });
  stubDb(t);
  const fetches = stubFetch(t);

  const res = await deliver(eventBody({ app_id: "not-ours" }));

  assert.equal(res.status, 200);
  assert.match(res.body.skipped, /not ours/);
  assert.equal(fetches.length, 0);
});

test("a store that is not the App Store is refused; TRANSFER may carry none", async (t) => {
  configured(t);
  stubDb(t);
  const fetches = stubFetch(t);

  const foreign = await deliver(eventBody({ store: "PLAY_STORE" }));
  assert.equal(foreign.status, 200);
  assert.match(foreign.body.skipped, /not ours/);
  assert.equal(fetches.length, 0);

  const transfer = await deliver(
    eventBody({
      id: "evt-transfer",
      type: "TRANSFER",
      store: undefined,
      product_id: undefined,
      app_user_id: undefined,
      transferred_to: [USER],
      transferred_from: [],
    }),
  );
  assert.equal(transfer.status, 200);
  assert.equal(transfer.body.status, "processed");
});

/* ── dedupe ─────────────────────────────────────────────────────────────── */

const duplicateKey = () =>
  new Prisma.PrismaClientKnownRequestError("duplicate", { code: "P2002", clientVersion: "5" });

test("a redelivery of an event already finished does no work at all", async (t) => {
  configured(t);
  const fetches = stubFetch(t);
  const db = stubDb(t, {
    eventCreate: async () => {
      throw duplicateKey();
    },
    eventFind: async () => ({ status: "processed" }),
  });

  const res = await deliver(eventBody());

  assert.equal(res.status, 200);
  assert.equal(res.body.deduped, true);
  assert.equal(fetches.length, 0);
  assert.equal(db.subUpsert.length, 0);
});

test("the same delivery twice is one piece of work — idempotence end to end", async (t) => {
  configured(t);
  const fetches = stubFetch(t);
  // A stateful WebhookEvent table in one object, so the SECOND delivery
  // genuinely collides on the unique index the way MongoDB would make it.
  const store = new Map<string, { status: string }>();
  stubDb(t, {
    eventCreate: async (args: any) => {
      if (store.has(args.data.eventId)) throw duplicateKey();
      store.set(args.data.eventId, { status: "processing" });
      return {};
    },
    eventFind: async (args: any) => store.get(args.where.provider_eventId.eventId) ?? null,
    eventMark: async (args: any) => {
      const row = store.get(args.where.eventId);
      if (row && !["processed", "skipped"].includes(row.status)) row.status = args.data.status;
      return { count: 1 };
    },
  });

  const first = await deliver(eventBody({ id: "evt-idem" }));
  const second = await deliver(eventBody({ id: "evt-idem" }));

  assert.equal(first.status, 200);
  assert.equal(first.body.status, "processed");
  assert.equal(second.status, 200);
  assert.equal(second.body.deduped, true);
  assert.equal(fetches.length, 1, "one delivery's worth of API traffic, not two");
});

/* ── the work: re-fetch and mirror ──────────────────────────────────────── */

test("out-of-order events converge: RENEWAL before INITIAL_PURCHASE writes the same state", async (t) => {
  configured(t);
  stubFetch(t); // one fixed subscriber state, whatever the event claims
  const db = stubDb(t);

  const renewal = await deliver(eventBody({ id: "evt-renewal", type: "RENEWAL" }));
  const initial = await deliver(eventBody({ id: "evt-initial", type: "INITIAL_PURCHASE" }));

  assert.equal(renewal.status, 200);
  assert.equal(initial.status, 200);
  assert.equal(db.subUpsert.length, 2);
  const [first, second] = db.subUpsert.map((c) => c[0].update);
  // Identical mirrored state — only our fetch clock may differ.
  const strip = ({ providerUpdatedAt, ...rest }: any) => rest;
  assert.deepEqual(strip(first), strip(second));
  assert.equal(first.status, "active");
});

test("a SANDBOX event is processed, and its rows arrive flagged testMode", async (t) => {
  configured(t); // note: revenuecatAllowSandbox is FALSE — recording is not granting
  stubFetch(t, () =>
    subscriber({
      subscriptions: {
        [RC_PRODUCT_YEARLY]: { expires_date: FUTURE, period_type: "trial", is_sandbox: true },
      },
      entitlements: { pro: { product_identifier: RC_PRODUCT_YEARLY, expires_date: FUTURE } },
    }),
  );
  const db = stubDb(t);

  const res = await deliver(
    eventBody({ environment: "SANDBOX", product_id: RC_PRODUCT_YEARLY }),
  );

  assert.equal(res.status, 200);
  assert.equal(res.body.status, "processed", "skipping sandbox would strand every TestFlight tester");
  assert.equal(db.subUpsert.length, 1);
  const written = db.subUpsert[0][0];
  assert.equal(written.update.testMode, true);
  assert.equal(written.update.environment, "sandbox");
  assert.equal(written.create.userId, USER);
});

test("an anonymous app_user_id is understood, logged without the id, and skipped", async (t) => {
  configured(t);
  const fetches = stubFetch(t);
  const db = stubDb(t);

  const res = await deliver(
    eventBody({ app_user_id: "$RCAnonymousID:87c6049c58069238dce29853f9644e44" }),
  );

  assert.equal(res.status, 200);
  assert.equal(res.body.status, "skipped");
  assert.equal(fetches.length, 0);
  assert.equal(finalStatus(db.eventMark), "skipped");
});

test("an id shaped like ours but matching no account is skipped, not guessed at", async (t) => {
  configured(t);
  const fetches = stubFetch(t);
  const db = stubDb(t, { userFind: async () => null });

  const res = await deliver(eventBody());

  assert.equal(res.status, 200);
  assert.equal(res.body.status, "skipped");
  assert.equal(fetches.length, 0);
  assert.equal(finalStatus(db.eventMark), "skipped");
});

test("a TRANSFER re-syncs BOTH sides — the loser must lose access too", async (t) => {
  configured(t);
  const fetches = stubFetch(t, (url) =>
    url.includes(USER)
      ? subscriber() // the receiving account now holds the subscription…
      : subscriber({ subscriptions: {}, entitlements: {} }), // …and the losing one holds nothing
  );
  // Record every sweep with the userId it targeted and the externalIds it spared.
  const sweeps: { userId: string; notIn: string[] }[] = [];
  const db = stubDb(t, {
    subSweep: async (args: any) => {
      sweeps.push({ userId: args.where.userId, notIn: args.where.externalId.notIn });
      return { count: 1 };
    },
  });

  const res = await deliver(
    eventBody({
      id: "evt-transfer-2",
      type: "TRANSFER",
      store: "APP_STORE",
      product_id: undefined,
      app_user_id: undefined,
      transferred_to: [USER],
      transferred_from: [OTHER_USER],
    }),
  );

  assert.equal(res.status, 200);
  assert.equal(res.body.status, "processed");
  assert.equal(fetches.length, 2);
  const urls = fetches.map((c) => String(c[0]));
  assert.ok(urls.some((u) => u.includes(USER)));
  assert.ok(urls.some((u) => u.includes(OTHER_USER)));
  // The receiver's snapshot mirrors its subscription.
  assert.equal(db.subUpsert.length, 1);
  assert.equal(db.subUpsert[0][0].create.userId, USER);

  // THE FIX: the loser's empty snapshot does NOT write nothing — it SWEEPS.
  // Its sweep spares no externalId (notIn: []), so every RC row it holds is
  // revoked; the receiver's sweep spares exactly the row it just wrote.
  const loserSweep = sweeps.find((s) => s.userId === OTHER_USER);
  assert.ok(loserSweep, "the losing account must be swept");
  assert.deepEqual(loserSweep!.notIn, [], "an empty snapshot spares nothing — every RC row is revoked");
  const winnerSweep = sweeps.find((s) => s.userId === USER);
  assert.ok(winnerSweep, "the winner is swept too, sparing what it just mirrored");
  assert.deepEqual(winnerSweep!.notIn, [`${USER}:${RC_PRODUCT_MONTHLY}`]);
});

test("a RevenueCat outage marks the event failed and asks for redelivery", async (t) => {
  configured(t);
  stubFetch(t, () => ({ boom: true }));
  const db = stubDb(t);

  const res = await deliver(eventBody({ id: "evt-outage" }));

  assert.equal(res.status, 500, "a state we failed to mirror must be redelivered");
  assert.equal(finalStatus(db.eventMark), "failed");
});

test("a body whose shape we do not recognise fails the event — it NEVER mass-revokes", async (t) => {
  // If RevenueCat's response shape ever changes, the old degrade-to-empty
  // behaviour would have swept every syncing account's rows. It must park and
  // retry instead, writing no revocation at all.
  configured(t);
  const db = stubDb(t);
  stubMethod(
    t,
    globalThis as any,
    "fetch",
    async () => new Response(JSON.stringify({ request_date: "2026-08-12" }), { status: 200 }),
  );

  const res = await deliver(eventBody({ id: "evt-badshape" }));

  assert.equal(res.status, 500, "an unreadable upstream must be redelivered, not acted on");
  assert.equal(finalStatus(db.eventMark), "failed");
  assert.equal(db.subSweep.length, 0, "no revocation on a response we could not read");
  assert.equal(db.purchaseSweep.length, 0);
});

test("a 404 subscriber sweeps nothing — the account keeps what it holds", async (t) => {
  configured(t);
  const db = stubDb(t);
  stubMethod(t, globalThis as any, "fetch", async () => new Response("", { status: 404 }));

  const res = await deliver(eventBody({ id: "evt-404" }));

  // Processed, not failed: a 404 is a coherent answer, just not an
  // authoritative empty one. Nothing to mirror, and nothing to revoke.
  assert.equal(res.status, 200);
  assert.equal(res.body.status, "processed");
  assert.equal(db.subSweep.length, 0, "a 404 must never revoke a licence");
  assert.equal(db.purchaseSweep.length, 0);
});

/* ── sandbox: recorded, isolated, and never a production right ──────────── */

/*
 * With no staging deploy (one Vercel project, one Atlas database), sandbox
 * transactions land at the SAME backend as real money, for the same accounts.
 * Whether they GRANT is decided at read time per account
 * (REVENUECAT_SANDBOX_ALLOWED_USER_IDS — see routes/billing.test.ts). What the
 * webhook owes is the other half: writing rows that can be told apart at all,
 * from RevenueCat's data rather than from the delivery's claims.
 */

test("the row's environment comes from the re-fetched subscriber, never from the event", async (t) => {
  configured(t);
  // The delivery CLAIMS production. The subscriber we re-fetch says sandbox —
  // and the re-fetch is the state, so sandbox is what gets written.
  stubFetch(t, () =>
    subscriber({
      subscriptions: {
        [RC_PRODUCT_MONTHLY]: { expires_date: FUTURE, period_type: "normal", is_sandbox: true },
      },
    }),
  );
  const db = stubDb(t);

  const res = await deliver(eventBody({ id: "evt-env-claims-prod", environment: "PRODUCTION" }));

  assert.equal(res.status, 200);
  assert.equal(db.subUpsert[0][0].update.environment, "sandbox");
  assert.equal(db.subUpsert[0][0].update.testMode, true, "an event cannot launder a free purchase");
});

test("…and the reverse: an event crying SANDBOX cannot hide a production purchase", async (t) => {
  configured(t);
  stubFetch(t); // the default subscriber: a real, paid monthly
  const db = stubDb(t);

  const res = await deliver(eventBody({ id: "evt-env-claims-sandbox", environment: "SANDBOX" }));

  assert.equal(res.status, 200);
  assert.equal(db.subUpsert[0][0].update.environment, "production");
  assert.equal(db.subUpsert[0][0].update.testMode, false);
});

test("a SANDBOX lifetime lands on its OWN row — the paid lifetime is untouched", async (t) => {
  // The cohabitation that actually happens: a customer who bought the lifetime
  // for real installs a TestFlight build and buys it again in the sandbox.
  // Both entries sit in the same `non_subscriptions` list, and if the sandbox
  // one landed on the paid row it would stamp it testMode — hiding, from a
  // paying customer, the licence they own, because they helped us test.
  configured(t);
  const lifetime = RC_LIFETIME_PRODUCT_IDS[0];
  stubFetch(t, () =>
    subscriber({
      subscriptions: {},
      non_subscriptions: {
        [lifetime]: [
          { id: "txn-paid", purchase_date: "2026-07-01T00:00:00.000Z", is_sandbox: false },
          { id: "txn-testflight", purchase_date: "2026-08-12T09:00:00.000Z", is_sandbox: true },
        ],
      },
      entitlements: { pro: { product_identifier: lifetime } },
    }),
  );
  const db = stubDb(t);

  const res = await deliver(
    eventBody({
      id: "evt-sandbox-lifetime",
      type: "NON_RENEWING_PURCHASE",
      environment: "SANDBOX",
      product_id: lifetime,
    }),
  );

  assert.equal(res.status, 200);
  assert.equal(res.body.status, "processed");
  assert.equal(db.purchaseUpsert.length, 2, "two environments, two rows");
  const byId = Object.fromEntries(
    db.purchaseUpsert.map((c) => [c[0].where.provider_externalId.externalId, c[0]]),
  );
  const paid = byId[`${USER}:${lifetime}`];
  const sandbox = byId[`${USER}:${lifetime}:sandbox`];
  assert.ok(paid && sandbox, "the paid row and the sandbox row are distinct");
  assert.equal(paid.update.testMode, false, "the paid row is never stamped test");
  assert.equal(paid.update.isRefunded, false, "…and never stops granting");
  assert.equal(paid.update.environment, "production");
  assert.equal(sandbox.update.testMode, true);
  assert.equal(sandbox.update.environment, "sandbox");
  // …and the sweep spares BOTH, so neither is revoked on the way past.
  assert.deepEqual(
    [...db.purchaseSweep[0][0].where.externalId.notIn].sort(),
    [`${USER}:${lifetime}`, `${USER}:${lifetime}:sandbox`].sort(),
  );
});
