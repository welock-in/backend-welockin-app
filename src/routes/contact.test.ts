import assert from "node:assert/strict";
import { test } from "node:test";
import request from "supertest";
import { createApp } from "../app";
import { prisma } from "../lib/prisma";
import { env } from "../lib/env";

/*
 * The contact form: one public POST that forwards a message to the support
 * inbox. Small surface, but every branch is a promise to someone:
 *
 *  - the mail must arrive at the inbox with `reply_to` set to the SUBMITTER,
 *    because "just press reply" is the entire ergonomic point;
 *  - a dev environment without RESEND_API_KEY must still answer 200 (with
 *    `delivered: false`), or the form on the site breaks locally;
 *  - a REAL delivery failure must be a loud 502 that names the fallback
 *    address, never a quiet 200 that swallows the message.
 *
 * Same harness as auth-email.test.ts: no test database, Prisma methods are
 * monkey-patched per test, and the mailer is intercepted at the `fetch` seam —
 * which captures the exact bytes Resend would have received (recipient,
 * subject, reply_to), strictly more than a function stub would see.
 */

// Rate limiting off for the FILE (the flag is read at call time); the one test
// that is ABOUT the limiter turns it back on and stubs the throttle table.
(env as { authRateLimitDisabled: boolean }).authRateLimitDisabled = true;

const app = createApp();

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

/** Pin an env flag for one test and put it back. Flags are read at call time. */
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

/**
 * The mailer, intercepted at the only seam that exists (see the long note in
 * auth-email.test.ts): `send()` reads `env.resendApiKey` at call time and then
 * calls the global `fetch`, so a key plus a fetch swap captures the wire bytes.
 * This one also keeps `reply_to`, which is the field under test here.
 */
type SentMail = { to: string; subject: string; html: string; text: string; replyTo?: string };

function mailbox(t: Ctx): SentMail[] {
  const sent: SentMail[] = [];
  const beforeKey = env.resendApiKey;
  (env as { resendApiKey: string }).resendApiKey = "test-resend-key";
  const originalFetch = globalThis.fetch;

  (globalThis as any).fetch = async (_url: unknown, init: { body: string }) => {
    const body = JSON.parse(init.body) as {
      to: string[];
      subject: string;
      html: string;
      text: string;
      reply_to?: string;
    };
    sent.push({
      to: body.to[0],
      subject: body.subject,
      html: body.html,
      text: body.text,
      replyTo: body.reply_to,
    });
    return { ok: true, status: 200, json: async () => ({ id: "test-email-id" }) };
  };

  t.after(() => {
    (env as { resendApiKey: string }).resendApiKey = beforeKey;
    (globalThis as any).fetch = originalFetch;
  });
  return sent;
}

/** A Resend that is configured and DOWN — every send answers HTTP 500. */
function brokenMailer(t: Ctx) {
  const beforeKey = env.resendApiKey;
  (env as { resendApiKey: string }).resendApiKey = "test-resend-key";
  const originalFetch = globalThis.fetch;
  (globalThis as any).fetch = async () => ({
    ok: false,
    status: 500,
    json: async () => ({ message: "resend is on fire" }),
  });
  t.after(() => {
    (env as { resendApiKey: string }).resendApiKey = beforeKey;
    (globalThis as any).fetch = originalFetch;
  });
}

type Row = Record<string, any>;

/**
 * AuthThrottle, honouring the filters `consumeRateLimit` actually sends: the
 * conditional `updateMany` bumps only a row whose window is still open, the
 * `upsert` opens one, and the `findUnique` reads the count back.
 */
function fakeThrottle(t: Ctx, seed: Row[] = []) {
  const store: Row[] = seed.map((r) => ({ count: 0, windowStartedAt: new Date(), ...r }));

  stubMethod(t, prisma.authThrottle as any, "updateMany", async (args: any) => {
    const w = args?.where ?? {};
    let matches = store.filter((r) => r.key === w.key);
    if (w.windowStartedAt?.gt) {
      matches = matches.filter(
        (r) => r.windowStartedAt.getTime() > w.windowStartedAt.gt.getTime(),
      );
    }
    for (const row of matches) row.count += args.data.count.increment;
    return { count: matches.length };
  });

  stubMethod(t, prisma.authThrottle as any, "upsert", async (args: any) => {
    const existing = store.find((r) => r.key === args.where.key);
    if (existing) {
      Object.assign(existing, args.update);
      return { ...existing };
    }
    const row = { ...args.create };
    store.push(row);
    return { ...row };
  });

  stubMethod(t, prisma.authThrottle as any, "findUnique", async (args: any) => {
    const row = store.find((r) => r.key === args.where.key);
    return row ? { ...row } : null;
  });

  return store;
}

