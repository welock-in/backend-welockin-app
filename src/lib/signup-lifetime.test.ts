import assert from "node:assert/strict";
import { test } from "node:test";
import type { Request } from "express";
import { readClientPlatform, signupLifetimeGrantData, signupLifetimeOfferFromSettings, signupLifetimeOfferForPlatform } from "./signup-lifetime";

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

test("a reservation activates its saved scopes regardless of signup device and preserves timestamps", () => {
  const now = new Date("2026-09-23T10:00:00Z");
  assert.deepEqual(signupLifetimeGrantData({ signupPlatform: "ios", signupLifetimeOffer: "ios" }, now),
    { iosLifetimeGrantedAt: now });
  for (const platform of ["windows", "macos"]) {
    assert.deepEqual(signupLifetimeGrantData({ signupPlatform: platform, signupLifetimeOffer: "desktop" }, now),
      { desktopLifetimeGrantedAt: now });
  }
  for (const row of [
    {}, { signupPlatform: "ios" }, { signupLifetimeOffer: "ios" },
    { signupPlatform: "unknown", signupLifetimeOffer: "ios" },
    { signupPlatform: "ios", signupLifetimeOffer: "ios", iosLifetimeGrantedAt: new Date(0) },
    { signupPlatform: "macos", signupLifetimeOffer: "desktop", desktopLifetimeGrantedAt: new Date(0) },
  ]) assert.deepEqual(signupLifetimeGrantData(row, now), {});
  for (const signupPlatform of ["ios", "windows", "macos"]) {
    assert.deepEqual(signupLifetimeGrantData({ signupPlatform, signupLifetimeOffer: "ios" }, now),
      { iosLifetimeGrantedAt: now });
    assert.deepEqual(signupLifetimeGrantData({ signupPlatform, signupLifetimeOffer: "desktop" }, now),
      { desktopLifetimeGrantedAt: now });
    assert.deepEqual(signupLifetimeGrantData({ signupPlatform, signupLifetimeOffer: "all" }, now),
      { iosLifetimeGrantedAt: now, desktopLifetimeGrantedAt: now });
    assert.deepEqual(signupLifetimeGrantData({
      signupPlatform, signupLifetimeOffer: "all", iosLifetimeGrantedAt: new Date(0),
    }, now), { desktopLifetimeGrantedAt: now });
    assert.deepEqual(signupLifetimeGrantData({
      signupPlatform, signupLifetimeOffer: "all", iosLifetimeGrantedAt: now, desktopLifetimeGrantedAt: now,
    }, new Date()), {});
  }
});

test("all switch combinations are saved while precheck remains compatible with released apps", () => {
  for (const [ios, desktop, expected] of [
    [false, false, null], [true, false, "ios"], [false, true, "desktop"], [true, true, "all"],
  ] as const) {
    const offer = signupLifetimeOfferFromSettings({
      iosSignupLifetimeEnabled: ios, desktopSignupLifetimeEnabled: desktop,
    });
    assert.equal(offer, expected);
    assert.equal(signupLifetimeOfferForPlatform(offer, "ios"), ios ? "ios" : null);
    assert.equal(signupLifetimeOfferForPlatform(offer, "windows"), desktop ? "desktop" : null);
    assert.equal(signupLifetimeOfferForPlatform(offer, "macos"), desktop ? "desktop" : null);
    assert.equal(signupLifetimeOfferForPlatform(offer, "unknown"), null);
  }
});
