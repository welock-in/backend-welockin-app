import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test, before, after } from "node:test";
import request from "supertest";
import { startMongo, stopMongo, runId } from "./harness";

/**
 * One payable acquisition per account, proved against a real replica set.
 *
 * `POST /api/checkout` mints a hosted Lemon Squeezy payment URL. It creates no
 * subscription and — before this file existed — reserved nothing, so two tabs,
 * two devices or two Vercel instances could each mint a URL and a customer who
 * paid both ended up with two subscriptions. An in-memory guard or a disabled
 * button cannot close that: the two requests need not share a process.
 *
 * So the invariant lives in MongoDB, and these tests drive the real Express app
 * over real HTTP against a real database, releasing both requests from a barrier
 * so they genuinely collide. Every scenario asserts the EXACT number of provider
 * creation calls, because "no trial was granted" is not the same claim as "only
 * one checkout exists".
 */

let prisma: any;
let app: any;
let signToken: (p: { sub: string; email: string }) => string;

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-08-11T12:00:00.000Z");
const at = (days: number) => new Date(NOW.getTime() + days * DAY);

const STORE = "364783";
const V_MONTHLY = "1986433";
const V_YEARLY = "1986420";
const V_LIFETIME = "1960881";

before(async () => {
  await startMongo();
  process.env.LEMONSQUEEZY_API_KEY = "test-key";
  process.env.LEMONSQUEEZY_WEBHOOK_SECRET = "whsec-lock-test";
  process.env.LEMONSQUEEZY_STORE_ID = STORE;
  process.env.LEMONSQUEEZY_VARIANT_MONTHLY = V_MONTHLY;
  process.env.LEMONSQUEEZY_VARIANT_YEARLY = V_YEARLY;
  process.env.LEMONSQUEEZY_VARIANT_ID = V_LIFETIME;
  process.env.EMAIL_VERIFICATION_ENFORCED = "false";

  const [p, a, jwt] = await Promise.all([
    import("../../src/lib/prisma"),
    import("../../src/app"),
    import("../../src/lib/jwt"),
  ]);
  prisma = p.prisma;
  app = a.createApp();
  signToken = jwt.signToken;
});

after(async () => {
  await prisma?.$disconnect();
  await stopMongo();
});

// ── fixtures ─────────────────────────────────────────────────────────────────

let seq = 0;

async function makeAccount(tag: string) {
  const n = ++seq;
  const user = await prisma.user.create({
    data: { email: `qa-${runId}-${tag}-${n}@example.test`, plan: "free", emailVerified: true },
  });
  return {
    user,
    auth: { Authorization: `Bearer ${signToken({ sub: user.id, email: user.email })}` },
  };
}

function silenceErrors(t: any) {
  const real = console.error;
  console.error = () => {};
  t.after(() => {
    console.error = real;
  });
}

/**
 * Hold every arrival until `n` are waiting, then release together.
 *
 * Left to chance the two requests serialise and the second simply reads the
 * first one's state — a green test that never touched the race it claims to
 * cover. The barrier sits inside the provider stub, which is the last thing
 * either request does before it would create a checkout.
 */
function barrier(n: number, maxWaitMs = 250) {
  let seen = 0;
  let open!: () => void;
  const gate = new Promise<void>((r) => {
    open = r;
  });
  // ALSO opens on a timer, and that is not a hedge. Once the lock works only ONE
  // request reaches the provider, so a barrier waiting for two arrivals would
  // hang for ever — the test would fail on a timeout instead of on the thing it
  // measures. The timer keeps the first caller inside the provider call while
  // the second contends for the lock, which is the overlap that matters.
  const timer = setTimeout(() => open(), maxWaitMs);
  return async () => {
    if (++seen >= n) {
      clearTimeout(timer);
      open();
    }
    await gate;
  };
}

/**
 * A provider that records every creation call and can be synchronised.
 *
 * `calls` is the number that matters in every test here: the invariant is about
 * how many checkouts exist at Lemon Squeezy, not about what our own rows say.
 */
function stubProvider(
  t: any,
  opts: { arrive?: () => Promise<void>; respond?: (n: number) => any } = {},
) {
  const calls: any[] = [];
  const real = globalThis.fetch;
  (globalThis as any).fetch = async (_url: any, init: any) => {
    const n = calls.length;
    calls.push(JSON.parse(init.body));
    if (opts.arrive) await opts.arrive();
    if (opts.respond) return opts.respond(n);
    return {
      ok: true,
      status: 201,
      json: async () => ({
        data: {
          id: `chk_${runId}_${n}`,
          attributes: { url: `https://ls.test/checkout/${n}`, expires_at: null },
        },
      }),
    };
  };
  t.after(() => {
    (globalThis as any).fetch = real;
  });
  return calls;
}

/**
 * Forget the rate-limit counters between rounds.
 *
 * The checkout route caps 60 requests per IP per five minutes, and every request
 * in this file comes from 127.0.0.1 — so forty racing rounds exhaust the budget
 * and the suite starts measuring the throttle instead of the lock. Cleared
 * rather than worked around by racing less: the ten rounds are what make an
 * accidental serialisation unlikely.
 */
async function forgetRateLimits() {
  await prisma.authThrottle.deleteMany({});
}

const checkoutRaw = (auth: any, plan: string, body: Record<string, unknown> = {}) =>
  request(app).post("/api/checkout").set(auth).send({ plan, ...body });

/** Every request here comes from 127.0.0.1; keep the IP budget out of the way. */
const checkout = async (auth: any, plan: string, body: Record<string, unknown> = {}) => {
  await forgetRateLimits();
  return checkoutRaw(auth, plan, body);
};

// ── §3 — the race, before anything guards it ─────────────────────────────────

/**
 * Every pair of plans, raced ten times each.
 *
 * The pairings matter separately because the invariant spans them: monthly and
 * yearly are both recurring, but lifetime is a different product on a different
 * code path, and a lock that only covered subscriptions would let someone hold a
 * payable monthly link and a payable lifetime link at the same time.
 */
const PAIRS = [
  ["monthly", "yearly"],
  ["monthly", "lifetime"],
  ["yearly", "lifetime"],
  ["monthly", "monthly"],
] as const;

