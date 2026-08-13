import assert from "node:assert/strict";
import { test } from "node:test";
import request from "supertest";
import { createApp } from "../app";
import { stubAccountGuard } from "./test-helpers";
import { signToken } from "../lib/jwt";
import { prisma } from "../lib/prisma";
import { env } from "../lib/env";

const app = createApp();

// This router now sits behind the account guard (see app.ts), which reads the
// caller's account on every request. Answer that one read for the whole file;
// every other user lookup still falls through and fails loudly if unstubbed.
stubAccountGuard();
const userId = "507f1f77bcf86cd799439011";
const auth = {
  authorization: `Bearer ${signToken({ sub: userId, email: "user@example.com" })}`,
};

function stubMethod(
  t: { after: (fn: () => void) => void },
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

/** Configure the storefront for the length of one test. */
function configured(t: { after: (fn: () => void) => void }) {
  const keys = [
    "lemonSqueezyApiKey",
    "lemonSqueezyStoreId",
    "lemonSqueezyVariantId",
    "lemonSqueezyVariantMonthly",
    "lemonSqueezyVariantYearly",
  ] as const;
  const before = Object.fromEntries(keys.map((k) => [k, env[k]]));
  // The real ids, so a mapping bug reads as a wrong NUMBER rather than as a
  // placeholder that would look equally wrong whichever plan produced it.
  (env as any).lemonSqueezyApiKey = "test-key";
  (env as any).lemonSqueezyStoreId = "364783";
  (env as any).lemonSqueezyVariantId = "1960881";
  (env as any).lemonSqueezyVariantMonthly = "1986433";
  (env as any).lemonSqueezyVariantYearly = "1986420";
  t.after(() => {
    for (const k of keys) (env as any)[k] = before[k];
  });
}

function stubFetch(t: { after: (fn: () => void) => void }, impl: (...args: any[]) => any) {
  const original = globalThis.fetch;
  (globalThis as any).fetch = impl;
  t.after(() => {
    (globalThis as any).fetch = original;
  });
}

test("checkout requires a bearer token", async () => {
  const res = await request(app).post("/api/checkout");
  assert.equal(res.status, 401);
});

test("a checkout carries the caller's own user id, not one the buyer chose", async (t) => {
  stubMethod(t, prisma.acquisitionLock as any, "findUnique", async () => null);
  stubMethod(t, prisma.acquisitionLock as any, "create", async (a: any) => a.data);
  stubMethod(t, prisma.acquisitionLock as any, "updateMany", async () => ({ count: 1 }));
  stubMethod(t, prisma.acquisitionLock as any, "deleteMany", async () => ({ count: 1 }));
  stubMethod(t, prisma.checkoutIntent as any, "findUnique", async () => null);
  stubMethod(t, prisma.checkoutIntent as any, "create", async (a: any) => ({ id: "intent-1", ...a.data }));
  stubMethod(t, prisma.checkoutIntent as any, "updateMany", async () => ({ count: 1 }));
  stubMethod(t, prisma as any, "$transaction", async (fn: any) => (typeof fn === "function" ? fn(prisma) : Promise.all(fn)));
  stubMethod(t, prisma.subscription as any, "findMany", async () => []);
  stubMethod(t, prisma.billingTask as any, "findMany", async () => []);
  stubMethod(t, prisma.trialClaim as any, "findUnique", async () => null);
  configured(t);
  stubMethod(t, prisma.user as any, "findUnique", async () => ({ email: "user@example.com" }));
  stubMethod(t, prisma.purchase as any, "findFirst", async () => null);

  let sent: any = null;
  stubFetch(t, async (_url: string, init: any) => {
    sent = JSON.parse(init.body);
    return {
      ok: true,
      status: 201,
      json: async () => ({ data: { attributes: { url: "https://the-hnh.lemonsqueezy.com/checkout/abc" } } }),
    };
  });

  const res = await request(app).post("/api/checkout").set(auth).send({ plan: "lifetime" });

  assert.equal(res.status, 201, res.text);
  assert.equal(res.body.url, "https://the-hnh.lemonsqueezy.com/checkout/abc");
  // The whole reason this endpoint exists: the account is bound server-side,
  // from the token, before the payment page is created.
  assert.equal(sent.data.attributes.checkout_data.custom.user_id, userId);
  assert.equal(sent.data.relationships.variant.data.id, "1960881");
  // The return path: the confirmation button and the receipt email both point
  // at the bridge page that fires the desktop's welockin:// deep link, and
  // `[order_id]` is Lemon Squeezy's link variable — substituted at render, it
  // is what lets POST /checkout/confirm verify the purchase at the source.
  // Pinned by a test because deleting either field would silently degrade
  // every future purchase to "nothing happens after paying".
  assert.equal(
    sent.data.attributes.product_options.redirect_url,
    `${env.publicSiteUrl}/thanks?order_id=[order_id]`,
  );
  assert.equal(
    sent.data.attributes.product_options.receipt_link_url,
    `${env.publicSiteUrl}/thanks?order_id=[order_id]`,
  );
});

test("someone who already owns the licence is not sent to pay again", async (t) => {
  stubMethod(t, prisma.acquisitionLock as any, "findUnique", async () => null);
  stubMethod(t, prisma.acquisitionLock as any, "create", async (a: any) => a.data);
  stubMethod(t, prisma.acquisitionLock as any, "updateMany", async () => ({ count: 1 }));
  stubMethod(t, prisma.acquisitionLock as any, "deleteMany", async () => ({ count: 1 }));
  stubMethod(t, prisma.checkoutIntent as any, "findUnique", async () => null);
  stubMethod(t, prisma.checkoutIntent as any, "create", async (a: any) => ({ id: "intent-1", ...a.data }));
  stubMethod(t, prisma.checkoutIntent as any, "updateMany", async () => ({ count: 1 }));
  stubMethod(t, prisma as any, "$transaction", async (fn: any) => (typeof fn === "function" ? fn(prisma) : Promise.all(fn)));
  stubMethod(t, prisma.subscription as any, "findMany", async () => []);
  stubMethod(t, prisma.billingTask as any, "findMany", async () => []);
  stubMethod(t, prisma.trialClaim as any, "findUnique", async () => null);
  configured(t);
  stubMethod(t, prisma.user as any, "findUnique", async () => ({ email: "user@example.com" }));
  stubMethod(t, prisma.purchase as any, "findFirst", async () => ({ id: "purchase-1" }));
  stubFetch(t, async () => {
    throw new Error("must not reach Lemon Squeezy");
  });

  const res = await request(app).post("/api/checkout").set(auth).send({ plan: "lifetime" });

  assert.equal(res.status, 409);
});

// A refunded purchase is not ownership: that customer may buy again.
test("a refunded purchase does not block a new checkout", async (t) => {
  stubMethod(t, prisma.acquisitionLock as any, "findUnique", async () => null);
  stubMethod(t, prisma.acquisitionLock as any, "create", async (a: any) => a.data);
  stubMethod(t, prisma.acquisitionLock as any, "updateMany", async () => ({ count: 1 }));
  stubMethod(t, prisma.acquisitionLock as any, "deleteMany", async () => ({ count: 1 }));
  stubMethod(t, prisma.checkoutIntent as any, "findUnique", async () => null);
  stubMethod(t, prisma.checkoutIntent as any, "create", async (a: any) => ({ id: "intent-1", ...a.data }));
  stubMethod(t, prisma.checkoutIntent as any, "updateMany", async () => ({ count: 1 }));
  stubMethod(t, prisma as any, "$transaction", async (fn: any) => (typeof fn === "function" ? fn(prisma) : Promise.all(fn)));
  stubMethod(t, prisma.subscription as any, "findMany", async () => []);
  stubMethod(t, prisma.billingTask as any, "findMany", async () => []);
  stubMethod(t, prisma.trialClaim as any, "findUnique", async () => null);
  configured(t);
  stubMethod(t, prisma.user as any, "findUnique", async () => ({ email: "user@example.com" }));
  // The route asks only for a live one, so the refunded row is simply not found.
  const calls = stubMethod(t, prisma.purchase as any, "findFirst", async () => null);
  stubFetch(t, async () => ({
    ok: true,
    status: 201,
    json: async () => ({ data: { attributes: { url: "https://example.test/c" } } }),
  }));

  const res = await request(app).post("/api/checkout").set(auth).send({ plan: "lifetime" });

  assert.equal(res.status, 201, res.text);
  assert.equal(calls[0][0].where.isRefunded, false);
});

test("an unconfigured storefront fails loudly instead of returning a dead button", async (t) => {
  stubMethod(t, prisma.purchase as any, "findFirst", async () => null);
  stubMethod(t, prisma.acquisitionLock as any, "findUnique", async () => null);
  stubMethod(t, prisma.acquisitionLock as any, "create", async (a: any) => a.data);
  stubMethod(t, prisma.acquisitionLock as any, "updateMany", async () => ({ count: 1 }));
  stubMethod(t, prisma.acquisitionLock as any, "deleteMany", async () => ({ count: 1 }));
  stubMethod(t, prisma.checkoutIntent as any, "findUnique", async () => null);
  stubMethod(t, prisma.checkoutIntent as any, "create", async (a: any) => ({ id: "intent-1", ...a.data }));
  stubMethod(t, prisma.checkoutIntent as any, "updateMany", async () => ({ count: 1 }));
  stubMethod(t, prisma as any, "$transaction", async (fn: any) => (typeof fn === "function" ? fn(prisma) : Promise.all(fn)));
  stubMethod(t, prisma.subscription as any, "findMany", async () => []);
  stubMethod(t, prisma.billingTask as any, "findMany", async () => []);
  stubMethod(t, prisma.trialClaim as any, "findUnique", async () => null);
  const before = env.lemonSqueezyVariantId;
  (env as any).lemonSqueezyVariantId = "";
  t.after(() => {
    (env as any).lemonSqueezyVariantId = before;
  });

  const res = await request(app).post("/api/checkout").set(auth).send({ plan: "lifetime" });

  assert.equal(res.status, 400);
});

test("a provider outage does not leak the request or hang the caller", async (t) => {
  stubMethod(t, prisma.acquisitionLock as any, "findUnique", async () => null);
  stubMethod(t, prisma.acquisitionLock as any, "create", async (a: any) => a.data);
  stubMethod(t, prisma.acquisitionLock as any, "updateMany", async () => ({ count: 1 }));
  stubMethod(t, prisma.acquisitionLock as any, "deleteMany", async () => ({ count: 1 }));
  stubMethod(t, prisma.checkoutIntent as any, "findUnique", async () => null);
  stubMethod(t, prisma.checkoutIntent as any, "create", async (a: any) => ({ id: "intent-1", ...a.data }));
  stubMethod(t, prisma.checkoutIntent as any, "updateMany", async () => ({ count: 1 }));
  stubMethod(t, prisma as any, "$transaction", async (fn: any) => (typeof fn === "function" ? fn(prisma) : Promise.all(fn)));
  stubMethod(t, prisma.trialClaim as any, "findUnique", async () => null);
  stubMethod(t, prisma.subscription as any, "findMany", async () => []);
  stubMethod(t, prisma.billingTask as any, "findMany", async () => []);
  configured(t);
  stubMethod(t, prisma.user as any, "findUnique", async () => ({ email: "user@example.com" }));
  stubMethod(t, prisma.purchase as any, "findFirst", async () => null);
  stubFetch(t, async () => {
    throw new Error("connect ECONNREFUSED — Bearer test-key");
  });

  const res = await request(app).post("/api/checkout").set(auth).send({ plan: "lifetime" });

  // A dropped connection does not prove nothing was created — see the intent
  // state machine. The lock is held and the caller told to wait.
  assert.equal(res.status, 503, res.text);
  assert.equal(res.body.code, "CHECKOUT_STATE_UNCERTAIN");
  // The upstream message quoted the Authorization header; it must not travel.
  assert.ok(!JSON.stringify(res.body).includes("test-key"));
});

// --- Plans -------------------------------------------------------------------

// Turning a plan NAME into a variant id is the security boundary of this
// endpoint — it is what stops a caller naming a variant of their own choosing.
// Assert it by number, per plan.
for (const [plan, variantId] of [
  ["monthly", "1986433"],
  ["yearly", "1986420"],
  ["lifetime", "1960881"],
] as const) {
  test(`the "${plan}" plan is minted against its own variant`, async (t) => {
    stubMethod(t, prisma.acquisitionLock as any, "findUnique", async () => null);
    stubMethod(t, prisma.acquisitionLock as any, "create", async (a: any) => a.data);
    stubMethod(t, prisma.acquisitionLock as any, "updateMany", async () => ({ count: 1 }));
    stubMethod(t, prisma.acquisitionLock as any, "deleteMany", async () => ({ count: 1 }));
    stubMethod(t, prisma.checkoutIntent as any, "findUnique", async () => null);
    stubMethod(t, prisma.checkoutIntent as any, "create", async (a: any) => ({ id: "intent-1", ...a.data }));
    stubMethod(t, prisma.checkoutIntent as any, "updateMany", async () => ({ count: 1 }));
    stubMethod(t, prisma as any, "$transaction", async (fn: any) => (typeof fn === "function" ? fn(prisma) : Promise.all(fn)));
    stubMethod(t, prisma.trialClaim as any, "findUnique", async () => null);
    configured(t);
    stubMethod(t, prisma.user as any, "findUnique", async () => ({ email: "user@example.com" }));
    stubMethod(t, prisma.purchase as any, "findFirst", async () => null);
    stubMethod(t, prisma.subscription as any, "findMany", async () => []);
  stubMethod(t, prisma.billingTask as any, "findMany", async () => []);

    let sent: any = null;
    stubFetch(t, async (_url: string, init: any) => {
      sent = JSON.parse(init.body);
      return {
        ok: true,
        status: 201,
        json: async () => ({ data: { attributes: { url: "https://example.test/c" } } }),
      };
    });

    const res = await request(app).post("/api/checkout").set(auth).send({ plan });

    assert.equal(res.status, 201, res.text);
    assert.equal(sent.data.relationships.variant.data.id, variantId);
  });
}

/* ── One free trial per account (skip_trial) ────────────────────────────── */

test("a first-time subscriber gets the trial (no skip_trial in the checkout)", async (t) => {
  stubMethod(t, prisma.acquisitionLock as any, "findUnique", async () => null);
  stubMethod(t, prisma.acquisitionLock as any, "create", async (a: any) => a.data);
  stubMethod(t, prisma.acquisitionLock as any, "updateMany", async () => ({ count: 1 }));
  stubMethod(t, prisma.acquisitionLock as any, "deleteMany", async () => ({ count: 1 }));
  stubMethod(t, prisma.checkoutIntent as any, "findUnique", async () => null);
  stubMethod(t, prisma.checkoutIntent as any, "create", async (a: any) => ({ id: "intent-1", ...a.data }));
  stubMethod(t, prisma.checkoutIntent as any, "updateMany", async () => ({ count: 1 }));
  stubMethod(t, prisma as any, "$transaction", async (fn: any) => (typeof fn === "function" ? fn(prisma) : Promise.all(fn)));
  stubMethod(t, prisma.trialClaim as any, "findUnique", async () => null);
  configured(t);
  stubMethod(t, prisma.user as any, "findUnique", async () => ({ email: "user@example.com" }));
  stubMethod(t, prisma.purchase as any, "findFirst", async () => null);
  // No prior subscription rows.
  stubMethod(t, prisma.subscription as any, "findMany", async () => []);
  stubMethod(t, prisma.billingTask as any, "findMany", async () => []);
  let sent: any = null;
  stubFetch(t, async (_url: string, init: any) => {
    sent = JSON.parse(init.body);
    return { ok: true, status: 201, json: async () => ({ data: { attributes: { url: "https://x/c" } } }) };
  });

  await request(app).post("/api/checkout").set(auth).send({ plan: "monthly" });

  assert.ok(
    !sent.data.attributes.checkout_options,
    "a first-time subscriber must be offered the trial the paywall promised",
  );
});

test("a returning account whose subscription lapsed gets NO second trial", async (t) => {
  stubMethod(t, prisma.acquisitionLock as any, "findUnique", async () => null);
  stubMethod(t, prisma.acquisitionLock as any, "create", async (a: any) => a.data);
  stubMethod(t, prisma.acquisitionLock as any, "updateMany", async () => ({ count: 1 }));
  stubMethod(t, prisma.acquisitionLock as any, "deleteMany", async () => ({ count: 1 }));
  stubMethod(t, prisma.checkoutIntent as any, "findUnique", async () => null);
  stubMethod(t, prisma.checkoutIntent as any, "create", async (a: any) => ({ id: "intent-1", ...a.data }));
  stubMethod(t, prisma.checkoutIntent as any, "updateMany", async () => ({ count: 1 }));
  stubMethod(t, prisma as any, "$transaction", async (fn: any) => (typeof fn === "function" ? fn(prisma) : Promise.all(fn)));
  stubMethod(t, prisma.trialClaim as any, "findUnique", async () => null);
  configured(t);
  stubMethod(t, prisma.user as any, "findUnique", async () => ({ email: "user@example.com" }));
  stubMethod(t, prisma.purchase as any, "findFirst", async () => null);
  // An expired subscription row exists — they have subscribed (and trialed) before.
  stubMethod(t, prisma.subscription as any, "findMany", async () => [
    { status: "expired", validUntil: new Date(Date.now() - 86_400_000) },
  ]);
  stubMethod(t, prisma.billingTask as any, "findMany", async () => []);
  let sent: any = null;
  stubFetch(t, async (_url: string, init: any) => {
    sent = JSON.parse(init.body);
    return { ok: true, status: 201, json: async () => ({ data: { attributes: { url: "https://x/c" } } }) };
  });

  await request(app).post("/api/checkout").set(auth).send({ plan: "monthly" });

  assert.equal(
    sent.data.attributes.checkout_options.skip_trial,
    true,
    "the trial is a first-time offer, not a renewable one",
  );
});

test("a NEW account on a machine that already trialed gets NO trial (per-device)", async (t) => {
  stubMethod(t, prisma.acquisitionLock as any, "findUnique", async () => null);
  stubMethod(t, prisma.acquisitionLock as any, "create", async (a: any) => a.data);
  stubMethod(t, prisma.acquisitionLock as any, "updateMany", async () => ({ count: 1 }));
  stubMethod(t, prisma.acquisitionLock as any, "deleteMany", async () => ({ count: 1 }));
  stubMethod(t, prisma.checkoutIntent as any, "findUnique", async () => null);
  stubMethod(t, prisma.checkoutIntent as any, "create", async (a: any) => ({ id: "intent-1", ...a.data }));
  stubMethod(t, prisma.checkoutIntent as any, "updateMany", async () => ({ count: 1 }));
  stubMethod(t, prisma as any, "$transaction", async (fn: any) => (typeof fn === "function" ? fn(prisma) : Promise.all(fn)));
  configured(t);
  stubMethod(t, prisma.user as any, "findUnique", async () => ({ email: "fresh@example.com" }));
  stubMethod(t, prisma.purchase as any, "findFirst", async () => null);
  // Brand-new account: no subscription rows of its own…
  stubMethod(t, prisma.subscription as any, "findMany", async () => []);
  stubMethod(t, prisma.billingTask as any, "findMany", async () => []);
  // …but THIS MACHINE already has a trial claim.
  stubMethod(t, prisma.trialClaim as any, "findUnique", async () => ({ id: "claim-1" }));
  let sent: any = null;
  stubFetch(t, async (_url: string, init: any) => {
    sent = JSON.parse(init.body);
    return { ok: true, status: 201, json: async () => ({ data: { attributes: { url: "https://x/c" } } }) };
  });

  await request(app)
    .post("/api/checkout")
    .set(auth)
    .set("x-welockin-device-id", "win-abc")
    .send({ plan: "monthly" });

  assert.equal(sent.data.attributes.checkout_options.skip_trial, true, "the machine already used its trial");
  // The device id rides in custom_data so the webhook can record the next trial.
  assert.equal(sent.data.attributes.checkout_data.custom.device_id, "win-abc");
});

test("the shared 'unidentified' device id is treated as no device (fail open)", async (t) => {
  stubMethod(t, prisma.acquisitionLock as any, "findUnique", async () => null);
  stubMethod(t, prisma.acquisitionLock as any, "create", async (a: any) => a.data);
  stubMethod(t, prisma.acquisitionLock as any, "updateMany", async () => ({ count: 1 }));
  stubMethod(t, prisma.acquisitionLock as any, "deleteMany", async () => ({ count: 1 }));
  stubMethod(t, prisma.checkoutIntent as any, "findUnique", async () => null);
  stubMethod(t, prisma.checkoutIntent as any, "create", async (a: any) => ({ id: "intent-1", ...a.data }));
  stubMethod(t, prisma.checkoutIntent as any, "updateMany", async () => ({ count: 1 }));
  stubMethod(t, prisma as any, "$transaction", async (fn: any) => (typeof fn === "function" ? fn(prisma) : Promise.all(fn)));
  configured(t);
  stubMethod(t, prisma.user as any, "findUnique", async () => ({ email: "user@example.com" }));
  stubMethod(t, prisma.purchase as any, "findFirst", async () => null);
  stubMethod(t, prisma.subscription as any, "findMany", async () => []);
  stubMethod(t, prisma.billingTask as any, "findMany", async () => []);
  // If this were consulted with the shared id, one machine would burn the trial
  // for all of them. It must NOT be consulted at all.
  let claimLookups = 0;
  stubMethod(t, prisma.trialClaim as any, "findUnique", async () => {
    claimLookups += 1;
    return { id: "claim-shared" };
  });
  let sent: any = null;
  stubFetch(t, async (_url: string, init: any) => {
    sent = JSON.parse(init.body);
    return { ok: true, status: 201, json: async () => ({ data: { attributes: { url: "https://x/c" } } }) };
  });

  await request(app)
    .post("/api/checkout")
    .set(auth)
    .set("x-welockin-device-id", "win-unidentified")
    .send({ plan: "monthly" });

  assert.equal(claimLookups, 0, "the shared fallback id must never key the per-machine ledger");
  assert.ok(!sent.data.attributes.checkout_options, "an unreadable machine still gets its trial");
  assert.ok(!sent.data.attributes.checkout_data.custom.device_id, "and its shared id is not recorded");
});

test("a variant id supplied by the caller is ignored", async (t) => {
  stubMethod(t, prisma.acquisitionLock as any, "findUnique", async () => null);
  stubMethod(t, prisma.acquisitionLock as any, "create", async (a: any) => a.data);
  stubMethod(t, prisma.acquisitionLock as any, "updateMany", async () => ({ count: 1 }));
  stubMethod(t, prisma.acquisitionLock as any, "deleteMany", async () => ({ count: 1 }));
  stubMethod(t, prisma.checkoutIntent as any, "findUnique", async () => null);
  stubMethod(t, prisma.checkoutIntent as any, "create", async (a: any) => ({ id: "intent-1", ...a.data }));
  stubMethod(t, prisma.checkoutIntent as any, "updateMany", async () => ({ count: 1 }));
  stubMethod(t, prisma as any, "$transaction", async (fn: any) => (typeof fn === "function" ? fn(prisma) : Promise.all(fn)));
  stubMethod(t, prisma.trialClaim as any, "findUnique", async () => null);
  configured(t);
  stubMethod(t, prisma.user as any, "findUnique", async () => ({ email: "user@example.com" }));
  stubMethod(t, prisma.purchase as any, "findFirst", async () => null);
  stubMethod(t, prisma.subscription as any, "findMany", async () => []);
  stubMethod(t, prisma.billingTask as any, "findMany", async () => []);

  let sent: any = null;
  stubFetch(t, async (_url: string, init: any) => {
    sent = JSON.parse(init.body);
    return {
      ok: true,
      status: 201,
      json: async () => ({ data: { attributes: { url: "https://example.test/c" } } }),
    };
  });

  // A variant of the buyer's choosing, smuggled in beside a real plan name.
  const res = await request(app)
    .post("/api/checkout")
    .set(auth)
    .send({ plan: "monthly", variantId: "1", variant_id: "1", price: 0 });

  assert.equal(res.status, 201, res.text);
  assert.equal(sent.data.relationships.variant.data.id, "1986433");
});

test("an unknown plan never reaches the provider", async (t) => {
  stubMethod(t, prisma.purchase as any, "findFirst", async () => null);
  stubMethod(t, prisma.acquisitionLock as any, "findUnique", async () => null);
  stubMethod(t, prisma.acquisitionLock as any, "create", async (a: any) => a.data);
  stubMethod(t, prisma.acquisitionLock as any, "updateMany", async () => ({ count: 1 }));
  stubMethod(t, prisma.acquisitionLock as any, "deleteMany", async () => ({ count: 1 }));
  stubMethod(t, prisma.checkoutIntent as any, "findUnique", async () => null);
  stubMethod(t, prisma.checkoutIntent as any, "create", async (a: any) => ({ id: "intent-1", ...a.data }));
  stubMethod(t, prisma.checkoutIntent as any, "updateMany", async () => ({ count: 1 }));
  stubMethod(t, prisma as any, "$transaction", async (fn: any) => (typeof fn === "function" ? fn(prisma) : Promise.all(fn)));
  stubMethod(t, prisma.subscription as any, "findMany", async () => []);
  stubMethod(t, prisma.billingTask as any, "findMany", async () => []);
  stubMethod(t, prisma.trialClaim as any, "findUnique", async () => null);
  configured(t);
  stubFetch(t, async () => {
    throw new Error("must not reach Lemon Squeezy");
  });

  for (const body of [{}, { plan: "" }, { plan: "weekly" }, { plan: ["monthly"] }]) {
    const res = await request(app).post("/api/checkout").set(auth).send(body);
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
  }
});

// One plan being unconfigured must not take the others down with it — the usual
// shape of this mistake is shipping the yearly id and forgetting the monthly.
test("a missing id disables only its own plan", async (t) => {
  stubMethod(t, prisma.acquisitionLock as any, "findUnique", async () => null);
  stubMethod(t, prisma.acquisitionLock as any, "create", async (a: any) => a.data);
  stubMethod(t, prisma.acquisitionLock as any, "updateMany", async () => ({ count: 1 }));
  stubMethod(t, prisma.acquisitionLock as any, "deleteMany", async () => ({ count: 1 }));
  stubMethod(t, prisma.checkoutIntent as any, "findUnique", async () => null);
  stubMethod(t, prisma.checkoutIntent as any, "create", async (a: any) => ({ id: "intent-1", ...a.data }));
  stubMethod(t, prisma.checkoutIntent as any, "updateMany", async () => ({ count: 1 }));
  stubMethod(t, prisma as any, "$transaction", async (fn: any) => (typeof fn === "function" ? fn(prisma) : Promise.all(fn)));
  stubMethod(t, prisma.trialClaim as any, "findUnique", async () => null);
  configured(t);
  (env as any).lemonSqueezyVariantMonthly = "";
  stubMethod(t, prisma.user as any, "findUnique", async () => ({ email: "user@example.com" }));
  stubMethod(t, prisma.purchase as any, "findFirst", async () => null);
  stubMethod(t, prisma.subscription as any, "findMany", async () => []);
  stubMethod(t, prisma.billingTask as any, "findMany", async () => []);
  stubFetch(t, async () => ({
    ok: true,
    status: 201,
    json: async () => ({ data: { attributes: { url: "https://example.test/c" } } }),
  }));

  const monthly = await request(app).post("/api/checkout").set(auth).send({ plan: "monthly" });
  const yearly = await request(app).post("/api/checkout").set(auth).send({ plan: "yearly" });

  assert.equal(monthly.status, 400);
  assert.equal(yearly.status, 201);
});

// --- Buying what you already have --------------------------------------------

test("a live subscription blocks a second subscription", async (t) => {
  stubMethod(t, prisma.acquisitionLock as any, "findUnique", async () => null);
  stubMethod(t, prisma.acquisitionLock as any, "create", async (a: any) => a.data);
  stubMethod(t, prisma.acquisitionLock as any, "updateMany", async () => ({ count: 1 }));
  stubMethod(t, prisma.acquisitionLock as any, "deleteMany", async () => ({ count: 1 }));
  stubMethod(t, prisma.checkoutIntent as any, "findUnique", async () => null);
  stubMethod(t, prisma.checkoutIntent as any, "create", async (a: any) => ({ id: "intent-1", ...a.data }));
  stubMethod(t, prisma.checkoutIntent as any, "updateMany", async () => ({ count: 1 }));
  stubMethod(t, prisma as any, "$transaction", async (fn: any) => (typeof fn === "function" ? fn(prisma) : Promise.all(fn)));
  stubMethod(t, prisma.trialClaim as any, "findUnique", async () => null);
  configured(t);
  stubMethod(t, prisma.user as any, "findUnique", async () => ({ email: "user@example.com" }));
  stubMethod(t, prisma.purchase as any, "findFirst", async () => null);
  stubMethod(t, prisma.subscription as any, "findMany", async () => [
    { externalId: "77001", status: "active", validUntil: new Date(Date.now() + 30 * 86_400_000) },
  ]);
  // Nothing owed at the provider — see `blocksNewRecurringCheckout`.
  stubMethod(t, prisma.billingTask as any, "findMany", async () => []);
  stubFetch(t, async () => {
    throw new Error("must not reach Lemon Squeezy");
  });

  const res = await request(app).post("/api/checkout").set(auth).send({ plan: "yearly" });

  assert.equal(res.status, 409);
});

// Refusing this would be refusing money from the best customer there is.
test("a live subscription does NOT block the upgrade to lifetime", async (t) => {
  stubMethod(t, prisma.acquisitionLock as any, "findUnique", async () => null);
  stubMethod(t, prisma.acquisitionLock as any, "create", async (a: any) => a.data);
  stubMethod(t, prisma.acquisitionLock as any, "updateMany", async () => ({ count: 1 }));
  stubMethod(t, prisma.acquisitionLock as any, "deleteMany", async () => ({ count: 1 }));
  stubMethod(t, prisma.checkoutIntent as any, "findUnique", async () => null);
  stubMethod(t, prisma.checkoutIntent as any, "create", async (a: any) => ({ id: "intent-1", ...a.data }));
  stubMethod(t, prisma.checkoutIntent as any, "updateMany", async () => ({ count: 1 }));
  stubMethod(t, prisma as any, "$transaction", async (fn: any) => (typeof fn === "function" ? fn(prisma) : Promise.all(fn)));
  stubMethod(t, prisma.trialClaim as any, "findUnique", async () => null);
  configured(t);
  stubMethod(t, prisma.user as any, "findUnique", async () => ({ email: "user@example.com" }));
  stubMethod(t, prisma.purchase as any, "findFirst", async () => null);
  stubMethod(t, prisma.subscription as any, "findMany", async () => [
    { status: "on_trial", validUntil: new Date(Date.now() + 3 * 86_400_000) },
  ]);
  stubMethod(t, prisma.billingTask as any, "findMany", async () => []);
  stubFetch(t, async () => ({
    ok: true,
    status: 201,
    json: async () => ({ data: { attributes: { url: "https://example.test/c" } } }),
  }));

  const res = await request(app).post("/api/checkout").set(auth).send({ plan: "lifetime" });

  assert.equal(res.status, 201, res.text);
});

test("a lapsed subscription does not block resubscribing", async (t) => {
  stubMethod(t, prisma.acquisitionLock as any, "findUnique", async () => null);
  stubMethod(t, prisma.acquisitionLock as any, "create", async (a: any) => a.data);
  stubMethod(t, prisma.acquisitionLock as any, "updateMany", async () => ({ count: 1 }));
  stubMethod(t, prisma.acquisitionLock as any, "deleteMany", async () => ({ count: 1 }));
  stubMethod(t, prisma.checkoutIntent as any, "findUnique", async () => null);
  stubMethod(t, prisma.checkoutIntent as any, "create", async (a: any) => ({ id: "intent-1", ...a.data }));
  stubMethod(t, prisma.checkoutIntent as any, "updateMany", async () => ({ count: 1 }));
  stubMethod(t, prisma as any, "$transaction", async (fn: any) => (typeof fn === "function" ? fn(prisma) : Promise.all(fn)));
  stubMethod(t, prisma.trialClaim as any, "findUnique", async () => null);
  configured(t);
  stubMethod(t, prisma.user as any, "findUnique", async () => ({ email: "user@example.com" }));
  stubMethod(t, prisma.purchase as any, "findFirst", async () => null);
  stubMethod(t, prisma.subscription as any, "findMany", async () => [
    { status: "expired", validUntil: new Date(Date.now() - 86_400_000) },
  ]);
  stubMethod(t, prisma.billingTask as any, "findMany", async () => []);
  stubFetch(t, async () => ({
    ok: true,
    status: 201,
    json: async () => ({ data: { attributes: { url: "https://example.test/c" } } }),
  }));

  const res = await request(app).post("/api/checkout").set(auth).send({ plan: "monthly" });

  assert.equal(res.status, 201, res.text);
});

test("a lifetime licence blocks every plan, subscriptions included", async (t) => {
  stubMethod(t, prisma.acquisitionLock as any, "findUnique", async () => null);
  stubMethod(t, prisma.acquisitionLock as any, "create", async (a: any) => a.data);
  stubMethod(t, prisma.acquisitionLock as any, "updateMany", async () => ({ count: 1 }));
  stubMethod(t, prisma.acquisitionLock as any, "deleteMany", async () => ({ count: 1 }));
  stubMethod(t, prisma.checkoutIntent as any, "findUnique", async () => null);
  stubMethod(t, prisma.checkoutIntent as any, "create", async (a: any) => ({ id: "intent-1", ...a.data }));
  stubMethod(t, prisma.checkoutIntent as any, "updateMany", async () => ({ count: 1 }));
  stubMethod(t, prisma as any, "$transaction", async (fn: any) => (typeof fn === "function" ? fn(prisma) : Promise.all(fn)));
  stubMethod(t, prisma.subscription as any, "findMany", async () => []);
  stubMethod(t, prisma.billingTask as any, "findMany", async () => []);
  stubMethod(t, prisma.trialClaim as any, "findUnique", async () => null);
  configured(t);
  stubMethod(t, prisma.user as any, "findUnique", async () => ({ email: "user@example.com" }));
  stubMethod(t, prisma.purchase as any, "findFirst", async () => ({ id: "purchase-1" }));
  stubFetch(t, async () => {
    throw new Error("must not reach Lemon Squeezy");
  });

  for (const plan of ["monthly", "yearly", "lifetime"] as const) {
    const res = await request(app).post("/api/checkout").set(auth).send({ plan });
    assert.equal(res.status, 409, `expected 409 for ${plan}`);
  }
});

/*
 * A refusal has to SAY why. Lemon Squeezy answers with JSON:API errors whose
 * prose names the fix ("Variant not found", "…is not published"); throwing that
 * away made every refusal read "Could not start the purchase. Please try again."
 * — false comfort when the cause is a variant id that will still be wrong on the
 * fifth try, and nothing anywhere to tell an operator which of key, store or
 * variant was at fault.
 */
test("a refusal from Lemon Squeezy reports what Lemon Squeezy said", async (t) => {
  stubMethod(t, prisma.acquisitionLock as any, "findUnique", async () => null);
  stubMethod(t, prisma.acquisitionLock as any, "create", async (a: any) => a.data);
  stubMethod(t, prisma.acquisitionLock as any, "updateMany", async () => ({ count: 1 }));
  stubMethod(t, prisma.acquisitionLock as any, "deleteMany", async () => ({ count: 1 }));
  stubMethod(t, prisma.checkoutIntent as any, "findUnique", async () => null);
  stubMethod(t, prisma.checkoutIntent as any, "create", async (a: any) => ({ id: "intent-1", ...a.data }));
  stubMethod(t, prisma.checkoutIntent as any, "updateMany", async () => ({ count: 1 }));
  stubMethod(t, prisma as any, "$transaction", async (fn: any) => (typeof fn === "function" ? fn(prisma) : Promise.all(fn)));
  stubMethod(t, prisma.trialClaim as any, "findUnique", async () => null);
  configured(t);
  stubMethod(t, prisma.user as any, "findUnique", async () => ({ email: "user@example.com" }));
  stubMethod(t, prisma.purchase as any, "findFirst", async () => null);
  stubMethod(t, prisma.subscription as any, "findMany", async () => []);
  stubMethod(t, prisma.billingTask as any, "findMany", async () => []);
  stubFetch(t, async () => ({
    ok: false,
    status: 404,
    json: async () => ({
      errors: [{ status: "404", title: "Not Found", detail: "No variant found with ID 1986420" }],
    }),
  }));

  const res = await request(app).post("/api/checkout").set(auth).send({ plan: "yearly" });

  assert.equal(res.status, 400);
  assert.match(res.body.error, /No variant found with ID 1986420/);
});

test("an unreadable refusal still fails cleanly, without the API key", async (t) => {
  stubMethod(t, prisma.acquisitionLock as any, "findUnique", async () => null);
  stubMethod(t, prisma.acquisitionLock as any, "create", async (a: any) => a.data);
  stubMethod(t, prisma.acquisitionLock as any, "updateMany", async () => ({ count: 1 }));
  stubMethod(t, prisma.acquisitionLock as any, "deleteMany", async () => ({ count: 1 }));
  stubMethod(t, prisma.checkoutIntent as any, "findUnique", async () => null);
  stubMethod(t, prisma.checkoutIntent as any, "create", async (a: any) => ({ id: "intent-1", ...a.data }));
  stubMethod(t, prisma.checkoutIntent as any, "updateMany", async () => ({ count: 1 }));
  stubMethod(t, prisma as any, "$transaction", async (fn: any) => (typeof fn === "function" ? fn(prisma) : Promise.all(fn)));
  stubMethod(t, prisma.trialClaim as any, "findUnique", async () => null);
  configured(t);
  stubMethod(t, prisma.user as any, "findUnique", async () => ({ email: "user@example.com" }));
  stubMethod(t, prisma.purchase as any, "findFirst", async () => null);
  stubMethod(t, prisma.subscription as any, "findMany", async () => []);
  stubMethod(t, prisma.billingTask as any, "findMany", async () => []);
  stubFetch(t, async () => ({
    ok: false,
    status: 502,
    json: async () => {
      throw new Error("not json");
    },
  }));

  const res = await request(app).post("/api/checkout").set(auth).send({ plan: "yearly" });

  // 503 AND AMBIGUOUS, not 400. A 502 means Lemon Squeezy may well have created
  // the checkout and failed while telling us — so the account's acquisition lock
  // is KEPT rather than released, and the customer is asked to wait instead of
  // being handed a second payable link beside an invisible first one.
  assert.equal(res.status, 503, res.text);
  assert.equal(res.body.code, "CHECKOUT_STATE_UNCERTAIN");
  assert.ok(!JSON.stringify(res.body).includes("test-key"));
});

/*
 * The failure that cost the most hours in this whole storefront, so it gets a
 * test rather than a comment: three variant ids pasted from the LIVE dashboard
 * into a deploy holding a TEST key. Test and live are separate object graphs,
 * so every id is simply absent, every plan 404s at once, and Lemon Squeezy says
 * only "The related resource does not exist" — which reads exactly like a typo
 * and sends you checking the ids you just pasted, character by character.
 *
 * The store knows the answer. Ask it.
 */
function withTestMode(t: { after: (fn: () => void) => void }, on: boolean) {
  const before = env.lemonSqueezyAllowTestMode;
  (env as any).lemonSqueezyAllowTestMode = on;
  t.after(() => {
    (env as any).lemonSqueezyAllowTestMode = before;
  });
}

/** A 404 on the checkout, and a catalogue that holds the real ids. */
function stubGraphMismatch(t: { after: (fn: () => void) => void }) {
  stubMethod(t, prisma.user as any, "findUnique", async () => ({ email: "user@example.com" }));
  stubMethod(t, prisma.purchase as any, "findFirst", async () => null);
  stubMethod(t, prisma.subscription as any, "findMany", async () => []);
  stubMethod(t, prisma.billingTask as any, "findMany", async () => []);
  stubFetch(t, async (url: string) => {
    if (String(url).includes("/v1/variants")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [
            { id: 1987310, attributes: { is_subscription: true, interval: "month" } },
            { id: 1987304, attributes: { is_subscription: true, interval: "year" } },
            { id: 1987312, attributes: { is_subscription: false, interval: "year" } },
          ],
        }),
      };
    }
    return {
      ok: false,
      status: 404,
      json: async () => ({
        errors: [{ status: "404", title: "Not Found", detail: "The related resource does not exist." }],
      }),
    };
  });
}

