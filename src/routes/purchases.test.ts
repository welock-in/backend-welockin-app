import assert from "node:assert/strict";
import { test } from "node:test";
import { recordLifetime } from "./purchases";
import { prisma } from "../lib/prisma";
import { HttpError } from "../lib/http-error";
import { APP_STORE, LIFETIME_PRODUCT_ID } from "../lib/entitlement";

/*
 * The legacy JWS lifetime path (POST /api/purchases). The route itself cannot
 * be exercised end to end — reaching `recordLifetime` needs a transaction Apple
 * actually signed, which is the one thing the verifier makes impossible to fake
 * (see apple-jws.test.ts) — so the writer is tested directly, the same way that
 * file tests the rules the route calls.
 *
 * What these tests pin: this path IS globally unique on originalTransactionId,
 * and that uniqueness now MEANS ownership. A second account posting the same
 * JWS used to land on the first account's row and silently refresh it —
 * "recorded" to the caller, nothing granted, and the caller's replay rewriting
 * the owner's refund state. Now: owner alive → an honest 409 naming a masked
 * account; owner deleted → an audited adoption; the owner themselves →
 * exactly the idempotent replay it always was.
 */

const USER = "507f1f77bcf86cd799439011";
const OTHER = "507f1f77bcf86cd799439022";
const T0 = Date.parse("2026-07-01T00:00:00.000Z");
const TX = {
  originalTransactionId: "2000000123456789",
  productId: LIFETIME_PRODUCT_ID,
  purchaseDate: T0,
};

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

/** The writer's world: one (possibly absent) existing row, one (possibly
 *  deleted) owner, and every write recorded. */
function stubDb(
  t: Ctx,
  existing: { userId: string } | null,
  owner: { email: string } | null = null,
) {
  return {
    rowRead: stubMethod(t, prisma.purchase as any, "findUnique", async () => existing),
    ownerRead: stubMethod(t, prisma.user as any, "findUnique", async () => owner),
    upsert: stubMethod(t, prisma.purchase as any, "upsert", async (a: any) => a.create),
    audit: stubMethod(t, prisma.adminAuditLog as any, "create", async (a: any) => a.data),
    warns: stubMethod(t, console as any, "warn", () => {}),
  };
}

test("the first post records the lifetime, owned by the poster", async (t) => {
  const db = stubDb(t, null);

  await recordLifetime(USER, TX, false);

  assert.equal(db.upsert.length, 1);
  const { where, create, update } = db.upsert[0][0];
  assert.deepEqual(where.provider_externalId, {
    provider: APP_STORE,
    externalId: TX.originalTransactionId,
  });
  assert.equal(create.userId, USER);
  assert.equal(create.isRefunded, false);
  assert.equal("userId" in update, false, "ownership is decided at create, like every writer");
  assert.equal(db.ownerRead.length, 0, "no other owner, nobody to look up");
  assert.equal(db.audit.length, 0);
});

test("the owner's own replay is the idempotent refresh it always was", async (t) => {
  // StoreKit re-delivers on every launch; a restore replays verbatim. Same
  // account → same row, refreshed, ownership untouched, nothing logged.
  const db = stubDb(t, { userId: USER });

  await recordLifetime(USER, TX, false);

  assert.equal(db.upsert.length, 1);
  const { update } = db.upsert[0][0];
  assert.equal("userId" in update, false, "a replay never rewrites ownership");
  assert.equal(update.isRefunded, false);
  assert.equal(update.refundedAt, null);
  assert.equal(db.ownerRead.length, 0, "the caller IS the owner — no dispute to check");
  assert.equal(db.audit.length, 0);
  assert.equal(db.warns.length, 0);
});

test("a second account posting the same JWS gets a 409 naming the masked owner — and writes NOTHING", async (t) => {
  // The silent cross-account update this test buries: account B restoring
  // account A's purchase used to refresh A's row and tell B "recorded".
  const db = stubDb(t, { userId: OTHER }, { email: "owner@example.com" });

  await assert.rejects(
    () => recordLifetime(USER, TX, false),
    (err: unknown) => {
      assert.ok(err instanceof HttpError);
      assert.equal(err.status, 409);
      assert.equal(err.code, "PURCHASE_OWNED_BY_OTHER_ACCOUNT");
      assert.deepEqual(err.details, { maskedEmail: "o•••@ex•••.com" });
      return true;
    },
  );

  assert.equal(db.upsert.length, 0, "the owner's row is not touched — not even 'refreshed'");
  assert.equal(db.audit.length, 0);
  // Loud, with both ids: a restore dispute needs both sides on the log line.
  assert.equal(db.warns.length, 1);
  assert.ok(String(db.warns[0][0]).includes(USER));
  assert.ok(String(db.warns[0][0]).includes(OTHER));
});

test("…and the refusal never leaks the raw address, only the maskEmail form", async (t) => {
  stubDb(t, { userId: OTHER }, { email: "hedi.fourati@epfl.ch" });

  await assert.rejects(
    () => recordLifetime(USER, TX, false),
    (err: unknown) => {
      assert.ok(err instanceof HttpError);
      const masked = (err.details as { maskedEmail: string }).maskedEmail;
      assert.equal(masked, "h•••@ep•••.ch");
      assert.ok(!masked.includes("fourati"), "the local part must not survive");
      assert.ok(!JSON.stringify(err.message).includes("epfl"), "nor ride in the message");
      return true;
    },
  );
});

test("a row whose owner DELETED their account is adopted: ownership moves, audited", async (t) => {
  const db = stubDb(t, { userId: OTHER }, null); // the owner is gone

  await recordLifetime(USER, TX, false);

  assert.equal(db.upsert.length, 1);
  const { update } = db.upsert[0][0];
  assert.equal(update.userId, USER, "userId enters the update clause ONLY via this branch");
  assert.equal(update.isRefunded, false);
  // The move is written down: an ownership change with no admin in the loop
  // must still be explainable later.
  assert.equal(db.audit.length, 1);
  const audit = db.audit[0][0].data;
  assert.equal(audit.action, "adopt_orphaned_purchase");
  assert.equal(audit.actorId, USER);
  assert.equal(audit.meta.previousUserId, OTHER);
  assert.equal(audit.meta.externalId, TX.originalTransactionId);
  assert.equal(db.warns.length, 1, "an adoption is a loud event");
  assert.match(String(db.warns[0][0]), /adopting orphaned/);
});

test("a lost audit row does not cost the customer the licence they just proved", async (t) => {
  const db = stubDb(t, { userId: OTHER }, null);
  stubMethod(t, prisma.adminAuditLog as any, "create", async () => {
    throw new Error("replica set unavailable");
  });
  const errors = stubMethod(t, console as any, "error", () => {});

  await recordLifetime(USER, TX, false); // must not throw

  assert.equal(db.upsert.length, 1, "the adoption itself landed");
  assert.equal(errors.length, 1, "…and the lost audit row is loud instead of silent");
});

test("a refund replay still lands whoever owns the row it always did — same account, refund recorded", async (t) => {
  const db = stubDb(t, { userId: USER });

  await recordLifetime(USER, TX, true);

  const { update } = db.upsert[0][0];
  assert.equal(update.isRefunded, true);
  assert.ok(update.refundedAt instanceof Date, "a refund is stamped, not merely flagged");
  assert.equal("userId" in update, false);
});
