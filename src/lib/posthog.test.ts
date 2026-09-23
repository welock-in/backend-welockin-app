import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";

import { env } from "./env";
import { capture, eventUuid, resetPostHogWarnLatchForTests } from "./posthog";

/**
 * The server-side emitter.
 *
 * The load-bearing test in this file is the first one. Both webhook suites
 * replace `globalThis.fetch` and then assert on the exact number of calls a
 * delivery makes — "one delivery's worth of API traffic, not two". If this
 * module ever reaches fetch with no key configured, it does not fail its own
 * tests: it fails theirs, in a way that reads as a RevenueCat bug.
 */

type Call = { url: string; init: RequestInit };

/** Patch a method in place and restore it after the test. Same shape as the
 *  `stubMethod` the webhook suites use — no module mocking anywhere in this repo. */
function stubFetch(t: TestContext, respond: () => Promise<Response> | Response): Call[] {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return respond();
  }) as unknown as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  return calls;
}

/** Patch the `env` object in place — it is mutable by design (env.ts blanks
 *  keys after validation) and this is how every other suite here does it. */
function setEnv(t: TestContext, values: Record<string, unknown>): void {
  const target = env as unknown as Record<string, unknown>;
  const previous: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = target[key];
    target[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) target[key] = value;
  });
}

function quiet(t: TestContext): void {
  const warn = console.warn;
  const error = console.error;
  console.warn = () => {};
  console.error = () => {};
  t.after(() => {
    console.warn = warn;
    console.error = error;
  });
}

const ok = () => new Response("1", { status: 200 });

const base = {
  event: "purchase_completed" as const,
  distinctId: "65f1a2b3c4d5e6f708192a3b",
  dedupeKey: "ls:order:9090213",
  timestamp: new Date("2026-08-17T10:00:00.000Z"),
};

/* ── the one that protects the other suites ─────────────────────────────── */

test("with no key configured, fetch is never reached", async (t) => {
  quiet(t);
  resetPostHogWarnLatchForTests();
  setEnv(t, { posthogApiKey: "" });
  const calls = stubFetch(t, ok);

  const result = await capture({ ...base, properties: { plan: "lifetime" } });

  assert.equal(calls.length, 0, "an unconfigured emitter must be invisible to fetch-counting tests");
  assert.deepEqual(result, { ok: false, skipped: true, reason: "not_configured" });
});

test("the missing-key warning fires once per instance, not once per event", async (t) => {
  setEnv(t, { posthogApiKey: "" });
  resetPostHogWarnLatchForTests();
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (msg: string) => warnings.push(String(msg));
  t.after(() => {
    console.warn = warn;
  });

  await capture(base);
  await capture(base);
  await capture(base);

  // A webhook emits several events. One log line per event would bury the
  // Vercel output for a condition that is the same every time.
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /POSTHOG_API_KEY not set/);
});

/* ── the wire format ────────────────────────────────────────────────────── */

