import assert from "node:assert/strict";
import { test } from "node:test";
import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { env } from "./env";
import { sendTrialReminders } from "./trial-reminders";
import { sendTrialEndingReminder, trialEndParts } from "./resend";
import { stubNoBillingHolds } from "../routes/test-helpers";

/*
 * The trial-end reminder cron: one email (and one push) per (user, trial end),
 * decided by the ENTITLEMENT RESOLVER rather than by whichever row nominated
 * the candidate.
 *
 * What these tests pin, in order of what it costs to lose:
 *
 *  - once and ONLY once per (user, trial end), across repeated runs — the
 *    marker is durable, so an hourly cron inside a day-wide window cannot
 *    become two dozen copies of the same email;
 *  - a failed send marks NOTHING, so the reminder stays owed and the next run
 *    retries — the opposite order (mark, then send) silently drops it;
 *  - only `trialing` accounts are mailed: a lifetime owner or a comped account
 *    whose old trial row happens to end today must never be told a payment is
 *    coming;
 *  - the window's edges: ends-in-hours is reminded, ends-in-days and
 *    already-ended are not;
 *  - the copy carries the DATE and the TIME — the sentence is about an instant
 *    money moves, and "soon" is not an instant.
 *
 * No test database (house pattern): Prisma methods are monkey-patched per test
 * and the mailer + Expo push are intercepted at the `fetch` seam, exactly as
 * contact.test.ts does for Resend. The stubs apply the queries' own range
 * filters — a stub that ignored `gt`/`lte` would let the boundary tests pass
 * against a cron that reminds everyone.
 */

stubNoBillingHolds();

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

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

function setEnv(t: Ctx, patch: Record<string, unknown>) {
  const before: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    before[k] = (env as any)[k];
    (env as any)[k] = v;
  }
  t.after(() => {
    for (const [k, v] of Object.entries(before)) (env as any)[k] = v;
  });
}

type WorldUser = {
  id: string;
  email: string;
  locale?: string | null;
  /** The legacy per-account stamp (pre-ledger cohort). */
  legacyTrialEndsAt?: Date | null;
  /** The machine trial's ledger claim. */
  claimEndsAt?: Date | null;
  compActive?: boolean;
  purchases?: Array<{ isRefunded: boolean; provider: string }>;
  subscriptions?: Array<Record<string, any>>;
  pushTokens?: string[];
};

/** A live Lemon Squeezy trial row, with every column the eligibility select reads. */
function lsTrialSub(userId: string, endsAt: Date, over: Record<string, any> = {}) {
  const written = new Date(endsAt.getTime() - 3 * DAY);
  return {
    userId,
    externalId: `sub-${userId}`,
    provider: "lemonsqueezy",
    status: "on_trial",
    interval: "monthly",
    variantId: "111",
    validUntil: endsAt,
    trialEndsAt: endsAt,
    renewsAt: null,
    endsAt: null,
    trialCancelledAt: null,
    pauseMode: null,
    providerUpdatedAt: written,
    createdAt: written,
    updatedAt: written,
    willRenew: null,
    customerPortalUrl: null,
    updatePaymentUrl: null,
    testMode: false,
    ...over,
  };
}

type CapturedEmail = { to: string; subject: string; html: string; text: string };
type CapturedPush = { to: string; title: string; body: string };

/**
 * An in-memory world for the whole flow: the three candidate queries, the
 * resolver's reads, the dedupe marker, the push tokens, and the two outbound
 * `fetch` destinations (Resend, Expo). Markers persist across runs within one
 * test, which is what makes "run it twice" mean something.
 */
