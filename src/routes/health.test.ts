import assert from "node:assert/strict";
import { test } from "node:test";
import request from "supertest";
import { createApp } from "../app";
import { env } from "../lib/env";

const app = createApp();

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
 * /api/health/config exists because on Vercel an env change only applies to the
 * NEXT deployment — so "I set the variable" and "the server sees it" are
 * different states. These tests pin the property that makes it safe to expose:
 * secrets are reported as booleans, never as values.
 */

test("config reports presence, never the secret itself", async (t) => {
  const before = { key: env.lemonSqueezyApiKey, secret: env.lemonSqueezyWebhookSecret };
  (env as any).lemonSqueezyApiKey = "sk-test-SECRET-VALUE";
  (env as any).lemonSqueezyWebhookSecret = "whsec-SECRET-VALUE";
  t.after(() => {
    (env as any).lemonSqueezyApiKey = before.key;
    (env as any).lemonSqueezyWebhookSecret = before.secret;
  });

  const res = await request(app).get("/api/health/config");

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

  const res = await request(app).get("/api/health/config");

  assert.equal(res.body.lemonSqueezy.storeId, "364783");
});