test("a 404 names the variant id that would have worked", async (t) => {
  stubMethod(t, prisma.purchase as any, "findFirst", async () => null);
  stubMethod(t, prisma.acquisitionLock as any, "findUnique", async () => null);
  stubMethod(t, prisma.acquisitionLock as any, "create", async (a: any) => a.data);
  stubMethod(t, prisma.acquisitionLock as any, "updateMany", async () => ({ count: 1 }));
  stubMethod(t, prisma.acquisitionLock as any, "deleteMany", async () => ({ count: 1 }));
  stubMethod(t, prisma.checkoutIntent as any, "findUnique", async () => null);
  stubMethod(t, prisma.checkoutIntent as any, "create", async (a: any) => ({ id: "intent-1", ...a.data }));
  stubMethod(t, prisma.checkoutIntent as any, "updateMany", async () => ({ count: 1 }));
  stubMethod(t, prisma as any, "$transaction", async (fn: any) => (typeof fn === "function" ? fn(prisma) : Promise.all(fn)));
  stubMethod(t, prisma.subscription as any, "findMany", async () => []);
  stubMethod(t, prisma.billingTask as any, "findMany", async () => []);
  stubMethod(t, prisma.trialClaim as any, "findUnique", async () => null);
  configured(t);
  withTestMode(t, true);
  stubGraphMismatch(t);

  const res = await request(app).post("/api/checkout").set(auth).send({ plan: "monthly" });

  assert.equal(res.status, 400);
  // The id, the variable to put it in, and the one that does not exist.
  assert.match(res.body.error, /LEMONSQUEEZY_VARIANT_MONTHLY=1987310/);
  assert.match(res.body.error, /1986433 does not exist/);
});

