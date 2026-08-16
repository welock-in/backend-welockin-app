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
  stubMethod(t, prisma.acquisitionLock as any, "findUnique", async () => null);
  stubMethod(t, prisma.checkoutIntent as any, "findUnique", async () => null);
  stubMethod(t, prisma.purchase as any, "findFirst", async () => null);
  stubMethod(t, prisma.trialClaim as any, "findUnique", async () => null);
  configured(t);
  stubMethod(t, prisma.subscription as any, "findMany", async () => [liveTrial]);
  stubMethod(t, prisma.billingTask as any, "findMany", async () => []);

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
  stubMethod(t, prisma.acquisitionLock as any, "findUnique", async () => null);
  stubMethod(t, prisma.checkoutIntent as any, "findUnique", async () => null);
  stubMethod(t, prisma.purchase as any, "findFirst", async () => null);
  stubMethod(t, prisma.trialClaim as any, "findUnique", async () => null);
  configured(t);
  const finds = stubMethod(t, prisma.subscription as any, "findMany", async () => [liveTrial]);
  stubMethod(t, prisma.billingTask as any, "findMany", async () => []);
  stubFetch(t, async () => ({ ok: true, status: 200, json: async () => ({}) }));

  await request(app)
    .post("/api/subscription/end-trial")
    .set(auth)
    .send({ subscriptionId: "99999", externalId: "99999" });

  assert.equal(finds[0][0].where.userId, userId, "scoped to the caller");
});

test("a second click is refused rather than charging twice", async (t) => {
  stubMethod(t, prisma.acquisitionLock as any, "findUnique", async () => null);
  stubMethod(t, prisma.checkoutIntent as any, "findUnique", async () => null);
  stubMethod(t, prisma.purchase as any, "findFirst", async () => null);
  stubMethod(t, prisma.trialClaim as any, "findUnique", async () => null);
  configured(t);
  // The first click converted it: the status is no longer on_trial.
  stubMethod(t, prisma.subscription as any, "findMany", async () => [
    { ...liveTrial, status: "active" },
  ]);
  stubMethod(t, prisma.billingTask as any, "findMany", async () => []);
  stubFetch(t, async () => {
    throw new Error("must not reach Lemon Squeezy");
  });

  const res = await request(app).post("/api/subscription/end-trial").set(auth);

  assert.equal(res.status, 409);
});

test("an expired trial is not a trial to end", async (t) => {
  stubMethod(t, prisma.acquisitionLock as any, "findUnique", async () => null);
  stubMethod(t, prisma.checkoutIntent as any, "findUnique", async () => null);
  stubMethod(t, prisma.purchase as any, "findFirst", async () => null);
  stubMethod(t, prisma.trialClaim as any, "findUnique", async () => null);
  configured(t);
  stubMethod(t, prisma.subscription as any, "findMany", async () => [
    { ...liveTrial, validUntil: new Date(Date.now() - 86_400_000) },
  ]);
  stubMethod(t, prisma.billingTask as any, "findMany", async () => []);
  stubFetch(t, async () => {
    throw new Error("must not reach Lemon Squeezy");
  });

  const res = await request(app).post("/api/subscription/end-trial").set(auth);

  assert.equal(res.status, 409);
});

test("an account with no subscription at all is refused cleanly", async (t) => {
  stubMethod(t, prisma.acquisitionLock as any, "findUnique", async () => null);
  stubMethod(t, prisma.checkoutIntent as any, "findUnique", async () => null);
  stubMethod(t, prisma.purchase as any, "findFirst", async () => null);
  stubMethod(t, prisma.trialClaim as any, "findUnique", async () => null);
  configured(t);
  stubMethod(t, prisma.subscription as any, "findMany", async () => []);
  stubMethod(t, prisma.billingTask as any, "findMany", async () => []);
  stubFetch(t, async () => {
    throw new Error("must not reach Lemon Squeezy");
  });

  const res = await request(app).post("/api/subscription/end-trial").set(auth);

  assert.equal(res.status, 409);
});

test("a provider outage does not leak the API key", async (t) => {
  stubMethod(t, prisma.acquisitionLock as any, "findUnique", async () => null);
  stubMethod(t, prisma.checkoutIntent as any, "findUnique", async () => null);
  stubMethod(t, prisma.purchase as any, "findFirst", async () => null);
  stubMethod(t, prisma.trialClaim as any, "findUnique", async () => null);
  configured(t);
  stubMethod(t, prisma.subscription as any, "findMany", async () => [liveTrial]);
  stubMethod(t, prisma.billingTask as any, "findMany", async () => []);
  stubFetch(t, async () => {
    throw new Error("connect ECONNREFUSED — Bearer test-key");
  });

  const res = await request(app).post("/api/subscription/end-trial").set(auth);

  assert.equal(res.status, 400);
  assert.ok(!JSON.stringify(res.body).includes("test-key"));
});

test("an unconfigured storefront fails loudly instead of pretending to charge", async (t) => {
  stubMethod(t, prisma.acquisitionLock as any, "findUnique", async () => null);
  stubMethod(t, prisma.checkoutIntent as any, "findUnique", async () => null);
  stubMethod(t, prisma.purchase as any, "findFirst", async () => null);
  stubMethod(t, prisma.trialClaim as any, "findUnique", async () => null);
  stubMethod(t, prisma.billingTask as any, "findMany", async () => []);
  configured(t, { lemonSqueezyApiKey: "" });
  stubFetch(t, async () => {
    throw new Error("must not reach Lemon Squeezy");
  });

  const res = await request(app).post("/api/subscription/end-trial").set(auth);

  assert.equal(res.status, 400);
});

/* ── Cancelling ─────────────────────────────────────────────────────────
 *
 * There must ALWAYS be a way out from inside the app. And cancelling must not
 * take away time already paid for: Lemon Squeezy stops future payments and sets
 * ends_at to the end of the current period, which `subscriptionGrants` honours
 * by ranking `cancelled` as granting.
 */

