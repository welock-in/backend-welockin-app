import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { Prisma } from "@prisma/client";
import express from "express";
import request from "supertest";
import { adminSignupLifetimeRouter } from "./admin-signup-lifetime";
import { errorHandler } from "../middleware/error";
import { prisma } from "../lib/prisma";
import { signAdminToken } from "../lib/admin-jwt";
import { signToken } from "../lib/jwt";

const app = express().use(express.json()).use("/api/admin/signup-lifetime", adminSignupLifetimeRouter).use(errorHandler);
const auth = { authorization: `Bearer ${signAdminToken("operator")}` };
type Row = Record<string, any>;
prisma.$use(async () => { throw new Error("No database connections in this suite"); });

function stub(t: TestContext, target: object, name: string, fn: (...args: any[]) => any) {
  const methods = target as Row;
  const original = methods[name];
  methods[name] = fn;
  t.after(() => { methods[name] = original; });
}

function setup(t: TestContext) {
  const state: { row: Row | null; writes: Row[]; audit: Row[]; failAudit: boolean } =
    { row: null, writes: [], audit: [], failAudit: false };
  stub(t, prisma.signupLifetimeSettings, "findUnique", async () => state.row ? { ...state.row } : null);
  stub(t, prisma.signupLifetimeSettings, "upsert", async (args: Row) => {
    state.writes.push(args);
    state.row = { ...(state.row ? { ...state.row, ...args.update } : args.create), updatedAt: new Date() };
    return { ...state.row };
  });
  stub(t, prisma.adminAuditLog, "create", async ({ data }: Row) => {
    if (state.failAudit) throw new Error("audit unavailable");
    state.audit.push(data);
    return data;
  });
  stub(t, prisma, "$transaction", async (fn: (tx: typeof prisma) => Promise<unknown>) => {
    const before = state.row ? { ...state.row } : null;
    try { return await fn(prisma); }
    catch (error) { state.row = before; throw error; }
  });
  return state;
}

test("missing settings are OFF without creating a document", async (t) => {
  const state = setup(t);
  const res = await request(app).get("/api/admin/signup-lifetime").set(auth);
  assert.equal(res.status, 200);
  assert.equal(res.headers["cache-control"], "no-store");
  assert.deepEqual(res.body.settings, { iosSignupLifetimeEnabled: false, desktopSignupLifetimeEnabled: false,
    updatedAt: null, updatedBy: null });
  assert.equal(state.writes.length, 0);
});

test("partial switches preserve the other value and audit the stored state", async (t) => {
  const state = setup(t);
  const ios = await request(app).patch("/api/admin/signup-lifetime").set(auth).send({ iosSignupLifetimeEnabled: true });
  assert.equal(ios.status, 200);
  assert.equal(ios.body.settings.desktopSignupLifetimeEnabled, false);
  const desktop = await request(app).patch("/api/admin/signup-lifetime").set(auth).send({ desktopSignupLifetimeEnabled: true });
  assert.equal(desktop.status, 200);
  assert.equal(desktop.body.settings.iosSignupLifetimeEnabled, true);
  assert.equal(desktop.body.settings.updatedBy, "operator");
  assert.ok(Date.parse(desktop.body.settings.updatedAt));
  const off = await request(app).patch("/api/admin/signup-lifetime").set(auth).send({ iosSignupLifetimeEnabled: false });
  assert.equal(off.body.settings.desktopSignupLifetimeEnabled, true);
  assert.equal(state.audit.length, 3);
  assert.equal(state.audit[1].before.iosSignupLifetimeEnabled, true);
  assert.equal(state.audit[1].after.desktopSignupLifetimeEnabled, true);
  assert.deepEqual(state.writes[1].update, { desktopSignupLifetimeEnabled: true, updatedBy: "operator" });
  const reloaded = await request(app).get("/api/admin/signup-lifetime").set(auth);
  assert.deepEqual(reloaded.body, off.body);
});

test("regular user tokens and malformed patches cannot change settings", async (t) => {
  const state = setup(t);
  const user = { authorization: `Bearer ${signToken({ sub: "507f1f77bcf86cd799439011", email: "u@example.com" })}` };
  for (const headers of [{}, user]) {
    assert.equal((await request(app).get("/api/admin/signup-lifetime").set(headers)).status, 401);
    assert.equal((await request(app).patch("/api/admin/signup-lifetime").set(headers).send({ iosSignupLifetimeEnabled: true })).status, 401);
  }
  for (const body of [{}, { iosSignupLifetimeEnabled: "true" }, { desktopSignupLifetimeEnabled: null }, { random: true }]) {
    assert.equal((await request(app).patch("/api/admin/signup-lifetime").set(auth).send(body)).status, 400);
  }
  assert.equal(state.writes.length, 0);
});

test("read failure is explicit and audit failure rolls back the change", async (t) => {
  const state = setup(t);
  state.failAudit = true;
  const failed = await request(app).patch("/api/admin/signup-lifetime").set(auth).send({ iosSignupLifetimeEnabled: true });
  assert.equal(failed.status, 503);
  assert.equal(failed.body.code, "SIGNUP_LIFETIME_SETTINGS_UNAVAILABLE");
  assert.equal(state.row, null);
  stub(t, prisma.signupLifetimeSettings, "findUnique", async () => { throw new Error("offline"); });
  const res = await request(app).get("/api/admin/signup-lifetime").set(auth);
  assert.equal(res.status, 503);
  assert.equal(res.body.settings, undefined);
});

test("concurrent first-document conflicts retry instead of resetting the other switch", async (t) => {
  const state = setup(t);
  let attempts = 0;
  const transact = prisma.$transaction.bind(prisma);
  stub(t, prisma, "$transaction", async (fn: any) => {
    if (attempts++ === 0) {
      state.row = { iosSignupLifetimeEnabled: true, desktopSignupLifetimeEnabled: false, updatedAt: new Date(), updatedBy: "first" };
      throw new Prisma.PrismaClientKnownRequestError("race", { code: "P2002", clientVersion: "test" });
    }
    return transact(fn);
  });
  const res = await request(app).patch("/api/admin/signup-lifetime").set(auth).send({ desktopSignupLifetimeEnabled: true });
  assert.equal(res.status, 200);
  assert.equal(attempts, 2);
  assert.equal(res.body.settings.iosSignupLifetimeEnabled, true);
  assert.equal(res.body.settings.desktopSignupLifetimeEnabled, true);
});