test("the yearly plan resolves to the yearly variant, not the monthly one", async (t) => {
  stubMethod(t, prisma.purchase as any, "findFirst", async () => null);
  stubMethod(t, prisma.acquisitionLock as any, "findUnique", async () => null);
  stubMethod(t, prisma.acquisitionLock as any, "create", async (a: any) => a.data);
  stubMethod(t, prisma.acquisitionLock as any, "updateMany", async () => ({ count: 1 }));
  stubMethod(t, prisma.acquisitionLock as any, "deleteMany", async () => ({ count: 1 }));
  stubMethod(t, prisma.checkoutIntent as any, "findUnique", async () => null);
  stubMethod(t, prisma.checkoutIntent as any, "create", async (a: any) => ({ id: "intent-1", ...a.data }));
  stubMethod(t, prisma.checkoutIntent as any, "updateMany", async () => ({ count: 1 }));
  stubMethod(t, prisma as any, "$transaction", async (fn: any) => (typeof fn === "function" ? fn(prisma) : Promise.all(fn)));
  stubMethod(t, prisma.subscription as any, "findMany", async () => []);
  stubMethod(t, prisma.billingTask as any, "findMany", async () => []);
  stubMethod(t, prisma.trialClaim as any, "findUnique", async () => null);
  configured(t);
  withTestMode(t, true);
  stubGraphMismatch(t);

  const res = await request(app).post("/api/checkout").set(auth).send({ plan: "yearly" });

  assert.match(res.body.error, /LEMONSQUEEZY_VARIANT_YEARLY=1987304/);
});

