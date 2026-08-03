import assert from "node:assert/strict";
import { test } from "node:test";
import request from "supertest";
import { createApp } from "../app";
import { prisma } from "../lib/prisma";
import { env } from "../lib/env";
import { signAdminToken } from "../lib/admin-jwt";

/**
 * Registering a release, once there is more than one platform to register for.
 *
 * The behaviour under test is narrow but expensive to get wrong: `target` and
 * `arch` decide which fleet a build reaches, nothing downstream re-checks them,
 * and a wrong value produces no error anywhere — just an update that never
 * arrives.
 */

const app = createApp();

type Ctx = { after: (fn: () => void) => void };

function stubMethod(
  t: Ctx,
  target: Record<string, any>,
  name: string,
  implementation: (...args: any[]) => any,
) {
  const original = target[name];
  const calls: any[][] = [];
  target[name] = (...args: any[]) => {
    calls.push(args);
    return implementation(...args);
  };
  t.after(() => {
    target[name] = original;
  });
  return calls;
}

/** Admin auth is env-credential based; give the suite a usable token. */
const ORIGINAL_ADMIN_PASSWORD = env.adminPassword;
env.adminPassword = "test-admin-password";
const auth = { authorization: `Bearer ${signAdminToken(env.adminUsername)}` };
test.after(() => {
  env.adminPassword = ORIGINAL_ADMIN_PASSWORD;
});

const VALID = {
  version: "0.2.0",
  url: "https://cdn.example/releases/0.2.0/WeLockIn.app.tar.gz",
  signature: "MAC_SIG",
};

/** No existing row, and `create` echoes what it was handed. */
function stubCreate(t: Ctx) {
  stubMethod(t, prisma.release as any, "findFirst", async () => null);
  return stubMethod(t, prisma.release as any, "create", async (args: any) => ({
    id: "new",
    ...args.data,
  }));
}

test("a Windows release still registers without naming a platform", async (t) => {
  const created = stubCreate(t);

  // The shipped Windows release.mjs sends exactly this — no target, no arch.
  const res = await request(app)
    .post("/api/admin/releases")
    .set(auth)
    .send({ version: "0.3.3", url: "https://cdn.example/w.exe", signature: "S" });

  assert.equal(res.status, 201);
  assert.equal(created.length, 1);
  assert.equal(created[0][0].data.target, "windows", "defaults, so the old pipeline keeps working");
  assert.equal(created[0][0].data.arch, "x86_64");
  assert.equal(created[0][0].data.status, "draft", "never live on creation");
  assert.equal(created[0][0].data.rolloutPercent, 0);
});

test("a macOS release registers when it names darwin/aarch64", async (t) => {
  const created = stubCreate(t);

  const res = await request(app)
    .post("/api/admin/releases")
    .set(auth)
    .send({ ...VALID, target: "darwin", arch: "aarch64" });

  assert.equal(res.status, 201);
  assert.equal(created[0][0].data.target, "darwin");
  assert.equal(created[0][0].data.arch, "aarch64");
  assert.equal(created[0][0].data.version, "0.2.0");
});

/**
 * The failure this validation exists for. `macos` is the name a person reaches
 * for; `darwin` is the one Tauri sends. Without the check the release is created,
 * publishes, ramps, and is never requested by anything.
 */
test("the plausible typo is refused, not silently accepted", async (t) => {
  const created = stubCreate(t);

  const res = await request(app)
    .post("/api/admin/releases")
    .set(auth)
    .send({ ...VALID, target: "macos", arch: "aarch64" });

  assert.equal(res.status, 400);
  assert.match(String(res.body.error), /darwin\/aarch64/, "the message names what IS accepted");
  assert.equal(created.length, 0, "and nothing was written");
});

test("an unsupported architecture for a supported platform is refused", async (t) => {
  const created = stubCreate(t);

  // The macOS build is Apple-silicon only; registering an Intel one would create
  // a row the public route is built to refuse — better to say so here.
  const res = await request(app)
    .post("/api/admin/releases")
    .set(auth)
    .send({ ...VALID, target: "darwin", arch: "x86_64" });

  assert.equal(res.status, 400);
  assert.equal(created.length, 0);
});

test("mixing one platform's arch with another's is refused", async (t) => {
  const created = stubCreate(t);
  const res = await request(app)
    .post("/api/admin/releases")
    .set(auth)
    .send({ ...VALID, target: "windows", arch: "aarch64" });
  assert.equal(res.status, 400);
  assert.equal(created.length, 0);
});

/**
 * Version numbers are per platform. Windows is on 0.3.x while macOS starts at
 * 0.2.x, so the two lines will cross — and when they do, the same number must
 * remain registrable once per platform.
 */
test("the same version number is registrable once per platform", async (t) => {
  const rows: any[] = [{ channel: "stable", target: "windows", arch: "x86_64", version: "0.3.0" }];
  stubMethod(t, prisma.release as any, "findFirst", async (args: any) => {
    const w = args.where;
    return (
      rows.find(
        (r) =>
          r.channel === w.channel &&
          r.target === w.target &&
          r.arch === w.arch &&
          r.version === w.version,
      ) ?? null
    );
  });
  const created = stubMethod(t, prisma.release as any, "create", async (a: any) => ({
    id: "x",
    ...a.data,
  }));

  const dup = await request(app)
    .post("/api/admin/releases")
    .set(auth)
    .send({ version: "0.3.0", url: "https://cdn/w2.exe", signature: "S" });
  assert.equal(dup.status, 400, "a burned Windows version stays burned");

  const mac = await request(app)
    .post("/api/admin/releases")
    .set(auth)
    .send({ version: "0.3.0", url: "https://cdn/m.app.tar.gz", signature: "S", target: "darwin", arch: "aarch64" });
  assert.equal(mac.status, 201, "but the macOS line has its own 0.3.0");
  assert.equal(created.length, 1);
});

test("registering a release requires an admin token", async (t) => {
  const created = stubCreate(t);
  const res = await request(app).post("/api/admin/releases").send(VALID);
  assert.ok(res.status === 401 || res.status === 403, `got ${res.status}`);
  assert.equal(created.length, 0);
});
