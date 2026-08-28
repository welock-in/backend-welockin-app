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

test("the Intel row registers now that the macOS build is universal", async (t) => {
  const created = stubCreate(t);

  const res = await request(app)
    .post("/api/admin/releases")
    .set(auth)
    .send({ ...VALID, target: "darwin", arch: "x86_64" });

  assert.equal(res.status, 201);
  assert.equal(created[0][0].data.target, "darwin");
  assert.equal(created[0][0].data.arch, "x86_64");
});

test("an arch no build ever reports is still refused", async (t) => {
  const created = stubCreate(t);

  // Tauri's triple says `aarch64`; `arm64` is the macOS-native spelling a
  // person might paste from `lipo -archs`. A row under it would sit in a
  // draft, publish cleanly, and be requested by nothing, ever.
  const res = await request(app)
    .post("/api/admin/releases")
    .set(auth)
    .send({ ...VALID, target: "darwin", arch: "arm64" });

  assert.equal(res.status, 400);
  assert.equal(created.length, 0);
});

/**
 * The exact shape the universal release runbook produces: one version, one
 * artifact URL, TWO rows. If this ever starts failing, the Mac release
 * pipeline's second registration will 400 after a 15-minute build and burn
 * the version number.
 */
test("one universal version registers under both darwin arches", async (t) => {
  const rows: any[] = [];
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
  const created = stubMethod(t, prisma.release as any, "create", async (a: any) => {
    rows.push(a.data);
    return { id: `r${rows.length}`, ...a.data };
  });

  for (const arch of ["aarch64", "x86_64"]) {
    const res = await request(app)
      .post("/api/admin/releases")
      .set(auth)
      .send({ ...VALID, target: "darwin", arch });
    assert.equal(res.status, 201, arch);
  }
  assert.equal(created.length, 2, "two rows, one universal artifact");
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

/* ── lifecycle actions name the darwin sibling they did not touch ────────── */

/**
 * The universal build is one release as two rows, but pause/rollout/rollback
 * act on one id. The half-done state is silent from the outside — the
 * forgotten fleet's checks just answer as usual — so the response itself must
 * carry the reminder. These pin that it does, and that Windows never pays for
 * a sibling lookup it cannot have.
 */
const darwinRow = (arch: string, over: Record<string, unknown> = {}) => ({
  id: `row-${arch}`,
  channel: "stable",
  target: "darwin",
  arch,
  version: "0.2.13",
  status: "live",
  rolloutPercent: 100,
  ...over,
});

test("pausing one darwin row warns about the sibling it did not touch", async (t) => {
  stubMethod(t, prisma.release as any, "findUnique", async () => darwinRow("aarch64"));
  stubMethod(t, prisma.release as any, "findFirst", async (args: any) =>
    args.where.arch === "x86_64" ? darwinRow("x86_64") : null,
  );
  stubMethod(t, prisma.release as any, "update", async (a: any) => ({
    ...darwinRow("aarch64"),
    ...a.data,
  }));

  const res = await request(app).post("/api/admin/releases/row-aarch64/pause").set(auth);

  assert.equal(res.status, 200);
  assert.equal(res.body.status, "paused");
  assert.match(String(res.body.siblingWarning), /darwin\/x86_64/);
  assert.match(String(res.body.siblingWarning), /NOT touched/);
});

test("a darwin row with no registered sibling says the fleet is missing", async (t) => {
  stubMethod(t, prisma.release as any, "findUnique", async () => darwinRow("x86_64"));
  stubMethod(t, prisma.release as any, "findFirst", async () => null);
  stubMethod(t, prisma.release as any, "update", async (a: any) => ({
    ...darwinRow("x86_64"),
    ...a.data,
  }));

  const res = await request(app).post("/api/admin/releases/row-x86_64/pause").set(auth);

  assert.equal(res.status, 200);
  assert.match(String(res.body.siblingWarning), /no darwin\/aarch64 row exists/);
});

test("a Windows row's lifecycle carries no sibling warning", async (t) => {
  const winRow = {
    id: "w1",
    channel: "stable",
    target: "windows",
    arch: "x86_64",
    version: "0.3.34",
    status: "live",
    rolloutPercent: 100,
  };
  stubMethod(t, prisma.release as any, "findUnique", async () => winRow);
  const lookups = stubMethod(t, prisma.release as any, "findFirst", async () => null);
  stubMethod(t, prisma.release as any, "update", async (a: any) => ({ ...winRow, ...a.data }));

  const res = await request(app).post("/api/admin/releases/w1/pause").set(auth);

  assert.equal(res.status, 200);
  assert.equal(res.body.siblingWarning, undefined);
  assert.equal(lookups.length, 0, "windows never pays the sibling lookup");
});
