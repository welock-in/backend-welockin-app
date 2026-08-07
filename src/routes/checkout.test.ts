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

  assert.equal(res.status, 201);
  assert.equal(res.body.url, "https://the-hnh.lemonsqueezy.com/checkout/abc");
  // The whole reason this endpoint exists: the account is bound server-side,
  // from the token, before the payment page is created.
  assert.equal(sent.data.attributes.checkout_data.custom.user_id, userId);
  assert.equal(sent.data.relationships.variant.data.id, "1960881");
});

test("someone who already owns the licence is not sent to pay again", async (t) => {
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

  assert.equal(res.status, 201);
  assert.equal(calls[0][0].where.isRefunded, false);
});

test("an unconfigured storefront fails loudly instead of returning a dead button", async (t) => {
  const before = env.lemonSqueezyVariantId;
  (env as any).lemonSqueezyVariantId = "";
  t.after(() => {
    (env as any).lemonSqueezyVariantId = before;
  });

  const res = await request(app).post("/api/checkout").set(auth).send({ plan: "lifetime" });

  assert.equal(res.status, 400);
});

test("a provider outage does not leak the request or hang the caller", async (t) => {
  configured(t);
  stubMethod(t, prisma.user as any, "findUnique", async () => ({ email: "user@example.com" }));
  stubMethod(t, prisma.purchase as any, "findFirst", async () => null);
  stubFetch(t, async () => {
    throw new Error("connect ECONNREFUSED — Bearer test-key");
  });

  const res = await request(app).post("/api/checkout").set(auth).send({ plan: "lifetime" });

  assert.equal(res.status, 400);
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
    configured(t);
    stubMethod(t, prisma.user as any, "findUnique", async () => ({ email: "user@example.com" }));
    stubMethod(t, prisma.purchase as any, "findFirst", async () => null);
    stubMethod(t, prisma.subscription as any, "findMany", async () => []);

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

    assert.equal(res.status, 201);
    assert.equal(sent.data.relationships.variant.data.id, variantId);
  });
}

test("a variant id supplied by the caller is ignored", async (t) => {
  configured(t);
  stubMethod(t, prisma.user as any, "findUnique", async () => ({ email: "user@example.com" }));
  stubMethod(t, prisma.purchase as any, "findFirst", async () => null);
  stubMethod(t, prisma.subscription as any, "findMany", async () => []);

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

  assert.equal(res.status, 201);
  assert.equal(sent.data.relationships.variant.data.id, "1986433");
});

test("an unknown plan never reaches the provider", async (t) => {
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
  configured(t);
  (env as any).lemonSqueezyVariantMonthly = "";
  stubMethod(t, prisma.user as any, "findUnique", async () => ({ email: "user@example.com" }));
  stubMethod(t, prisma.purchase as any, "findFirst", async () => null);
  stubMethod(t, prisma.subscription as any, "findMany", async () => []);
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
  configured(t);
  stubMethod(t, prisma.user as any, "findUnique", async () => ({ email: "user@example.com" }));
  stubMethod(t, prisma.purchase as any, "findFirst", async () => null);
  stubMethod(t, prisma.subscription as any, "findMany", async () => [
    { status: "active", validUntil: new Date(Date.now() + 30 * 86_400_000) },
  ]);
  stubFetch(t, async () => {
    throw new Error("must not reach Lemon Squeezy");
  });

  const res = await request(app).post("/api/checkout").set(auth).send({ plan: "yearly" });

  assert.equal(res.status, 409);
});

// Refusing this would be refusing money from the best customer there is.
test("a live subscription does NOT block the upgrade to lifetime", async (t) => {
  configured(t);
  stubMethod(t, prisma.user as any, "findUnique", async () => ({ email: "user@example.com" }));
  stubMethod(t, prisma.purchase as any, "findFirst", async () => null);
  stubMethod(t, prisma.subscription as any, "findMany", async () => [
    { status: "on_trial", validUntil: new Date(Date.now() + 3 * 86_400_000) },
  ]);
  stubFetch(t, async () => ({
    ok: true,
    status: 201,
    json: async () => ({ data: { attributes: { url: "https://example.test/c" } } }),
  }));

  const res = await request(app).post("/api/checkout").set(auth).send({ plan: "lifetime" });

  assert.equal(res.status, 201);
});

test("a lapsed subscription does not block resubscribing", async (t) => {
  configured(t);
  stubMethod(t, prisma.user as any, "findUnique", async () => ({ email: "user@example.com" }));
  stubMethod(t, prisma.purchase as any, "findFirst", async () => null);
  stubMethod(t, prisma.subscription as any, "findMany", async () => [
    { status: "expired", validUntil: new Date(Date.now() - 86_400_000) },
  ]);
  stubFetch(t, async () => ({
    ok: true,
    status: 201,
    json: async () => ({ data: { attributes: { url: "https://example.test/c" } } }),
  }));

  const res = await request(app).post("/api/checkout").set(auth).send({ plan: "monthly" });

  assert.equal(res.status, 201);
});

test("a lifetime licence blocks every plan, subscriptions included", async (t) => {
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
  configured(t);
  stubMethod(t, prisma.user as any, "findUnique", async () => ({ email: "user@example.com" }));
  stubMethod(t, prisma.purchase as any, "findFirst", async () => null);
  stubMethod(t, prisma.subscription as any, "findMany", async () => []);
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
  configured(t);
  stubMethod(t, prisma.user as any, "findUnique", async () => ({ email: "user@example.com" }));
  stubMethod(t, prisma.purchase as any, "findFirst", async () => null);
  stubMethod(t, prisma.subscription as any, "findMany", async () => []);
  stubFetch(t, async () => ({
    ok: false,
    status: 502,
    json: async () => {
      throw new Error("not json");
    },
  }));

  const res = await request(app).post("/api/checkout").set(auth).send({ plan: "yearly" });

  assert.equal(res.status, 400);
  assert.match(res.body.error, /HTTP 502/);
  assert.ok(!JSON.stringify(res.body).includes("test-key"));
});