test("cancelling calls Lemon Squeezy's delete and reports when access stops", async (t) => {
  stubMethod(t, prisma.acquisitionLock as any, "findUnique", async () => null);
  stubMethod(t, prisma.checkoutIntent as any, "findUnique", async () => null);
  stubMethod(t, prisma.purchase as any, "findFirst", async () => null);
  stubMethod(t, prisma.trialClaim as any, "findUnique", async () => null);
  configured(t);
  stubMethod(t, prisma.subscription as any, "findMany", async () => [
    { externalId: "77001", status: "active", validUntil: new Date(Date.now() + 20 * 86_400_000) },
  ]);
  stubMethod(t, prisma.billingTask as any, "findMany", async () => []);

  let url = "";
  let method = "";
  stubFetch(t, async (u: string, i: any) => {
    url = u;
    method = i.method;
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: { attributes: { ends_at: "2026-09-01T00:00:00.000Z" } } }),
    };
  });

  const res = await request(app).post("/api/subscription/cancel").set(auth);

  assert.equal(res.status, 202);
  assert.equal(method, "DELETE");
  assert.ok(url.endsWith("/v1/subscriptions/77001"), url);
  assert.equal(res.body.endsAt, "2026-09-01T00:00:00.000Z", "so the UI can say when it stops");
});

test("the subscription to cancel comes from the token, never the request", async (t) => {
  stubMethod(t, prisma.acquisitionLock as any, "findUnique", async () => null);
  stubMethod(t, prisma.checkoutIntent as any, "findUnique", async () => null);
  stubMethod(t, prisma.purchase as any, "findFirst", async () => null);
  stubMethod(t, prisma.trialClaim as any, "findUnique", async () => null);
  configured(t);
  const finds = stubMethod(t, prisma.subscription as any, "findMany", async () => [
    { externalId: "77001", status: "active", validUntil: new Date(Date.now() + 86_400_000) },
  ]);
  stubMethod(t, prisma.billingTask as any, "findMany", async () => []);
  stubFetch(t, async () => ({ ok: true, status: 200, json: async () => ({}) }));

  await request(app).post("/api/subscription/cancel").set(auth).send({ subscriptionId: "99999" });

  assert.equal(finds[0][0].where.userId, userId);
});

test("cancelling twice is refused rather than repeated", async (t) => {
  stubMethod(t, prisma.acquisitionLock as any, "findUnique", async () => null);
  stubMethod(t, prisma.checkoutIntent as any, "findUnique", async () => null);
  stubMethod(t, prisma.purchase as any, "findFirst", async () => null);
  stubMethod(t, prisma.trialClaim as any, "findUnique", async () => null);
  configured(t);
  stubMethod(t, prisma.subscription as any, "findMany", async () => [
    { externalId: "77001", status: "cancelled", validUntil: new Date(Date.now() + 86_400_000) },
  ]);
  stubMethod(t, prisma.billingTask as any, "findMany", async () => []);
  stubFetch(t, async () => {
    throw new Error("must not reach Lemon Squeezy");
  });

  const res = await request(app).post("/api/subscription/cancel").set(auth);

  assert.equal(res.status, 409);
});

test("cancelling DURING a trial is allowed — it means 'don't charge me'", async (t) => {
  stubMethod(t, prisma.acquisitionLock as any, "findUnique", async () => null);
  stubMethod(t, prisma.checkoutIntent as any, "findUnique", async () => null);
  stubMethod(t, prisma.purchase as any, "findFirst", async () => null);
  stubMethod(t, prisma.trialClaim as any, "findUnique", async () => null);
  configured(t);
  stubMethod(t, prisma.subscription as any, "findMany", async () => [
    { externalId: "77001", status: "on_trial", validUntil: new Date(Date.now() + 3 * 86_400_000) },
  ]);
  stubMethod(t, prisma.billingTask as any, "findMany", async () => []);
  let method = "";
  stubFetch(t, async (_u: string, i: any) => {
    method = i.method;
    return { ok: true, status: 200, json: async () => ({ data: { attributes: { ends_at: "2026-08-15T00:00:00.000Z" } } }) };
  });

  const res = await request(app).post("/api/subscription/cancel").set(auth);

  assert.equal(res.status, 202, "a trialer must be able to opt out before being charged");
  assert.equal(method, "DELETE");
});

test("GET /subscription still marks an on-trial row as cancellable", async (t) => {
  stubMethod(t, prisma.acquisitionLock as any, "findUnique", async () => null);
  stubMethod(t, prisma.checkoutIntent as any, "findUnique", async () => null);
  stubMethod(t, prisma.purchase as any, "findFirst", async () => null);
  stubMethod(t, prisma.trialClaim as any, "findUnique", async () => null);
  configured(t);
  stubMethod(t, prisma.subscription as any, "findMany", async () => [
    {
      status: "on_trial",
      interval: "monthly",
      validUntil: new Date(Date.now() + 3 * 86_400_000),
      trialEndsAt: new Date(Date.now() + 3 * 86_400_000),
      renewsAt: new Date(Date.now() + 3 * 86_400_000),
      endsAt: null,
    },
  ]);
  stubMethod(t, prisma.billingTask as any, "findMany", async () => []);

  const res = await request(app).get("/api/subscription").set(auth);

  assert.equal(res.body.subscription.cancellable, true, "the trialer can cancel to avoid the charge");
});

test("a cancelled subscription still reads as live, with its end date", async (t) => {
  stubMethod(t, prisma.acquisitionLock as any, "findUnique", async () => null);
  stubMethod(t, prisma.checkoutIntent as any, "findUnique", async () => null);
  stubMethod(t, prisma.purchase as any, "findFirst", async () => null);
  stubMethod(t, prisma.trialClaim as any, "findUnique", async () => null);
  configured(t);
  const endsAt = new Date(Date.now() + 12 * 86_400_000);
  stubMethod(t, prisma.subscription as any, "findMany", async () => [
    {
      status: "cancelled",
      interval: "yearly",
      validUntil: endsAt,
      trialEndsAt: null,
      renewsAt: null,
      endsAt,
    },
  ]);
  stubMethod(t, prisma.billingTask as any, "findMany", async () => []);

  const res = await request(app).get("/api/subscription").set(auth);

  assert.equal(res.status, 200);
  assert.equal(res.body.subscription.status, "cancelled");
  assert.equal(res.body.subscription.endsAt, endsAt.toISOString(), "when the access actually stops");
  assert.equal(res.body.subscription.cancellable, false, "nothing left to cancel");
});