/*
 * Shape is the only thing that identifies a plan — every single-variant product
 * is called "Default" — and two candidates means a human has to choose. Picking
 * one would decide which product a customer's money runs through, silently.
 */
test("an ambiguous match refuses to choose, and says so", async (t) => {
  stubMethod(t, prisma.acquisitionLock as any, "findUnique", async () => null);
  stubMethod(t, prisma.acquisitionLock as any, "create", async (a: any) => a.data);
  stubMethod(t, prisma.acquisitionLock as any, "updateMany", async () => ({ count: 1 }));
  stubMethod(t, prisma.acquisitionLock as any, "deleteMany", async () => ({ count: 1 }));
  stubMethod(t, prisma.checkoutIntent as any, "findUnique", async () => null);
  stubMethod(t, prisma.checkoutIntent as any, "create", async (a: any) => ({ id: "intent-1", ...a.data }));
  stubMethod(t, prisma.checkoutIntent as any, "updateMany", async () => ({ count: 1 }));
  stubMethod(t, prisma as any, "$transaction", async (fn: any) => (typeof fn === "function" ? fn(prisma) : Promise.all(fn)));
  stubMethod(t, prisma.subscription as any, "findMany", async () => []);
  stubMethod(t, prisma.billingTask as any, "findMany", async () => []);
  stubMethod(t, prisma.trialClaim as any, "findUnique", async () => null);
  configured(t);
  withTestMode(t, true);
  stubMethod(t, prisma.user as any, "findUnique", async () => ({ email: "user@example.com" }));
  stubMethod(t, prisma.purchase as any, "findFirst", async () => null);
  stubFetch(t, async (url: string) => {
    if (String(url).includes("/v1/variants")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [
            { id: 1960836, attributes: { is_subscription: false, interval: "year" } },
            { id: 1987312, attributes: { is_subscription: false, interval: "year" } },
          ],
        }),
      };
    }
    return {
      ok: false,
      status: 404,
      json: async () => ({ errors: [{ title: "Not Found", detail: "does not exist" }] }),
    };
  });

  const res = await request(app).post("/api/checkout").set(auth).send({ plan: "lifetime" });

  assert.match(res.body.error, /2 variants match/);
  assert.match(res.body.error, /1960836, 1987312/);
});

