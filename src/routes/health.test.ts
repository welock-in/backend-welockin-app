import assert from "node:assert/strict";
import { test } from "node:test";
import request from "supertest";
import { createApp } from "../app";
import { env } from "../lib/env";
import { prisma } from "../lib/prisma";
import { signAdminToken } from "../lib/admin-jwt";

const app = createApp();

/** /api/health/config is admin-only; its two probe siblings deliberately are not. */
const adminAuth = { authorization: `Bearer ${signAdminToken(env.adminUsername)}` };

type Ctx = { after: (fn: () => void) => void };

function stubMethod(
  t: Ctx,
  target: Record<string, any>,
  name: string,
  implementation: (...args: any[]) => any,
) {
  const original = target[name];
  target[name] = implementation;
  t.after(() => {
    target[name] = original;
  });
}

test("GET /api/health returns ok:true and a time", async () => {
  const res = await request(app).get("/api/health");
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(typeof res.body.time, "string");
  assert.ok(!Number.isNaN(Date.parse(res.body.time)));
});

test("unknown route returns 404 with error shape", async () => {
  const res = await request(app).get("/api/does-not-exist");
  assert.equal(res.status, 404);
  assert.equal(typeof res.body.error, "string");
});

test("protected route without token returns 401", async () => {
  const res = await request(app).get("/api/me");
  assert.equal(res.status, 401);
  assert.equal(typeof res.body.error, "string");
});

test("new mobile event route is mounted and protected", async () => {
  const res = await request(app).post("/api/focus-events").send({});
  assert.equal(res.status, 401);
  assert.equal(typeof res.body.error, "string");
});

test("onboarding route is mounted and protected", async () => {
  const res = await request(app).post("/api/onboarding").send({});
  assert.equal(res.status, 401);
  assert.equal(typeof res.body.error, "string");
});
/*
 * The two PROBES stay open. Regression pins, not decoration: /config right below
 * them now carries `requireAdmin`, and the tempting way to write that gate is on
 * the mount in app.ts — which would take the liveness and readiness checks down
 * with it. A platform health checker carries no token, so a probe that can
 * answer 401 reports the wrong thing about a perfectly healthy deployment.
 */

test("the liveness probe answers with NO token at all", async () => {
  const res = await request(app).get("/api/health");

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
});

test("the readiness probe answers with NO token at all", async (t) => {
  stubMethod(t, prisma as any, "$runCommandRaw", async () => ({ ok: 1 }));

  const res = await request(app).get("/api/health/db");

  assert.equal(res.status, 200);
  assert.equal(res.body.db, "ok");
});

/*
 * /api/health/config exists because on Vercel an env change only applies to the
 * NEXT deployment — so "I set the variable" and "the server sees it" are
 * different states. These tests pin the property that makes it safe to expose:
 * secrets are reported as booleans, never as values.
 *
 * It is ADMIN-ONLY, though, because the booleans are themselves the answer to
 * "which gate on this deployment is unarmed" — allowTestMode, entitlement
 * enforcement, email verification, device binding — next to the commit that says
 * which code is live. Not secret values; a shopping list.
 */

test("config is refused outright without an admin token", async () => {
  const res = await request(app).get("/api/health/config");

  assert.equal(res.status, 401);
  assert.equal(typeof res.body.error, "string");
  assert.equal(
    "deviceBindingEnforced" in res.body,
    false,
    "not one field of the posture leaks on the refusal",
  );
});

test("config is refused for a plain USER token — the admin gate is its own", async () => {
  const res = await request(app)
    .get("/api/health/config")
    .set({ authorization: "Bearer not-an-admin-token" });

  assert.equal(res.status, 401);
});

test("config answers in full for an admin", async () => {
  const res = await request(app).get("/api/health/config").set(adminAuth);

  assert.equal(res.status, 200);
  assert.equal(typeof res.body.deviceBindingEnforced, "boolean");
  assert.equal(typeof res.body.entitlement.enforced, "boolean");
  assert.equal(typeof res.body.email.verificationEnforced, "boolean");
});

test("config reports presence, never the secret itself", async (t) => {
  const before = { key: env.lemonSqueezyApiKey, secret: env.lemonSqueezyWebhookSecret };
  (env as any).lemonSqueezyApiKey = "sk-test-SECRET-VALUE";
  (env as any).lemonSqueezyWebhookSecret = "whsec-SECRET-VALUE";
  t.after(() => {
    (env as any).lemonSqueezyApiKey = before.key;
    (env as any).lemonSqueezyWebhookSecret = before.secret;
  });

  const res = await request(app).get("/api/health/config").set(adminAuth);

  assert.equal(res.status, 200);
  assert.equal(res.body.lemonSqueezy.apiKey, true);
  assert.equal(res.body.lemonSqueezy.webhookSecret, true);
  assert.ok(!JSON.stringify(res.body).includes("SECRET-VALUE"), "values must never travel");
});

test("config reports the public ids verbatim, so a wrong paste is visible", async (t) => {
  const before = env.lemonSqueezyStoreId;
  (env as any).lemonSqueezyStoreId = "364783";
  t.after(() => {
    (env as any).lemonSqueezyStoreId = before;
  });

  const res = await request(app).get("/api/health/config").set(adminAuth);

  assert.equal(res.body.lemonSqueezy.storeId, "364783");
});

/*
 * A half-configured storefront is deliberately BLANKED in env.ts so the deploy
 * cannot sell. The cost is that this endpoint would otherwise report "no API
 * key" for a deploy whose key is fine and whose real problem is one empty
 * variant id — the exact wrong answer to give someone mid-way through swapping
 * test ids for live ones. `degraded` + `problems` name the real cause.
 */
test("config says WHEN it is degraded, and which variable caused it", async () => {
  const res = await request(app).get("/api/health/config").set(adminAuth);

  assert.equal(res.status, 200);
  assert.equal(typeof res.body.lemonSqueezy.degraded, "boolean");
  assert.ok(Array.isArray(res.body.lemonSqueezy.problems));
});