for (const [a, b] of PAIRS) {
  test(`ten synchronised ${a} vs ${b} checkouts create exactly one`, async (t) => {
    silenceErrors(t);

    for (let round = 0; round < 10; round++) {
      await forgetRateLimits();
      const account = await makeAccount(`race-${a}-${b}`);
      const arrive = barrier(2);
      const calls = stubProvider(t, { arrive });

      const [ra, rb] = await Promise.all([
        checkout(account.auth, a),
        checkout(account.auth, b),
      ]);

      assert.equal(
        calls.length,
        1,
        `round ${round}: exactly one checkout may exist at the provider, got ${calls.length}`,
      );

      const statuses = [ra.status, rb.status].sort();
      assert.ok(
        statuses[0] === 201,
        `round ${round}: one caller must succeed — got ${JSON.stringify(statuses)} / ${ra.text} / ${rb.text}`,
      );

      // Exactly one winner in every pairing, including same-plan. A request that
      // arrives while another is mid-flight cannot be handed a link that does not
      // exist yet, so it is told to come back — and the reuse path below covers
      // the case the spec actually names, a checkout that is already ready.
      const winners = [ra, rb].filter((r) => r.status === 201);
      const losers = [ra, rb].filter((r) => r.status !== 201);
      assert.equal(winners.length, 1, `round ${round}: ${ra.text} / ${rb.text}`);
      assert.equal(losers[0].status, 409, `round ${round}: ${losers[0].text}`);
      assert.equal(losers[0].body.code, "CHECKOUT_IN_PROGRESS", `round ${round}`);

      // And once it IS ready, asking again for the same plan reuses it rather
      // than minting a second — no provider call at all.
      const wonPlan = winners[0] === ra ? a : b;
      const again = await checkout(account.auth, wonPlan);
      assert.equal(again.status, 201, `round ${round}: reuse — ${again.text}`);
      assert.equal(again.body.reused, true, `round ${round}: reused flag`);
      assert.equal(again.body.url, winners[0].body.url, `round ${round}: the same link`);
      assert.equal(calls.length, 1, `round ${round}: reuse must not call the provider`);

      // And nothing about racing may hand out a trial or a subscription.
      assert.equal(
        await prisma.subscription.count({ where: { userId: account.user.id } }),
        0,
        `round ${round}: minting creates no subscription`,
      );
      assert.equal(
        await prisma.trialClaim.count({ where: { firstUserId: account.user.id } }),
        0,
        `round ${round}: minting reserves no trial`,
      );
    }
  });
}

/** Two different accounts must never contend with each other. */
test("two accounts checking out at the same instant both succeed", async (t) => {
  silenceErrors(t);
  await forgetRateLimits();
  const one = await makeAccount("two-accounts-a");
  const two = await makeAccount("two-accounts-b");
  const arrive = barrier(2);
  const calls = stubProvider(t, { arrive });

  const [ra, rb] = await Promise.all([
    checkout(one.auth, "monthly"),
    checkout(two.auth, "yearly"),
  ]);

  assert.equal(ra.status, 201, ra.text);
  assert.equal(rb.status, 201, rb.text);
  assert.equal(calls.length, 2, "the lock is per account, not global");
});

// ── §7 — provider outcomes ───────────────────────────────────────────────────

const intentsOf = (userId: string) =>
  prisma.checkoutIntent.findMany({ where: { userId }, orderBy: { createdAt: "asc" } });
const lockOf = (userId: string) =>
  prisma.acquisitionLock.findUnique({ where: { userId_scope: { userId, scope: "acquisition" } } });

/**
 * A refusal we can read releases the lock at once.
 *
 * Lemon Squeezy looked at the request and said no, so no checkout exists to
 * collide with. Making someone wait out a thirty-minute window because of a
 * misconfigured variant would be gratuitous.
 */
test("a certain 4xx refusal frees the lock and a retry is allowed", async (t) => {
  silenceErrors(t);
  const account = await makeAccount("4xx");
  let calls = stubProvider(t, {
    respond: () => ({
      ok: false,
      status: 422,
      json: async () => ({ errors: [{ detail: "variant is not purchasable" }] }),
    }),
  });

  const refused = await checkout(account.auth, "monthly");
  assert.equal(refused.status, 400, refused.text);
  assert.equal(calls.length, 1);

  const [intent] = await intentsOf(account.user.id);
  assert.equal(intent.state, "failed", "a readable refusal is a decision, not a mystery");
  assert.equal(await lockOf(account.user.id), null, "and the lock goes with it");

  calls = stubProvider(t);
  const retried = await checkout(account.auth, "yearly");
  assert.equal(retried.status, 201, retried.text);
  assert.equal(calls.length, 1, "the retry is free to create exactly one");
});

/**
 * A timeout is NOT a refusal, and this is the case the whole design turns on.
 *
 * The request may have arrived and the reply been lost, so a payable link may
 * exist that we cannot see, cannot list (Lemon Squeezy documents no filter by
 * custom data) and cannot cancel (it documents no way to invalidate a checkout
 * after creation). The only safe move is to keep the lock until the link we
 * might have created stops being payable — which we know, because we sent
 * `expires_at` when we asked for it.
 */
test("an ambiguous failure keeps the lock and refuses to create a second", async (t) => {
  silenceErrors(t);
  const account = await makeAccount("ambiguous");
  let calls = stubProvider(t, {
    respond: () => {
      throw new Error("socket hang up");
    },
  });

  const lost = await checkout(account.auth, "monthly");
  assert.equal(lost.status, 503, lost.text);
  assert.equal(lost.body.code, "CHECKOUT_STATE_UNCERTAIN");
  assert.equal(calls.length, 1);

  const [intent] = await intentsOf(account.user.id);
  assert.equal(intent.state, "uncertain");
  const lock = await lockOf(account.user.id);
  assert.ok(lock, "the lock is KEPT — a lost reply does not prove nothing was created");

  // Every plan is refused, lifetime included: a second PAYMENT is the risk, and
  // lifetime can produce one just as easily as a subscription.
  calls = stubProvider(t);
  for (const plan of ["monthly", "yearly", "lifetime"] as const) {
    const res = await checkout(account.auth, plan);
    assert.equal(res.status, 409, `${plan}: ${res.text}`);
    assert.equal(res.body.code, "CHECKOUT_STATE_UNCERTAIN", plan);
  }
  assert.equal(calls.length, 0, "nothing may be created while the outcome is unknown");

  // And the state is legible to support rather than silently stuck.
  const status = await request(app).get("/api/subscription").set(account.auth);
  for (const plan of ["monthly", "yearly", "lifetime"] as const) {
    assert.equal(status.body.purchaseEligibility[plan].reasonCode, "CHECKOUT_STATE_UNCERTAIN");
  }
});