test("a configured emitter posts the documented capture shape", async (t) => {
  setEnv(t, { posthogApiKey: "phc_test", posthogHost: "https://us.i.posthog.com" });
  const calls = stubFetch(t, ok);

  const result = await capture({ ...base, properties: { plan: "lifetime", revenue_usd: 22.92 } });

  assert.deepEqual(result, { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://us.i.posthog.com/i/v0/e/");
  assert.equal(calls[0]!.init.method, "POST");

  const body = JSON.parse(String(calls[0]!.init.body));
  assert.equal(body.api_key, "phc_test");
  assert.equal(body.event, "purchase_completed");
  assert.equal(body.distinct_id, "65f1a2b3c4d5e6f708192a3b");
  assert.equal(body.timestamp, "2026-08-17T10:00:00.000Z");
  assert.match(body.uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.deepEqual(body.properties, { plan: "lifetime", revenue_usd: 22.92 });
});

test("a host pasted with its trailing slash does not mint a double slash", async (t) => {
  // env.ts strips it at read time; this pins that the emitter relies on that and
  // does not add a slash of its own.
  setEnv(t, { posthogApiKey: "phc_test", posthogHost: "https://us.i.posthog.com" });
  const calls = stubFetch(t, ok);
  await capture(base);
  assert.ok(!calls[0]!.url.includes("//i/v0"), calls[0]!.url);
});

/* ── deduplication ──────────────────────────────────────────────────────── */

test("the uuid is deterministic, versioned, and specific to the key", () => {
  const a = eventUuid("ls:order:9090213");
  assert.equal(a, eventUuid("ls:order:9090213"), "a redelivery must produce the same uuid");
  assert.notEqual(a, eventUuid("ls:order:9090214"));
  assert.notEqual(a, eventUuid("ls:sub:9090213"));
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("a redelivery re-sends a byte-identical dedup quadruple", async (t) => {
  // THE POINT OF THE WHOLE FILE. PostHog dedupes on (uuid, event, timestamp,
  // distinct_id) and buckets the timestamp by calendar day. Lemon Squeezy retries
  // with a backoff measured in hours — so the second delivery routinely lands the
  // next morning. If the timestamp came from the clock instead of the provider,
  // the two copies would stop matching and the order would count twice.
  setEnv(t, { posthogApiKey: "phc_test", posthogHost: "https://us.i.posthog.com" });
  const calls = stubFetch(t, ok);

  await capture(base);
  await capture(base); // same provider event, replayed a day later

  const first = JSON.parse(String(calls[0]!.init.body));
  const second = JSON.parse(String(calls[1]!.init.body));
  assert.equal(first.uuid, second.uuid);
  assert.equal(first.event, second.event);
  assert.equal(first.timestamp, second.timestamp);
  assert.equal(first.distinct_id, second.distinct_id);
});

/* ── the anonymity contract, enforced at the wire ───────────────────────── */

test("forbidden properties are stripped, and the rest still goes", async (t) => {
  quiet(t);
  setEnv(t, { posthogApiKey: "phc_test", posthogHost: "https://us.i.posthog.com" });
  const calls = stubFetch(t, ok);

  await capture({
    ...base,
    properties: {
      plan: "lifetime",
      revenue_usd: 22.92,
      email: "hedi@example.com",
      checkout_url: "https://the-hnh.lemonsqueezy.com/checkout/…",
    },
  });

  const body = JSON.parse(String(calls[0]!.init.body));
  // Stripped, not dropped: the leak never leaves the process AND the revenue
  // reconciliation stays whole. Dropping the event would trade one failure for
  // another.
  assert.deepEqual(body.properties, { plan: "lifetime", revenue_usd: 22.92 });
});

test("the offending KEYS are logged, never their values", async (t) => {
  setEnv(t, { posthogApiKey: "phc_test", posthogHost: "https://us.i.posthog.com" });
  stubFetch(t, ok);
  const errors: string[] = [];
  const error = console.error;
  console.error = (msg: string) => errors.push(String(msg));
  t.after(() => {
    console.error = error;
  });

  await capture({ ...base, properties: { email: "hedi@example.com" } });

  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /email/);
  // Logging the value would put the very thing we just refused to send into the
  // log instead.
  assert.ok(!errors[0]!.includes("hedi@example.com"), errors[0]);
});

/* ── never fatal to the caller ──────────────────────────────────────────── */

test("a thrown fetch is swallowed", async (t) => {
  quiet(t);
  setEnv(t, { posthogApiKey: "phc_test", posthogHost: "https://us.i.posthog.com" });
  stubFetch(t, () => {
    throw new Error("posthog down");
  });

  // Not `assert.rejects` — the point is that it resolves. A throw here would
  // become a 500 in a webhook, and a 500 is an instruction to redeliver.
  const result = await capture(base);
  assert.deepEqual(result, { ok: false, skipped: false, reason: "network" });
});

test("a rejected promise is swallowed too", async (t) => {
  quiet(t);
  setEnv(t, { posthogApiKey: "phc_test", posthogHost: "https://us.i.posthog.com" });
  stubFetch(t, () => Promise.reject(new Error("ECONNRESET")));
  assert.deepEqual(await capture(base), { ok: false, skipped: false, reason: "network" });
});

test("a non-2xx is reported without echoing the body", async (t) => {
  setEnv(t, { posthogApiKey: "phc_test", posthogHost: "https://us.i.posthog.com" });
  stubFetch(t, () => new Response("the key phc_test is invalid", { status: 401 }));
  const errors: string[] = [];
  const error = console.error;
  console.error = (msg: string) => errors.push(String(msg));
  t.after(() => {
    console.error = error;
  });

  const result = await capture(base);

  assert.deepEqual(result, { ok: false, skipped: false, reason: "http" });
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /HTTP 401/);
  // The request carried the project key; this repo never echoes such an error
  // verbatim.
  assert.ok(!errors[0]!.includes("phc_test"), errors[0]);
});

test("an empty distinct_id is refused before the network", async (t) => {
  setEnv(t, { posthogApiKey: "phc_test", posthogHost: "https://us.i.posthog.com" });
  const calls = stubFetch(t, ok);

  // PostHog answers 200 to an empty distinct_id and files the event under a
  // phantom person. Silence is better than a lie.
  const result = await capture({ ...base, distinctId: "" });

  assert.deepEqual(result, { ok: false, skipped: true, reason: "no_distinct_id" });
  assert.equal(calls.length, 0);
});

test("the key is read at call time, not captured at import", async (t) => {
  // env mutates itself after validation, and every suite here patches it in
  // place after the modules have loaded. A module-level const would be frozen.
  quiet(t);
  resetPostHogWarnLatchForTests();
  setEnv(t, { posthogApiKey: "" });
  const calls = stubFetch(t, ok);

  await capture(base);
  assert.equal(calls.length, 0);

  (env as unknown as Record<string, unknown>).posthogApiKey = "phc_late";
  await capture(base);
  assert.equal(calls.length, 1, "switching the key on must take effect immediately");
});