/*
 * A live storefront's 404 is read by a CUSTOMER. The name of an environment
 * variable is meaningless to them and reads like the price is negotiable.
 */
test("the operator hint never reaches a live storefront", async (t) => {
  stubMethod(t, prisma.purchase as any, "findFirst", async () => null);
  stubMethod(t, prisma.acquisitionLock as any, "findUnique", async () => null);
  stubMethod(t, prisma.acquisitionLock as any, "create", async (a: any) => a.data);
  stubMethod(t, prisma.acquisitionLock as any, "updateMany", async () => ({ count: 1 }));
  stubMethod(t, prisma.acquisitionLock as any, "deleteMany", async () => ({ count: 1 }));
  stubMethod(t, prisma.checkoutIntent as any, "findUnique", async () => null);
  stubMethod(t, prisma.checkoutIntent as any, "create", async (a: any) => ({ id: "intent-1", ...a.data }));
  stubMethod(t, prisma.checkoutIntent as any, "updateMany", async () => ({ count: 1 }));
  stubMethod(t, prisma as any, "$transaction", async (fn: any) => (typeof fn === "function" ? fn(prisma) : Promise.all(fn)));
  stubMethod(t, prisma.subscription as any, "findMany", async () => []);
  stubMethod(t, prisma.billingTask as any, "findMany", async () => []);
  stubMethod(t, prisma.trialClaim as any, "findUnique", async () => null);
  configured(t);
  withTestMode(t, false);
  stubGraphMismatch(t);

  const res = await request(app).post("/api/checkout").set(auth).send({ plan: "monthly" });

  assert.equal(res.status, 400);
  assert.ok(!res.body.error.includes("LEMONSQUEEZY_VARIANT_MONTHLY"), res.body.error);
  // Lemon Squeezy's own prose still comes through, as it always has.
  assert.match(res.body.error, /does not exist/);
});