/** A 5xx is exactly as ambiguous as a dropped socket, and treated the same. */
test("a provider 5xx is ambiguous, not a failure", async (t) => {
  silenceErrors(t);
  const account = await makeAccount("5xx");
  stubProvider(t, {
    respond: () => ({ ok: false, status: 503, json: async () => ({}) }),
  });

  const res = await checkout(account.auth, "monthly");
  assert.equal(res.status, 503, res.text);
  assert.equal(res.body.code, "CHECKOUT_STATE_UNCERTAIN");
  const [intent] = await intentsOf(account.user.id);
  assert.equal(intent.state, "uncertain");
  assert.ok(await lockOf(account.user.id));
});

// ── §12 — crashes ────────────────────────────────────────────────────────────

/**
 * The process died between reserving and calling the provider.
 *
 * Nothing was created, but nothing recorded that either — the intent is stuck at
 * `reserved`. It must still hold the lock: from the outside, "we reserved and
 * then went quiet" is indistinguishable from "we called and lost the answer",
 * and guessing the harmless one is how a double payment happens.
 */
test("a crash after reserving still blocks, until the reservation expires", async (t) => {
  silenceErrors(t);
  const account = await makeAccount("crash-reserve");

  // The reservation, with no provider call after it — exactly what a process
  // killed between the two leaves behind.
  const intent = await prisma.checkoutIntent.create({
    data: {
      token: `tok-${runId}-crash-reserve`,
      idempotencyKey: `tok-${runId}-crash-reserve`,
      userId: account.user.id,
      plan: "monthly",
      scope: "acquisition",
      state: "reserved",
      provider: "lemonsqueezy",
      expiresAt: new Date(Date.now() + 30 * 60_000),
    },
  });
  await prisma.acquisitionLock.create({
    data: {
      userId: account.user.id,
      scope: "acquisition",
      intentId: intent.id,
      expiresAt: intent.expiresAt,
    },
  });

  const calls = stubProvider(t);
  const blocked = await checkout(account.auth, "yearly");
  assert.equal(blocked.status, 409, blocked.text);
  assert.equal(blocked.body.code, "CHECKOUT_IN_PROGRESS");
  assert.equal(calls.length, 0);

  // Once the window has genuinely passed, the account is free again.
  const past = new Date(Date.now() - 60_000);
  await prisma.acquisitionLock.updateMany({
    where: { userId: account.user.id },
    data: { expiresAt: past },
  });
  await prisma.checkoutIntent.update({ where: { id: intent.id }, data: { expiresAt: past } });

  const freed = await checkout(account.auth, "yearly");
  assert.equal(freed.status, 201, freed.text);
  assert.equal(calls.length, 1);
  const reread = await prisma.checkoutIntent.findUnique({ where: { id: intent.id } });
  assert.equal(reread.state, "expired", "the abandoned reservation is closed, not left open");
});

/**
 * The provider created the checkout and the process died before we recorded it.
 *
 * The worst case, and the reason the lock is not keyed on our own success: a
 * payable link exists at Lemon Squeezy that our database has no id for. The
 * `reserved` intent keeps the lock for the full window we told the provider
 * about, so no second link can be minted beside it.
 */
test("a crash after creation but before finalising still holds the lock", async (t) => {
  silenceErrors(t);
  const account = await makeAccount("crash-finalise");

  const intent = await prisma.checkoutIntent.create({
    data: {
      token: `tok-${runId}-crash-finalise`,
      idempotencyKey: `tok-${runId}-crash-finalise`,
      userId: account.user.id,
      plan: "lifetime",
      scope: "acquisition",
      state: "reserved",
      provider: "lemonsqueezy",
      expiresAt: new Date(Date.now() + 30 * 60_000),
    },
  });
  await prisma.acquisitionLock.create({
    data: {
      userId: account.user.id,
      scope: "acquisition",
      intentId: intent.id,
      expiresAt: intent.expiresAt,
    },
  });

  const calls = stubProvider(t);
  for (const plan of ["monthly", "yearly", "lifetime"] as const) {
    const res = await checkout(account.auth, plan);
    assert.equal(res.status, 409, `${plan}: ${res.text}`);
    assert.equal(res.body.code, "CHECKOUT_IN_PROGRESS", plan);
  }
  assert.equal(calls.length, 0, "not even the same plan may be re-created");
});

// ── §13 — the old link must be dead before a new one exists ──────────────────

/**
 * A monthly link approaching its expiry, and a customer who wants yearly.
 *
 * The new checkout may only be minted once the old link is genuinely unpayable.
 * Our stored expiry sits a margin BEYOND what we told Lemon Squeezy, so the
 * moment we consider the account free is strictly after the moment their link
 * dies — never before, which would be a window in which both are payable.
 */
test("a nearly-expired link still blocks a different plan", async (t) => {
  silenceErrors(t);
  const account = await makeAccount("old-link");
  const calls = stubProvider(t);

  const minted = await checkout(account.auth, "monthly");
  assert.equal(minted.status, 201, minted.text);

  const lockBefore = await lockOf(account.user.id);
  const [intent] = await intentsOf(account.user.id);
  assert.ok(
    lockBefore!.expiresAt.getTime() >= intent.expiresAt.getTime(),
    "the lock never dies before the intent it protects",
  );
  // What we told the provider, recovered from the request we actually sent.
  const sentExpiry = new Date(calls[0].data.attributes.expires_at).getTime();
  assert.ok(
    intent.expiresAt.getTime() > sentExpiry,
    "our row must outlive the provider's link, never the other way round",
  );

  // One second before the local expiry: the link may still be payable.
  const almost = new Date(intent.expiresAt.getTime() - 1000);
  await prisma.acquisitionLock.updateMany({
    where: { userId: account.user.id },
    data: { expiresAt: almost },
  });
  const tooSoon = await checkout(account.auth, "yearly");
  assert.equal(tooSoon.status, 409, tooSoon.text);
  assert.equal(tooSoon.body.code, "CHECKOUT_IN_PROGRESS");
  assert.equal(calls.length, 1, "no second link while the first may still be paid");

  // Past it: the old link is certainly dead, so a new one is safe.
  await prisma.acquisitionLock.updateMany({
    where: { userId: account.user.id },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });
  const now = await checkout(account.auth, "yearly");
  assert.equal(now.status, 201, now.text);
  assert.equal(calls.length, 2);
});

