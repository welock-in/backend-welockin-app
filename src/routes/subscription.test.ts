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

/* ── Cancelling ─────────────────────────────────────────────────────────
 *
 * There must ALWAYS be a way out from inside the app. And cancelling must not
 * take away time already paid for: Lemon Squeezy stops future payments and sets
 * ends_at to the end of the current period, which `subscriptionGrants` honours
 * by ranking `cancelled` as granting.
 */

test("cancelling calls Lemon Squeezy's delete and reports when access stops", async (t) => {
  configured(t);
  stubMethod(t, prisma.subscription as any, "findMany", async () => [
    { externalId: "77001", status: "active", validUntil: new Date(Date.now() + 20 * 86_400_000) },
  ]);

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
  configured(t);
  const finds = stubMethod(t, prisma.subscription as any, "findMany", async () => [
    { externalId: "77001", status: "active", validUntil: new Date(Date.now() + 86_400_000) },
  ]);
  stubFetch(t, async () => ({ ok: true, status: 200, json: async () => ({}) }));

  await request(app).post("/api/subscription/cancel").set(auth).send({ subscriptionId: "99999" });

  assert.equal(finds[0][0].where.userId, userId);
});

test("cancelling twice is refused rather than repeated", async (t) => {
  configured(t);
  stubMethod(t, prisma.subscription as any, "findMany", async () => [
    { externalId: "77001", status: "cancelled", validUntil: new Date(Date.now() + 86_400_000) },
  ]);
  stubFetch(t, async () => {
    throw new Error("must not reach Lemon Squeezy");
  });

  const res = await request(app).post("/api/subscription/cancel").set(auth);

  assert.equal(res.status, 409);
});

test("cancelling is refused while on trial (nothing to cancel yet)", async (t) => {
  configured(t);
  stubMethod(t, prisma.subscription as any, "findMany", async () => [
    { externalId: "77001", status: "on_trial", validUntil: new Date(Date.now() + 3 * 86_400_000) },
  ]);
  let called = false;
  stubFetch(t, async () => {
    called = true;
    return { ok: true, status: 200, json: async () => ({}) };
  });

  const res = await request(app).post("/api/subscription/cancel").set(auth);

  assert.equal(res.status, 409);
  assert.equal(called, false, "Lemon Squeezy is never asked to cancel a trial from in-app");
});

test("GET /subscription marks an on-trial row as NOT cancellable", async (t) => {
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

  const res = await request(app).get("/api/subscription").set(auth);

  assert.equal(res.body.subscription.cancellable, false, "the cancel button hides during the trial");
});

test("a cancelled subscription still reads as live, with its end date", async (t) => {
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

  const res = await request(app).get("/api/subscription").set(auth);

  assert.equal(res.status, 200);
  assert.equal(res.body.subscription.status, "cancelled");
  assert.equal(res.body.subscription.endsAt, endsAt.toISOString(), "when the access actually stops");
  assert.equal(res.body.subscription.cancellable, false, "nothing left to cancel");
});

test("an account with only expired rows reports no subscription", async (t) => {
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
  configured(t);
  stubMethod(t, prisma.subscription as any, "findMany", async () => [
    { externalId: "77001", status: "cancelled", validUntil: new Date(Date.now() + 10 * 86_400_000), endsAt: new Date(Date.now() + 10 * 86_400_000) },
  ]);

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
  configured(t);
  const finds = stubMethod(t, prisma.subscription as any, "findMany", async () => [
    { externalId: "77001", status: "cancelled", validUntil: new Date(Date.now() + 86_400_000), endsAt: new Date(Date.now() + 86_400_000) },
  ]);
  stubFetch(t, async () => ({ ok: true, status: 200, json: async () => ({}) }));

  await request(app).post("/api/subscription/reactivate").set(auth).send({ subscriptionId: "99999" });

  assert.equal(finds[0][0].where.userId, userId);
});

test("there is nothing to reactivate on an account with no cancelled subscription", async (t) => {
  configured(t);
  stubMethod(t, prisma.subscription as any, "findMany", async () => [
    { externalId: "77001", status: "active", validUntil: new Date(Date.now() + 86_400_000), endsAt: null },
  ]);
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
  configured(t);
  stubMethod(t, prisma.subscription as any, "findMany", async () => [
    { externalId: "77001", status: "cancelled", validUntil: new Date(Date.now() - 86_400_000), endsAt: new Date(Date.now() - 86_400_000) },
  ]);
  stubFetch(t, async () => ({ ok: true, status: 200, json: async () => ({}) }));

  const res = await request(app).post("/api/subscription/reactivate").set(auth);

  // Past ends_at the row no longer grants, so subscriptionGrants filters it out
  // and there is nothing resumable — a clean 409, not a provider error.
  assert.equal(res.status, 409);
});

test("GET /subscription flags a cancelled-but-live row as reactivatable", async (t) => {
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
  configuredVariants(t);
  stubMethod(t, prisma.subscription as any, "findMany", async () => [liveMonthly]);
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
  configuredVariants(t);
  stubMethod(t, prisma.subscription as any, "findMany", async () => [liveYearly]);
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
  configuredVariants(t);
  stubMethod(t, prisma.subscription as any, "findMany", async () => [
    { externalId: "77001", status: "on_trial", validUntil: new Date(Date.now() + 3 * 86_400_000), variantId: "1986433" },
  ]);
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
  configuredVariants(t);
  stubMethod(t, prisma.subscription as any, "findMany", async () => [liveMonthly]);
  stubFetch(t, async () => ({ ok: true, status: 200, json: async () => ({}) }));

  const res = await request(app).post("/api/subscription/change-plan").set(auth).send({ plan: "monthly" });

  assert.equal(res.status, 409);
});

test("changing plan comes from the token, never the request body", async (t) => {
  configuredVariants(t);
  const finds = stubMethod(t, prisma.subscription as any, "findMany", async () => [liveMonthly]);
  stubFetch(t, async () => ({ ok: true, status: 200, json: async () => ({}) }));

  await request(app).post("/api/subscription/change-plan").set(auth).send({ plan: "yearly", subscriptionId: "99999" });

  assert.equal(finds[0][0].where.userId, userId);
});

test("change-plan rejects a plan that is not monthly or yearly (no lifetime here)", async (t) => {
  configuredVariants(t);
  stubMethod(t, prisma.subscription as any, "findMany", async () => [liveMonthly]);
  stubFetch(t, async () => ({ ok: true, status: 200, json: async () => ({}) }));

  const res = await request(app).post("/api/subscription/change-plan").set(auth).send({ plan: "lifetime" });

  assert.equal(res.status, 400, "lifetime is a checkout, not a variant swap");
});
