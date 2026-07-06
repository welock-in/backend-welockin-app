import assert from "node:assert/strict";
import { test } from "node:test";
import request from "supertest";
import { createApp } from "../app";

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