test("an account with only expired rows reports no subscription", async (t) => {
  stubMethod(t, prisma.acquisitionLock as any, "findUnique", async () => null);
  stubMethod(t, prisma.checkoutIntent as any, "findUnique", async () => null);
  stubMethod(t, prisma.purchase as any, "findFirst", async () => null);
  stubMethod(t, prisma.trialClaim as any, "findUnique", async () => null);
  configured(t);
  stubMethod(t, prisma.subscription as any, "findMany", async () => [
    {
      status: "expired",
      interval: "monthly",
      validUntil: new Date(Date.now() - 86_400_000),
      trialEndsAt: null,
      renewsAt: null,
      endsAt: new Date(Date.now() - 86_400_000),
    },
  ]);
  stubMethod(t, prisma.billingTask as any, "findMany", async () => []);

  const res = await request(app).get("/api/subscription").set(auth);

  assert.equal(res.body.subscription, null);
});

/*
 * Reactivate = un-cancel during the paid-through window (the gap the audit and
 * the subscription-map both flagged). It must PATCH cancelled:false at Lemon
 * Squeezy, work only on a cancelled-but-still-granting row, and be found from
 * the token like every other money action.
 */
test("reactivating a cancelled-but-live subscription patches cancelled:false", async (t) => {
  stubMethod(t, prisma.acquisitionLock as any, "findUnique", async () => null);
  stubMethod(t, prisma.checkoutIntent as any, "findUnique", async () => null);
  stubMethod(t, prisma.purchase as any, "findFirst", async () => null);
  stubMethod(t, prisma.trialClaim as any, "findUnique", async () => null);
  configured(t);
  stubMethod(t, prisma.subscription as any, "findMany", async () => [
    { externalId: "77001", status: "cancelled", validUntil: new Date(Date.now() + 10 * 86_400_000), endsAt: new Date(Date.now() + 10 * 86_400_000) },
  ]);
  stubMethod(t, prisma.billingTask as any, "findMany", async () => []);

  let url = "";
  let method = "";
  let sentBody: any = null;
  stubFetch(t, async (u: string, i: any) => {
    url = u;
    method = i.method;
    sentBody = JSON.parse(i.body);
    return { ok: true, status: 200, json: async () => ({ data: { attributes: { renews_at: "2026-10-01T00:00:00.000Z" } } }) };
  });

  const res = await request(app).post("/api/subscription/reactivate").set(auth);

  assert.equal(res.status, 202);
  assert.equal(method, "PATCH");
  assert.ok(url.endsWith("/v1/subscriptions/77001"), url);
  assert.equal(sentBody.data.attributes.cancelled, false);
  assert.equal(res.body.renewsAt, "2026-10-01T00:00:00.000Z");
});

test("the subscription to reactivate comes from the token, never the request", async (t) => {
  stubMethod(t, prisma.acquisitionLock as any, "findUnique", async () => null);
  stubMethod(t, prisma.checkoutIntent as any, "findUnique", async () => null);
  stubMethod(t, prisma.purchase as any, "findFirst", async () => null);
  stubMethod(t, prisma.trialClaim as any, "findUnique", async () => null);
  configured(t);
  const finds = stubMethod(t, prisma.subscription as any, "findMany", async () => [
    { externalId: "77001", status: "cancelled", validUntil: new Date(Date.now() + 86_400_000), endsAt: new Date(Date.now() + 86_400_000) },
  ]);
  stubMethod(t, prisma.billingTask as any, "findMany", async () => []);
  stubFetch(t, async () => ({ ok: true, status: 200, json: async () => ({}) }));

  await request(app).post("/api/subscription/reactivate").set(auth).send({ subscriptionId: "99999" });

  assert.equal(finds[0][0].where.userId, userId);
});

test("there is nothing to reactivate on an account with no cancelled subscription", async (t) => {
  stubMethod(t, prisma.acquisitionLock as any, "findUnique", async () => null);
  stubMethod(t, prisma.checkoutIntent as any, "findUnique", async () => null);
  stubMethod(t, prisma.purchase as any, "findFirst", async () => null);
  stubMethod(t, prisma.trialClaim as any, "findUnique", async () => null);
  configured(t);
  stubMethod(t, prisma.subscription as any, "findMany", async () => [
    { externalId: "77001", status: "active", validUntil: new Date(Date.now() + 86_400_000), endsAt: null },
  ]);
  stubMethod(t, prisma.billingTask as any, "findMany", async () => []);
  let called = false;
  stubFetch(t, async () => {
    called = true;
    return { ok: true, status: 200, json: async () => ({}) };
  });

  const res = await request(app).post("/api/subscription/reactivate").set(auth);

  assert.equal(res.status, 409);
  assert.equal(called, false, "Lemon Squeezy is never called when there is nothing to resume");
});

test("an already-expired subscription cannot be reactivated (start a new plan instead)", async (t) => {
  stubMethod(t, prisma.acquisitionLock as any, "findUnique", async () => null);
  stubMethod(t, prisma.checkoutIntent as any, "findUnique", async () => null);
  stubMethod(t, prisma.purchase as any, "findFirst", async () => null);
  stubMethod(t, prisma.trialClaim as any, "findUnique", async () => null);
  configured(t);
  stubMethod(t, prisma.subscription as any, "findMany", async () => [
    { externalId: "77001", status: "cancelled", validUntil: new Date(Date.now() - 86_400_000), endsAt: new Date(Date.now() - 86_400_000) },
  ]);
  stubMethod(t, prisma.billingTask as any, "findMany", async () => []);
  stubFetch(t, async () => ({ ok: true, status: 200, json: async () => ({}) }));

  const res = await request(app).post("/api/subscription/reactivate").set(auth);

  // Past ends_at the row no longer grants, so subscriptionGrants filters it out
  // and there is nothing resumable — a clean 409, not a provider error.
  assert.equal(res.status, 409);
});