function stubWorld(t: Ctx, users: WorldUser[], opts: { emailFails?: () => boolean } = {}) {
  setEnv(t, { resendApiKey: "test-resend-key" });
  const byId = new Map(users.map((u) => [u.id, u]));
  const markers = new Map<string, { userId: string; endsAt: Date; channels: string | null }>();
  const markerKey = (userId: string, endsAt: Date) => `${userId}|${endsAt.toISOString()}`;
  const deliveries: Array<{ userId: string | null; dedupeKey: string | null }> = [];
  const emails: CapturedEmail[] = [];
  const pushes: CapturedPush[] = [];

  const inRange = (d: Date | null | undefined, range: { gt?: Date; lte?: Date }) =>
    d != null &&
    (range.gt === undefined || d.getTime() > range.gt.getTime()) &&
    (range.lte === undefined || d.getTime() <= range.lte.getTime());

  // The three candidate queries + the resolver's subscription read, told apart
  // by shape: only the candidate query filters on `status`.
  stubMethod(t, prisma.subscription as any, "findMany", async (args: any) => {
    if (args?.where?.status === "on_trial") {
      return users.flatMap((u) =>
        (u.subscriptions ?? [])
          .filter((s) => s.status === "on_trial" && inRange(s.validUntil, args.where.validUntil))
          .map(() => ({ userId: u.id })),
      );
    }
    return byId.get(args?.where?.userId)?.subscriptions ?? [];
  });
  stubMethod(t, prisma.trialClaim as any, "findMany", async (args: any) =>
    users
      .filter((u) => inRange(u.claimEndsAt, args?.where?.endsAt ?? {}))
      .map((u) => ({ firstUserId: u.id })),
  );
  stubMethod(t, prisma.user as any, "findMany", async (args: any) =>
    users
      .filter((u) => inRange(u.legacyTrialEndsAt, args?.where?.trialEndsAt ?? {}))
      .map((u) => ({ id: u.id })),
  );

  // The resolver's reads (and the email-address lookup, told apart by select).
  stubMethod(t, prisma.user as any, "findUnique", async (args: any) => {
    const u = byId.get(args?.where?.id);
    if (!u) return null;
    if (args?.select?.email) {
      return { email: u.email, onboarding: u.locale === undefined ? null : { locale: u.locale } };
    }
    return {
      trialEndsAt: u.legacyTrialEndsAt ?? null,
      compActive: u.compActive ?? false,
      compedUntil: null,
      accessRevoked: false,
    };
  });
  stubMethod(t, prisma.purchase as any, "findMany", async (args: any) =>
    byId.get(args?.where?.userId)?.purchases ?? [],
  );
  stubMethod(t, prisma.trialClaim as any, "findFirst", async (args: any) => {
    const legs = (args?.where?.OR ?? []) as Array<{ firstUserId?: string }>;
    const userId = legs.find((leg) => leg.firstUserId)?.firstUserId;
    const u = userId ? byId.get(userId) : undefined;
    if (!u?.claimEndsAt) return null;
    return { id: `claim-${u.id}`, endsAt: u.claimEndsAt, trialDays: 14 };
  });
  stubMethod(t, prisma.user as any, "update", async () => ({}));

  // The durable marker: the read, and the race-proof create.
  stubMethod(t, prisma.trialReminderSent as any, "findUnique", async (args: any) => {
    const { userId, endsAt } = args?.where?.userId_endsAt ?? {};
    return markers.get(markerKey(userId, endsAt)) ?? null;
  });
  stubMethod(t, prisma.trialReminderSent as any, "create", async (args: any) => {
    const { userId, endsAt, channels } = args.data;
    const key = markerKey(userId, endsAt);
    if (markers.has(key)) {
      throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "test",
      });
    }
    const row = { userId, endsAt, channels: channels ?? null };
    markers.set(key, row);
    return row;
  });

  // The push leg's reads/writes (deliver()'s own dedupe + audit rows).
  stubMethod(t, prisma.pushToken as any, "findMany", async (args: any) =>
    (byId.get(args?.where?.userId)?.pushTokens ?? []).map((token) => ({ token })),
  );
  stubMethod(t, prisma.notificationDelivery as any, "findMany", async (args: any) =>
    deliveries
      .filter((d) => d.dedupeKey === args?.where?.dedupeKey)
      .map((d) => ({ userId: d.userId })),
  );
  stubMethod(t, prisma.notificationDelivery as any, "createMany", async (args: any) => {
    for (const row of args.data) deliveries.push({ userId: row.userId, dedupeKey: row.dedupeKey });
    return { count: args.data.length };
  });
  stubMethod(t, prisma.pushToken as any, "updateMany", async () => ({ count: 0 }));

  // The two wires out of the process: Resend and the Expo Push API.
  stubMethod(t, globalThis as any, "fetch", async (url: unknown, init: any) => {
    const target = String(url);
    if (target.includes("api.resend.com")) {
      const body = JSON.parse(init.body);
      if (opts.emailFails?.()) {
        return { ok: false, status: 500, json: async () => ({ message: "resend is down" }) };
      }
      emails.push({ to: body.to[0], subject: body.subject, html: body.html, text: body.text });
      return { ok: true, status: 200, json: async () => ({ id: `email_${emails.length}` }) };
    }
    if (target.includes("exp.host")) {
      const messages = JSON.parse(init.body) as Array<{ to: string; title: string; body: string }>;
      for (const m of messages) pushes.push({ to: m.to, title: m.title, body: m.body });
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: messages.map((_, i) => ({ status: "ok", id: `t${i}` })) }),
      };
    }
    throw new Error(`unexpected fetch to ${target}`);
  });

  return { emails, pushes, markers };
}

