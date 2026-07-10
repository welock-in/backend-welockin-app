import assert from "node:assert/strict";
import { test } from "node:test";
import { legacyNameOnlyDeviceWhere } from "./device-identity";

test("legacy device migration matches null and absent deviceId fields", () => {
  assert.deepEqual(legacyNameOnlyDeviceWhere("user-1", "Android phone"), {
    userId: "user-1",
    name: "Android phone",
    OR: [{ deviceId: null }, { deviceId: { isSet: false } }],
  });
});