test("GET /subscription flags a cancelled-but-live row as reactivatable", async (t) => {
  stubMethod(t, prisma.acquisitionLock as any, "findUnique", async () => null);
  stubMethod(t, prisma.checkoutIntent as any, "findUnique", async () => null);
  stubMethod(t, prisma.purchase as any, "findFirst", async () => null);
  stubMethod(t, prisma.trialClaim as any, "findUnique", async () => null);
  configured(t);
  stubMethod(t, prisma.subscription as any, "findMany", async () => [
    {
      status: "cancelled",
      interval: "yearly",
      validUntil: new Date(Date.now() + 5 * 86_400_000),
      trialEndsAt: null,
      renewsAt: null,
      endsAt: new Date(Date.now() + 5 * 86_400_000),
    },
  ]);
  stubMethod(t, prisma.billingTask as any, "findMany", async () => []);

  const res = await request(app).get("/api/subscription").set(auth);

  assert.equal(res.body.subscription.reactivatable, true);
  assert.equal(res.body.subscription.cancellable, false);
});

/* ── Change plan (monthly ↔ yearly) ─────────────────────────────────────── */

const liveMonthly = {
  externalId: "77001",
  status: "active",
  validUntil: new Date(Date.now() + 20 * 86_400_000),
  variantId: "1986433", // env.lemonSqueezyVariantMonthly (configured() sets this)
};
const liveYearly = {
  externalId: "77002",
  status: "active",
  validUntil: new Date(Date.now() + 300 * 86_400_000),
  variantId: "1986420", // env.lemonSqueezyVariantYearly
};

function configuredVariants(t: Ctx) {
  configured(t, {
    lemonSqueezyApiKey: "test-key",
    lemonSqueezyVariantMonthly: "1986433",
    lemonSqueezyVariantYearly: "1986420",
    lemonSqueezyVariantId: "1960881",
  });
}

test("upgrading monthly→yearly PATCHes the new variant and charges now", async (t) => {
  stubMethod(t, prisma.acquisitionLock as any, "findUnique", async () => null);
  stubMethod(t, prisma.checkoutIntent as any, "findUnique", async () => null);
  stubMethod(t, prisma.purchase as any, "findFirst", async () => null);
  stubMethod(t, prisma.trialClaim as any, "findUnique", async () => null);
  configuredVariants(t);
  stubMethod(t, prisma.subscription as any, "findMany", async () => [liveMonthly]);
  stubMethod(t, prisma.billingTask as any, "findMany", async () => []);
  let init: any = null;
  let url = "";
  stubFetch(t, async (u: string, i: any) => {
    url = u;
    init = i;
    return { ok: true, status: 200, json: async () => ({ data: { attributes: { renews_at: "2027-01-01T00:00:00.000Z" } } }) };
  });

  const res = await request(app).post("/api/subscription/change-plan").set(auth).send({ plan: "yearly" });

  assert.equal(res.status, 202);
  assert.equal(init.method, "PATCH");
  assert.ok(url.endsWith("/v1/subscriptions/77001"), url);
  const sent = JSON.parse(init.body);
  assert.equal(sent.data.attributes.variant_id, 1986420);
  assert.equal(sent.data.attributes.invoice_immediately, true, "an upgrade charges the prorated difference now");
  assert.ok(!("disable_prorations" in sent.data.attributes), "upgrade must not disable prorations");
  assert.equal(res.body.immediate, true);
});

test("downgrading yearly→monthly switches at renewal without charging now", async (t) => {
  stubMethod(t, prisma.acquisitionLock as any, "findUnique", async () => null);
  stubMethod(t, prisma.checkoutIntent as any, "findUnique", async () => null);
  stubMethod(t, prisma.purchase as any, "findFirst", async () => null);
  stubMethod(t, prisma.trialClaim as any, "findUnique", async () => null);
  configuredVariants(t);
  stubMethod(t, prisma.subscription as any, "findMany", async () => [liveYearly]);
  stubMethod(t, prisma.billingTask as any, "findMany", async () => []);
  let init: any = null;
  stubFetch(t, async (_u: string, i: any) => {
    init = i;
    return { ok: true, status: 200, json: async () => ({}) };
  });

  const res = await request(app).post("/api/subscription/change-plan").set(auth).send({ plan: "monthly" });

  assert.equal(res.status, 202);
  const sent = JSON.parse(init.body);
  assert.equal(sent.data.attributes.variant_id, 1986433);
  assert.equal(sent.data.attributes.disable_prorations, true, "a downgrade bills the new price next renewal, no charge now");
  assert.ok(!("invoice_immediately" in sent.data.attributes), "downgrade must not invoice immediately");
  assert.equal(res.body.immediate, false);
});

test("changing plan is refused while on trial (pay now first)", async (t) => {
  stubMethod(t, prisma.acquisitionLock as any, "findUnique", async () => null);
  stubMethod(t, prisma.checkoutIntent as any, "findUnique", async () => null);
  stubMethod(t, prisma.purchase as any, "findFirst", async () => null);
  stubMethod(t, prisma.trialClaim as any, "findUnique", async () => null);
  configuredVariants(t);
  stubMethod(t, prisma.subscription as any, "findMany", async () => [
    { externalId: "77001", status: "on_trial", validUntil: new Date(Date.now() + 3 * 86_400_000), variantId: "1986433" },
  ]);
  stubMethod(t, prisma.billingTask as any, "findMany", async () => []);
  let called = false;
  stubFetch(t, async () => {
    called = true;
    return { ok: true, status: 200, json: async () => ({}) };
  });

  const res = await request(app).post("/api/subscription/change-plan").set(auth).send({ plan: "yearly" });

  assert.equal(res.status, 409);
  assert.equal(called, false, "Lemon Squeezy is never called for an on-trial change");
});