/*
 * If the configured id IS in the catalogue, the 404 was about the STORE, and a
 * hint pointing at the variant would send someone to change a correct value.
 */
test("a present variant produces no hint", async (t) => {
  stubMethod(t, prisma.acquisitionLock as any, "findUnique", async () => null);
  stubMethod(t, prisma.acquisitionLock as any, "create", async (a: any) => a.data);
  stubMethod(t, prisma.acquisitionLock as any, "updateMany", async () => ({ count: 1 }));
  stubMethod(t, prisma.acquisitionLock as any, "deleteMany", async () => ({ count: 1 }));
  stubMethod(t, prisma.checkoutIntent as any, "findUnique", async () => null);
  stubMethod(t, prisma.checkoutIntent as any, "create", async (a: any) => ({ id: "intent-1", ...a.data }));
  stubMethod(t, prisma.checkoutIntent as any, "updateMany", async () => ({ count: 1 }));
  stubMethod(t, prisma as any, "$transaction", async (fn: any) => (typeof fn === "function" ? fn(prisma) : Promise.all(fn)));
  stubMethod(t, prisma.trialClaim as any, "findUnique", async () => null);
  configured(t);
  withTestMode(t, true);
  stubMethod(t, prisma.user as any, "findUnique", async () => ({ email: "user@example.com" }));
  stubMethod(t, prisma.purchase as any, "findFirst", async () => null);
  stubMethod(t, prisma.subscription as any, "findMany", async () => []);
  stubMethod(t, prisma.billingTask as any, "findMany", async () => []);
  stubFetch(t, async (url: string) => {
    if (String(url).includes("/v1/variants")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [{ id: 1986433, attributes: { is_subscription: true, interval: "month" } }],
        }),
      };
    }
    return {
      ok: false,
      status: 404,
      json: async () => ({ errors: [{ title: "Not Found", detail: "does not exist" }] }),
    };
  });

  const res = await request(app).post("/api/checkout").set(auth).send({ plan: "monthly" });

  assert.ok(!res.body.error.includes("Set LEMONSQUEEZY"), res.body.error);
});

/* A hint that cannot be produced must never turn a clear 400 into a 500. */
test("an unreachable catalogue still fails as a clean 400", async (t) => {
  stubMethod(t, prisma.acquisitionLock as any, "findUnique", async () => null);
  stubMethod(t, prisma.acquisitionLock as any, "create", async (a: any) => a.data);
  stubMethod(t, prisma.acquisitionLock as any, "updateMany", async () => ({ count: 1 }));
  stubMethod(t, prisma.acquisitionLock as any, "deleteMany", async () => ({ count: 1 }));
  stubMethod(t, prisma.checkoutIntent as any, "findUnique", async () => null);
  stubMethod(t, prisma.checkoutIntent as any, "create", async (a: any) => ({ id: "intent-1", ...a.data }));
  stubMethod(t, prisma.checkoutIntent as any, "updateMany", async () => ({ count: 1 }));
  stubMethod(t, prisma as any, "$transaction", async (fn: any) => (typeof fn === "function" ? fn(prisma) : Promise.all(fn)));
  stubMethod(t, prisma.trialClaim as any, "findUnique", async () => null);
  configured(t);
  withTestMode(t, true);
  stubMethod(t, prisma.user as any, "findUnique", async () => ({ email: "user@example.com" }));
  stubMethod(t, prisma.purchase as any, "findFirst", async () => null);
  stubMethod(t, prisma.subscription as any, "findMany", async () => []);
  stubMethod(t, prisma.billingTask as any, "findMany", async () => []);
  stubFetch(t, async (url: string) => {
    if (String(url).includes("/v1/variants")) throw new Error("network down");
    return {
      ok: false,
      status: 404,
      json: async () => ({ errors: [{ title: "Not Found", detail: "does not exist" }] }),
    };
  });

  const res = await request(app).post("/api/checkout").set(auth).send({ plan: "monthly" });

  assert.equal(res.status, 400);
  assert.ok(!JSON.stringify(res.body).includes("test-key"));
});

/* ── POST /api/checkout/confirm — the active half of fulfilment ─────────── */

/**
 * The confirm route asks Lemon Squeezy about the order, writes through the
 * webhook's own writers, then answers with the resolved entitlement. These
 * stubs cover that whole span: the route's user read + the resolver's reads.
 */
function confirmStubs(t: { after: (fn: () => void) => void }) {
  configured(t);
  withTestMode(t, true);
  const beforeRl = env.authRateLimitDisabled;
  (env as any).authRateLimitDisabled = true;
  t.after(() => {
    (env as any).authRateLimitDisabled = beforeRl;
  });
  stubMethod(t, prisma.user as any, "findUnique", async () => ({
    email: "user@example.com",
    trialEndsAt: null,
    compActive: false,
    compedUntil: null,
    accessRevoked: false,
  }));
  stubMethod(t, prisma.user as any, "update", async () => ({}));
  stubMethod(t, prisma.purchase as any, "findMany", async () => []);
  stubMethod(t, prisma.trialClaim as any, "findFirst", async () => null);
  stubMethod(t, prisma.subscription as any, "findMany", async () => []);
  stubMethod(t, prisma.billingTask as any, "findMany", async () => []);
  // The shared writers (recordPaidOrder / mirrorSubscriptionState) read the
  // existing row + the consumed-order tombstone before writing. Baseline: no
  // prior row, never consumed → the grant proceeds; the upsert just records it.
  stubMethod(t, prisma.purchase as any, "findUnique", async () => null);
  stubMethod(t, prisma.consumedOrder as any, "findUnique", async () => null);
  stubMethod(t, prisma.consumedOrder as any, "upsert", async () => ({}));
}

function lsOrder(over: Record<string, unknown> = {}) {
  return {
    data: {
      type: "orders",
      id: "777",
      attributes: {
        store_id: 364783,
        user_email: "user@example.com",
        status: "paid",
        refunded: false,
        total_usd: 7499,
        created_at: "2026-08-08T10:00:00Z",
        test_mode: true,
        first_order_item: { product_id: 1254414, variant_id: 1960881 },
        ...over,
      },
    },
  };
}

function lsSubList(over: Record<string, unknown> = {}) {
  return {
    data: [
      {
        type: "subscriptions",
        id: "555",
        attributes: {
          store_id: 364783,
          user_email: "user@example.com",
          status: "on_trial",
          variant_id: 1986433,
          product_id: 1270398,
          trial_ends_at: "2026-08-11T10:00:00Z",
          renews_at: "2026-08-11T10:00:00Z",
          ends_at: null,
          urls: { update_payment_method: "https://x/upm", customer_portal: "https://x/portal" },
          updated_at: "2026-08-08T10:00:05Z",
          test_mode: true,
          ...over,
        },
      },
    ],
  };
}

test("confirming a paid subscription order mirrors the subscription and answers 200", async (t) => {
  stubMethod(t, prisma.purchase as any, "findFirst", async () => null);
  stubMethod(t, prisma.acquisitionLock as any, "findUnique", async () => null);
  stubMethod(t, prisma.acquisitionLock as any, "create", async (a: any) => a.data);
  stubMethod(t, prisma.acquisitionLock as any, "updateMany", async () => ({ count: 1 }));
  stubMethod(t, prisma.acquisitionLock as any, "deleteMany", async () => ({ count: 1 }));
  stubMethod(t, prisma.checkoutIntent as any, "findUnique", async () => null);
  stubMethod(t, prisma.checkoutIntent as any, "create", async (a: any) => ({ id: "intent-1", ...a.data }));
  stubMethod(t, prisma.checkoutIntent as any, "updateMany", async () => ({ count: 1 }));
  stubMethod(t, prisma as any, "$transaction", async (fn: any) => (typeof fn === "function" ? fn(prisma) : Promise.all(fn)));
  stubMethod(t, prisma.subscription as any, "findMany", async () => []);
  stubMethod(t, prisma.billingTask as any, "findMany", async () => []);
  stubMethod(t, prisma.trialClaim as any, "findUnique", async () => null);
  confirmStubs(t);
  stubMethod(t, prisma.subscription as any, "updateMany", async () => ({ count: 0 }));
  stubMethod(t, prisma.subscription as any, "findUnique", async () => null);
  const created = stubMethod(t, prisma.subscription as any, "create", async (args: any) => args.data);
  stubFetch(t, async (url: string) => {
    if (String(url).includes("/v1/subscriptions")) {
      return { ok: true, status: 200, json: async () => lsSubList() };
    }
    return {
      ok: true,
      status: 200,
      json: async () =>
        lsOrder({ first_order_item: { product_id: 1270398, variant_id: 1986433 } }),
    };
  });

  const res = await request(app).post("/api/checkout/confirm").set(auth).send({ orderId: "777" });

  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(created.length, 1, "the subscription row is written");
  assert.equal(created[0][0].data.externalId, "555");
  assert.equal(created[0][0].data.userId, userId, "bound to the CALLER, not to anything client-sent");
  assert.equal(created[0][0].data.status, "on_trial");
});

