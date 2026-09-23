import assert from "node:assert/strict";
import { test } from "node:test";
import request from "supertest";
import { createApp } from "../app";
import { prisma } from "../lib/prisma";
import { signAdminToken } from "../lib/admin-jwt";

const app = createApp();
test("admin broadcast still sends to all valid tokens and reports partial failure", async (t) => {
  mockPrisma(t, prisma.pushToken, "findMany", async (args: any) => {
    assert.deepEqual(args.where, { valid: true });
    return [{ token: "ExpoPushToken[a]", userId: "a" }, { token: "ExpoPushToken[b]", userId: "b" }];
  });
  t.mock.method(globalThis, "fetch", async (_url: unknown, opts: any) => {
    assert.equal(JSON.parse(opts.body).length, 2);
    return { ok: true, status: 200, json: async () => ({ data: [{ status: "ok", id: "one" }, { status: "error", message: "InvalidCredentials" }] }) };
  });
  let logged: any[] = [];
  mockPrisma(t, prisma.notificationDelivery, "createMany", async (args: any) => { logged = args.data; return { count: 2 }; });
  const res = await request(app).post("/api/admin/notifications/send")
    .set("Authorization", `Bearer ${signAdminToken("test-admin")}`)
    .send({ title: "News", body: "Message", audience: { mode: "all" } });
  assert.equal(res.status, 200);
  assert.equal(res.body.recipients, 2);
  assert.equal(res.body.sent, 1);
  assert.equal(res.body.failed, 1);
  assert.ok(logged.every((r) => r.source === "admin"));
});

test("broadcast and receipt checks require admin authentication", async () => {
  assert.equal((await request(app).post("/api/admin/notifications/send").send({})).status, 401);
  assert.equal((await request(app).post("/api/admin/notifications/receipts").send({})).status, 401);
});

function mockPrisma(t: { after: (cb: () => void) => void }, target: any, name: string, implementation: (...args: any[]) => any) {
  const original = target[name];
  target[name] = implementation;
  t.after(() => { target[name] = original; });
}