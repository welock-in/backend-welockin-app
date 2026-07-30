import assert from "node:assert/strict";
import { test } from "node:test";
import request from "supertest";
import { createApp } from "../app";
import { signToken } from "../lib/jwt";
import { prisma } from "../lib/prisma";
import { env } from "../lib/env";

const app = createApp();
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
  const before = {
    key: env.lemonSqueezyApiKey,
    store: env.lemonSqueezyStoreId,
    variant: env.lemonSqueezyVariantId,
  };
  (env as any).lemonSqueezyApiKey = "test-key";
  (env as any).lemonSqueezyStoreId = "364783";
  (env as any).lemonSqueezyVariantId = "1960881";
  t.after(() => {
    (env as any).lemonSqueezyApiKey = before.key;
    (env as any).lemonSqueezyStoreId = before.store;
    (env as any).lemonSqueezyVariantId = before.variant;
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

  const res = await request(app).post("/api/checkout").set(auth);

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

  const res = await request(app).post("/api/checkout").set(auth);

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

  const res = await request(app).post("/api/checkout").set(auth);

  assert.equal(res.status, 201);
  assert.equal(calls[0][0].where.isRefunded, false);
});

test("an unconfigured storefront fails loudly instead of returning a dead button", async (t) => {
  const before = env.lemonSqueezyVariantId;
  (env as any).lemonSqueezyVariantId = "";
  t.after(() => {
    (env as any).lemonSqueezyVariantId = before;
  });

  const res = await request(app).post("/api/checkout").set(auth);

  assert.equal(res.status, 400);
});

test("a provider outage does not leak the request or hang the caller", async (t) => {
  configured(t);
  stubMethod(t, prisma.user as any, "findUnique", async () => ({ email: "user@example.com" }));
  stubMethod(t, prisma.purchase as any, "findFirst", async () => null);
  stubFetch(t, async () => {
    throw new Error("connect ECONNREFUSED — Bearer test-key");
  });

  const res = await request(app).post("/api/checkout").set(auth);

  assert.equal(res.status, 400);
  // The upstream message quoted the Authorization header; it must not travel.
  assert.ok(!JSON.stringify(res.body).includes("test-key"));
});
