import assert from "node:assert/strict";
import { test } from "node:test";
import type { Request } from "express";
import { readClientPlatform, signupLifetimeGrantData } from "./signup-lifetime";

function client(platform?: string, deviceId?: string): Request {
  return { header: (name: string) => name === "x-welockin-platform" ? platform : deviceId, body: {} } as Request;
}

test("signup origin requires an explicit recognized platform or a legacy desktop id", () => {
  for (const value of [undefined, "", "android", "web", "invalid"]) {
    assert.equal(readClientPlatform(client(value, "opaque-device")), "unknown");
  }
  assert.equal(readClientPlatform(client(undefined, "ios-device")), "unknown");
  assert.equal(readClientPlatform(client("ios")), "ios");
  assert.equal(readClientPlatform(client(" iPadOS ")), "ios");
  assert.equal(readClientPlatform(client("windows")), "windows");
  assert.equal(readClientPlatform(client("macos")), "macos");
  assert.equal(readClientPlatform(client(undefined, "win-machine")), "windows");
  assert.equal(readClientPlatform(client(undefined, "mac-machine")), "macos");
  assert.equal(readClientPlatform(client("ios", "win-machine")), "windows");
  assert.equal(readClientPlatform(client("ipados", "mac-machine")), "macos");
});

test("a reservation activates only its matching scope and never replaces an acquired timestamp", () => {
  const now = new Date("2026-09-23T10:00:00Z");
  assert.deepEqual(signupLifetimeGrantData({ signupPlatform: "ios", signupLifetimeOffer: "ios" }, now),
    { iosLifetimeGrantedAt: now });
  for (const platform of ["windows", "macos"]) {
    assert.deepEqual(signupLifetimeGrantData({ signupPlatform: platform, signupLifetimeOffer: "desktop" }, now),
      { desktopLifetimeGrantedAt: now });
  }
  for (const row of [
    {}, { signupPlatform: "ios" }, { signupLifetimeOffer: "ios" },
    { signupPlatform: "ios", signupLifetimeOffer: "desktop" },
    { signupPlatform: "windows", signupLifetimeOffer: "ios" },
    { signupPlatform: "unknown", signupLifetimeOffer: "ios" },
    { signupPlatform: "ios", signupLifetimeOffer: "ios", iosLifetimeGrantedAt: new Date(0) },
    { signupPlatform: "macos", signupLifetimeOffer: "desktop", desktopLifetimeGrantedAt: new Date(0) },
  ]) assert.deepEqual(signupLifetimeGrantData(row, now), {});
});