// ── §10 — idempotency ────────────────────────────────────────────────────────

test("the same Idempotency-Key returns the same intent, and never a second checkout", async (t) => {
  silenceErrors(t);
  const account = await makeAccount("idem");
  const calls = stubProvider(t);
  const key = `key-${runId}-a`;

  const first = await request(app)
    .post("/api/checkout")
    .set(account.auth)
    .set("Idempotency-Key", key)
    .send({ plan: "monthly" });
  assert.equal(first.status, 201, first.text);

  const again = await request(app)
    .post("/api/checkout")
    .set(account.auth)
    .set("Idempotency-Key", key)
    .send({ plan: "monthly" });
  assert.equal(again.status, 201, again.text);
  assert.equal(again.body.reused, true);
  assert.equal(again.body.url, first.body.url);
  assert.equal(calls.length, 1, "one key, one checkout");
  assert.equal((await intentsOf(account.user.id)).length, 1, "and one intent");
});

test("the same key with a different plan is refused, not silently honoured", async (t) => {
  silenceErrors(t);
  const account = await makeAccount("idem-conflict");
  const calls = stubProvider(t);
  const key = `key-${runId}-b`;

  assert.equal(
    (
      await request(app)
        .post("/api/checkout")
        .set(account.auth)
        .set("Idempotency-Key", key)
        .send({ plan: "monthly" })
    ).status,
    201,
  );

  const conflict = await request(app)
    .post("/api/checkout")
    .set(account.auth)
    .set("Idempotency-Key", key)
    .send({ plan: "yearly" });
  assert.equal(conflict.status, 409, conflict.text);
  assert.equal(conflict.body.code, "IDEMPOTENCY_CONFLICT");
  assert.equal(calls.length, 1);
});

/**
 * A key is scoped to its account. Reusing someone else's must neither succeed
 * nor reveal that it exists — the key is part of a compound unique with the
 * account, so a stranger's key is simply an unused key.
 */
test("an idempotency key from another account leaks nothing", async (t) => {
  silenceErrors(t);
  const owner = await makeAccount("idem-owner");
  const stranger = await makeAccount("idem-stranger");
  const calls = stubProvider(t);
  const key = `key-${runId}-shared`;

  const mine = await request(app)
    .post("/api/checkout")
    .set(owner.auth)
    .set("Idempotency-Key", key)
    .send({ plan: "monthly" });
  assert.equal(mine.status, 201, mine.text);

  const theirs = await request(app)
    .post("/api/checkout")
    .set(stranger.auth)
    .set("Idempotency-Key", key)
    .send({ plan: "yearly" });
  assert.equal(theirs.status, 201, theirs.text);
  assert.notEqual(theirs.body.url, mine.body.url, "no cross-account reuse");
  assert.notEqual(theirs.body.intentToken, mine.body.intentToken);
  assert.equal(calls.length, 2, "two accounts, two checkouts");
});

// ── §9 — the webhook closes its own intent ───────────────────────────────────

async function deliver(body: unknown) {
  const raw = JSON.stringify(body);
  const signature = crypto.createHmac("sha256", "whsec-lock-test").update(raw).digest("hex");
  return request(app)
    .post("/api/webhooks/lemonsqueezy")
    .set("Content-Type", "application/json")
    .set("X-Signature", signature)
    .send(raw);
}

function subscriptionPaid(opts: { userId: string; token: string; externalId: string }) {
  return {
    meta: {
      event_name: "subscription_created",
      custom_data: { user_id: opts.userId, checkout_intent_id: opts.token },
    },
    data: {
      id: opts.externalId,
      attributes: {
        user_email: "buyer@example.test",
        status: "active",
        store_id: Number(STORE),
        variant_id: Number(V_MONTHLY),
        trial_ends_at: null,
        renews_at: at(30).toISOString(),
        ends_at: null,
        updated_at: at(0).toISOString(),
        test_mode: false,
        urls: { update_payment_method: "https://x/pay", customer_portal: "https://x/portal" },
      },
    },
  };
}

test("a paid subscription webhook completes its intent and frees the lock", async (t) => {
  silenceErrors(t);
  const account = await makeAccount("wh-sub");
  const calls = stubProvider(t);
  const minted = await checkout(account.auth, "monthly");
  assert.equal(minted.status, 201, minted.text);
  const token = minted.body.intentToken;
  assert.ok(token, "the intent handle is returned so the webhook can carry it back");

  const externalId = `sub-${runId}-wh`;
  const body = subscriptionPaid({ userId: account.user.id, token, externalId });
  assert.equal((await deliver(body)).status, 200);

  const [intent] = await intentsOf(account.user.id);
  assert.equal(intent.state, "completed");
  assert.equal(await lockOf(account.user.id), null, "the acquisition is over");

  // A redelivery changes nothing.
  assert.equal((await deliver(body)).status, 200);
  const after = await prisma.checkoutIntent.findUnique({ where: { id: intent.id } });
  assert.equal(after.state, "completed");
  assert.equal(await lockOf(account.user.id), null);
  assert.equal(calls.length, 1);
});

/**
 * The delivery that would otherwise be a hole: a webhook for a checkout the
 * customer abandoned, arriving while they are midway through paying a NEWER one.
 * Keyed on the intent, it closes the old one and leaves the new lock alone.
 */
