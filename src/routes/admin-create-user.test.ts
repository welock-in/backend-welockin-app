import assert from "node:assert/strict";
import { test } from "node:test";
import request from "supertest";
import { createApp } from "../app";
import { prisma } from "../lib/prisma";
import { env } from "../lib/env";
import { signAdminToken } from "../lib/admin-jwt";
import { stubNoBillingHolds } from "./test-helpers";

// The route answers with the RESOLVED entitlement, whose eligibility leg reads
// holds and claims no test here installs.
stubNoBillingHolds();

/**
 * Provisioning an account from the console.
 *
 * What is worth pinning is not the happy path but the four properties that make
 * this safe to hand to a human, because each of them is a way a real account
 * gets damaged: an existing address must never be overwritten, a permanent
 * grant must be stated rather than fallen into, the exact age must never reach
 * the database, and the address must come out verified — the whole reason the
 * door exists is that the six-digit code goes to an inbox the operator cannot
 * read.
 */

const app = createApp();
const NEW_ID = "507f1f77bcf86cd799439099";

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

const ORIGINAL_ADMIN_PASSWORD = env.adminPassword;
env.adminPassword = "test-admin-password";
const auth = { authorization: `Bearer ${signAdminToken(env.adminUsername)}` };
test.after(() => {
  env.adminPassword = ORIGINAL_ADMIN_PASSWORD;
});

function body(over: Record<string, unknown> = {}) {
  return {
    email: "Nouveau@Example.COM",
    password: "a-long-enough-password",
    name: "Selim",
    age: 19,
    university: "HEC Montréal",
    hours: 8,
    plan: "lifetime",
    reason: "founding beta cohort",
    confirmPermanent: true,
    ...over,
  };
}

/** Every write the route makes, recorded. `over.userFind` decides whether the
 *  address is taken. */
function stubDb(t: Ctx, over: Record<string, any> = {}) {
  const created = { id: NEW_ID, email: "nouveau@example.com", plan: "trial" };
  // Two different questions reach the same method: "is this address taken?"
  // (by email, before the write) and the resolver's own re-read (by id, after
  // it). Answering both with one value is how this stub used to make the happy
  // path 404 — so it answers by the key it was asked with.
  const taken = over.taken ?? null;
  stubMethod(t, prisma.user as any, "findUnique", async (args: any) =>
    args?.where?.email !== undefined ? taken : created,
  );
  const creates = stubMethod(t, prisma.user as any, "create", async () => created);
  const updates = stubMethod(t, prisma.user as any, "update", async () => created);
  stubMethod(t, prisma.user as any, "findUniqueOrThrow", async () => created);
  const profiles = stubMethod(t, prisma.onboardingProfile as any, "create", async (args: any) => ({
    ...args.data,
    completedAt: args.data.completedAt,
  }));
  const audits = stubMethod(t, prisma.adminAuditLog as any, "create", async () => ({}));
  // The resolver's own reads; the route only reports what it says.
  stubMethod(t, prisma.purchase as any, "findMany", async () => []);
  stubMethod(t, prisma.subscription as any, "findMany", async () => []);
  stubMethod(t, prisma.trialClaim as any, "findFirst", async () => null);
  return { creates, updates, profiles, audits };
}

test("the create door is admin-gated", async () => {
  const res = await request(app).post("/api/admin/users").send(body());
  assert.equal(res.status, 401);
});

test("an account is created verified, comped, and with the funnel already answered", async (t) => {
  const db = stubDb(t);

  const res = await request(app).post("/api/admin/users").set(auth).send(body());

  assert.equal(res.status, 201);
  const user = db.creates[0][0].data;
  // The address is normalised by registerSchema's OWN rule, so a lookup can
  // never miss this account on casing alone.
  assert.equal(user.email, "nouveau@example.com");
  assert.equal(user.emailVerified, true, "no six-digit code to an inbox we cannot read");
  assert.ok(user.emailVerifiedAt instanceof Date);
  assert.ok(user.passwordHash && user.passwordHash !== "a-long-enough-password", "hashed, never stored raw");
  assert.equal(user.compActive, true);
  assert.equal(user.compedUntil, null, "lifetime: permanent");
  // The same reason prefix POST /users/:id/plan writes, so two operators who
  // granted the same thing by different doors leave rows that read alike.
  assert.equal(user.compReason, "set plan lifetime: founding beta cohort");

  const profile = db.profiles[0][0].data;
  assert.equal(profile.ageBand, "18_24");
  assert.equal(profile.selfReportedDailyHours, 8);
  assert.equal(profile.university, "HEC Montréal");
  assert.equal(profile.displayName, "Selim");
  assert.equal(profile.funnelVersion, "operator_v2", "no funnel produced these answers");
  assert.ok(profile.completedAt, "the 15-screen funnel is skipped");
});