test("confirming a paid lifetime order records the purchase", async (t) => {
  stubMethod(t, prisma.purchase as any, "findFirst", async () => null);
  stubMethod(t, prisma.acquisitionLock as any, "findUnique", async () => null);
  stubMethod(t, prisma.acquisitionLock as any, "create", async (a: any) => a.data);
  stubMethod(t, prisma.acquisitionLock as any, "updateMany", async () => ({ count: 1 }));
  stubMethod(t, prisma.acquisitionLock as any, "deleteMany", async () => ({ count: 1 }));
  stubMethod(t, prisma.checkoutIntent as any, "findUnique", async () => null);
  stubMethod(t, prisma.checkoutIntent as any, "create", async (a: any) => ({ id: "intent-1", ...a.data }));
  stubMethod(t, prisma.checkoutIntent as any, "updateMany", async () => ({ count: 1 }));
  stubMethod(t, prisma as any, "$transaction", async (fn: any) => (typeof fn === "function" ? fn(prisma) : Promise.all(fn)));
  stubMethod(t, prisma.subscription as any, "findMany", async () => []);
  stubMethod(t, prisma.billingTask as any, "findMany", async () => []);
  stubMethod(t, prisma.trialClaim as any, "findUnique", async () => null);
  confirmStubs(t);
  const upserts = stubMethod(t, prisma.purchase as any, "upsert", async (args: any) => args.create);
  stubFetch(t, async () => ({ ok: true, status: 200, json: async () => lsOrder() }));

  const res = await request(app).post("/api/checkout/confirm").set(auth).send({ orderId: 777 });

  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(upserts.length, 1);
  assert.equal(upserts[0][0].where.provider_externalId.externalId, "777");
  assert.equal(upserts[0][0].create.userId, userId);
});

/*
 * THE trust boundary of this endpoint. An order id is a guessable integer that
 * crossed two user-editable URLs; the only thing binding it to the caller is
 * the buyer email Lemon Squeezy recorded, checked server-side.
 */
test("someone else's order id reads as not found and writes nothing (no oracle)", async (t) => {
  stubMethod(t, prisma.purchase as any, "findFirst", async () => null);
  stubMethod(t, prisma.acquisitionLock as any, "findUnique", async () => null);
  stubMethod(t, prisma.acquisitionLock as any, "create", async (a: any) => a.data);
  stubMethod(t, prisma.acquisitionLock as any, "updateMany", async () => ({ count: 1 }));
  stubMethod(t, prisma.acquisitionLock as any, "deleteMany", async () => ({ count: 1 }));
  stubMethod(t, prisma.checkoutIntent as any, "findUnique", async () => null);
  stubMethod(t, prisma.checkoutIntent as any, "create", async (a: any) => ({ id: "intent-1", ...a.data }));
  stubMethod(t, prisma.checkoutIntent as any, "updateMany", async () => ({ count: 1 }));
  stubMethod(t, prisma as any, "$transaction", async (fn: any) => (typeof fn === "function" ? fn(prisma) : Promise.all(fn)));
  stubMethod(t, prisma.subscription as any, "findMany", async () => []);
  stubMethod(t, prisma.billingTask as any, "findMany", async () => []);
  stubMethod(t, prisma.trialClaim as any, "findUnique", async () => null);
  confirmStubs(t);
  const upserts = stubMethod(t, prisma.purchase as any, "upsert", async (args: any) => args.create);
  const created = stubMethod(t, prisma.subscription as any, "create", async (args: any) => args.data);
  stubFetch(t, async () => ({
    ok: true,
    status: 200,
    json: async () => lsOrder({ user_email: "someone.else@example.com" }),
  }));

  const res = await request(app).post("/api/checkout/confirm").set(auth).send({ orderId: "777" });

  // 404, identical to a nonexistent order: a not-yours order must be
  // indistinguishable from no order at all, or /confirm is an enumeration oracle.
  assert.equal(res.status, 404);
  assert.equal(upserts.length, 0);
  assert.equal(created.length, 0);
});

test("a spent order cannot be re-confirmed after its account was deleted", async (t) => {
  stubMethod(t, prisma.purchase as any, "findFirst", async () => null);
  stubMethod(t, prisma.acquisitionLock as any, "findUnique", async () => null);
  stubMethod(t, prisma.acquisitionLock as any, "create", async (a: any) => a.data);
  stubMethod(t, prisma.acquisitionLock as any, "updateMany", async () => ({ count: 1 }));
  stubMethod(t, prisma.acquisitionLock as any, "deleteMany", async () => ({ count: 1 }));
  stubMethod(t, prisma.checkoutIntent as any, "findUnique", async () => null);
  stubMethod(t, prisma.checkoutIntent as any, "create", async (a: any) => ({ id: "intent-1", ...a.data }));
  stubMethod(t, prisma.checkoutIntent as any, "updateMany", async () => ({ count: 1 }));
  stubMethod(t, prisma as any, "$transaction", async (fn: any) => (typeof fn === "function" ? fn(prisma) : Promise.all(fn)));
  stubMethod(t, prisma.subscription as any, "findMany", async () => []);
  stubMethod(t, prisma.billingTask as any, "findMany", async () => []);
  stubMethod(t, prisma.trialClaim as any, "findUnique", async () => null);
  confirmStubs(t);
  // Purchase gone (account deleted), but the consumption tombstone remains.
  stubMethod(t, prisma.purchase as any, "findUnique", async () => null);
  stubMethod(t, prisma.consumedOrder as any, "findUnique", async () => ({ id: "consumed-777" }));
  const upserts = stubMethod(t, prisma.purchase as any, "upsert", async (args: any) => args.create);
  stubFetch(t, async () => ({ ok: true, status: 200, json: async () => lsOrder() }));

  const res = await request(app).post("/api/checkout/confirm").set(auth).send({ orderId: "777" });

  assert.equal(res.status, 409);
  assert.equal(upserts.length, 0, "no fresh licence is minted for a spent order");
});

test("a pending order answers 409 so the app's bounded retry keeps trying", async (t) => {
  stubMethod(t, prisma.purchase as any, "findFirst", async () => null);
  stubMethod(t, prisma.acquisitionLock as any, "findUnique", async () => null);
  stubMethod(t, prisma.acquisitionLock as any, "create", async (a: any) => a.data);
  stubMethod(t, prisma.acquisitionLock as any, "updateMany", async () => ({ count: 1 }));
  stubMethod(t, prisma.acquisitionLock as any, "deleteMany", async () => ({ count: 1 }));
  stubMethod(t, prisma.checkoutIntent as any, "findUnique", async () => null);
  stubMethod(t, prisma.checkoutIntent as any, "create", async (a: any) => ({ id: "intent-1", ...a.data }));
  stubMethod(t, prisma.checkoutIntent as any, "updateMany", async () => ({ count: 1 }));
  stubMethod(t, prisma as any, "$transaction", async (fn: any) => (typeof fn === "function" ? fn(prisma) : Promise.all(fn)));
  stubMethod(t, prisma.subscription as any, "findMany", async () => []);
  stubMethod(t, prisma.billingTask as any, "findMany", async () => []);
  stubMethod(t, prisma.trialClaim as any, "findUnique", async () => null);
  confirmStubs(t);
  stubFetch(t, async () => ({
    ok: true,
    status: 200,
    json: async () => lsOrder({ status: "pending" }),
  }));

  const res = await request(app).post("/api/checkout/confirm").set(auth).send({ orderId: "777" });

  assert.equal(res.status, 409);
});

test("a test-mode order is refused while the test gate is closed", async (t) => {
  stubMethod(t, prisma.purchase as any, "findFirst", async () => null);
  stubMethod(t, prisma.acquisitionLock as any, "findUnique", async () => null);
  stubMethod(t, prisma.acquisitionLock as any, "create", async (a: any) => a.data);
  stubMethod(t, prisma.acquisitionLock as any, "updateMany", async () => ({ count: 1 }));
  stubMethod(t, prisma.acquisitionLock as any, "deleteMany", async () => ({ count: 1 }));
  stubMethod(t, prisma.checkoutIntent as any, "findUnique", async () => null);
  stubMethod(t, prisma.checkoutIntent as any, "create", async (a: any) => ({ id: "intent-1", ...a.data }));
  stubMethod(t, prisma.checkoutIntent as any, "updateMany", async () => ({ count: 1 }));
  stubMethod(t, prisma as any, "$transaction", async (fn: any) => (typeof fn === "function" ? fn(prisma) : Promise.all(fn)));
  stubMethod(t, prisma.subscription as any, "findMany", async () => []);
  stubMethod(t, prisma.billingTask as any, "findMany", async () => []);
  stubMethod(t, prisma.trialClaim as any, "findUnique", async () => null);
  confirmStubs(t);
  withTestMode(t, false);
  const upserts = stubMethod(t, prisma.purchase as any, "upsert", async (args: any) => args.create);
  stubFetch(t, async () => ({ ok: true, status: 200, json: async () => lsOrder() }));

  const res = await request(app).post("/api/checkout/confirm").set(auth).send({ orderId: "777" });

  assert.equal(res.status, 400);
  assert.equal(upserts.length, 0);
});

/* Same words as a true 404: an id in someone else's store must not be confirmable as existing. */
test("an order from a foreign store reads as not found", async (t) => {
  stubMethod(t, prisma.purchase as any, "findFirst", async () => null);
  stubMethod(t, prisma.acquisitionLock as any, "findUnique", async () => null);
  stubMethod(t, prisma.acquisitionLock as any, "create", async (a: any) => a.data);
  stubMethod(t, prisma.acquisitionLock as any, "updateMany", async () => ({ count: 1 }));
  stubMethod(t, prisma.acquisitionLock as any, "deleteMany", async () => ({ count: 1 }));
  stubMethod(t, prisma.checkoutIntent as any, "findUnique", async () => null);
  stubMethod(t, prisma.checkoutIntent as any, "create", async (a: any) => ({ id: "intent-1", ...a.data }));
  stubMethod(t, prisma.checkoutIntent as any, "updateMany", async () => ({ count: 1 }));
  stubMethod(t, prisma as any, "$transaction", async (fn: any) => (typeof fn === "function" ? fn(prisma) : Promise.all(fn)));
  stubMethod(t, prisma.subscription as any, "findMany", async () => []);
  stubMethod(t, prisma.billingTask as any, "findMany", async () => []);
  stubMethod(t, prisma.trialClaim as any, "findUnique", async () => null);
  confirmStubs(t);
  stubFetch(t, async () => ({
    ok: true,
    status: 200,
    json: async () => lsOrder({ store_id: 999999 }),
  }));

  const res = await request(app).post("/api/checkout/confirm").set(auth).send({ orderId: "777" });

  assert.equal(res.status, 404);
});

