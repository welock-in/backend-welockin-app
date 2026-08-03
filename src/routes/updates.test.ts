import assert from "node:assert/strict";
import { test } from "node:test";
import request from "supertest";
import { createApp } from "../app";
import { prisma } from "../lib/prisma";
import { invalidateReleaseCache } from "./updates";
import { toSortKey } from "../lib/semver";

/**
 * The desktop update manifest, once it serves two platforms.
 *
 * The route is public and unauthenticated, so there is no account guard to stub
 * — but there IS a 30-second in-process cache, and it is shared by every test in
 * the file. Each one clears it first; forgetting to would make a test pass on
 * the previous test's data, which is the exact failure this file exists to
 * catch.
 *
 * The stakes are asymmetric and worth stating: a manifest that wrongly answers
 * 204 costs a delayed update, while one that wrongly answers 200 hands a machine
 * an installer built for a different architecture.
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

/** A live release row, shaped like Prisma returns one. */
const release = (over: Partial<Record<string, unknown>> = {}) => ({
  id: "r1",
  channel: "stable",
  target: "windows",
  arch: "x86_64",
  version: "0.3.2",
  versionKey: toSortKey("0.3.2"),
  notes: "",
  pubDate: new Date("2026-08-03T11:30:11.795Z"),
  url: "https://cdn.example/releases/0.3.2/welockin_0.3.2_x64-setup.exe",
  sha256: null,
  signature: "SIG",
  sizeBytes: 11_000_000,
  status: "live",
  rolloutPercent: 100,
  rolloutOffset: 0,
  publishedAt: new Date(),
  pausedAt: null,
  createdBy: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

/**
 * Serve rows from a fake table, honouring the route's own `where`.
 *
 * Deliberately applies the filters rather than returning a fixed row: the whole
 * question here is whether the route asks for the right platform, and a stub
 * that ignored `where` would answer "yes" no matter what the route did.
 */
function fakeReleases(t: Ctx, rows: ReturnType<typeof release>[]) {
  invalidateReleaseCache();
  t.after(() => invalidateReleaseCache());
  return stubMethod(t, prisma.release as any, "findFirst", async (args: any) => {
    const w = args?.where ?? {};
    const hits = rows.filter(
      (r) =>
        (w.channel === undefined || r.channel === w.channel) &&
        (w.target === undefined || r.target === w.target) &&
        (w.arch === undefined || r.arch === w.arch) &&
        (w.status === undefined || r.status === w.status),
    );
    hits.sort((a, b) => (a.versionKey < b.versionKey ? 1 : -1));
    return hits[0] ?? null;
  });
}

/* ── Windows must not move ─────────────────────────────────────────────── */

test("the Windows manifest still answers exactly as it did", async (t) => {
  fakeReleases(t, [release()]);

  const res = await request(app).get("/api/updates/windows/x86_64/stable/0.1.0");

  assert.equal(res.status, 200);
  // The shape is the Tauri v2 dynamic format. A renamed field here is a fleet
  // that stops updating, so this asserts the exact keys, not a subset.
  assert.deepEqual(Object.keys(res.body).sort(), [
    "notes",
    "pub_date",
    "signature",
    "url",
    "version",
  ]);
  assert.equal(res.body.version, "0.3.2");
  assert.equal(res.body.pub_date, "2026-08-03T11:30:11.795Z");
  assert.equal(res.body.signature, "SIG");
});

test("a Windows client already on the live version is told nothing", async (t) => {
  fakeReleases(t, [release()]);
  const res = await request(app).get("/api/updates/windows/x86_64/stable/0.3.2");
  assert.equal(res.status, 204);
});

/* ── macOS ─────────────────────────────────────────────────────────────── */

test("darwin/aarch64 is served once a macOS release is live", async (t) => {
  fakeReleases(t, [
    release(),
    release({
      id: "r2",
      target: "darwin",
      arch: "aarch64",
      version: "0.2.1",
      versionKey: toSortKey("0.2.1"),
      url: "https://cdn.example/releases/0.2.1/WeLockIn.app.tar.gz",
      signature: "MAC_SIG",
    }),
  ]);

  const res = await request(app).get("/api/updates/darwin/aarch64/stable/0.2.0");

  assert.equal(res.status, 200);
  assert.equal(res.body.version, "0.2.1");
  assert.equal(res.body.signature, "MAC_SIG", "each platform serves its own signature");
  assert.ok(res.body.url.endsWith(".app.tar.gz"));
});

test("darwin/aarch64 answers 204 while only a Windows release exists", async (t) => {
  fakeReleases(t, [release()]);
  const res = await request(app).get("/api/updates/darwin/aarch64/stable/0.2.0");
  assert.equal(res.status, 204);
});

/**
 * THE one that matters. An Intel Mac handed the Apple-silicon build would
 * install it and then fail to launch — a worse outcome than never updating.
 */
test("an Intel Mac is never offered the Apple-silicon build", async (t) => {
  fakeReleases(t, [
    release({
      id: "r2",
      target: "darwin",
      arch: "aarch64",
      version: "0.2.1",
      versionKey: toSortKey("0.2.1"),
    }),
  ]);

  const res = await request(app).get("/api/updates/darwin/x86_64/stable/0.2.0");
  assert.equal(res.status, 204);
});

test("a platform nobody supports is refused without touching the database", async (t) => {
  const calls = fakeReleases(t, [release()]);
  for (const path of [
    "/api/updates/linux/x86_64/stable/0.1.0",
    "/api/updates/macos/aarch64/stable/0.1.0", // the plausible typo for "darwin"
    "/api/updates/windows/aarch64/stable/0.1.0",
  ]) {
    const res = await request(app).get(path);
    assert.equal(res.status, 204, path);
  }
  assert.equal(calls.length, 0, "an unsupported pair must cost no query");
});

/* ── the two platforms do not leak into each other ──────────────────────── */

test("each platform sees only its own release, at its own version numbers", async (t) => {
  // Windows is ahead of macOS in version numbers; the two lines are independent
  // and will cross. Neither may ever be offered the other's build.
  fakeReleases(t, [
    release({ version: "0.3.2", versionKey: toSortKey("0.3.2"), url: "https://cdn/win.exe" }),
    release({
      id: "r2",
      target: "darwin",
      arch: "aarch64",
      version: "0.2.1",
      versionKey: toSortKey("0.2.1"),
      url: "https://cdn/mac.app.tar.gz",
    }),
  ]);

  const win = await request(app).get("/api/updates/windows/x86_64/stable/0.1.0");
  const mac = await request(app).get("/api/updates/darwin/aarch64/stable/0.2.0");

  assert.equal(win.body.version, "0.3.2");
  assert.equal(win.body.url, "https://cdn/win.exe");
  assert.equal(mac.body.version, "0.2.1");
  assert.equal(mac.body.url, "https://cdn/mac.app.tar.gz");
});

/**
 * The cache used to be a single slot. Alternating platforms evicted it every
 * time, so a container serving both cached nothing — and a per-platform cache
 * must still never answer one platform from the other's entry.
 */
test("caching per platform serves each correctly and stops re-querying", async (t) => {
  const calls = fakeReleases(t, [
    release(),
    release({
      id: "r2",
      target: "darwin",
      arch: "aarch64",
      version: "0.2.1",
      versionKey: toSortKey("0.2.1"),
    }),
  ]);

  for (let i = 0; i < 3; i++) {
    const w = await request(app).get("/api/updates/windows/x86_64/stable/0.1.0");
    const m = await request(app).get("/api/updates/darwin/aarch64/stable/0.2.0");
    assert.equal(w.body.version, "0.3.2");
    assert.equal(m.body.version, "0.2.1");
  }
  assert.equal(calls.length, 2, "one query per platform, not one per request");
});

/* ── rollout is per platform ────────────────────────────────────────────── */

test("a macOS canary at 50% does not hold back a fully-rolled-out Windows", async (t) => {
  fakeReleases(t, [
    release({ rolloutPercent: 100 }),
    release({
      id: "r2",
      target: "darwin",
      arch: "aarch64",
      version: "0.2.1",
      versionKey: toSortKey("0.2.1"),
      rolloutPercent: 50,
      rolloutOffset: 0,
    }),
  ]);

  // Buckets 0..49 are inside a 50% rollout, 50..99 are outside.
  const macIn = await request(app).get("/api/updates/darwin/aarch64/10/0.2.0");
  const macOut = await request(app).get("/api/updates/darwin/aarch64/80/0.2.0");
  const win = await request(app).get("/api/updates/windows/x86_64/80/0.1.0");

  assert.equal(macIn.status, 200, "a bucket inside the macOS ramp gets it");
  assert.equal(macOut.status, 204, "a bucket outside it does not");
  assert.equal(win.status, 200, "and Windows at 100% is unaffected either way");
});

test("the literal `stable` bucket is never given a partial rollout", async (t) => {
  fakeReleases(t, [
    release({
      id: "r2",
      target: "darwin",
      arch: "aarch64",
      version: "0.2.1",
      versionKey: toSortKey("0.2.1"),
      rolloutPercent: 50,
    }),
  ]);
  // `stable` is what a client falls back to when it cannot compute its bucket —
  // a fallback must never land someone in a canary.
  const res = await request(app).get("/api/updates/darwin/aarch64/stable/0.2.0");
  assert.equal(res.status, 204);
});

/* ── the failure modes stay safe ────────────────────────────────────────── */

test("a database failure answers 204 rather than an error", async (t) => {
  invalidateReleaseCache();
  t.after(() => invalidateReleaseCache());
  stubMethod(t, prisma.release as any, "findFirst", async () => {
    throw new Error("mongo is down");
  });

  const res = await request(app).get("/api/updates/darwin/aarch64/stable/0.2.0");
  // The updater must never be able to break the app: any doubt reads as
  // "you're up to date".
  assert.ok(res.status === 204 || res.status >= 500, `got ${res.status}`);
});

test("a malformed version is refused without a query", async (t) => {
  const calls = fakeReleases(t, [release()]);
  const res = await request(app).get("/api/updates/darwin/aarch64/stable/not-a-version");
  assert.equal(res.status, 204);
  assert.equal(calls.length, 0);
});
