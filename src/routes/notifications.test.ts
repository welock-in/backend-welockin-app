import assert from "node:assert/strict";
import { test } from "node:test";
import { Prisma } from "@prisma/client";
import request from "supertest";
import { createApp } from "../app";
import { prisma } from "../lib/prisma";
import { signToken } from "../lib/jwt";
import { stubAccountGuard } from "./test-helpers";

stubAccountGuard();
const app = createApp();
const userId = "507f1f77bcf86cd799439011";
const auth = { authorization: `Bearer ${signToken({ sub: userId, email: "test@example.com" })}` };

function stub(t: { after: (cb: () => void) => void }, target: any, name: string, fn: (...args: any[]) => any) {
  const original = target[name]; target[name] = fn; t.after(() => { target[name] = original; });
}

test("token rotation disables only previous registrations of the same account and device", async (t) => {
  const registeredAt = new Date();
  stub(t, prisma.pushToken, "upsert", async ({ create }) => ({ id: "new", ...create, updatedAt: registeredAt }));
  let old: any;
  stub(t, prisma.pushToken, "updateMany", async (args) => { old = args; return { count: 1 }; });
  const res = await request(app).post("/api/notifications/token").set(auth)
    .send({ token: "ExpoPushToken[new]", deviceId: "phone", tokenType: "expo" });
  assert.equal(res.status, 200);
  assert.deepEqual(old.where, { userId, deviceId: "phone", tokenType: "expo", token: { not: "ExpoPushToken[new]" }, valid: true, updatedAt: { lt: registeredAt } });
  assert.equal(old.data.disabledReason, "TokenReplaced");
});

test("concurrent token registration reapplies ownership instead of returning a previous account", async (t) => {
  stub(t, prisma.pushToken, "upsert", async () => { throw new Prisma.PrismaClientKnownRequestError("duplicate", { code: "P2002", clientVersion: "5.22" }); });
  let updated: any;
  stub(t, prisma.pushToken, "update", async (args) => { updated = args; return { id: "new", ...args.data }; });
  stub(t, prisma.pushToken, "updateMany", async () => ({ count: 0 }));
  const res = await request(app).post("/api/notifications/token").set(auth)
    .send({ token: "ExpoPushToken[same]", deviceId: "phone" });
  assert.equal(res.status, 200);
  assert.equal(updated.data.userId, userId);
  assert.equal(updated.data.valid, true);
  assert.equal(res.body.pushToken.userId, userId);
});