test("changing to the plan you already have is refused", async (t) => {
  stubMethod(t, prisma.acquisitionLock as any, "findUnique", async () => null);
  stubMethod(t, prisma.checkoutIntent as any, "findUnique", async () => null);
  stubMethod(t, prisma.purchase as any, "findFirst", async () => null);
  stubMethod(t, prisma.trialClaim as any, "findUnique", async () => null);
  configuredVariants(t);
  stubMethod(t, prisma.subscription as any, "findMany", async () => [liveMonthly]);
  stubMethod(t, prisma.billingTask as any, "findMany", async () => []);
  stubFetch(t, async () => ({ ok: true, status: 200, json: async () => ({}) }));

  const res = await request(app).post("/api/subscription/change-plan").set(auth).send({ plan: "monthly" });

  assert.equal(res.status, 409);
});

test("changing plan comes from the token, never the request body", async (t) => {
  stubMethod(t, prisma.acquisitionLock as any, "findUnique", async () => null);
  stubMethod(t, prisma.checkoutIntent as any, "findUnique", async () => null);
  stubMethod(t, prisma.purchase as any, "findFirst", async () => null);
  stubMethod(t, prisma.trialClaim as any, "findUnique", async () => null);
  configuredVariants(t);
  const finds = stubMethod(t, prisma.subscription as any, "findMany", async () => [liveMonthly]);
  stubMethod(t, prisma.billingTask as any, "findMany", async () => []);
  stubFetch(t, async () => ({ ok: true, status: 200, json: async () => ({}) }));

  await request(app).post("/api/subscription/change-plan").set(auth).send({ plan: "yearly", subscriptionId: "99999" });

  assert.equal(finds[0][0].where.userId, userId);
});

/*
 * PayPal-backed subscriptions cannot be PATCHed — Lemon Squeezy answers 422,
 * because the change must go through PayPal's own consent flow — and the
 * subscription object then carries `urls.customer_portal_update_subscription`,
 * the one page that CAN do it. The client must receive that page as a stable
 * code, not a dead-end prose error.
 */
test("a PayPal-backed change-plan hands back the portal that CAN do it", async (t) => {
  stubMethod(t, prisma.acquisitionLock as any, "findUnique", async () => null);
  stubMethod(t, prisma.checkoutIntent as any, "findUnique", async () => null);
  stubMethod(t, prisma.purchase as any, "findFirst", async () => null);
  stubMethod(t, prisma.trialClaim as any, "findUnique", async () => null);
  configuredVariants(t);
  stubMethod(t, prisma.subscription as any, "findMany", async () => [liveMonthly]);
  stubMethod(t, prisma.billingTask as any, "findMany", async () => []);
  stubFetch(t, async (_u: string, i: any) => {
    if ((i?.method ?? "GET") === "PATCH") {
      return {
        ok: false,
        status: 422,
        json: async () => ({ errors: [{ title: "Unprocessable Entity", detail: "PayPal subscriptions cannot be updated" }] }),
      };
    }
    // The re-fetch: the subscription object carries the PayPal portal page.
    return {
      ok: true,
      status: 200,
      json: async () => ({
        data: { attributes: { urls: { customer_portal_update_subscription: "https://x/paypal-portal" } } },
      }),
    };
  });

  const res = await request(app).post("/api/subscription/change-plan").set(auth).send({ plan: "yearly" });

  assert.equal(res.status, 409);
  assert.equal(res.body.code, "SUBSCRIPTION_PORTAL_REQUIRED");
  assert.equal(res.body.url, "https://x/paypal-portal");
});

test("a 422 with no portal page to offer stays the generic refusal", async (t) => {
  // Not every 422 is PayPal. When the re-fetch has no portal URL, the honest
  // answer is still the provider's own refusal — never a 409 pointing nowhere.
  stubMethod(t, prisma.acquisitionLock as any, "findUnique", async () => null);
  stubMethod(t, prisma.checkoutIntent as any, "findUnique", async () => null);
  stubMethod(t, prisma.purchase as any, "findFirst", async () => null);
  stubMethod(t, prisma.trialClaim as any, "findUnique", async () => null);
  configuredVariants(t);
  stubMethod(t, prisma.subscription as any, "findMany", async () => [liveMonthly]);
  stubMethod(t, prisma.billingTask as any, "findMany", async () => []);
  stubFetch(t, async (_u: string, i: any) => {
    if ((i?.method ?? "GET") === "PATCH") {
      return { ok: false, status: 422, json: async () => ({ errors: [{ title: "Unprocessable Entity" }] }) };
    }
    return { ok: true, status: 200, json: async () => ({ data: { attributes: { urls: {} } } }) };
  });

  const res = await request(app).post("/api/subscription/change-plan").set(auth).send({ plan: "yearly" });

  assert.equal(res.status, 400);
  assert.equal(res.body.code, undefined);
});

test("a PayPal-backed end-trial hands back the same portal", async (t) => {
  stubMethod(t, prisma.acquisitionLock as any, "findUnique", async () => null);
  stubMethod(t, prisma.checkoutIntent as any, "findUnique", async () => null);
  stubMethod(t, prisma.purchase as any, "findFirst", async () => null);
  stubMethod(t, prisma.trialClaim as any, "findUnique", async () => null);
  configured(t);
  stubMethod(t, prisma.subscription as any, "findMany", async () => [liveTrial]);
  stubMethod(t, prisma.billingTask as any, "findMany", async () => []);
  stubFetch(t, async (_u: string, i: any) => {
    if ((i?.method ?? "GET") === "PATCH") {
      return { ok: false, status: 422, json: async () => ({ errors: [{ title: "Unprocessable Entity" }] }) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        data: { attributes: { urls: { customer_portal_update_subscription: "https://x/paypal-portal" } } },
      }),
    };
  });

  const res = await request(app).post("/api/subscription/end-trial").set(auth);

  assert.equal(res.status, 409);
  assert.equal(res.body.code, "SUBSCRIPTION_PORTAL_REQUIRED");
  assert.equal(res.body.url, "https://x/paypal-portal");
});

test("change-plan rejects a plan that is not monthly or yearly (no lifetime here)", async (t) => {
  stubMethod(t, prisma.acquisitionLock as any, "findUnique", async () => null);
  stubMethod(t, prisma.checkoutIntent as any, "findUnique", async () => null);
  stubMethod(t, prisma.purchase as any, "findFirst", async () => null);
  stubMethod(t, prisma.trialClaim as any, "findUnique", async () => null);
  configuredVariants(t);
  stubMethod(t, prisma.subscription as any, "findMany", async () => [liveMonthly]);
  stubMethod(t, prisma.billingTask as any, "findMany", async () => []);
  stubFetch(t, async () => ({ ok: true, status: 200, json: async () => ({}) }));

  const res = await request(app).post("/api/subscription/change-plan").set(auth).send({ plan: "lifetime" });

  assert.equal(res.status, 400, "lifetime is a checkout, not a variant swap");
});