/* ── once, and only once ─────────────────────────────────────────────────── */

test("an ending trial is reminded by email AND push, once — repeated runs repeat nothing", async (t) => {
  const endsAt = new Date(Date.now() + 2 * HOUR);
  const world = stubWorld(t, [
    {
      id: "507f1f77bcf86cd799439011",
      email: "trialist@example.com",
      subscriptions: [lsTrialSub("507f1f77bcf86cd799439011", endsAt)],
      pushTokens: ["ExponentPushToken[abc]"],
    },
  ]);

  const first = await sendTrialReminders();
  assert.deepEqual(first, {
    candidates: 1,
    sent: 1,
    pushed: 1,
    alreadySent: 0,
    notTrialing: 0,
    failed: 0,
  });
  assert.equal(world.emails.length, 1);
  assert.equal(world.emails[0].to, "trialist@example.com");
  assert.equal(world.pushes.length, 1);
  assert.equal(world.pushes[0].to, "ExponentPushToken[abc]");
  assert.equal([...world.markers.values()][0]?.channels, "email+push");

  // The copy is about an instant: date AND time, in every rendering.
  const { date, time } = trialEndParts(endsAt, false);
  for (const copy of [world.emails[0].subject, world.emails[0].text, world.emails[0].html]) {
    assert.ok(copy.includes(date), `missing date in: ${copy.slice(0, 120)}`);
    assert.ok(copy.includes(time), `missing time in: ${copy.slice(0, 120)}`);
  }
  assert.ok(world.pushes[0].body.includes(date));
  assert.ok(world.pushes[0].body.includes(time));
  // A live LS trial converts: the reminder says a payment is coming, and where
  // to act — it never promises a cancellation this server cannot perform.
  assert.ok(world.emails[0].text.includes("first payment"));
  assert.ok(world.emails[0].text.includes("Manage subscription"));

  // The same cron an hour later: the marker holds, nothing goes out again.
  const second = await sendTrialReminders();
  assert.equal(second.sent, 0);
  assert.equal(second.alreadySent, 1);
  assert.equal(world.emails.length, 1);
  assert.equal(world.pushes.length, 1);
});

/* ── the window's edges ──────────────────────────────────────────────────── */

test("ends-in-hours is reminded; ends-in-days and already-ended are not", async (t) => {
  const world = stubWorld(t, [
    { id: "507f1f77bcf86cd799439021", email: "soon@example.com", claimEndsAt: new Date(Date.now() + 2 * HOUR) },
    { id: "507f1f77bcf86cd799439022", email: "later@example.com", claimEndsAt: new Date(Date.now() + 3 * DAY) },
    { id: "507f1f77bcf86cd799439023", email: "over@example.com", claimEndsAt: new Date(Date.now() - HOUR) },
  ]);

  const report = await sendTrialReminders();
  assert.equal(report.candidates, 1); // the range is applied by the QUERY, not by luck
  assert.equal(report.sent, 1);
  assert.deepEqual(
    world.emails.map((e) => e.to),
    ["soon@example.com"],
  );
  // A machine trial has no card on file: access ends, no payment is threatened.
  assert.ok(world.emails[0].text.includes("no payment will be taken"));
  assert.ok(world.emails[0].text.includes("choose a plan"));
});

test("the resolver's end decides, not the nominating row", async (t) => {
  // The legacy stamp ends within the window, but the ledger claim — which the
  // resolver ranks above it — runs three more days. Reminding now would name a
  // date the account is not actually ending on.
  const world = stubWorld(t, [
    {
      id: "507f1f77bcf86cd799439031",
      email: "extended@example.com",
      legacyTrialEndsAt: new Date(Date.now() + 2 * HOUR),
      claimEndsAt: new Date(Date.now() + 3 * DAY),
    },
  ]);

  const report = await sendTrialReminders();
  assert.equal(report.candidates, 1);
  assert.equal(report.sent, 0);
  assert.equal(report.notTrialing, 1);
  assert.equal(world.emails.length, 0);
});

/* ── a failed send stays owed ────────────────────────────────────────────── */