test("a late webhook never releases a newer acquisition", async (t) => {
  silenceErrors(t);
  const account = await makeAccount("wh-late");
  const calls = stubProvider(t);

  const first = await checkout(account.auth, "monthly");
  assert.equal(first.status, 201, first.text);
  const oldToken = first.body.intentToken;

  // The customer abandons it; the window passes and they start a lifetime one.
  await prisma.acquisitionLock.updateMany({
    where: { userId: account.user.id },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });
  const second = await checkout(account.auth, "lifetime");
  assert.equal(second.status, 201, second.text);
  const newToken = second.body.intentToken;
  assert.notEqual(newToken, oldToken);
  const newLock = await lockOf(account.user.id);
  assert.ok(newLock);

  // Now the OLD checkout's webhook finally lands.
  assert.equal(
    (
      await deliver(
        subscriptionPaid({
          userId: account.user.id,
          token: oldToken,
          externalId: `sub-${runId}-late`,
        }),
      )
    ).status,
    200,
  );

  const held = await lockOf(account.user.id);
  assert.ok(held, "the NEW acquisition must survive an old delivery");
  assert.equal(held!.intentId, newLock!.intentId, "and it is still the same one");
  assert.equal(calls.length, 2);
});

/** A token that is not this account's must do nothing at all. */
test("a webhook carrying a foreign intent token changes nothing", async (t) => {
  silenceErrors(t);
  const owner = await makeAccount("wh-foreign-owner");
  const other = await makeAccount("wh-foreign-other");
  stubProvider(t);

  const mine = await checkout(owner.auth, "monthly");
  assert.equal(mine.status, 201, mine.text);
  const myToken = mine.body.intentToken;

  // The other account's payment quotes MY intent token.
  assert.equal(
    (
      await deliver(
        subscriptionPaid({
          userId: other.user.id,
          token: myToken,
          externalId: `sub-${runId}-foreign`,
        }),
      )
    ).status,
    200,
  );

  const lock = await lockOf(owner.user.id);
  assert.ok(lock, "custom data is not proof of anything — my lock stands");
  const [intent] = await intentsOf(owner.user.id);
  assert.equal(intent.state, "ready");
});

// ── §11 / §12 — the advertised state, and what the client may not see ────────

test("the status read exposes the checkout state per plan, without the link", async (t) => {
  silenceErrors(t);
  const account = await makeAccount("state");
  stubProvider(t);

  let status = await request(app).get("/api/subscription").set(account.auth);
  assert.equal(status.body.purchaseEligibility.monthly.reasonCode, "ELIGIBLE_WITH_TRIAL");

  const minted = await checkout(account.auth, "monthly");
  assert.equal(minted.status, 201, minted.text);

  status = await request(app).get("/api/subscription").set(account.auth);
  assert.deepEqual(status.body.purchaseEligibility.monthly, {
    canPurchase: true,
    reasonCode: "CHECKOUT_RESUMABLE",
    trialMode: "none",
    trialDays: 0,
  });
  for (const plan of ["yearly", "lifetime"] as const) {
    assert.equal(status.body.purchaseEligibility[plan].reasonCode, "CHECKOUT_IN_PROGRESS", plan);
    assert.equal(status.body.purchaseEligibility[plan].canPurchase, false, plan);
  }

  // THE SECRET LINK IS NOT HERE. It is handed out only by the authenticated
  // checkout endpoint, which is the one place a caller has proved intent.
  const blob = JSON.stringify(status.body);
  assert.ok(!blob.includes("ls.test/checkout"), "the status read must not carry the payment URL");
  assert.ok(!blob.includes(minted.body.intentToken), "nor the intent handle");
});

/** Nothing a client sends may change what it is sold, lock or no lock. */
test("hostile parameters cannot influence the minted checkout", async (t) => {
  silenceErrors(t);
  const account = await makeAccount("hostile");
  const calls = stubProvider(t);

  const res = await request(app)
    .post("/api/checkout")
    .set(account.auth)
    .send({
      plan: "monthly",
      skip_trial: false,
      trialDays: 30,
      variantId: "9999999",
      variant_id: "9999999",
      storeId: "111",
      accountId: "000000000000000000000000",
      userId: "000000000000000000000000",
      expires_at: at(3650).toISOString(),
      checkout_intent_id: "forged",
    });
  assert.equal(res.status, 201, res.text);

  const body = calls[0];
  assert.equal(body.data.relationships.variant.data.id, V_MONTHLY);
  assert.equal(body.data.relationships.store.data.id, STORE);
  assert.equal(body.data.attributes.checkout_data.custom.user_id, account.user.id);
  assert.equal(body.data.attributes.checkout_data.custom.checkout_intent_id, res.body.intentToken);
  assert.notEqual(body.data.attributes.checkout_data.custom.checkout_intent_id, "forged");
  // The expiry is ours, not theirs: a client-chosen one would be a lock the
  // customer sets the length of.
  assert.ok(
    new Date(body.data.attributes.expires_at).getTime() < Date.now() + 2 * 60 * 60_000,
    "the checkout expiry is a server decision",
  );
  assert.ok(!JSON.stringify(body).includes("9999999"));
});

// ── §1 — the indexes the schema promises actually exist ─────────────────────

/**
 * The invariant is a database constraint or it is nothing.
 *
 * Asserted BEHAVIOURALLY rather than by reading `getIndexes()`: what matters is
 * not that an index is listed, it is that a second lock for the same account is
 * rejected. `prisma db push` builds these from the same schema production uses,
 * so a green here means the constraint the code relies on is really enforced.
 */
