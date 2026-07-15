import assert from "node:assert/strict";
import { test } from "node:test";
import { canAutoLinkAppleAccount, getVerifiedAppleEmail } from "./apple";
import { env } from "./env";

test("Apple account linking accepts only a verified token email", () => {
  assert.equal(
    getVerifiedAppleEmail({
      sub: "apple-user",
      email: "relay@privaterelay.appleid.com",
      emailVerified: true,
    }),
    "relay@privaterelay.appleid.com",
  );
  assert.equal(
    getVerifiedAppleEmail({ sub: "apple-user", email: "victim@example.com", emailVerified: false }),
    null,
  );
  assert.equal(getVerifiedAppleEmail({ sub: "apple-user" }), null);
});

test("Apple auto-linking rejects unverified password accounts", () => {
  assert.equal(canAutoLinkAppleAccount({ emailVerified: false }), false);
  assert.equal(canAutoLinkAppleAccount({ emailVerified: null }), false);
  assert.equal(canAutoLinkAppleAccount({}), false);
  assert.equal(canAutoLinkAppleAccount({ emailVerified: true }), true);
});

test("Apple audience defaults to the app bundle identifier", () => {
  assert.equal(env.appleBundleId, process.env.APPLE_BUNDLE_ID ?? "in.welock.app");
});
