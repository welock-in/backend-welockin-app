import assert from "node:assert/strict";
import { test } from "node:test";
import { hasDesktopLifetime, isDesktopDeviceId } from "./desktop-lifetime";

test("desktop ids include hardware and fallback ids for both desktop apps", () => {
  for (const id of ["win-machine-guid", "win-unidentified", "mac-platform-uuid", "mac-fallback-id"]) {
    assert.equal(isDesktopDeviceId(id), true, id);
  }
});

test("mobile, missing, malformed and partial desktop ids never qualify", () => {
  for (const id of ["", "ios-device", "android-device", "device", "win-", "mac-", "win- ", "mac-\n", "windows-device", "macos-device", "WIN-device", "xmac-device", " win-device"]) {
    assert.equal(isDesktopDeviceId(id), false, JSON.stringify(id));
  }
});

test("a saved lifetime follows its account between desktop apps only", () => {
  const granted = { desktopLifetimeGrantedAt: new Date("2026-09-20T00:00:00.000Z") };
  assert.equal(hasDesktopLifetime(granted, "win-new-computer"), true);
  assert.equal(hasDesktopLifetime(granted, "mac-new-computer"), true);
  assert.equal(hasDesktopLifetime(granted, "ios-phone"), false);
  assert.equal(hasDesktopLifetime(granted, ""), false);
});

test("legacy and missing accounts receive no inferred lifetime", () => {
  for (const user of [null, {}, { desktopLifetimeGrantedAt: null }]) {
    assert.equal(hasDesktopLifetime(user, "win-computer"), false);
    assert.equal(hasDesktopLifetime(user, "mac-computer"), false);
  }
});