/* ── GET /portal — a link that is actually alive ─────────────────────────
 *
 * Lemon Squeezy SIGNS the customer-portal URL and it expires after 24 hours. We
 * persist it on every webhook and used to hand that stored copy out, which is
 * fine for an account whose subscription changed today and a dead link for
 * everyone else — i.e. for almost everyone, almost always, in the way that is
 * hardest to notice: the button works, the page just refuses.
 */

const liveSub = {
  id: "row-1",
  externalId: "77001",
  status: "active",
  validUntil: new Date(Date.now() + 20 * 86_400_000),
  trialEndsAt: null,
  trialCancelledAt: null,
  pauseMode: null,
  variantId: "",
  providerUpdatedAt: new Date(),
  createdAt: new Date(),
  customerPortalUrl: "https://stored/portal",
  updatePaymentUrl: "https://stored/pay",
};

test("the portal link is fetched fresh from Lemon Squeezy, not served from the row", async (t) => {
  stubMethod(t, prisma.acquisitionLock as any, "findUnique", async () => null);
  stubMethod(t, prisma.checkoutIntent as any, "findUnique", async () => null);
  stubMethod(t, prisma.purchase as any, "findFirst", async () => null);
  stubMethod(t, prisma.trialClaim as any, "findUnique", async () => null);
  configured(t);
  stubMethod(t, prisma.subscription as any, "findMany", async () => [liveSub]);
  stubMethod(t, prisma.billingTask as any, "findMany", async () => []);
  const writes = stubMethod(t, prisma.subscription as any, "update", async () => ({}));
  stubFetch(t, async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      data: { attributes: { urls: { customer_portal: "https://fresh/portal" } } },
    }),
  }));

  const res = await request(app).get("/api/subscription/portal").set(auth);

  assert.equal(res.status, 200);
  assert.equal(res.body.url, "https://fresh/portal");
  assert.equal(res.body.fresh, true);
  assert.equal(writes[0][0].data.customerPortalUrl, "https://fresh/portal", "and cached on the way past");
});

test("an unreachable provider falls back to the stored link rather than nothing", async (t) => {
  stubMethod(t, prisma.acquisitionLock as any, "findUnique", async () => null);
  stubMethod(t, prisma.checkoutIntent as any, "findUnique", async () => null);
  stubMethod(t, prisma.purchase as any, "findFirst", async () => null);
  stubMethod(t, prisma.trialClaim as any, "findUnique", async () => null);
  configured(t);
  stubMethod(t, prisma.subscription as any, "findMany", async () => [liveSub]);
  stubMethod(t, prisma.billingTask as any, "findMany", async () => []);
  stubMethod(t, prisma.subscription as any, "update", async () => ({}));
  stubFetch(t, async () => {
    throw new Error("ECONNREFUSED");
  });

  const res = await request(app).get("/api/subscription/portal").set(auth);

  assert.equal(res.status, 200);
  assert.equal(res.body.url, "https://stored/portal");
  assert.equal(res.body.fresh, false, "possibly stale beats no link at all — and says so");
});

/*
 * The subscription is found from the TOKEN and never named by the request. There
 * is no id to supply, so there is nothing to enumerate: an account with no rows
 * gets a refusal, not somebody else's billing page.
 */
test("an account with no subscription cannot reach a portal link", async (t) => {
  stubMethod(t, prisma.acquisitionLock as any, "findUnique", async () => null);
  stubMethod(t, prisma.checkoutIntent as any, "findUnique", async () => null);
  stubMethod(t, prisma.purchase as any, "findFirst", async () => null);
  stubMethod(t, prisma.trialClaim as any, "findUnique", async () => null);
  configured(t);
  stubMethod(t, prisma.subscription as any, "findMany", async () => []);
  stubMethod(t, prisma.billingTask as any, "findMany", async () => []);
  stubFetch(t, async () => {
    throw new Error("must not reach Lemon Squeezy");
  });

  const res = await request(app).get("/api/subscription/portal").set(auth);

  assert.equal(res.status, 409);
});

test("the portal link needs a bearer token", async () => {
  const res = await request(app).get("/api/subscription/portal");
  assert.equal(res.status, 401);
});

/* ── a cancelled trial is not resumable ──────────────────────────────────
 *
 * The other half of the tombstone. Cancelling a trial ends access at once, so
 * there is nothing left to resume — and if this endpoint resumed it anyway, the
 * customer would get the rest of their trial back for free, repeatedly.
 */
test("reactivate refuses a trial that was cancelled", async (t) => {
  stubMethod(t, prisma.acquisitionLock as any, "findUnique", async () => null);
  stubMethod(t, prisma.checkoutIntent as any, "findUnique", async () => null);
  stubMethod(t, prisma.purchase as any, "findFirst", async () => null);
  stubMethod(t, prisma.trialClaim as any, "findUnique", async () => null);
  configured(t);
  const inThreeDays = new Date(Date.now() + 3 * 86_400_000);
  stubMethod(t, prisma.subscription as any, "findMany", async () => [
    {
      externalId: "77001",
      status: "cancelled",
      validUntil: inThreeDays,
      endsAt: inThreeDays,
      trialEndsAt: inThreeDays,
      trialCancelledAt: new Date(),
      pauseMode: null,
      variantId: "",
      providerUpdatedAt: new Date(),
      createdAt: new Date(),
    },
  ]);
  stubMethod(t, prisma.billingTask as any, "findMany", async () => []);
  stubFetch(t, async () => {
    throw new Error("must not reach Lemon Squeezy");
  });

  const res = await request(app).post("/api/subscription/reactivate").set(auth);

  assert.equal(res.status, 409);
});

