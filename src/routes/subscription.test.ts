import assert from "node:assert/strict";
import { test } from "node:test";
import request from "supertest";
import { createApp } from "../app";
import { stubAccountGuard } from "./test-helpers";
import { signToken } from "../lib/jwt";
import { prisma } from "../lib/prisma";
import { env } from "../lib/env";

/*
 * "Pay now" takes money from a card that is already on file, without a browser
 * and without the customer confirming anything at Lemon Squeezy's end. So the
 * two properties worth pinning are: WHOSE subscription it charges, and that it
 * refuses everything that is not a live trial.
 */

const app = createApp();
stubAccountGuard();

const userId = "507f1f77bcf86cd799439011";
const auth = { authorization: `Bearer ${signToken({ sub: userId, email: "user@example.com" })}` };

type Ctx = { after: (fn: () => void) => void };

function stubMethod(t: Ctx, target: Record<string, any>, name: string, impl: (...a: any[]) => any) {
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

function configured(t: Ctx, extra: Record<string, unknown> = {}) {
  const before: Record<string, unknown> = {};
  const patch = { lemonSqueezyApiKey: "test-key", ...extra };
  for (const [k, v] of Object.entries(patch)) {
    before[k] = (env as any)[k];
    (env as any)[k] = v;
  }
  t.after(() => {
    for (const [k, v] of Object.entries(before)) (env as any)[k] = v;
  });
}

function stubFetch(t: Ctx, impl: (...a: any[]) => any) {
  const original = globalThis.fetch;
  (globalThis as any).fetch = impl;
  t.after(() => {
    (globalThis as any).fetch = original;
  });
}

const liveTrial = {
  externalId: "77001",
  status: "on_trial",
  validUntil: new Date(Date.now() + 3 * 86_400_000),
  trialEndsAt: new Date(Date.now() + 3 * 86_400_000),
};

test("ending a trial requires a bearer token", async () => {
  const res = await request(app).post("/api/subscription/end-trial");
  assert.equal(res.status, 401);
});

test("it ends the trial NOW and asks for the invoice immediately", async (t) => {
  configured(t);
  stubMethod(t, prisma.subscription as any, "findMany", async () => [liveTrial]);

  let url = "";
  let init: any = null;
  stubFetch(t, async (u: string, i: any) => {
    url = u;
    init = i;
    return { ok: true, status: 200, json: async () => ({}) };
  });

  const res = await request(app).post("/api/subscription/end-trial").set(auth);

  assert.equal(res.status, 202);
  assert.equal(init.method, "PATCH");
  assert.ok(url.endsWith("/v1/subscriptions/77001"), url);

  const sent = JSON.parse(init.body);
  assert.equal(sent.data.id, "77001");
  // Without this the trial ends and the charge still waits for the next
  // renewal — the customer presses "Pay now" and pays nothing.
  assert.equal(sent.data.attributes.invoice_immediately, true);
  const endsAt = Date.parse(sent.data.attributes.trial_ends_at);
  assert.ok(Math.abs(endsAt - Date.now()) < 60_000, "the trial ends now, not at some future date");
});

/*
 * The subscription is found from the TOKEN. A subscription id in the request
 * body would let anyone end — and charge — a stranger's trial.
 */
test("the subscription comes from the caller's token, never from the request", async (t) => {
  configured(t);
  const finds = stubMethod(t, prisma.subscription as any, "findMany", async () => [liveTrial]);
  stubFetch(t, async () => ({ ok: true, status: 200, json: async () => ({}) }));

  await request(app)
    .post("/api/subscription/end-trial")
    .set(auth)
    .send({ subscriptionId: "99999", externalId: "99999" });

  assert.equal(finds[0][0].where.userId, userId, "scoped to the caller");
});

test("a second click is refused rather than charging twice", async (t) => {
  configured(t);
  // The first click converted it: the status is no longer on_trial.
  stubMethod(t, prisma.subscription as any, "findMany", async () => [
    { ...liveTrial, status: "active" },
  ]);
  stubFetch(t, async () => {
    throw new Error("must not reach Lemon Squeezy");
  });

  const res = await request(app).post("/api/subscription/end-trial").set(auth);

  assert.equal(res.status, 409);
});

test("an expired trial is not a trial to end", async (t) => {
  configured(t);
  stubMethod(t, prisma.subscription as any, "findMany", async () => [
    { ...liveTrial, validUntil: new Date(Date.now() - 86_400_000) },
  ]);
  stubFetch(t, async () => {
    throw new Error("must not reach Lemon Squeezy");
  });

  const res = await request(app).post("/api/subscription/end-trial").set(auth);

  assert.equal(res.status, 409);
});

test("an account with no subscription at all is refused cleanly", async (t) => {
  configured(t);
  stubMethod(t, prisma.subscription as any, "findMany", async () => []);
  stubFetch(t, async () => {
    throw new Error("must not reach Lemon Squeezy");
  });

  const res = await request(app).post("/api/subscription/end-trial").set(auth);

  assert.equal(res.status, 409);
});

test("a provider outage does not leak the API key", async (t) => {
  configured(t);
  stubMethod(t, prisma.subscription as any, "findMany", async () => [liveTrial]);
  stubFetch(t, async () => {
    throw new Error("connect ECONNREFUSED — Bearer test-key");
  });

  const res = await request(app).post("/api/subscription/end-trial").set(auth);

  assert.equal(res.status, 400);
  assert.ok(!JSON.stringify(res.body).includes("test-key"));
});

test("an unconfigured storefront fails loudly instead of pretending to charge", async (t) => {
  configured(t, { lemonSqueezyApiKey: "" });
  stubFetch(t, async () => {
    throw new Error("must not reach Lemon Squeezy");
  });

  const res = await request(app).post("/api/subscription/end-trial").set(auth);

  assert.equal(res.status, 400);
});