test("AcquisitionLock(userId, scope) is genuinely unique in MongoDB", async () => {
  const account = await makeAccount("index");
  const intent = await prisma.checkoutIntent.create({
    data: {
      token: `tok-${runId}-index`,
      idempotencyKey: `tok-${runId}-index`,
      userId: account.user.id,
      plan: "monthly",
      scope: "acquisition",
      state: "reserved",
      provider: "lemonsqueezy",
      expiresAt: new Date(Date.now() + 60_000),
    },
  });
  const lock = () =>
    prisma.acquisitionLock.create({
      data: {
        userId: account.user.id,
        scope: "acquisition",
        intentId: intent.id,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

  await lock();
  await assert.rejects(lock(), (e: any) => e.code === "P2002", "a second lock must be refused");

  // And the intent token is unique too — it is a public handle.
  await assert.rejects(
    prisma.checkoutIntent.create({
      data: {
        token: `tok-${runId}-index`,
        idempotencyKey: `other-${runId}`,
        userId: account.user.id,
        plan: "yearly",
        scope: "acquisition",
        state: "reserved",
        provider: "lemonsqueezy",
        expiresAt: new Date(Date.now() + 60_000),
      },
    }),
    (e: any) => e.code === "P2002",
  );
});

// ── §2 — the signed lifetime order, end to end ──────────────────────────────

function orderPaid(over: {
  userId?: string;
  token?: string | null;
  orderId?: string;
  storeId?: number;
  variantId?: number;
  testMode?: boolean;
  status?: string;
}) {
  const custom: Record<string, unknown> = {};
  if (over.userId) custom.user_id = over.userId;
  if (over.token) custom.checkout_intent_id = over.token;
  return {
    meta: { event_name: "order_created", custom_data: custom },
    data: {
      id: over.orderId ?? `order-${runId}`,
      attributes: {
        user_email: "buyer@example.test",
        status: over.status ?? "paid",
        refunded: false,
        refunded_at: null,
        total_usd: 9900,
        created_at: at(0).toISOString(),
        test_mode: over.testMode ?? false,
        store_id: over.storeId ?? Number(STORE),
        first_order_item: {
          product_id: 1,
          variant_id: over.variantId ?? Number(V_LIFETIME),
        },
      },
    },
  };
}

/** A lifetime checkout, minted through the real route, then actually paid. */
async function readyLifetime(t: any, tag: string) {
  const account = await makeAccount(tag);
  const calls = stubProvider(t);
  const minted = await checkout(account.auth, "lifetime");
  assert.equal(minted.status, 201, minted.text);
  const lock = await lockOf(account.user.id);
  assert.ok(lock, "precondition: the acquisition is held");
  return { account, token: minted.body.intentToken as string, calls, lockId: lock!.intentId };
}

test("a signed lifetime order_created grants the licence and closes its intent", async (t) => {
  silenceErrors(t);
  const { account, token } = await readyLifetime(t, "life-ok");
  const orderId = `order-${runId}-life-ok`;

  const body = orderPaid({ userId: account.user.id, token, orderId });
  assert.equal((await deliver(body)).status, 200);

  // The licence landed.
  const purchases = await prisma.purchase.findMany({ where: { userId: account.user.id } });
  assert.equal(purchases.length, 1, "exactly one lifetime purchase");
  assert.equal(purchases[0].externalId, orderId);
  assert.equal(purchases[0].isRefunded, false);

  // The acquisition is over, and only it.
  const [intent] = await intentsOf(account.user.id);
  assert.equal(intent.state, "completed");
  assert.equal(await lockOf(account.user.id), null);

  // A lifetime licence is not a trial and does not renew.
  assert.equal(await prisma.trialClaim.count({ where: { firstUserId: account.user.id } }), 0);
  assert.equal(await prisma.subscription.count({ where: { userId: account.user.id } }), 0);

  // Redelivery changes nothing at all.
  assert.equal((await deliver(body)).status, 200);
  assert.equal(
    (await prisma.purchase.findMany({ where: { userId: account.user.id } })).length,
    1,
    "a redelivered order must not grant twice",
  );
  const after = await prisma.checkoutIntent.findUnique({ where: { id: intent.id } });
  assert.equal(after.state, "completed");
  assert.equal(await lockOf(account.user.id), null);
});

/**
 * Everything that must NOT grant — and must not release the lock either.
 *
 * The lock is the point: a payload we refuse tells us nothing about whether the
 * customer's real checkout is still payable, so letting a bad order free the
 * account would open exactly the window the lock exists to close.
 */
for (const bad of [
  { name: "a store that is not ours", patch: { storeId: 999999 } },
  { name: "a variant that is not the lifetime one", patch: { variantId: 5551234 } },
  { name: "a test-mode order on a live-only deployment", patch: { testMode: true } },
  { name: "an order that was never paid", patch: { status: "pending" } },
] as const) {
  test(`a lifetime order with ${bad.name} grants nothing and keeps the lock`, async (t) => {
    silenceErrors(t);
    const { account, token } = await readyLifetime(t, "life-bad");

    const body = orderPaid({
      userId: account.user.id,
      token,
      orderId: `order-${runId}-bad-${Math.abs(hash(bad.name))}`,
      ...bad.patch,
    });
    const res = await deliver(body);
    assert.ok(res.status === 200, `a refused payload is acknowledged, not 500: ${res.text}`);

    assert.equal(
      await prisma.purchase.count({ where: { userId: account.user.id } }),
      0,
      "no licence",
    );
    const [intent] = await intentsOf(account.user.id);
    assert.notEqual(intent.state, "completed", "the intent is not closed by a payload we refused");
    assert.ok(await lockOf(account.user.id), "and the acquisition is still held");
  });
}

/**
 * A token we never issued does NOT invalidate the order — and that distinction
 * matters more than it looks.
 *
 * The correlation id is bookkeeping; the payment is the fact. An order that is
 * paid, from our store, for our lifetime variant, belonging to this account, must
 * grant the licence whether or not we can match it to an intent — refusing a
 * paying customer because a custom field went missing would be the worst
 * possible reading of a missing field. What we must NOT do is close an intent we
 * cannot identify, or free a lock on the strength of it.
 */
test("a lifetime order with an unknown intent token still grants, but closes nothing", async (t) => {
  silenceErrors(t);
  const { account } = await readyLifetime(t, "life-untracked");

  const res = await deliver(
    orderPaid({
      userId: account.user.id,
      token: "a-token-we-never-issued",
      orderId: `order-${runId}-untracked`,
    }),
  );
  assert.equal(res.status, 200);

  assert.equal(
    await prisma.purchase.count({ where: { userId: account.user.id } }),
    1,
    "the customer paid — the licence is theirs",
  );
  const [intent] = await intentsOf(account.user.id);
  assert.equal(intent.state, "ready", "but an intent we cannot identify is not closed");
  assert.ok(await lockOf(account.user.id), "and no lock is freed on an unmatched id");
});

/** A stable, dependency-free hash so each bad case gets its own order id. */
function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

test("a lifetime order quoting ANOTHER account's intent closes nothing", async (t) => {
  silenceErrors(t);
  const owner = await readyLifetime(t, "life-owner");
  const buyer = await makeAccount("life-buyer");

  const res = await deliver(
    orderPaid({
      userId: buyer.user.id,
      token: owner.token, // not theirs
      orderId: `order-${runId}-life-foreign`,
    }),
  );
  assert.equal(res.status, 200);

  assert.ok(await lockOf(owner.account.user.id), "the owner's acquisition stands");
  const [ownerIntent] = await intentsOf(owner.account.user.id);
  assert.equal(ownerIntent.state, "ready");
  // The buyer's own purchase is unaffected by the bad correlation.
  assert.equal(await prisma.purchase.count({ where: { userId: buyer.user.id } }), 1);
});

test("an old lifetime order never releases a newer acquisition", async (t) => {
  silenceErrors(t);
  const { account, token: oldToken } = await readyLifetime(t, "life-late");

  // Abandoned, expired, and a new acquisition started.
  await prisma.acquisitionLock.updateMany({
    where: { userId: account.user.id },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });
  const second = await checkout(account.auth, "monthly");
  assert.equal(second.status, 201, second.text);
  const newLock = await lockOf(account.user.id);
  assert.ok(newLock);

  assert.equal(
    (
      await deliver(
        orderPaid({
          userId: account.user.id,
          token: oldToken,
          orderId: `order-${runId}-life-late`,
        }),
      )
    ).status,
    200,
  );

  const held = await lockOf(account.user.id);
  assert.ok(held, "the newer acquisition survives");
  assert.equal(held!.intentId, newLock!.intentId);
});

// ── §3 — crash windows, rebuilt as a fresh serverless instance would see them ─

/**
 * "The response was lost" is not a state the database can tell from success.
 *
 * Each of these reconstructs what a NEW instance finds after the old one died,
 * and asserts the only safe reading of it. No in-memory state survives, which is
 * the whole reason the lock is a document.
 */
test("a ready intent whose HTTP response was lost is resumed, not re-created", async (t) => {
  silenceErrors(t);
  const account = await makeAccount("lost-response");
  const calls = stubProvider(t);

  const minted = await checkout(account.auth, "monthly");
  assert.equal(minted.status, 201, minted.text);
  // The customer never saw that reply and pressed Buy again.
  const retried = await checkout(account.auth, "monthly");

  assert.equal(retried.status, 201, retried.text);
  assert.equal(retried.body.reused, true);
  assert.equal(retried.body.url, minted.body.url, "the same link, not a second one");
  assert.equal(calls.length, 1, "exactly one provider call");
  assert.equal((await intentsOf(account.user.id)).length, 1);
});

test("an uncertain acquisition only frees after the provider expiry plus the margin", async (t) => {
  silenceErrors(t);
  const account = await makeAccount("uncertain-window");
  let calls = stubProvider(t, {
    respond: () => {
      throw new Error("socket hang up");
    },
  });
  assert.equal((await checkout(account.auth, "monthly")).status, 503);
  assert.equal(calls.length, 1);

  const [intent] = await intentsOf(account.user.id);
  const lock = await lockOf(account.user.id);
  assert.equal(intent.state, "uncertain");
  assert.ok(
    lock!.expiresAt.getTime() >= intent.expiresAt.getTime(),
    "the lock outlives the intent it protects",
  );
  assert.ok(
    intent.expiresAt.getTime() > Date.now() + 30 * 60_000,
    "the hold covers the full life the invisible link could have, plus the margin",
  );

  // Still inside the window: nothing may be created, for any plan.
  calls = stubProvider(t);
  for (const plan of ["monthly", "yearly", "lifetime"] as const) {
    const res = await checkout(account.auth, plan);
    assert.equal(res.status, 409, `${plan}: ${res.text}`);
    assert.equal(res.body.code, "CHECKOUT_STATE_UNCERTAIN");
  }
  assert.equal(calls.length, 0);

  // Past it, the account is free again.
  const past = new Date(Date.now() - 1000);
  await prisma.acquisitionLock.updateMany({ where: { userId: account.user.id }, data: { expiresAt: past } });
  await prisma.checkoutIntent.update({ where: { id: intent.id }, data: { state: "expired", expiresAt: past } });
  const freed = await checkout(account.auth, "monthly");
  assert.equal(freed.status, 201, freed.text);
  assert.equal(calls.length, 1);
});

/**
 * P1 — an `uncertain` intent locked the account out of buying FOR EVER.
 *
 * `markUncertain` computes a hold window and writes it to both rows:
 * `UNCERTAIN_HOLD_MS`, the full life the invisible checkout could have plus the
 * clock-skew margin. That window is the whole point — it is the instant after
 * which a link we never saw can no longer be paid, so a fresh purchase is safe.
 *
 * `outstandingAcquisition` then ignored it: `if (state === "uncertain") return
 * intent` with no clock comparison at all. One dropped response during a
 * checkout and the customer could never buy anything again — every plan refused,
 * and the message told them to "finish or cancel it first" with nothing in the
 * product that can do either.
 *
 * Reported from the real app: an active monthly subscriber saw "A checkout is
 * already in progress on this account" on Get lifetime and Switch to yearly.
 */
test("an uncertain acquisition stops blocking once its hold window has passed", async (t) => {
  silenceErrors(t);
  const f = await makeAccount("uncertain-forever");
  let calls = stubProvider(t, {
    respond: () => {
      throw new Error("socket hang up");
    },
  });
  assert.equal((await checkout(f.auth, "monthly")).status, 503);
  assert.equal(calls.length, 1);

  const [intent] = await intentsOf(f.user.id);
  assert.equal(intent.state, "uncertain");

  // Inside the window, nothing may be created. That part was always right.
  calls = stubProvider(t);
  assert.equal((await checkout(f.auth, "lifetime")).status, 409);
  assert.equal(calls.length, 0);

  // Now push both rows past the hold the product itself computed — exactly what
  // the passage of time does.
  const past = new Date(Date.now() - 1000);
  await prisma.checkoutIntent.update({ where: { id: intent.id }, data: { expiresAt: past } });
  await prisma.acquisitionLock.updateMany({
    where: { userId: f.user.id },
    data: { expiresAt: past },
  });

  const freed = await checkout(f.auth, "lifetime");
  assert.equal(
    freed.status,
    201,
    `the hold expired, so buying must be possible again: ${freed.text}`,
  );
  assert.equal(calls.length, 1);

  // And the status read agrees with the endpoint.
  const status = await request(app).get("/api/subscription").set(f.auth);
  assert.notEqual(
    status.body.purchaseEligibility.monthly.reasonCode,
    "CHECKOUT_STATE_UNCERTAIN",
    "an expired hold must not still report an unknown checkout",
  );
});

/**
 * The dead end, from the API's side.
 *
 * A customer with a monthly checkout open clicked "Get lifetime" and was told
 * "A checkout is already in progress. Finish or cancel it first." Nothing in the
 * product can finish or cancel it — Lemon Squeezy publishes no way to invalidate
 * a checkout after creation — so the only true statement is WHEN the block ends.
 *
 * That instant was the one thing the client could not derive: it could read
 * WHICH plan is resumable from the code, but not until when.
 */
test("a held acquisition says which plan is resumable and until when", async (t) => {
  silenceErrors(t);
  const f = await makeAccount("resume-contract");
  const calls = stubProvider(t);

  const minted = await checkout(f.auth, "monthly");
  assert.equal(minted.status, 201, minted.text);

  const status = await request(app).get("/api/subscription").set(f.auth);
  const e = status.body.purchaseEligibility;

  // The resumable one names itself, and carries no secret.
  assert.equal(e.monthly.reasonCode, "CHECKOUT_RESUMABLE");
  assert.equal(e.monthly.canPurchase, true);

  // The others say when they come back, rather than asking for the impossible.
  for (const plan of ["yearly", "lifetime"] as const) {
    assert.equal(e[plan].reasonCode, "CHECKOUT_IN_PROGRESS", plan);
    assert.ok(e[plan].blockedUntil, `${plan} must say until when`);
    assert.ok(
      new Date(e[plan].blockedUntil).getTime() > Date.now(),
      `${plan}: the instant must be in the future`,
    );
  }

  // And no part of the status read leaks the way to pay.
  const blob = JSON.stringify(status.body);
  assert.ok(!blob.includes("ls.test/checkout"), "no checkout URL in the status read");
  assert.ok(!blob.includes(minted.body.intentToken), "no intent token either");

  // Resuming the same plan returns the SAME link and calls the provider once.
  const resumed = await checkout(f.auth, "monthly");
  assert.equal(resumed.status, 201, resumed.text);
  assert.equal(resumed.body.reused, true);
  assert.equal(resumed.body.url, minted.body.url);
  assert.equal(calls.length, 1, "resuming must not mint a second checkout");
});

/**
 * An unreadable provider answer offers no link, and says so.
 *
 * `ready` and `uncertain` look alike from outside — both refuse a new checkout —
 * but they must not read alike. `ready` means "here is the page you already
 * have"; `uncertain` means "we never learned whether a payable page exists", and
 * offering a resume there would send the customer to a link we cannot produce,
 * or invite the retry that charges twice. The only safe answer is the instant
 * after which an invisible link can no longer be paid.
 */
test("an uncertain acquisition offers nothing to resume, only when to return", async (t) => {
  silenceErrors(t);
  const f = await makeAccount("uncertain-contract");
  stubProvider(t, {
    respond: () => {
      throw new Error("socket hang up");
    },
  });
  assert.equal((await checkout(f.auth, "monthly")).status, 503);

  const e = (await request(app).get("/api/subscription").set(f.auth)).body.purchaseEligibility;

  for (const plan of ["monthly", "yearly", "lifetime"] as const) {
    assert.equal(e[plan].reasonCode, "CHECKOUT_STATE_UNCERTAIN", plan);
    assert.equal(e[plan].canPurchase, false, plan);
    assert.ok(e[plan].blockedUntil, `${plan} must name the instant it returns`);
  }
  assert.equal(
    Object.values(e).filter((p: any) => p.reasonCode === "CHECKOUT_RESUMABLE").length,
    0,
    "nothing may be offered for resumption when no link is known to exist",
  );
});

/**
 * When the hold lapses the account is free again — with ONE lock, not two.
 *
 * The screen refetches at the instant it was given. What it must find is a fully
 * open paywall: every plan buyable, no leftover `blockedUntil` for the copy to
 * quote, and a fresh acquisition replacing the stale one rather than joining it.
 * `@@unique([userId, scope])` is what makes the replacement atomic; if it were
 * ever missing in production, this is the test that describes what breaks.
 */
test("an expired hold reopens every plan and leaves a single lock behind", async (t) => {
  silenceErrors(t);
  const f = await makeAccount("expired-recovery");
  const calls = stubProvider(t);

  assert.equal((await checkout(f.auth, "monthly")).status, 201);
  const past = new Date(Date.now() - 1000);
  await prisma.checkoutIntent.updateMany({ where: { userId: f.user.id }, data: { expiresAt: past } });
  await prisma.acquisitionLock.updateMany({ where: { userId: f.user.id }, data: { expiresAt: past } });

  const e = (await request(app).get("/api/subscription").set(f.auth)).body.purchaseEligibility;
  for (const plan of ["monthly", "yearly", "lifetime"] as const) {
    assert.equal(e[plan].canPurchase, true, `${plan} must be buyable again`);
    assert.equal(e[plan].blockedUntil, undefined, `${plan} must not still quote a lifted hold`);
  }

  // A different plan now, which is the whole point of waiting.
  assert.equal((await checkout(f.auth, "lifetime")).status, 201);
  assert.equal(calls.length, 2, "the second checkout is a real one, not a reuse");

  const locks = await prisma.acquisitionLock.findMany({ where: { userId: f.user.id } });
  assert.equal(locks.length, 1, "the stale lock is replaced, never duplicated");
  assert.equal(locks[0].scope, "acquisition");
  assert.ok(locks[0].expiresAt.getTime() > Date.now(), "the replacement holds a live window");
});