test("a non-numeric order id never reaches Lemon Squeezy", async (t) => {
  stubMethod(t, prisma.purchase as any, "findFirst", async () => null);
  stubMethod(t, prisma.acquisitionLock as any, "findUnique", async () => null);
  stubMethod(t, prisma.acquisitionLock as any, "create", async (a: any) => a.data);
  stubMethod(t, prisma.acquisitionLock as any, "updateMany", async () => ({ count: 1 }));
  stubMethod(t, prisma.acquisitionLock as any, "deleteMany", async () => ({ count: 1 }));
  stubMethod(t, prisma.checkoutIntent as any, "findUnique", async () => null);
  stubMethod(t, prisma.checkoutIntent as any, "create", async (a: any) => ({ id: "intent-1", ...a.data }));
  stubMethod(t, prisma.checkoutIntent as any, "updateMany", async () => ({ count: 1 }));
  stubMethod(t, prisma as any, "$transaction", async (fn: any) => (typeof fn === "function" ? fn(prisma) : Promise.all(fn)));
  stubMethod(t, prisma.subscription as any, "findMany", async () => []);
  stubMethod(t, prisma.billingTask as any, "findMany", async () => []);
  stubMethod(t, prisma.trialClaim as any, "findUnique", async () => null);
  confirmStubs(t);
  let fetched = 0;
  stubFetch(t, async () => {
    fetched += 1;
    return { ok: true, status: 200, json: async () => lsOrder() };
  });

  const res = await request(app)
    .post("/api/checkout/confirm")
    .set(auth)
    .send({ orderId: "777; DROP TABLE" });

  assert.equal(res.status, 400);
  assert.equal(fetched, 0);
});

/* ── BUG T1-03 — /confirm after a price change ────────────────────────────
 *
 * The lifetime branch is chosen by `order.variantId === env.lemonSqueezyVariantId`
 * and nothing else. Change the lifetime price in Lemon Squeezy and it mints a NEW
 * variant id; every order placed on the OLD one then falls through to the
 * subscription branch, finds no subscription, and 409s — for ever, for a customer
 * who has paid.
 *
 * The webhook already reasons about exactly this (`isSellableOrder`, which calls
 * an unknown non-subscription variant "far more likely OUR configuration than a
 * foreign product"). This route had no equivalent.
 */
test("a lifetime order on a RETIRED variant id still activates", async (t) => {
  stubMethod(t, prisma.purchase as any, "findFirst", async () => null);
  stubMethod(t, prisma.acquisitionLock as any, "findUnique", async () => null);
  stubMethod(t, prisma.acquisitionLock as any, "create", async (a: any) => a.data);
  stubMethod(t, prisma.acquisitionLock as any, "updateMany", async () => ({ count: 1 }));
  stubMethod(t, prisma.acquisitionLock as any, "deleteMany", async () => ({ count: 1 }));
  stubMethod(t, prisma.checkoutIntent as any, "findUnique", async () => null);
  stubMethod(t, prisma.checkoutIntent as any, "create", async (a: any) => ({ id: "intent-1", ...a.data }));
  stubMethod(t, prisma.checkoutIntent as any, "updateMany", async () => ({ count: 1 }));
  stubMethod(t, prisma as any, "$transaction", async (fn: any) => (typeof fn === "function" ? fn(prisma) : Promise.all(fn)));
  stubMethod(t, prisma.subscription as any, "findMany", async () => []);
  stubMethod(t, prisma.billingTask as any, "findMany", async () => []);
  stubMethod(t, prisma.trialClaim as any, "findUnique", async () => null);
  confirmStubs(t);
  const upserts = stubMethod(t, prisma.purchase as any, "upsert", async (args: any) => args.create);
  // The store, the buyer and the payment all check out. Only the id has moved on.
  stubFetch(t, async () => ({
    ok: true,
    status: 200,
    json: async () => lsOrder({ first_order_item: { product_id: 1254414, variant_id: 1700000 } }),
  }));

  const res = await request(app).post("/api/checkout/confirm").set(auth).send({ orderId: 777 });

  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(upserts.length, 1, "the customer paid; a rotated id is our problem, not theirs");
});

/*
 * The other side of the same coin: a KNOWN subscription variant must still take
 * the subscription branch. Widening the lifetime test must not swallow these.
 */
test("a monthly order still takes the subscription branch, not the lifetime one", async (t) => {
  stubMethod(t, prisma.purchase as any, "findFirst", async () => null);
  stubMethod(t, prisma.acquisitionLock as any, "findUnique", async () => null);
  stubMethod(t, prisma.acquisitionLock as any, "create", async (a: any) => a.data);
  stubMethod(t, prisma.acquisitionLock as any, "updateMany", async () => ({ count: 1 }));
  stubMethod(t, prisma.acquisitionLock as any, "deleteMany", async () => ({ count: 1 }));
  stubMethod(t, prisma.checkoutIntent as any, "findUnique", async () => null);
  stubMethod(t, prisma.checkoutIntent as any, "create", async (a: any) => ({ id: "intent-1", ...a.data }));
  stubMethod(t, prisma.checkoutIntent as any, "updateMany", async () => ({ count: 1 }));
  stubMethod(t, prisma as any, "$transaction", async (fn: any) => (typeof fn === "function" ? fn(prisma) : Promise.all(fn)));
  stubMethod(t, prisma.subscription as any, "findMany", async () => []);
  stubMethod(t, prisma.billingTask as any, "findMany", async () => []);
  stubMethod(t, prisma.trialClaim as any, "findUnique", async () => null);
  confirmStubs(t);
  const upserts = stubMethod(t, prisma.purchase as any, "upsert", async (args: any) => args.create);
  let call = 0;
  stubFetch(t, async () => {
    call += 1;
    if (call === 1) {
      return {
        ok: true,
        status: 200,
        json: async () => lsOrder({ first_order_item: { product_id: 1270398, variant_id: 1986433 } }),
      };
    }
    // The subscription lookup for that order.
    return { ok: true, status: 200, json: async () => ({ data: [] }) };
  });

  const res = await request(app).post("/api/checkout/confirm").set(auth).send({ orderId: 777 });

  assert.equal(upserts.length, 0, "a subscription order must never mint a lifetime Purchase");
  assert.equal(res.status, 409, "no subscription yet — a conflict to retry, not a licence");
});

/* ── BUG T1-06 — /change-plan can be hammered ─────────────────────────────
 *
 * Unlike /cancel and /end-trial it never transitions into a state that refuses a
 * repeat, and every upgrade leg PATCHes with `invoice_immediately: true`. The
 * three sibling money routes (/checkout, /confirm, /portal) all carry a two-leg
 * rate limit; this one carried none, so monthly<->yearly could be alternated as
 * fast as the network allows.
 */
test("change-plan is rate limited like the other money routes", async (t) => {
  stubMethod(t, prisma.purchase as any, "findFirst", async () => null);
  stubMethod(t, prisma.acquisitionLock as any, "findUnique", async () => null);
  stubMethod(t, prisma.acquisitionLock as any, "create", async (a: any) => a.data);
  stubMethod(t, prisma.acquisitionLock as any, "updateMany", async () => ({ count: 1 }));
  stubMethod(t, prisma.acquisitionLock as any, "deleteMany", async () => ({ count: 1 }));
  stubMethod(t, prisma.checkoutIntent as any, "findUnique", async () => null);
  stubMethod(t, prisma.checkoutIntent as any, "create", async (a: any) => ({ id: "intent-1", ...a.data }));
  stubMethod(t, prisma.checkoutIntent as any, "updateMany", async () => ({ count: 1 }));
  stubMethod(t, prisma as any, "$transaction", async (fn: any) => (typeof fn === "function" ? fn(prisma) : Promise.all(fn)));
  stubMethod(t, prisma.trialClaim as any, "findUnique", async () => null);
  configured(t);
  const beforeRl = env.authRateLimitDisabled;
  (env as any).authRateLimitDisabled = false;
  t.after(() => {
    (env as any).authRateLimitDisabled = beforeRl;
  });
  stubMethod(t, prisma.subscription as any, "findMany", async () => []);
  stubMethod(t, prisma.billingTask as any, "findMany", async () => []);

  // Observed through the throttle store the limiter actually writes to, rather
  // than by patching the module: the route imports the binding directly, so a
  // namespace patch never intercepts it and the test would pass on nothing.
  const keys: string[] = [];
  stubMethod(t, prisma.authThrottle as any, "updateMany", async (a: any) => {
    if (a?.where?.key) keys.push(a.where.key);
    return { count: 0 };
  });
  stubMethod(t, prisma.authThrottle as any, "upsert", async (a: any) => {
    const k = a?.where?.key;
    if (k) keys.push(k);
    return {};
  });
  stubMethod(t, prisma.authThrottle as any, "findUnique", async () => null);

  // The route 409s (no subscription) long before it would reach Lemon Squeezy;
  // what is asserted is that a budget was consumed at all.
  await request(app).post("/api/subscription/change-plan").set(auth).send({ plan: "yearly" });

  assert.ok(
    keys.some((k) => k.startsWith("change-plan:")),
    `no rate-limit budget was consumed (saw: ${JSON.stringify(keys)})`,
  );
});