test("the declared age stops at the route — only the band is ever stored", async (t) => {
  const db = stubDb(t);

  await request(app).post("/api/admin/users").set(auth).send(body({ age: 41 }));

  const profile = db.profiles[0][0].data;
  assert.equal(profile.ageBand, "35_44");
  assert.equal((profile as Record<string, unknown>).age, undefined, "the integer is never persisted");
});

test("the user row is mirrored so GET /api/me does not send them back through the funnel", async (t) => {
  const db = stubDb(t);

  await request(app).post("/api/admin/users").set(auth).send(body());

  const mirror = db.updates.map((c) => c[0].data).find((d) => d.onboardingCompletedAt);
  assert.ok(mirror, "onboardingCompletedAt is mirrored onto the User");
  assert.equal(mirror.displayName, "Selim");
});

test("an address that already has an account is a 409, never an overwrite", async (t) => {
  const db = stubDb(t, { taken: { id: "existing", email: "nouveau@example.com" } });

  const res = await request(app).post("/api/admin/users").set(auth).send(body());

  assert.equal(res.status, 409);
  assert.equal(db.creates.length, 0, "a mistyped address must not rewrite a live account's password");
  assert.match(res.body.error, /already has an account/i);
});

test("a permanent lifetime cannot be fallen into — it has to be confirmed", async (t) => {
  const db = stubDb(t);

  const res = await request(app)
    .post("/api/admin/users")
    .set(auth)
    .send(body({ confirmPermanent: undefined }));

  assert.equal(res.status, 400);
  assert.equal(db.creates.length, 0);
});

test("every other granting plan needs an end date", async (t) => {
  const db = stubDb(t);

  const res = await request(app)
    .post("/api/admin/users")
    .set(auth)
    .send(body({ plan: "pro", confirmPermanent: undefined }));

  assert.equal(res.status, 400, "a grant nobody time-boxed is one nobody decided on");
  assert.equal(db.creates.length, 0);
});

test("a pro grant with a future end date is written time-boxed", async (t) => {
  const db = stubDb(t);
  const until = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  const res = await request(app)
    .post("/api/admin/users")
    .set(auth)
    .send(body({ plan: "pro", until, confirmPermanent: undefined }));

  assert.equal(res.status, 201);
  assert.deepEqual(db.creates[0][0].data.compedUntil, new Date(until));
});

test("a withdrawing plan name is refused — this door creates, it does not revoke", async (t) => {
  const db = stubDb(t);

  const res = await request(app).post("/api/admin/users").set(auth).send(body({ plan: "free" }));

  assert.equal(res.status, 400);
  assert.equal(db.creates.length, 0);
});

test("an age below the minimum is refused before anything is written", async (t) => {
  const db = stubDb(t);

  const res = await request(app).post("/api/admin/users").set(auth).send(body({ age: 12 }));

  assert.equal(res.status, 400);
  assert.equal(db.creates.length, 0);
});

test("a password the front door would refuse is refused here too", async (t) => {
  const db = stubDb(t);

  const res = await request(app).post("/api/admin/users").set(auth).send(body({ password: "short" }));

  assert.equal(res.status, 400, "a provisioned account must not be reachable by a weaker password");
  assert.equal(db.creates.length, 0);
});

test("the grant is audited with the operator's reason", async (t) => {
  const db = stubDb(t);

  await request(app).post("/api/admin/users").set(auth).send(body());

  const row = db.audits[0][0].data;
  assert.equal(row.action, "create_user");
  assert.equal(row.reason, "founding beta cohort");
  assert.equal(row.targetUserId, NEW_ID);
});