test("reactivate still works for a cancelled PAID subscription", async (t) => {
  stubMethod(t, prisma.acquisitionLock as any, "findUnique", async () => null);
  stubMethod(t, prisma.checkoutIntent as any, "findUnique", async () => null);
  stubMethod(t, prisma.purchase as any, "findFirst", async () => null);
  stubMethod(t, prisma.trialClaim as any, "findUnique", async () => null);
  configured(t);
  const inTenDays = new Date(Date.now() + 10 * 86_400_000);
  stubMethod(t, prisma.subscription as any, "findMany", async () => [
    {
      externalId: "77001",
      status: "cancelled",
      validUntil: inTenDays,
      endsAt: inTenDays,
      // Trialed long ago, converted, paid, then cancelled — the grace is bought.
      trialEndsAt: new Date(Date.now() - 30 * 86_400_000),
      trialCancelledAt: null,
      pauseMode: null,
      variantId: "",
      providerUpdatedAt: new Date(),
      createdAt: new Date(),
    },
  ]);
  stubMethod(t, prisma.billingTask as any, "findMany", async () => []);
  stubFetch(t, async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: { attributes: { renews_at: inTenDays.toISOString() } } }),
  }));

  const res = await request(app).post("/api/subscription/reactivate").set(auth);

  assert.equal(res.status, 202);
});

/*
 * The button that "did nothing". The desktop re-reads GET /subscription the
 * moment reactivate answers 202 — and the row still said `cancelled` until the
 * webhook landed, so the pane redrew the exact screen the customer had just
 * acted on, Reactivate button included. /cancel mirrors optimistically for the
 * mirror-image reason; this pins that /reactivate now does too.
 */
test("a successful reactivate mirrors the row NOW — the desktop re-reads before the webhook lands", async (t) => {
  stubMethod(t, prisma.acquisitionLock as any, "findUnique", async () => null);
  stubMethod(t, prisma.checkoutIntent as any, "findUnique", async () => null);
  stubMethod(t, prisma.purchase as any, "findFirst", async () => null);
  stubMethod(t, prisma.trialClaim as any, "findUnique", async () => null);
  configured(t);
  const inTenDays = new Date(Date.now() + 10 * 86_400_000);
  stubMethod(t, prisma.subscription as any, "findMany", async () => [
    {
      id: "row-1",
      externalId: "77001",
      status: "cancelled",
      validUntil: inTenDays,
      endsAt: inTenDays,
      trialEndsAt: null,
      trialCancelledAt: null,
      pauseMode: null,
      variantId: "",
      providerUpdatedAt: new Date(),
      createdAt: new Date(),
    },
  ]);
  stubMethod(t, prisma.billingTask as any, "findMany", async () => []);
  const writes = stubMethod(t, prisma.subscription as any, "update", async () => ({}));
  stubFetch(t, async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: { attributes: { renews_at: "2026-10-01T00:00:00.000Z" } } }),
  }));

  const res = await request(app).post("/api/subscription/reactivate").set(auth);

  assert.equal(res.status, 202);
  assert.equal(writes.length, 1, "the row is mirrored immediately, like /cancel does");
  const [{ where, data }] = writes[0] as [{ where: any; data: any }];
  assert.equal(where.id, "row-1");
  assert.equal(data.status, "active", "un-cancelled: LS returns the subscription to active");
  assert.equal(data.endsAt, null, "the paid-through stop is cleared — nothing is ending any more");
  assert.equal(data.renewsAt?.toISOString(), "2026-10-01T00:00:00.000Z");
  assert.equal(data.validUntil?.toISOString(), "2026-10-01T00:00:00.000Z");
  // The webhook stays the authority: its staleness guard compares this stamp,
  // and writing it here would let the optimistic guess outrank the real event.
  assert.ok(!("providerUpdatedAt" in data), "providerUpdatedAt is the webhook's to write");
});

test("a reactivate answered without a renewal date mirrors the status and keeps the old window", async (t) => {
  stubMethod(t, prisma.acquisitionLock as any, "findUnique", async () => null);
  stubMethod(t, prisma.checkoutIntent as any, "findUnique", async () => null);
  stubMethod(t, prisma.purchase as any, "findFirst", async () => null);
  stubMethod(t, prisma.trialClaim as any, "findUnique", async () => null);
  configured(t);
  const inTenDays = new Date(Date.now() + 10 * 86_400_000);
  stubMethod(t, prisma.subscription as any, "findMany", async () => [
    {
      id: "row-1",
      externalId: "77001",
      status: "cancelled",
      validUntil: inTenDays,
      endsAt: inTenDays,
      trialEndsAt: null,
      trialCancelledAt: null,
      pauseMode: null,
      variantId: "",
      providerUpdatedAt: new Date(),
      createdAt: new Date(),
    },
  ]);
  stubMethod(t, prisma.billingTask as any, "findMany", async () => []);
  const writes = stubMethod(t, prisma.subscription as any, "update", async () => ({}));
  // A body we cannot read: the reactivation still happened.
  stubFetch(t, async () => ({
    ok: true,
    status: 200,
    json: async () => ({}),
  }));

  const res = await request(app).post("/api/subscription/reactivate").set(auth);

  assert.equal(res.status, 202);
  assert.equal(writes.length, 1);
  const [{ data }] = writes[0] as [{ data: any }];
  assert.equal(data.status, "active");
  assert.equal(data.endsAt, null);
  // Only what we KNOW is written. The old validUntil (the paid-through end) is
  // still a true lower bound on access, and the webhook corrects it shortly.
  assert.ok(!("renewsAt" in data), "no renewal date to invent");
  assert.ok(!("validUntil" in data), "the paid-through window is kept, not guessed");
});

/*
 * GET / must not offer a button POST /reactivate will refuse. A cancelled row
 * PAST its paid-through window is still "live" (it has not flipped to expired
 * yet), so it is still the display row — but there is nothing left to resume,
 * and the POST answers 409. Flagging it reactivatable sent the customer to a
 * guaranteed refusal.
 */
