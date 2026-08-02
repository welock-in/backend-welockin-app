import assert from "node:assert/strict";
import { test } from "node:test";
import request from "supertest";
import { Prisma, type OnboardingProfile } from "@prisma/client";
import { createApp } from "../app";
import { stubAccountGuard } from "./test-helpers";
import { signToken } from "../lib/jwt";
import { prisma } from "../lib/prisma";

const app = createApp();

// This router now sits behind the account guard (see app.ts), which reads the
// caller's account on every request. Answer that one read for the whole file;
// every other user lookup still falls through and fails loudly if unstubbed.
stubAccountGuard();
const userId = "507f1f77bcf86cd799439011";
const auth = { authorization: `Bearer ${signToken({ sub: userId, email: "user@example.com" })}` };

function stubMethod(
  t: { after: (fn: () => void) => void },
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

const NOW = new Date("2026-07-25T09:14:41.812Z");

/** A stored row, as Prisma would read it back. */
function row(overrides: Partial<OnboardingProfile> = {}): OnboardingProfile {
  return {
    id: "507f1f77bcf86cd7994390aa",
    userId,
    funnelVersion: "phone_v6",
    clientSubmissionId: "submission-0000-0001",
    displayName: "Hedi",
    ageBand: "25_34",
    profileSlug: "founder_or_freelancer",
    goalSlug: "focus_better",
    distractingAppSlugs: ["instagram", "tiktok", "youtube"],
    selfReportedDailyHours: 6,
    clientProjection: null,
    locale: "fr-FR",
    appVersion: "1.0.0",
    platform: "ios",
    deviceId: "6E1C0F2A-0000-4000-8000-000000000001",
    startedAt: new Date("2026-07-25T09:12:03.000Z"),
    completedAt: NOW,
    revision: 1,
    writeWindowStartedAt: NOW,
    writeWindowCount: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

/** A complete funnel submission body (only 4 keys are actually required). */
function body(overrides: Record<string, unknown> = {}) {
  return {
    clientSubmissionId: "submission-0000-0001",
    funnelVersion: "phone_v6",
    displayName: "Hedi",
    age: 22,
    profile: "founder_or_freelancer",
    goal: "focus_better",
    distractingApps: ["instagram", "tiktok", "youtube"],
    selfReportedDailyHours: 6,
    ...overrides,
  };
}

/**
 * `create` echoes back exactly what the handler asked for — every optional column
 * the create did NOT set reads back as null, like Mongo would return it.
 */
function stubCreate(t: { after: (fn: () => void) => void }) {
  return stubMethod(t, prisma.onboardingProfile as any, "create", async (args: any) =>
    row({
      displayName: null,
      profileSlug: null,
      goalSlug: null,
      distractingAppSlugs: [],
      clientProjection: null,
      locale: null,
      appVersion: null,
      platform: null,
      deviceId: null,
      startedAt: null,
      ...args.data,
    }),
  );
}

/** `update` echoes the merge, resolving the `{ increment }` operators to numbers. */
function stubUpdate(t: { after: (fn: () => void) => void }, existing: OnboardingProfile) {
  return stubMethod(t, prisma.onboardingProfile as any, "update", async (args: any) => ({
    ...existing,
    ...args.data,
    revision: existing.revision + 1,
    writeWindowCount: existing.writeWindowCount + 1,
  }));
}

const stubUserUpdate = (t: { after: (fn: () => void) => void }) =>
  stubMethod(t, prisma.user as any, "update", async (args: any) => ({ id: args.where.id }));

test("onboarding endpoints reject an unauthenticated caller", async () => {
  const post = await request(app).post("/api/onboarding").send(body());
  assert.equal(post.status, 401);
  const get = await request(app).get("/api/onboarding");
  assert.equal(get.status, 401);
});

test("the first submission creates the row and never stores the exact age", async (t) => {
  stubMethod(t, prisma.onboardingProfile as any, "findUnique", async () => null);
  const createCalls = stubCreate(t);
  stubUserUpdate(t);

  const res = await request(app).post("/api/onboarding").set(auth).send(body());

  assert.equal(res.status, 201);
  assert.equal(res.body.deduped, false);
  assert.equal(createCalls.length, 1);
  const data = createCalls[0][0].data as Record<string, unknown>;
  assert.ok(data.completedAt instanceof Date);
  assert.equal(data.revision, 1);
  assert.equal(data.ageBand, "18_24");
  assert.equal(data.writeWindowCount, 1);
  assert.ok(data.writeWindowStartedAt instanceof Date);
  assert.equal(data.funnelVersion, "phone_v6");
  // Data minimisation: only the band is persisted.
  assert.equal("age" in data, false);
});

test("the first submission mirrors exactly the two cached fields onto User", async (t) => {
  stubMethod(t, prisma.onboardingProfile as any, "findUnique", async () => null);
  stubCreate(t);
  const userUpdateCalls = stubUserUpdate(t);

  const withName = await request(app).post("/api/onboarding").set(auth).send(body());
  assert.equal(withName.status, 201);
  assert.equal(userUpdateCalls.length, 1);
  assert.deepEqual(userUpdateCalls[0][0].where, { id: userId });
  assert.deepEqual(Object.keys(userUpdateCalls[0][0].data), [
    "onboardingCompletedAt",
    "displayName",
  ]);

  const anonymous = await request(app)
    .post("/api/onboarding")
    .set(auth)
    .send(body({ displayName: undefined }));
  assert.equal(anonymous.status, 201);
  assert.equal(userUpdateCalls.length, 2);
  assert.deepEqual(Object.keys(userUpdateCalls[1][0].data), ["onboardingCompletedAt"]);
});

test("the receipt is written before the User cache", async (t) => {
  stubMethod(t, prisma.onboardingProfile as any, "findUnique", async () => null);
  const createCalls = stubCreate(t);
  stubMethod(t, prisma.user as any, "update", async (args: any) => {
    // Order is load-bearing: a crash in between must leave a receipt with a stale
    // cache, never a cache with no receipt.
    assert.equal(createCalls.length, 1, "OnboardingProfile must be created first");
    return { id: args.where.id };
  });

  const res = await request(app).post("/api/onboarding").set(auth).send(body());
  assert.equal(res.status, 201);
});

test("replaying the same submission id writes no answer and no revision", async (t) => {
  const existing = row({ clientSubmissionId: "submission-0000-0001" });
  stubMethod(t, prisma.onboardingProfile as any, "findUnique", async () => existing);
  const createCalls = stubCreate(t);
  const updateCalls = stubUpdate(t, existing);
  stubUserUpdate(t);

  const res = await request(app).post("/api/onboarding").set(auth).send(body());

  assert.equal(res.status, 200);
  assert.equal(res.body.deduped, true);
  assert.equal(res.body.onboarding.revision, 1);
  assert.equal(createCalls.length, 0);
  assert.equal(updateCalls.length, 0);
});

test("a replay converges the User mirror the first attempt failed to write", async (t) => {
  // The two writes are not atomic: the receipt can commit and `user.update` then
  // fail (pool timeout / failover) → 500. The client retries the SAME id, which
  // lands on the fast path — NOT the P2002 race path — so this is the only place
  // that can ever repair `displayName` / `onboardingCompletedAt`. Nothing else in
  // the backend writes them (no cron, no reconcile script).
  const existing = row({ clientSubmissionId: "submission-0000-0001", displayName: "Hedi" });
  stubMethod(t, prisma.onboardingProfile as any, "findUnique", async () => existing);
  const updateCalls = stubUpdate(t, existing);
  const userUpdateCalls = stubUserUpdate(t);

  const res = await request(app).post("/api/onboarding").set(auth).send(body());

  assert.equal(res.status, 200);
  assert.equal(res.body.deduped, true);
  assert.equal(updateCalls.length, 0, "a replay must not bump the revision");
  assert.equal(userUpdateCalls.length, 1);
  assert.deepEqual(userUpdateCalls[0][0].where, { id: userId });
  assert.deepEqual(Object.keys(userUpdateCalls[0][0].data), [
    "onboardingCompletedAt",
    "displayName",
  ]);
  assert.equal(userUpdateCalls[0][0].data.displayName, "Hedi");
});

test("a new submission id merges and never touches the immutable anchors", async (t) => {
  const existing = row({ clientSubmissionId: "submission-0000-0001", writeWindowCount: 2 });
  stubMethod(t, prisma.onboardingProfile as any, "findUnique", async () => existing);
  const updateCalls = stubUpdate(t, existing);
  stubUserUpdate(t);

  const res = await request(app)
    .post("/api/onboarding")
    .set(auth)
    .send(body({ clientSubmissionId: "submission-0000-0002", displayName: "Hédi" }));

  assert.equal(res.status, 200);
  assert.equal(res.body.deduped, false);
  assert.equal(res.body.onboarding.revision, 2);
  assert.equal(updateCalls.length, 1);
  const args = updateCalls[0][0] as { where: unknown; data: Record<string, unknown> };
  assert.deepEqual(args.where, { userId });
  assert.deepEqual(args.data.revision, { increment: 1 });
  assert.equal(args.data.clientSubmissionId, "submission-0000-0002");
  assert.equal(args.data.displayName, "Hédi");
  for (const immutable of ["completedAt", "startedAt", "funnelVersion", "createdAt"]) {
    assert.equal(immutable in args.data, false, `${immutable} must be immutable`);
  }
});

test("a partial re-submit leaves the omitted answers untouched", async (t) => {
  const existing = row({ clientSubmissionId: "submission-0000-0001" });
  stubMethod(t, prisma.onboardingProfile as any, "findUnique", async () => existing);
  const updateCalls = stubUpdate(t, existing);
  stubUserUpdate(t);

  const res = await request(app).post("/api/onboarding").set(auth).send({
    clientSubmissionId: "submission-0000-0002",
    funnelVersion: "phone_v6",
    displayName: "Hedi",
    age: 22,
    selfReportedDailyHours: 6,
  });

  assert.equal(res.status, 200);
  const data = updateCalls[0][0].data as Record<string, unknown>;
  // Absent ⇒ untouched: a rename in Settings must not wipe the app list.
  assert.equal("profileSlug" in data, false);
  assert.equal("goalSlug" in data, false);
  assert.equal("distractingAppSlugs" in data, false);
});

test("a raced create (P2002) returns the winner and still mirrors to User", async (t) => {
  const winner = row({ clientSubmissionId: "submission-0000-0001" });
  let lookup = 0;
  stubMethod(t, prisma.onboardingProfile as any, "findUnique", async () => {
    lookup += 1;
    return lookup === 1 ? null : winner;
  });
  stubMethod(t, prisma.onboardingProfile as any, "create", async () => {
    throw new Prisma.PrismaClientKnownRequestError("dup", {
      code: "P2002",
      clientVersion: "5.22.0",
    });
  });
  const userUpdateCalls = stubUserUpdate(t);

  const res = await request(app).post("/api/onboarding").set(auth).send(body());

  assert.equal(res.status, 200);
  assert.equal(res.body.deduped, true);
  assert.equal(userUpdateCalls.length, 1);
});

test("a raced create (P2034 write conflict) is treated the same way", async (t) => {
  const winner = row({ clientSubmissionId: "submission-0000-0001" });
  let lookup = 0;
  stubMethod(t, prisma.onboardingProfile as any, "findUnique", async () => {
    lookup += 1;
    return lookup === 1 ? null : winner;
  });
  stubMethod(t, prisma.onboardingProfile as any, "create", async () => {
    throw new Prisma.PrismaClientKnownRequestError("write conflict", {
      code: "P2034",
      clientVersion: "5.22.0",
    });
  });
  const userUpdateCalls = stubUserUpdate(t);

  const res = await request(app).post("/api/onboarding").set(auth).send(body());

  assert.equal(res.status, 200);
  assert.equal(res.body.deduped, true);
  assert.equal(userUpdateCalls.length, 1);
});

test("a raced create whose winner holds a DIFFERENT id merges instead of faking a dedupe", async (t) => {
  // The deterministic _id keys on userId alone, so a P2002 proves only that SOME
  // submission for this user landed first. Answering `deduped: true` to a loser that
  // carries different answers would tell the client its edit is stored while nothing
  // merged it — and a compliant client then drops its pending edit.
  const winner = row({ clientSubmissionId: "submission-0000-0001", displayName: "Old", goalSlug: null });
  let lookup = 0;
  stubMethod(t, prisma.onboardingProfile as any, "findUnique", async () => {
    lookup += 1;
    return lookup === 1 ? null : winner;
  });
  stubMethod(t, prisma.onboardingProfile as any, "create", async () => {
    throw new Prisma.PrismaClientKnownRequestError("dup", {
      code: "P2002",
      clientVersion: "5.22.0",
    });
  });
  const updateCalls = stubUpdate(t, winner);
  const userUpdateCalls = stubUserUpdate(t);

  const res = await request(app)
    .post("/api/onboarding")
    .set(auth)
    .send(body({ clientSubmissionId: "submission-0000-0002", displayName: "New" }));

  assert.equal(res.status, 200);
  assert.equal(res.body.deduped, false, "a losing edit is a merge, never a dedupe");
  assert.equal(updateCalls.length, 1);
  const data = updateCalls[0][0].data as Record<string, unknown>;
  assert.equal(data.clientSubmissionId, "submission-0000-0002");
  assert.equal(data.displayName, "New");
  assert.equal(data.goalSlug, "focus_better");
  assert.deepEqual(data.revision, { increment: 1 });
  assert.equal(res.body.onboarding.displayName, "New");
  assert.equal(res.body.onboarding.revision, 2);
  assert.equal(userUpdateCalls.length, 1);
});

test("a losing raced edit still honours the write-churn rate limit", async (t) => {
  // The merge path's rate-limit gate must not be bypassable by arriving via the
  // race branch instead of the sequential one.
  const winner = row({
    clientSubmissionId: "submission-0000-0001",
    writeWindowStartedAt: new Date(),
    writeWindowCount: 10,
  });
  let lookup = 0;
  stubMethod(t, prisma.onboardingProfile as any, "findUnique", async () => {
    lookup += 1;
    return lookup === 1 ? null : winner;
  });
  stubMethod(t, prisma.onboardingProfile as any, "create", async () => {
    throw new Prisma.PrismaClientKnownRequestError("dup", {
      code: "P2002",
      clientVersion: "5.22.0",
    });
  });
  const updateCalls = stubUpdate(t, winner);
  stubUserUpdate(t);

  const res = await request(app)
    .post("/api/onboarding")
    .set(auth)
    .send(body({ clientSubmissionId: "submission-0000-0099" }));

  assert.equal(res.status, 429);
  assert.equal(res.body.code, "ONBOARDING_RATE_LIMITED");
  assert.equal(updateCalls.length, 0);
});

test("a deleted account gets a MACHINE-READABLE 404, not a bare Not found", async (t) => {
  // requireAuth is stateless, so a token outliving its User row reaches the mirror
  // write. A codeless 404 is byte-identical to an unrouted-path / edge 404, and the
  // client's 404 action (drop the answers, sign out) is its one destructive branch.
  stubMethod(t, prisma.onboardingProfile as any, "findUnique", async () => null);
  stubCreate(t);
  stubMethod(t, prisma.user as any, "update", async () => {
    throw new Prisma.PrismaClientKnownRequestError("no such record", {
      code: "P2025",
      clientVersion: "5.22.0",
    });
  });

  const res = await request(app).post("/api/onboarding").set(auth).send(body());

  assert.equal(res.status, 404);
  assert.equal(res.body.code, "ACCOUNT_NOT_FOUND");
  // An unrouted path must stay distinguishable: same status, no code.
  const unrouted = await request(app).post("/api/onboarding/nope").set(auth).send(body());
  assert.equal(unrouted.status, 404);
  assert.equal("code" in unrouted.body, false);
});

test("an unrelated Prisma error is never swallowed as a dedupe", async (t) => {
  stubMethod(t, prisma.onboardingProfile as any, "findUnique", async () => null);
  stubMethod(t, prisma.onboardingProfile as any, "create", async () => {
    throw new Prisma.PrismaClientKnownRequestError("value too long", {
      code: "P2000",
      clientVersion: "5.22.0",
    });
  });
  stubUserUpdate(t);

  const res = await request(app).post("/api/onboarding").set(auth).send(body());
  assert.equal(res.status, 500);
});

test("an under-age declaration is refused before any read or write", async (t) => {
  const findCalls = stubMethod(t, prisma.onboardingProfile as any, "findUnique", async () => null);
  const createCalls = stubCreate(t);
  const userUpdateCalls = stubUserUpdate(t);

  const res = await request(app).post("/api/onboarding").set(auth).send(body({ age: 15 }));

  assert.equal(res.status, 403);
  assert.equal(res.body.code, "AGE_BELOW_MINIMUM");
  assert.equal(res.body.minimumAge, 16);
  assert.equal(findCalls.length, 0);
  assert.equal(createCalls.length, 0);
  assert.equal(userUpdateCalls.length, 0);
});

test("a first submission missing the age or the gauge is refused, with the keys named", async (t) => {
  stubMethod(t, prisma.onboardingProfile as any, "findUnique", async () => null);
  const createCalls = stubCreate(t);
  const userUpdateCalls = stubUserUpdate(t);
  const { age, selfReportedDailyHours, ...withoutFunnel } = body();

  const res = await request(app).post("/api/onboarding").set(auth).send(withoutFunnel);

  assert.equal(res.status, 400);
  assert.equal(res.body.code, "ONBOARDING_INCOMPLETE");
  // Machine-readable, so the client logs WHICH key its funnel store failed to send
  // instead of retrying a submission that can never succeed.
  assert.deepEqual(res.body.missing, ["age", "selfReportedDailyHours"]);
  assert.equal(createCalls.length, 0);
  assert.equal(userUpdateCalls.length, 0);
});

test("a rename-only edit needs neither the age nor the gauge, and wipes neither", async (t) => {
  // The reinstall case: the account exists server-side, the local funnel store is
  // gone, and GET only ever returned `ageBand` — so the client CANNOT restate `age`.
  // This must still work, and must not touch the two columns it omits.
  const existing = row();
  stubMethod(t, prisma.onboardingProfile as any, "findUnique", async () => existing);
  const updateCalls = stubUpdate(t, existing);
  stubUserUpdate(t);

  const res = await request(app).post("/api/onboarding").set(auth).send({
    clientSubmissionId: "submission-0000-0002",
    funnelVersion: "phone_v6",
    displayName: "Hédi",
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.deduped, false);
  const data = updateCalls[0][0].data as Record<string, unknown>;
  assert.equal(data.displayName, "Hédi");
  assert.equal("ageBand" in data, false);
  assert.equal("selfReportedDailyHours" in data, false);
  // The response still reports the stored answers, untouched.
  assert.equal(res.body.onboarding.ageBand, "25_34");
  assert.equal(res.body.onboarding.selfReportedDailyHours, 6);
  assert.equal(res.body.onboarding.projection.yearsLost, 20);
});

test("an edit that DOES declare an under-age value is still refused", async (t) => {
  // The age gate must not become skippable just because the age is now optional.
  const findCalls = stubMethod(
    t,
    prisma.onboardingProfile as any,
    "findUnique",
    async () => row(),
  );
  const updateCalls = stubMethod(t, prisma.onboardingProfile as any, "update", async () => row());

  const res = await request(app)
    .post("/api/onboarding")
    .set(auth)
    .send({ clientSubmissionId: "submission-0000-0003", funnelVersion: "phone_v6", age: 12 });

  assert.equal(res.status, 403);
  assert.equal(res.body.code, "AGE_BELOW_MINIMUM");
  assert.equal(findCalls.length, 0);
  assert.equal(updateCalls.length, 0);
});

test("unknown answer slugs round-trip and aliases are applied", async (t) => {
  stubMethod(t, prisma.onboardingProfile as any, "findUnique", async () => null);
  const createCalls = stubCreate(t);
  stubUserUpdate(t);

  const res = await request(app)
    .post("/api/onboarding")
    .set(auth)
    .send(body({ profile: "cosmonaut", distractingApps: ["threads", "x"] }));

  assert.equal(res.status, 201);
  const data = createCalls[0][0].data as Record<string, unknown>;
  assert.equal(data.profileSlug, "cosmonaut");
  assert.deepEqual(data.distractingAppSlugs, ["threads", "x_twitter"]);
});

test("a slug that collides with Object.prototype is stored as a plain string", async (t) => {
  // "constructor" passes the answer-slug regex, so a hostile (or unlucky) client can
  // send it. Prototype-chain lookup handed Prisma a FUNCTION here and 500'd the one
  // request that gates the paywall.
  stubMethod(t, prisma.onboardingProfile as any, "findUnique", async () => null);
  const createCalls = stubCreate(t);
  stubUserUpdate(t);

  const res = await request(app)
    .post("/api/onboarding")
    .set(auth)
    .send(body({ profile: "constructor", distractingApps: ["constructor", "instagram"] }));

  assert.equal(res.status, 201);
  const data = createCalls[0][0].data as Record<string, unknown>;
  assert.equal(typeof data.profileSlug, "string");
  assert.equal(data.profileSlug, "constructor");
  assert.deepEqual(data.distractingAppSlugs, ["constructor", "instagram"]);
  assert.equal(res.body.onboarding.profile, "constructor");
  assert.deepEqual(res.body.onboarding.distractingApps, ["constructor", "instagram"]);
});

test("the projection is always server-computed and mismatches are flagged", async (t) => {
  stubMethod(t, prisma.onboardingProfile as any, "findUnique", async () => null);
  stubCreate(t);
  stubUserUpdate(t);

  // 200 is the audit bound zod allows for yearsLost — still a blatant lie at h=6.
  const lying = await request(app)
    .post("/api/onboarding")
    .set(auth)
    .send(
      body({
        selfReportedDailyHours: 6,
        clientProjection: { yearsLost: 200, hoursPerYear: 1, reclaimDaysPerYear: 1 },
      }),
    );
  assert.equal(lying.status, 201);
  assert.deepEqual(lying.body.onboarding.projection, {
    selfReportedDailyHours: 6,
    hoursPerYear: 2190,
    yearsLost: 20,
    reclaimDaysPerYear: 37,
  });
  assert.equal(lying.body.onboarding.projectionMismatch, true);

  const agreeing = await request(app)
    .post("/api/onboarding")
    .set(auth)
    .send(
      body({
        selfReportedDailyHours: 6,
        clientProjection: { yearsLost: 20, hoursPerYear: 2190, reclaimDaysPerYear: 37 },
      }),
    );
  assert.equal(agreeing.body.onboarding.projectionMismatch, false);

  const silent = await request(app).post("/api/onboarding").set(auth).send(body());
  assert.equal(silent.body.onboarding.clientProjection, null);
  assert.equal(silent.body.onboarding.projectionMismatch, false);
});

test("write churn is rate-limited inside the rolling window", async (t) => {
  const existing = row({
    clientSubmissionId: "submission-0000-0001",
    writeWindowStartedAt: new Date(),
    writeWindowCount: 10,
  });
  stubMethod(t, prisma.onboardingProfile as any, "findUnique", async () => existing);
  const updateCalls = stubUpdate(t, existing);
  stubUserUpdate(t);

  const res = await request(app)
    .post("/api/onboarding")
    .set(auth)
    .send(body({ clientSubmissionId: "submission-0000-0011" }));

  assert.equal(res.status, 429);
  assert.equal(res.body.code, "ONBOARDING_RATE_LIMITED");
  assert.equal(updateCalls.length, 0);
});

test("a network retry is never rate-limited", async (t) => {
  const existing = row({
    clientSubmissionId: "submission-0000-0001",
    writeWindowStartedAt: new Date(),
    writeWindowCount: 10,
  });
  stubMethod(t, prisma.onboardingProfile as any, "findUnique", async () => existing);
  const updateCalls = stubUpdate(t, existing);
  stubUserUpdate(t);

  const res = await request(app).post("/api/onboarding").set(auth).send(body());

  assert.equal(res.status, 200);
  assert.equal(res.body.deduped, true);
  assert.equal(updateCalls.length, 0);
});

test("an expired window resets the counter instead of refusing", async (t) => {
  const existing = row({
    clientSubmissionId: "submission-0000-0001",
    writeWindowStartedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
    writeWindowCount: 50,
  });
  stubMethod(t, prisma.onboardingProfile as any, "findUnique", async () => existing);
  const updateCalls = stubUpdate(t, existing);
  stubUserUpdate(t);

  const res = await request(app)
    .post("/api/onboarding")
    .set(auth)
    .send(body({ clientSubmissionId: "submission-0000-0002" }));

  assert.equal(res.status, 200);
  const data = updateCalls[0][0].data as Record<string, unknown>;
  assert.equal(data.writeWindowCount, 1);
  assert.ok(data.writeWindowStartedAt instanceof Date);
});

test("GET returns a null record when the funnel was never submitted", async (t) => {
  stubMethod(t, prisma.onboardingProfile as any, "findUnique", async () => null);
  const res = await request(app).get("/api/onboarding").set(auth);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { onboarding: null });
});

test("GET exposes the wire DTO and no internal column", async (t) => {
  stubMethod(t, prisma.onboardingProfile as any, "findUnique", async () => row());
  const res = await request(app).get("/api/onboarding").set(auth);

  assert.equal(res.status, 200);
  const dto = res.body.onboarding as Record<string, unknown>;
  assert.equal(dto.completedAt, "2026-07-25T09:14:41.812Z");
  assert.equal(dto.updatedAt, "2026-07-25T09:14:41.812Z");
  assert.equal(dto.startedAt, "2026-07-25T09:12:03.000Z");
  assert.equal(dto.ageBand, "25_34");
  assert.deepEqual(dto.distractingApps, ["instagram", "tiktok", "youtube"]);
  assert.ok(dto.projection);
  for (const hidden of [
    "age",
    "userId",
    "id",
    "writeWindowCount",
    "writeWindowStartedAt",
    "clientSubmissionId",
  ]) {
    assert.equal(hidden in dto, false, `${hidden} must not be published`);
  }
});

test("the funnel POST works with no device header", async (t) => {
  // Regression guard: requireBoundDevice must never be added to this route — the
  // funnel's first authenticated call happens before the device is registered.
  stubMethod(t, prisma.onboardingProfile as any, "findUnique", async () => null);
  stubCreate(t);
  stubUserUpdate(t);

  const res = await request(app).post("/api/onboarding").set(auth).send(body());
  assert.equal(res.status, 201);
  assert.equal(res.body.deduped, false);
});