test("an email failure marks nothing sent — the next run retries and succeeds", async (t) => {
  let mailerDown = true;
  const endsAt = new Date(Date.now() + 5 * HOUR);
  const world = stubWorld(
    t,
    [
      {
        id: "507f1f77bcf86cd799439041",
        email: "retry@example.com",
        claimEndsAt: endsAt,
        pushTokens: ["ExponentPushToken[xyz]"],
      },
    ],
    { emailFails: () => mailerDown },
  );

  const quiet = console.warn;
  console.warn = () => {};
  t.after(() => {
    console.warn = quiet;
  });

  const first = await sendTrialReminders();
  assert.equal(first.failed, 1);
  assert.equal(first.sent, 0);
  assert.equal(world.markers.size, 0); // nothing durable about a send that never happened
  assert.equal(world.pushes.length, 0); // the push waits for the durable leg too

  mailerDown = false;
  const second = await sendTrialReminders();
  assert.equal(second.sent, 1);
  assert.equal(second.failed, 0);
  assert.equal(world.emails.length, 1);
  assert.equal(world.markers.size, 1);
});

/* ── only trialing accounts ──────────────────────────────────────────────── */

test("paid and comped accounts are never mailed, even when an old trial row ends today", async (t) => {
  const soon = new Date(Date.now() + 2 * HOUR);
  const world = stubWorld(t, [
    {
      // A lifetime owner whose spent machine trial happens to end today.
      id: "507f1f77bcf86cd799439051",
      email: "lifetime@example.com",
      claimEndsAt: soon,
      purchases: [{ isRefunded: false, provider: "lemonsqueezy" }],
    },
    {
      // A comped account inside the same window.
      id: "507f1f77bcf86cd799439052",
      email: "comped@example.com",
      claimEndsAt: soon,
      compActive: true,
    },
  ]);

  const report = await sendTrialReminders();
  assert.equal(report.candidates, 2);
  assert.equal(report.notTrialing, 2);
  assert.equal(report.sent, 0);
  assert.equal(world.emails.length, 0);
  assert.equal(world.pushes.length, 0);
});

/* ── the copy itself (the mailer, at the fetch seam) ─────────────────────── */

function captureEmail(t: Ctx) {
  setEnv(t, { resendApiKey: "test-resend-key" });
  const sent: CapturedEmail[] = [];
  stubMethod(t, globalThis as any, "fetch", async (_url: unknown, init: any) => {
    const body = JSON.parse(init.body);
    sent.push({ to: body.to[0], subject: body.subject, html: body.html, text: body.text });
    return { ok: true, status: 200, json: async () => ({ id: "email_1" }) };
  });
  return sent;
}

test("a French speaker reads the reminder in French, date and time included", async (t) => {
  const sent = captureEmail(t);
  const endsAt = new Date("2026-08-17T14:30:00.000Z");

  const result = await sendTrialEndingReminder("fr@example.com", {
    endsAt,
    willRenew: false,
    billingProvider: "NONE",
    locale: "fr-CH",
  });

  assert.equal(result.ok, true);
  const { date, time } = trialEndParts(endsAt, true);
  assert.ok(date.includes("août")); // the French formatter, not the English one
  for (const copy of [sent[0].subject, sent[0].text, sent[0].html]) {
    assert.ok(copy.includes(date), `missing date in: ${copy.slice(0, 120)}`);
    assert.ok(copy.includes(time), `missing time in: ${copy.slice(0, 120)}`);
  }
  assert.ok(sent[0].text.includes("aucun paiement"));
  assert.ok(sent[0].text.includes("choisissez une formule"));
});

test("an Apple trial that will not renew points at Apple's own settings — and promises nothing we cannot do", async (t) => {
  const sent = captureEmail(t);
  const endsAt = new Date("2026-08-17T09:00:00.000Z");

  await sendTrialEndingReminder("apple@example.com", {
    endsAt,
    willRenew: false,
    billingProvider: "APPLE",
    locale: "en-US",
  });

  assert.ok(sent[0].text.includes("no payment will be taken"));
  assert.ok(sent[0].text.includes("turn renewal back on"));
  assert.ok(sent[0].text.includes("Subscriptions"));
});

test("an Apple trial that WILL convert says a payment is coming and that only Apple can change it", async (t) => {
  const sent = captureEmail(t);

  await sendTrialEndingReminder("apple@example.com", {
    endsAt: new Date("2026-08-17T09:00:00.000Z"),
    willRenew: true,
    billingProvider: "APPLE",
  });

  assert.ok(sent[0].text.includes("first payment"));
  assert.ok(sent[0].text.includes("we cannot cancel an Apple subscription for you"));
});
