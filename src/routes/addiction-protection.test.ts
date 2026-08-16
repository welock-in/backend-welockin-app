import assert from "node:assert/strict";
import { test } from "node:test";
import request from "supertest";
import { createApp } from "../app";
import { signToken } from "../lib/jwt";
import { prisma } from "../lib/prisma";
import { stubAccountGuard, TEST_USER_ID, TEST_USER_EMAIL } from "./test-helpers";

/*
 * What these tests pin is the MOUNT, not the lock logic: /api/addiction-
 * protection sits behind the account guard (see app.ts). The router's own
 * requireAuth is a stateless signature check, so before the guard a deleted
 * account's JWT could keep reading the list and driving the lock for up to
 * thirty days.
 */

const app = createApp();
stubAccountGuard();
const auth = {
  authorization: `Bearer ${signToken({ sub: TEST_USER_ID, email: TEST_USER_EMAIL })}`,
};

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

test("a token whose account was deleted gets the machine-readable 404, not a status", async (t) => {
  // Per-test stub wins over the file-wide guard default and is restored after.
  stubMethod(t, prisma.user as any, "findUnique", async () => null);

  const res = await request(app).get("/api/addiction-protection/status").set(auth);

  assert.equal(res.status, 404);
  assert.equal(res.body.code, "ACCOUNT_NOT_FOUND");
  assert.equal("active" in res.body, false, "no lock state for a ghost");
});

test("a live account still reads its lock status through the guard", async (t) => {
  stubMethod(t, prisma.protectionLock as any, "findUnique", async () => null);

  const res = await request(app).get("/api/addiction-protection/status").set(auth);

  assert.equal(res.status, 200);
  assert.equal(res.body.userId, TEST_USER_ID);
  assert.equal(res.body.active, false);
});

test("no token at all is still the plain 401, before any account read", async () => {
  const res = await request(app).get("/api/addiction-protection/status");

  assert.equal(res.status, 401);
});