test("a cancelled row past its window is not offered as reactivatable", async (t) => {
  stubMethod(t, prisma.acquisitionLock as any, "findUnique", async () => null);
  stubMethod(t, prisma.checkoutIntent as any, "findUnique", async () => null);
  stubMethod(t, prisma.purchase as any, "findFirst", async () => null);
  stubMethod(t, prisma.trialClaim as any, "findUnique", async () => null);
  configured(t);
  const yesterday = new Date(Date.now() - 86_400_000);
  stubMethod(t, prisma.subscription as any, "findMany", async () => [
    {
      status: "cancelled",
      interval: "monthly",
      validUntil: yesterday,
      trialEndsAt: null,
      trialCancelledAt: null,
      renewsAt: null,
      endsAt: yesterday,
      pauseMode: null,
      variantId: "",
      providerUpdatedAt: new Date(),
      createdAt: new Date(),
    },
  ]);
  stubMethod(t, prisma.billingTask as any, "findMany", async () => []);

  const res = await request(app).get("/api/subscription").set(auth);

  assert.equal(res.body.subscription.status, "cancelled", "the row still displays");
  assert.equal(res.body.subscription.reactivatable, false, "but the dead button is not offered");
});

/* ── provider unification: GET / sees BOTH stores ────────────────────────
 *
 * The drift this section pins shut: this route used to read Lemon Squeezy rows
 * only while the checkout read all providers — so an Apple subscriber was told
 * monthly was purchasable here and then 409'd there. Both now consume the same
 * reads (lib/eligibility-io.ts), and the refusal names WHICH store is in the
 * way, because "go to Change plan" is a dead end for an Apple plan.
 */

const rcActive = {
  externalId: "507f1f77bcf86cd799439011:in.welock.app.monthly",
  provider: "revenuecat",
  status: "active",
  interval: "monthly",
  validUntil: new Date(Date.now() + 20 * 86_400_000),
  trialEndsAt: null,
  trialCancelledAt: null,
  renewsAt: new Date(Date.now() + 20 * 86_400_000),
  endsAt: null,
  pauseMode: null,
  variantId: "in.welock.app.monthly",
  providerUpdatedAt: new Date(),
  createdAt: new Date(),
  updatedAt: new Date(),
  willRenew: true,
  customerPortalUrl: "https://apps.apple.com/account/subscriptions",
  updatePaymentUrl: null,
};

test("an active Apple subscription now blocks monthly/yearly HERE too — lifetime stays purchasable", async (t) => {
  stubMethod(t, prisma.acquisitionLock as any, "findUnique", async () => null);
  stubMethod(t, prisma.checkoutIntent as any, "findUnique", async () => null);
  stubMethod(t, prisma.purchase as any, "findFirst", async () => null);
  stubMethod(t, prisma.trialClaim as any, "findUnique", async () => null);
  configured(t);
  stubMethod(t, prisma.subscription as any, "findMany", async () => [rcActive]);
  stubMethod(t, prisma.billingTask as any, "findMany", async () => []);

  const res = await request(app).get("/api/subscription").set(auth);

  assert.equal(res.status, 200);
  // The EXACT wire shape the clients mirror — field for field, nothing extra.
  assert.deepEqual(res.body.purchaseEligibility.monthly, {
    canPurchase: false,
    reasonCode: "ACTIVE_SUBSCRIPTION",
    trialMode: "none",
    trialDays: 0,
    blockingProvider: "revenuecat",
  });
  assert.equal(res.body.purchaseEligibility.yearly.canPurchase, false);
  assert.equal(res.body.purchaseEligibility.yearly.blockingProvider, "revenuecat");
  // A lifetime is not a second subscription, and the LS order webhook (KI-2's
  // twin) cancels nothing at Apple — it stays purchasable, exactly as at the
  // checkout, which is the whole point of sharing the reads.
  assert.equal(res.body.purchaseEligibility.lifetime.canPurchase, true);
});

test("the Apple row is the display row — and the server admits it cannot cancel it", async (t) => {
  stubMethod(t, prisma.acquisitionLock as any, "findUnique", async () => null);
  stubMethod(t, prisma.checkoutIntent as any, "findUnique", async () => null);
  stubMethod(t, prisma.purchase as any, "findFirst", async () => null);
  stubMethod(t, prisma.trialClaim as any, "findUnique", async () => null);
  configured(t);
  stubMethod(t, prisma.subscription as any, "findMany", async () => [rcActive]);
  stubMethod(t, prisma.billingTask as any, "findMany", async () => []);

  const res = await request(app).get("/api/subscription").set(auth);

  assert.equal(res.body.subscription.provider, "revenuecat");
  assert.equal(res.body.subscription.status, "active");
  assert.equal(res.body.subscription.interval, "monthly");
  // Only the customer can cancel an Apple subscription, on the device, at
  // Apple. Offering the buttons would promise actions this server cannot do.
  assert.equal(res.body.subscription.cancellable, false);
  assert.equal(res.body.subscription.reactivatable, false);
});

test("a Lemon Squeezy display row names its provider and keeps its buttons", async (t) => {
  stubMethod(t, prisma.acquisitionLock as any, "findUnique", async () => null);
  stubMethod(t, prisma.checkoutIntent as any, "findUnique", async () => null);
  stubMethod(t, prisma.purchase as any, "findFirst", async () => null);
  stubMethod(t, prisma.trialClaim as any, "findUnique", async () => null);
  configured(t);
  stubMethod(t, prisma.subscription as any, "findMany", async () => [
    {
      externalId: "77001",
      provider: "lemonsqueezy",
      status: "active",
      interval: "monthly",
      validUntil: new Date(Date.now() + 20 * 86_400_000),
      trialEndsAt: null,
      trialCancelledAt: null,
      renewsAt: new Date(Date.now() + 20 * 86_400_000),
      endsAt: null,
      pauseMode: null,
      variantId: "",
      providerUpdatedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ]);
  stubMethod(t, prisma.billingTask as any, "findMany", async () => []);

  const res = await request(app).get("/api/subscription").set(auth);

  assert.equal(res.body.subscription.provider, "lemonsqueezy");
  assert.equal(res.body.subscription.cancellable, true, "an LS row the server CAN act on");
  assert.equal(res.body.purchaseEligibility.monthly.blockingProvider, "lemonsqueezy");
});