const VALID = {
  name: "Ada Lovelace",
  email: "Ada@Example.com", // mixed case on purpose — emailRule must normalise it
  topic: "billing",
  message: "My invoice from last month never arrived, could you resend it?",
};

/* ── the tests ────────────────────────────────────────────────────────────── */

test("a valid submission lands in the inbox with reply_to pointed at the submitter", async (t) => {
  const mail = mailbox(t);

  const res = await request(app).post("/api/contact").send(VALID);

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true }, "no `delivered: false` on the happy path");
  assert.equal(mail.length, 1);
  assert.equal(mail[0].to, "hello@welock.in", "the form delivers to the support inbox");
  assert.equal(
    mail[0].replyTo,
    "ada@example.com",
    "reply_to is the submitter's NORMALISED address — support just presses reply",
  );
  assert.equal(mail[0].subject, "[billing] Contact form — Ada Lovelace <ada@example.com>");
  assert.ok(mail[0].text.includes(VALID.message), "the message rides in the text body");
});

/*
 * The message is the first email body in lib/resend.ts AUTHORED BY the sender —
 * every other mail interpolates only server-generated values. Without escaping,
 * anyone could inject markup into the mail the support inbox renders.
 */
test("user-authored markup arrives escaped in the HTML body", async (t) => {
  const mail = mailbox(t);

  const res = await request(app)
    .post("/api/contact")
    .send({ ...VALID, message: `<script>alert("pwned")</script> please help me` });

  assert.equal(res.status, 200);
  assert.ok(!mail[0].html.includes("<script>"), "no live tags from the submitter");
  assert.ok(mail[0].html.includes("&lt;script&gt;"), "the text survives, defanged");
});

test("a message under 10 characters is a 400 that never costs an email", async (t) => {
  const mail = mailbox(t);

  const res = await request(app)
    .post("/api/contact")
    .send({ ...VALID, message: "too short" }); // 9 characters

  assert.equal(res.status, 400);
  assert.match(res.body.error, /message/i);
  assert.equal(mail.length, 0, "validation rejects before the mailer is ever reached");
});

test("the sixth submission from one IP inside the hour is a 429, and sends nothing", async (t) => {
  setEnv(t, { authRateLimitDisabled: false });
  const mail = mailbox(t);
  // The row is already AT the cap (max 5): this request bumps it over.
  fakeThrottle(t, [{ key: "contact:ip:203.0.113.9", count: 5, windowStartedAt: new Date() }]);

  const res = await request(app)
    .post("/api/contact")
    .set("x-real-ip", "203.0.113.9")
    .send(VALID);

  assert.equal(res.status, 429);
  assert.equal(mail.length, 0, "a throttled request must not still cost a send");
});

test("a real Resend failure is a loud 502 that names the fallback address", async (t) => {
  brokenMailer(t);

  const res = await request(app).post("/api/contact").send(VALID);

  assert.equal(res.status, 502);
  assert.equal(res.body.code, "CONTACT_DELIVERY_FAILED", "the client branches on the code");
  assert.match(
    res.body.error,
    /hello@welock\.in/,
    "the sender is told where to write instead — this message may be their only channel",
  );
});

/*
 * A dev machine without RESEND_API_KEY must not present a broken contact form —
 * but the response must not pretend delivery happened either. `delivered: false`
 * is the honest middle.
 */
test("with no RESEND_API_KEY the form still answers 200, marked undelivered", async (t) => {
  setEnv(t, { resendApiKey: "" });
  const fetchCalls: unknown[] = [];
  const originalFetch = globalThis.fetch;
  (globalThis as any).fetch = async (...args: unknown[]) => {
    fetchCalls.push(args);
    throw new Error("nothing should reach the network");
  };
  t.after(() => {
    (globalThis as any).fetch = originalFetch;
  });

  const res = await request(app).post("/api/contact").send(VALID);

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, delivered: false });
  assert.equal(fetchCalls.length, 0, "skipped means skipped — no request went out");
});
