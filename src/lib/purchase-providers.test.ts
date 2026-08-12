import assert from "node:assert/strict";
import { test } from "node:test";
import { HttpError } from "./http-error";
import { PROVIDERS, assertCanWrite, getProvider } from "./purchase-providers";

/**
 * The registry decides which shops are open. What is worth pinning is not the
 * list itself — that changes as platforms ship — but the two properties the
 * design rests on: a closed shop cannot write, and a provider id can never
 * quietly change, because it is half of the unique key every existing purchase
 * row is stored under.
 */

test("a disabled provider cannot write, and says so as a 503", () => {
  const disabled = PROVIDERS.find((p) => !p.enabled);
  if (!disabled) {
    // Every provider enabled is a legitimate configuration; nothing to assert.
    return;
  }
  assert.throws(
    () => assertCanWrite(disabled.id),
    (err: unknown) => {
      assert.ok(err instanceof HttpError);
      // 503, not 400: the request may be perfectly honest — it is the shop that
      // is shut, and a client deciding whether to retry needs to know which.
      assert.equal(err.status, 503);
      assert.equal(err.code, "PROVIDER_DISABLED");
      return true;
    },
  );
});

test("an unknown provider is a server fault, not a client one", () => {
  assert.throws(
    () => assertCanWrite("stripe"),
    (err: unknown) => {
      assert.ok(err instanceof HttpError);
      assert.equal(err.status, 500);
      assert.equal(err.code, "PROVIDER_UNKNOWN");
      return true;
    },
  );
});

/*
 * Apple is the entry point iOS wires into, and it must stay shut until an iOS
 * build ships: the route behind it verifies a StoreKit JWS, and a free SANDBOX
 * transaction is signed by the same Apple chain as a real one. A door nobody
 * uses should not be open.
 */
test("Apple purchases are closed unless APPLE_PURCHASES_ENABLED says otherwise", () => {
  const apple = getProvider("app_store");
  assert.ok(apple, "the App Store entry must exist so iOS has somewhere to wire in");
  assert.equal(apple.enabled, process.env.APPLE_PURCHASES_ENABLED === "true");
});

/*
 * `provider` is half of `@@unique([provider, externalId])`. Renaming one would
 * orphan every purchase already recorded under the old spelling — the customers
 * would still have paid, and the resolver would stop counting them.
 */
test("the provider ids are the ones already written to the database", () => {
  const ids = PROVIDERS.map((p) => p.id).sort();
  assert.deepEqual(ids, ["app_store", "lemonsqueezy", "revenuecat"]);
});

test("every provider is uniquely addressable", () => {
  const ids = PROVIDERS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.equal(getProvider(id)?.id, id);
});
