import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RC_KNOWN_PRODUCT_IDS,
  RC_LIFETIME_PRODUCT_IDS,
  RC_PRODUCT_MONTHLY,
  RC_PRODUCT_YEARLY,
  RC_PROVIDER,
  projectSubscriber,
  statusForSubscription,
  syncUserFromRevenueCat,
  type RcSubscriber,
  type RcSubscriptionState,
} from "./revenuecat";
import { LIFETIME_PRODUCT_ID } from "./entitlement";
import { subscriptionGrants } from "./subscription";
import { env } from "./env";
import { prisma } from "./prisma";

/*
 * The projection is where iOS money becomes rows, and the one catastrophic
 * mistake available to it is vocabulary: `subscriptionGrants` carries a rule
 * built for Lemon Squeezy — status 'cancelled' with a future trialEndsAt
 * grants NOTHING — while Apple's cancellation (auto-renew off) keeps access
 * until expires_date even during a trial. So these tests pin two things: the
 * status mapping itself, and that every mapped row still answers
 * `subscriptionGrants` the way Apple's semantics demand.
 */

const NOW = new Date("2026-08-12T12:00:00.000Z");
const FUTURE = "2026-09-01T00:00:00.000Z";
const PAST = "2026-07-01T00:00:00.000Z";
const USER = "507f1f77bcf86cd799439011";

function subscriberWith(sub: RcSubscriptionState, productId = RC_PRODUCT_MONTHLY): RcSubscriber {
  return {
    subscriptions: { [productId]: sub },
    entitlements: { pro: { product_identifier: productId, expires_date: sub.expires_date } },
    management_url: "https://apps.apple.com/account/subscriptions",
    original_app_user_id: USER,
  };
}

function onlySub(subscriber: RcSubscriber) {
  const plan = projectSubscriber(USER, subscriber, NOW);
  assert.equal(plan.subscriptions.length, 1);
  return plan.subscriptions[0];
}

/* ── the status mapping ─────────────────────────────────────────────────── */

test("a paying subscription maps to active, with the renewal visible", () => {
  const row = onlySub(subscriberWith({ expires_date: FUTURE, period_type: "normal", is_sandbox: false }));
  assert.equal(row.externalId, `${USER}:${RC_PRODUCT_MONTHLY}`);
  assert.equal(row.data.status, "active");
  assert.equal(row.data.willRenew, true);
  assert.equal(row.data.interval, "monthly");
  assert.equal(row.data.renewsAt?.toISOString(), FUTURE);
  assert.equal(row.data.validUntil?.toISOString(), FUTURE);
  assert.equal(row.data.environment, "production");
  assert.equal(row.data.testMode, false);
  assert.equal(row.data.entitlementId, "pro");
});

test("an Apple trial maps to on_trial with the countdown date", () => {
  const row = onlySub(subscriberWith({ expires_date: FUTURE, period_type: "trial" }));
  assert.equal(row.data.status, "on_trial");
  assert.equal(row.data.trialEndsAt?.toISOString(), FUTURE);
  assert.ok(subscriptionGrants(row.data, NOW));
});

test("a lapsed subscription maps to expired and grants nothing", () => {
  const row = onlySub(subscriberWith({ expires_date: PAST, period_type: "normal" }));
  assert.equal(row.data.status, "expired");
  assert.equal(row.data.renewsAt, null);
  assert.equal(subscriptionGrants(row.data, NOW), false);
});

test("a billing issue inside a live grace period is past_due — and still grants", () => {
  const grace = "2026-08-20T00:00:00.000Z";
  const row = onlySub(
    subscriberWith({
      expires_date: "2026-08-10T00:00:00.000Z", // already past — the grace is what keeps it alive
      grace_period_expires_date: grace,
      billing_issues_detected_at: "2026-08-10T00:00:00.000Z",
      period_type: "normal",
    }),
  );
  assert.equal(row.data.status, "past_due");
  assert.equal(row.data.validUntil?.toISOString(), grace, "access runs to the END of the grace");
  assert.ok(subscriptionGrants(row.data, NOW), "a failed card is a card problem, not a decision");
});

test("a spent grace period is expired, however loudly the billing issue is flagged", () => {
  const row = onlySub(
    subscriberWith({
      expires_date: "2026-07-10T00:00:00.000Z",
      grace_period_expires_date: PAST,
      billing_issues_detected_at: "2026-07-10T00:00:00.000Z",
    }),
  );
  assert.equal(row.data.status, "expired");
  assert.equal(subscriptionGrants(row.data, NOW), false);
});

test("a refund is expired-with-revocation, not merely lapsed", () => {
  const refundedAt = "2026-08-01T00:00:00.000Z";
  const row = onlySub(
    subscriberWith({ expires_date: FUTURE, refunded_at: refundedAt, period_type: "normal" }),
  );
  assert.equal(row.data.status, "expired");
  assert.equal(row.data.refundedAt?.toISOString(), refundedAt);
  assert.equal(row.data.revokedAt?.toISOString(), refundedAt);
  assert.equal(subscriptionGrants(row.data, NOW), false, "money returned = access returned");
});

/* ── the 'cancelled' trap ───────────────────────────────────────────────── */

test("turning off auto-renew is NOT a cancellation: access runs to the paid end", () => {
  const row = onlySub(
    subscriberWith({
      expires_date: FUTURE,
      period_type: "normal",
      unsubscribe_detected_at: "2026-08-11T00:00:00.000Z",
    }),
  );
  assert.notEqual(row.data.status, "cancelled", "the LS-only status must never appear on an RC row");
  assert.equal(row.data.status, "active");
  assert.equal(row.data.willRenew, false);
  assert.equal(row.data.renewsAt, null, "no charge is coming — showing one would be a lie");
  assert.ok(subscriptionGrants(row.data, NOW), "they paid through this date");
});

test("cancelling DURING an Apple trial keeps the trial: Apple promised the window", () => {
  // The exact case the LS rule would destroy: status 'cancelled' + future
  // trialEndsAt reads as "grants nothing" in subscriptionGrants. Apple cannot
  // end a trial early, so the row must keep granting until expires_date.
  const row = onlySub(
    subscriberWith({
      expires_date: FUTURE,
      period_type: "trial",
      unsubscribe_detected_at: "2026-08-11T00:00:00.000Z",
    }),
  );
  assert.equal(row.data.status, "on_trial");
  assert.equal(row.data.willRenew, false);
  assert.ok(
    subscriptionGrants(row.data, NOW),
    "an Apple trial with auto-renew off still runs to its end — cutting it here is the trap",
  );
});

test("no mapped state, whatever the inputs, is ever 'cancelled'", () => {
  const dates = [FUTURE, PAST, null, "not a date"];
  const bools = [true, false, undefined];
  for (const expires of dates)
    for (const unsub of dates)
      for (const refunded of dates)
        for (const grace of dates)
          for (const period of ["normal", "trial", "intro", undefined])
            for (const sandbox of bools) {
              const { status } = statusForSubscription(
                {
                  expires_date: expires,
                  unsubscribe_detected_at: unsub,
                  refunded_at: refunded,
                  grace_period_expires_date: grace,
                  billing_issues_detected_at: unsub,
                  period_type: period,
                  is_sandbox: sandbox,
                },
                NOW,
              );
              assert.notEqual(status, "cancelled");
            }
});

/* ── sandbox marking ────────────────────────────────────────────────────── */

test("a sandbox subscription is recorded — flagged, never dropped", () => {
  const row = onlySub(subscriberWith({ expires_date: FUTURE, period_type: "trial", is_sandbox: true }));
  assert.equal(row.data.testMode, true);
  assert.equal(row.data.environment, "sandbox");
});

test("a production purchase EXPLICITLY clears the sandbox flag on its row", () => {
  // A TestFlight tester who later pays lands on the same (user, product) row.
  // Leaving testMode true would hide their paid subscription behind the
  // sandbox gate forever — so production writes false, not nothing.
  const row = onlySub(subscriberWith({ expires_date: FUTURE, is_sandbox: false }));
  assert.equal(row.data.testMode, false);
});

/* ── products ───────────────────────────────────────────────────────────── */

test("a product we do not sell is ignored, never guessed at", () => {
  const plan = projectSubscriber(
    USER,
    { subscriptions: { "com.someone.else": { expires_date: FUTURE } } },
    NOW,
  );
  assert.equal(plan.subscriptions.length, 0);
  assert.equal(plan.purchases.length, 0);
});

test("the yearly product labels its row yearly", () => {
  const row = onlySub(subscriberWith({ expires_date: FUTURE }, RC_PRODUCT_YEARLY));
  assert.equal(row.data.interval, "yearly");
});

/*
 * THE PRODUCT IDS THEMSELVES. Pinned as literals exactly once, here, because
 * every other fixture in the suite now spells them through the constants —
 * which means a typo in a constant would be copied faithfully into every test
 * and prove nothing. Apple never lets a Product ID change after creation, so
 * these three strings are as immutable as anything in the codebase.
 */
test("the Apple catalogue is exactly three product ids, and they are final", () => {
  assert.equal(RC_PRODUCT_MONTHLY, "in.welock.app.monthly");
  assert.equal(RC_PRODUCT_YEARLY, "in.welock.app.yearly");
  assert.deepEqual([...RC_LIFETIME_PRODUCT_IDS], ["in.welock.app.life"]);
  // The whole allow-list, so a fourth id cannot be added without a test saying so.
  assert.deepEqual([...RC_KNOWN_PRODUCT_IDS].sort(), [
    "in.welock.app.life",
    "in.welock.app.monthly",
    "in.welock.app.yearly",
  ]);
  // The RC mirror and the legacy JWS route must name the SAME lifetime product.
  assert.equal(RC_LIFETIME_PRODUCT_IDS[0], LIFETIME_PRODUCT_ID);
});

test("the lifetime product mints a Purchase", () => {
  const productId = RC_LIFETIME_PRODUCT_IDS[0];
  const plan = projectSubscriber(
    USER,
    {
      non_subscriptions: {
        [productId]: [{ id: "txn1", purchase_date: PAST, store: "app_store", is_sandbox: false }],
      },
      entitlements: { pro: { product_identifier: productId, expires_date: null } },
    },
    NOW,
  );
  assert.equal(plan.purchases.length, 1);
  const purchase = plan.purchases[0];
  assert.equal(purchase.externalId, `${USER}:${productId}`);
  assert.equal(purchase.data.store, "app_store");
  assert.equal(purchase.data.isRefunded, false);
  assert.equal(purchase.data.purchasedAt.toISOString(), PAST);
});

test("the RETIRED lifetime spelling is a product we do not sell — nothing is written", () => {
  // It was never sold: App Store Connect has only ever had `….life`, so a
  // subscriber naming the long spelling is either a stale fixture or someone
  // else's catalogue. Either way it must project to NOTHING, exactly like any
  // other foreign product — an alias kept "for compatibility" would be a
  // second, unaudited way to be granted a lifetime licence.
  // Built by concatenation, not written out: the purge is verified by a
  // repo-wide grep for the retired id coming back EMPTY, and a fixture that
  // spelled it would defeat the very check it is here to protect.
  const retired = `${LIFETIME_PRODUCT_ID}time`;
  for (const productId of [retired, "com.evil.app.pro"]) {
    const plan = projectSubscriber(
      USER,
      {
        non_subscriptions: {
          [productId]: [{ id: "txn1", purchase_date: PAST, is_sandbox: false }],
        },
        subscriptions: { [productId]: { expires_date: FUTURE, period_type: "normal" } },
        entitlements: { pro: { product_identifier: productId } },
      },
      NOW,
    );
    assert.deepEqual(plan.purchases, [], `${productId} must mint no Purchase`);
    assert.deepEqual(plan.subscriptions, [], `${productId} must mint no Subscription`);
    assert.equal(RC_KNOWN_PRODUCT_IDS.includes(productId), false, "nor pass the allow-list");
  }
});

test("a lifetime dropped from a reported entitlements object reads as refunded", () => {
  const productId = RC_LIFETIME_PRODUCT_IDS[0];
  const plan = projectSubscriber(
    USER,
    {
      non_subscriptions: { [productId]: [{ id: "txn1", purchase_date: PAST }] },
      // Entitlements ARE reported, and the lifetime is not among them.
      entitlements: { other: { product_identifier: "com.someone.else" } },
    },
    NOW,
  );
  assert.equal(plan.purchases[0].data.isRefunded, true);
  assert.ok(plan.purchases[0].data.revokedAt != null);
});

test("an ABSENT entitlements object never revokes anyone", () => {
  // Fail toward access: inferring "refunded" from a thin fetch would revoke
  // every paying customer over a missing field.
  const productId = RC_LIFETIME_PRODUCT_IDS[0];
  const plan = projectSubscriber(
    USER,
    { non_subscriptions: { [productId]: [{ id: "txn1", purchase_date: PAST }] } },
    NOW,
  );
  assert.equal(plan.purchases[0].data.isRefunded, false);
});

/* ── convergence ────────────────────────────────────────────────────────── */

test("the projection is a pure snapshot: same subscriber in, same rows out", () => {
  // This is what makes out-of-order webhooks converge — RENEWAL before
  // INITIAL_PURCHASE both end in a re-fetch, and the re-fetch is the state.
  const subscriber = subscriberWith({ expires_date: FUTURE, period_type: "normal" });
  assert.deepEqual(
    projectSubscriber(USER, subscriber, NOW),
    projectSubscriber(USER, subscriber, NOW),
  );
});

test("the management URL rides along for the billing view", () => {
  const plan = projectSubscriber(USER, subscriberWith({ expires_date: FUTURE }), NOW);
  assert.equal(plan.managementUrl, "https://apps.apple.com/account/subscriptions");
});

test("the management URL is PERSISTED on every subscription row it mirrors", () => {
  // Both callers used to discard `plan.managementUrl` after the upserts, so the
  // one page that can manage an Apple subscription was fetched on every sync
  // and stored nowhere — and the entitlement view had nothing to hand the
  // client. It now rides in the row's own `customerPortalUrl`, the same column
  // the Lemon Squeezy webhook fills with its portal link.
  const row = onlySub(subscriberWith({ expires_date: FUTURE, period_type: "normal" }));
  assert.equal(row.data.customerPortalUrl, "https://apps.apple.com/account/subscriptions");
});

test("a subscriber with no management URL writes null, never a stale leftover", () => {
  const subscriber = subscriberWith({ expires_date: FUTURE });
  delete (subscriber as { management_url?: unknown }).management_url;
  const row = onlySub(subscriber);
  assert.equal(row.data.customerPortalUrl, null);
});

test("the upsert hands RevenueCat's manage URL to the database", async (t) => {
  // End to end through syncUserFromRevenueCat: the URL must be IN the written
  // data, not merely in the projection — this is the line that was missing.
  const db = stubSync(t, ok(subscriberWith({ expires_date: FUTURE, period_type: "normal" })));

  await syncUserFromRevenueCat(USER);

  assert.equal(db.subUpsert.length, 1);
  assert.equal(
    db.subUpsert[0][0].update.customerPortalUrl,
    "https://apps.apple.com/account/subscriptions",
  );
  assert.equal(
    db.subUpsert[0][0].create.customerPortalUrl,
    "https://apps.apple.com/account/subscriptions",
  );
});

/* ── the authoritative sweep (the transfer-loser leak) ──────────────────── */

type Ctx = { after: (fn: () => void) => void };

function stubMethod(t: Ctx, target: Record<string, any>, name: string, impl: (...a: any[]) => any) {
  const original = target[name];
  const calls: any[][] = [];
  target[name] = (...args: any[]) => {
    calls.push(args);
    return impl(...args);
  };
  t.after(() => {
    target[name] = original;
  });
  return calls;
}

type Row = Record<string, any> & { userId: string; provider: string; externalId: string };

/**
 * Two in-memory tables that answer `upsert` and `updateMany` with the semantics
 * Prisma gives the exact WHEREs this module writes.
 *
 * Recording the calls (what `stubSync` alone does) proves the sweep is SCOPED;
 * APPLYING them proves what that scope actually spares, which is the part a
 * customer feels — a Lemon Squeezy lifetime still granting after an Apple
 * receipt moved away is a claim about rows, not about a `where` object.
 */
function tables(seed: { subscriptions?: Row[]; purchases?: Row[] } = {}) {
  const subscriptions = seed.subscriptions ?? [];
  const purchases = seed.purchases ?? [];
  const upsertInto = (rows: Row[]) => async (args: any) => {
    const { provider, externalId } = args.where.provider_externalId;
    const found = rows.find((r) => r.provider === provider && r.externalId === externalId);
    if (found) Object.assign(found, args.update);
    else rows.push({ ...args.create });
    return {};
  };
  const updateManyIn = (rows: Row[]) => async (args: any) => {
    const { userId, provider, externalId } = args.where;
    let count = 0;
    for (const row of rows) {
      if (row.userId !== userId || row.provider !== provider) continue;
      if (externalId?.notIn?.includes(row.externalId)) continue;
      Object.assign(row, args.data);
      count += 1;
    }
    return { count };
  };
  const find = (rows: Row[], userId: string, provider: string) =>
    rows.find((r) => r.userId === userId && r.provider === provider)!;
  return { subscriptions, purchases, upsertInto, updateManyIn, find };
}

type Tables = ReturnType<typeof tables>;

/**
 * Stub the RC API and every write the sync makes. `respond` returns the raw
 * HTTP answer, so a test can produce a 404 or a body of the wrong SHAPE —
 * the two paths that must never be mistaken for "this customer owns nothing".
 * Returns the recorded calls so tests can read each WHERE.
 *
 * Pass `store` to have those writes actually LAND in a pair of tables, for the
 * tests that assert on the surviving rows rather than on the calls.
 */
function stubSync(
  t: Ctx,
  respond: (url?: string, init?: any) => Response | Promise<Response>,
  store?: Tables,
) {
  const before = env.revenuecatSecretApiKey;
  (env as any).revenuecatSecretApiKey = "sk_test";
  t.after(() => {
    (env as any).revenuecatSecretApiKey = before;
  });

  stubMethod(t, globalThis as any, "fetch", async (url: any, init: any) =>
    respond(String(url), init),
  );
  const noop = async () => ({ count: 1 });
  // The Lemon Squeezy leg the sync now reads (KI-2, below). Baseline: no
  // recurring plan, so nothing is ever owed unless a test installs rows.
  stubMethod(t, prisma.subscription as any, "findMany", async () => []);
  return {
    subUpsert: stubMethod(
      t,
      prisma.subscription as any,
      "upsert",
      store ? store.upsertInto(store.subscriptions) : noop,
    ),
    purchaseUpsert: stubMethod(
      t,
      prisma.purchase as any,
      "upsert",
      store ? store.upsertInto(store.purchases) : noop,
    ),
    subSweep: stubMethod(
      t,
      prisma.subscription as any,
      "updateMany",
      store ? store.updateManyIn(store.subscriptions) : noop,
    ),
    purchaseSweep: stubMethod(
      t,
      prisma.purchase as any,
      "updateMany",
      store ? store.updateManyIn(store.purchases) : noop,
    ),
  };
}

/** The ordinary case: a 200 whose body has the documented wrapper. */
const ok = (subscriber: RcSubscriber) => () =>
  new Response(JSON.stringify({ subscriber }), { status: 200 });

/** The same answer, chosen by app_user_id: anyone unnamed owns NOTHING (200,
 *  empty collections) — the authoritative shape a transfer-loser re-fetches. */
const okFor = (byUser: Record<string, RcSubscriber>) => (url?: string) => {
  const named = Object.entries(byUser).find(([id]) => String(url).includes(id));
  return new Response(JSON.stringify({ subscriber: named?.[1] ?? {} }), { status: 200 });
};

test("an EMPTY snapshot sweeps ALL of this user's RC rows — the transfer-loser fix", async (t) => {
  // A 200 with empty collections: the losing account still EXISTS at
  // RevenueCat and is authoritatively saying it holds nothing.
  const db = stubSync(t, ok({}));

  await syncUserFromRevenueCat(USER);

  assert.equal(db.subUpsert.length, 0, "nothing to mirror");
  // Both sweeps fire, scoped to THIS user + provider, sparing nothing.
  for (const sweep of [db.subSweep, db.purchaseSweep]) {
    assert.equal(sweep.length, 1);
    const where = sweep[0][0].where;
    assert.equal(where.userId, USER);
    assert.equal(where.provider, "revenuecat");
    assert.deepEqual(where.externalId.notIn, [], "an empty snapshot spares no row");
  }
  // Subscription revoked to a non-granting state; purchase marked refunded.
  assert.equal(db.subSweep[0][0].data.status, "expired");
  assert.ok(db.subSweep[0][0].data.revokedAt instanceof Date);
  assert.equal(db.subSweep[0][0].data.willRenew, false);
  assert.equal(db.purchaseSweep[0][0].data.isRefunded, true);
  assert.ok(db.purchaseSweep[0][0].data.revokedAt instanceof Date);
});

test("the sweep is scoped: never lemonsqueezy, never a comp, never another user", async (t) => {
  const db = stubSync(t, ok({}));

  await syncUserFromRevenueCat(USER);

  for (const sweep of [db.subSweep, db.purchaseSweep]) {
    const where = sweep[0][0].where;
    // The three things the WHERE must pin, so a Lemon Squeezy lifetime, an
    // admin comp on User, or anyone else's rows can never fall in range.
    assert.equal(where.provider, "revenuecat");
    assert.equal(where.userId, USER);
    assert.ok("notIn" in where.externalId);
    assert.equal(Object.keys(where).sort().join(","), "externalId,provider,userId");
  }
});

test("a normally-expired subscription is PRESENT in the snapshot, so it is spared", async (t) => {
  // The false-positive the sweep must not commit: an expired-but-still-there
  // subscription is in the plan (mapped 'expired'), so its externalId is in
  // notIn and it is never swept.
  const db = stubSync(t, ok({
    subscriptions: { [RC_PRODUCT_MONTHLY]: { expires_date: PAST, period_type: "normal" } },
  }));

  await syncUserFromRevenueCat(USER);

  assert.equal(db.subUpsert.length, 1, "the expired row is still mirrored, not dropped");
  assert.deepEqual(
    db.subSweep[0][0].where.externalId.notIn,
    [`${USER}:${RC_PRODUCT_MONTHLY}`],
    "the still-present row is spared from the sweep",
  );
});

test("the sweep is idempotent: a second identical sync issues the same scoped writes", async (t) => {
  const db = stubSync(t, ok({}));

  await syncUserFromRevenueCat(USER);
  await syncUserFromRevenueCat(USER);

  assert.equal(db.subSweep.length, 2);
  assert.deepEqual(db.subSweep[0][0].where, db.subSweep[1][0].where);
  assert.equal(db.subSweep[1][0].data.status, "expired");
});

/* ── we only revoke on a response we actually understood ────────────────── */

/*
 * The interaction that made the sweep dangerous. While the sync was additive,
 * every "degrade to an empty subscriber" path was harmless — it just mirrored
 * nothing. With the sweep, an empty subscriber REVOKES EVERYTHING, so each of
 * those paths became a way for an upstream anomaly to strip paid access from
 * every account that syncs. Uncertainty must fail the sync, never revoke.
 */

test("a 404 revokes NOTHING — an unreadable customer is not an empty one", async (t) => {
  const db = stubSync(t, () => new Response("", { status: 404 }));

  await syncUserFromRevenueCat(USER);

  assert.equal(db.subSweep.length, 0, "a 404 must never revoke a licence");
  assert.equal(db.purchaseSweep.length, 0);
  assert.equal(db.subUpsert.length, 0, "and there is nothing to mirror either");
});

test("a 200 whose body has no `subscriber` wrapper FAILS the sync instead of revoking", async (t) => {
  // The mass-revocation scenario: RevenueCat changes its response shape, or
  // returns a partial body during an incident. Degrading that to `{}` would
  // revoke every paying account that syncs. It must throw so the webhook parks
  // the event as `failed` and retries.
  for (const body of ['{"request_date":"2026-08-12"}', '{"subscriber":null}', '"a string"', "[]"]) {
    const db = stubSync(t, () => new Response(body, { status: 200 }));

    await assert.rejects(
      () => syncUserFromRevenueCat(USER),
      (err: unknown) => {
        assert.equal((err as Error).name, "RevenueCatApiError");
        return true;
      },
      `body ${body} must fail the sync`,
    );

    assert.equal(db.subSweep.length, 0, "no revocation may be written on a body we cannot read");
    assert.equal(db.purchaseSweep.length, 0);
  }
});

test("an unreadable JSON body likewise fails rather than revoking", async (t) => {
  const db = stubSync(t, () => new Response("not json at all", { status: 200 }));

  await assert.rejects(() => syncUserFromRevenueCat(USER), /RevenueCatApiError|not JSON/);
  assert.equal(db.subSweep.length, 0);
  assert.equal(db.purchaseSweep.length, 0);
});

test("a refused or broken HTTP answer fails the sync — 401/403/429/5xx revoke NOTHING", async (t) => {
  // Every one of these is a way for an incident (a rotated key, a rate limit, a
  // bad gateway) to look like "this customer owns nothing" if the code ever
  // degraded an error to an empty subscriber. One stub, re-aimed per status, so
  // the global `fetch` is restored exactly once.
  let status = 500;
  const db = stubSync(t, () => new Response("", { status }));

  for (status of [400, 401, 403, 409, 429, 500, 502, 503, 504]) {
    await assert.rejects(
      () => syncUserFromRevenueCat(USER),
      (err: unknown) => {
        assert.equal((err as Error).name, "RevenueCatApiError");
        assert.equal((err as { status?: number }).status, status, "the status is carried, for the log");
        return true;
      },
      `HTTP ${status} must fail the sync`,
    );
    assert.equal(db.subSweep.length, 0, `HTTP ${status} must revoke nothing`);
    assert.equal(db.purchaseSweep.length, 0);
    assert.equal(db.subUpsert.length, 0);
    assert.equal(db.purchaseUpsert.length, 0);
  }
});

test("a network error fails the sync — the throw carries no status and no body", async (t) => {
  const db = stubSync(t, () => {
    throw new Error("ECONNRESET");
  });

  await assert.rejects(
    () => syncUserFromRevenueCat(USER),
    (err: unknown) => {
      assert.equal((err as Error).name, "RevenueCatApiError");
      assert.equal((err as { status?: number }).status, undefined);
      assert.match((err as Error).message, /unreachable/);
      return true;
    },
  );
  assert.equal(db.subSweep.length, 0);
  assert.equal(db.purchaseSweep.length, 0);
});

test("a HUNG RevenueCat aborts on the deadline, fails the sync, and revokes nothing", async (t) => {
  // The failure with no HTTP answer at all. Driven by mock timers rather than a
  // real ten-second wait: the point is that the AbortController fires, the
  // rejection is caught as an unreachable upstream, and — the part that matters
  // — a request that never answered cannot be read as an empty customer.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let signal: AbortSignal | undefined;
  const db = stubSync(
    t,
    (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        signal = init.signal;
        assert.ok(signal instanceof AbortSignal, "the request must carry a deadline at all");
        assert.equal(signal.aborted, false, "…and must not start already aborted");
        signal.addEventListener("abort", () => reject(signal!.reason ?? new Error("aborted")));
      }),
  );

  const pending = syncUserFromRevenueCat(USER);
  t.mock.timers.tick(10_000);
  assert.equal(signal?.aborted, true, "the ten-second deadline is what ended it");

  await assert.rejects(pending, (err: unknown) => {
    assert.equal((err as Error).name, "RevenueCatApiError");
    assert.match((err as Error).message, /unreachable/);
    return true;
  });
  assert.equal(db.subSweep.length, 0, "a request that never answered must not revoke a licence");
  assert.equal(db.purchaseSweep.length, 0);
});

/* ── the transfer policy: "Transfer to new App User ID" ─────────────────── */

/*
 * The RevenueCat dashboard is configured with TRANSFER TO NEW APP USER ID, and
 * that choice is what these tests describe. It means one Apple receipt belongs
 * to exactly one of our accounts at a time: sign into the app as B on a phone
 * whose Apple ID bought as A, and RevenueCat MOVES the receipt — B's subscriber
 * gains it and A's loses it. (The alternative policy, keeping it on the original
 * app_user_id, would make "Restore" on a second account a no-op instead.)
 *
 * Everything below is the consequence: our mirror must move the licence too, in
 * both directions, from nothing but the two re-fetched snapshots.
 */

const OTHER_USER = "507f1f77bcf86cd799439022";
const LIFETIME = RC_LIFETIME_PRODUCT_IDS[0];

/** A subscriber holding the one Apple lifetime. */
const lifetimeSubscriber = (): RcSubscriber => ({
  subscriptions: {},
  non_subscriptions: {
    [LIFETIME]: [{ id: "txn-life", purchase_date: PAST, store: "app_store", is_sandbox: false }],
  },
  entitlements: { pro: { product_identifier: LIFETIME } },
});

/** The row USER held before the receipt moved: a granting Apple lifetime. */
const lifetimeRow = (userId: string): Row => ({
  userId,
  provider: RC_PROVIDER,
  externalId: `${userId}:${LIFETIME}`,
  productId: LIFETIME,
  isRefunded: false,
  revokedAt: null,
});

/**
 * The transfer, run in a chosen order. RevenueCat has moved the receipt from
 * USER to OTHER_USER, so OTHER_USER's re-fetch holds the lifetime and USER's
 * comes back 200-with-empty-collections — "I own nothing now", authoritatively.
 */
async function runTransfer(t: Ctx, syncOrder: readonly string[]) {
  const store = tables({ purchases: [lifetimeRow(USER)] });
  const db = stubSync(t, okFor({ [OTHER_USER]: lifetimeSubscriber() }), store);
  for (const userId of syncOrder) await syncUserFromRevenueCat(userId);
  return { store, db };
}

/** Rows that still grant: a Purchase grants while it is not refunded. */
const granting = (purchases: Row[]) => purchases.filter((p) => !p.isRefunded);

test("a transferred lifetime MOVES: the new account gains it, the old one loses it", async (t) => {
  const { store } = await runTransfer(t, [OTHER_USER, USER]);

  assert.equal(granting(store.purchases).length, 1, "one Apple receipt grants to ONE account");
  assert.equal(granting(store.purchases)[0].userId, OTHER_USER);
  assert.equal(granting(store.purchases)[0].externalId, `${OTHER_USER}:${LIFETIME}`);

  const loser = store.purchases.find((p) => p.userId === USER)!;
  assert.equal(loser.isRefunded, true, "the leak was this row staying granting for ever");
  assert.ok(loser.revokedAt instanceof Date, "revoked, never deleted — the row is the audit trail");
});

test("the same transfer with the events REVERSED converges on the same one owner", async (t) => {
  // The loser's event arriving first is the ordinary case, not the exotic one:
  // RevenueCat sends one TRANSFER naming both sides, and nothing promises which
  // half we process first. Neither order may leave two live lifetimes.
  const { store } = await runTransfer(t, [USER, OTHER_USER]);

  assert.equal(granting(store.purchases).length, 1);
  assert.equal(granting(store.purchases)[0].userId, OTHER_USER);
});

test("a DUPLICATE delivery of the transfer changes nothing — re-running is a no-op", async (t) => {
  const { store, db } = await runTransfer(t, [OTHER_USER, USER, OTHER_USER, USER]);

  assert.equal(granting(store.purchases).length, 1);
  assert.equal(granting(store.purchases)[0].userId, OTHER_USER);
  assert.equal(db.purchaseSweep.length, 4, "each sync sweeps; the second pair simply finds it done");
});

test("the sweep of a transfer-loser spares Lemon Squeezy, other accounts and the comp", async (t) => {
  const store = tables({
    subscriptions: [
      { userId: USER, provider: RC_PROVIDER, externalId: `${USER}:${RC_PRODUCT_MONTHLY}`, status: "active", willRenew: true },
      { userId: USER, provider: "lemonsqueezy", externalId: "ls-sub-77", status: "active", willRenew: true },
      { userId: OTHER_USER, provider: RC_PROVIDER, externalId: `${OTHER_USER}:${RC_PRODUCT_MONTHLY}`, status: "active", willRenew: true },
    ],
    purchases: [
      lifetimeRow(USER),
      { userId: USER, provider: "lemonsqueezy", externalId: "ls-order-42", isRefunded: false, revokedAt: null },
      lifetimeRow(OTHER_USER),
    ],
  });
  // An admin comp is not a billing row at all — it is `User.compActive`. The
  // only way this sync could take one away is by writing to User, so that is
  // what is watched.
  const userUpdate = stubMethod(t, prisma.user as any, "update", async () => ({}));
  const db = stubSync(t, ok({}), store);

  await syncUserFromRevenueCat(USER);

  // THE WHERE ITSELF: one provider, one user, and no third clause that could
  // widen it. Asserted explicitly because it is the guarantee, not an artefact.
  for (const sweep of [db.subSweep, db.purchaseSweep]) {
    const where = sweep[0][0].where;
    assert.equal(where.provider, RC_PROVIDER, "never inter-provider");
    assert.equal(where.userId, USER, "never inter-user");
    assert.equal(Object.keys(where).sort().join(","), "externalId,provider,userId");
  }

  // …and what that scope spares once the writes are actually applied.
  assert.equal(store.find(store.subscriptions, USER, RC_PROVIDER).status, "expired");
  assert.equal(
    store.find(store.subscriptions, USER, "lemonsqueezy").status,
    "active",
    "a valid Lemon Squeezy subscription is not RevenueCat's to revoke",
  );
  assert.equal(
    store.find(store.subscriptions, OTHER_USER, RC_PROVIDER).status,
    "active",
    "another account's rows are never in range",
  );
  assert.equal(store.find(store.purchases, USER, RC_PROVIDER).isRefunded, true);
  assert.equal(
    store.find(store.purchases, USER, "lemonsqueezy").isRefunded,
    false,
    "a desktop lifetime survives an Apple receipt moving away",
  );
  assert.equal(store.find(store.purchases, OTHER_USER, RC_PROVIDER).isRefunded, false);
  assert.equal(userUpdate.length, 0, "the sweep cannot reach an admin grant");
});

test("two refreshes racing on one account never tear a snapshot in half", async (t) => {
  /*
   * HONEST LIMIT FIRST: this harness interleaves only at await points, so what
   * follows is not proof against a genuine two-process race — that needs the
   * database, and Mongo gives no cross-document transaction here. What it does
   * pin is the property that makes such a race survivable: every write is a
   * WHOLE snapshot (upserts then a sweep derived from the same fetch), so two
   * racers can only leave one of their two coherent outcomes, never a mixture
   * — and because each sync re-reads the truth, the next one converges.
   *
   * The interleaving forced here is the worst one available: the SLOW reader
   * saw the pre-transfer state and gets to write it AFTER the fast reader has
   * already swept everything away.
   */
  const store = tables({
    subscriptions: [
      { userId: USER, provider: RC_PROVIDER, externalId: `${USER}:${RC_PRODUCT_MONTHLY}`, status: "active", willRenew: true },
    ],
    purchases: [lifetimeRow(USER)],
  });
  const stale: RcSubscriber = {
    subscriptions: { [RC_PRODUCT_MONTHLY]: { expires_date: FUTURE, period_type: "normal" } },
    non_subscriptions: lifetimeSubscriber().non_subscriptions,
    entitlements: { pro: { product_identifier: LIFETIME } },
  };
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let call = 0;
  stubSync(
    t,
    async () => {
      call += 1;
      if (call === 1) await gate; // the slow reader, holding the pre-transfer truth
      const subscriber = call === 1 ? stale : {};
      return new Response(JSON.stringify({ subscriber }), { status: 200 });
    },
    store,
  );

  const slow = syncUserFromRevenueCat(USER);
  const fast = syncUserFromRevenueCat(USER);
  await fast; // sweeps everything: the transfer already happened
  release();
  await slow; // …and writes its whole stale snapshot on top

  // One coherent outcome, whichever won. What must NEVER appear is a mixture:
  // a live subscription beside a revoked lifetime, or the reverse — that would
  // be one snapshot's subscriptions with the other's purchases.
  const shape = {
    sub: store.subscriptions[0].status,
    lifetimeGone: store.purchases[0].isRefunded,
  };
  assert.ok(
    [
      { sub: "active", lifetimeGone: false }, // the stale snapshot, whole
      { sub: "expired", lifetimeGone: true }, // the fresh one, whole
    ].some((c) => c.sub === shape.sub && c.lifetimeGone === shape.lifetimeGone),
    `torn state: ${JSON.stringify(shape)}`,
  );

  // …and the next sync is authoritative, whatever the race left behind.
  await syncUserFromRevenueCat(USER);
  assert.equal(store.subscriptions[0].status, "expired");
  assert.equal(store.purchases[0].isRefunded, true);
});

/* ── sandbox and production, side by side ───────────────────────────────── */

/*
 * There is no staging deploy: one Vercel project, one Atlas database. So
 * sandbox transactions arrive at the SAME backend, for the same accounts, as
 * real money — and the only thing that separates them is the `testMode` stamp
 * these rows carry plus the read-time gate that hides it. Which makes the
 * cohabitation of the two worlds on ONE account a first-class case, not a
 * curiosity: the customer it happens to is the one who paid us and then helped
 * us test.
 */

test("a sandbox lifetime and a paid one are SEPARATE rows — testing never stamps the paid one", () => {
  // The bug this shape exists to prevent: `non_subscriptions[product]` is a
  // LIST, so a TestFlight purchase sits in it beside the real one. Taking the
  // last entry would land the sandbox purchase on the paid row, stamp it
  // testMode, and hide a licence the customer owns.
  const plan = projectSubscriber(
    USER,
    {
      non_subscriptions: {
        [LIFETIME]: [
          { id: "txn-paid", purchase_date: PAST, is_sandbox: false },
          { id: "txn-testflight", purchase_date: "2026-08-12T09:00:00.000Z", is_sandbox: true },
        ],
      },
      entitlements: { pro: { product_identifier: LIFETIME } },
    },
    NOW,
  );

  assert.equal(plan.purchases.length, 2, "one row per environment, never one row for both");
  const paid = plan.purchases.find((p) => p.data.environment === "production")!;
  const sandbox = plan.purchases.find((p) => p.data.environment === "sandbox")!;
  assert.equal(paid.externalId, `${USER}:${LIFETIME}`);
  assert.equal(paid.data.testMode, false, "the paid row is untouched by the TestFlight session");
  assert.equal(paid.data.isRefunded, false, "and still grants");
  assert.equal(paid.data.purchasedAt.toISOString(), PAST, "…with its own purchase date");
  assert.equal(sandbox.externalId, `${USER}:${LIFETIME}:sandbox`);
  assert.equal(sandbox.data.testMode, true);
});

test("both rows stay in the plan, so the sweep revokes neither", async (t) => {
  const store = tables({
    purchases: [lifetimeRow(USER), { ...lifetimeRow(USER), externalId: `${USER}:${LIFETIME}:sandbox` }],
  });
  const db = stubSync(
    t,
    ok({
      non_subscriptions: {
        [LIFETIME]: [
          { id: "txn-paid", purchase_date: PAST, is_sandbox: false },
          { id: "txn-testflight", purchase_date: PAST, is_sandbox: true },
        ],
      },
      entitlements: { pro: { product_identifier: LIFETIME } },
    }),
    store,
  );

  await syncUserFromRevenueCat(USER);

  assert.deepEqual(
    [...db.purchaseSweep[0][0].where.externalId.notIn].sort(),
    [`${USER}:${LIFETIME}`, `${USER}:${LIFETIME}:sandbox`].sort(),
  );
  assert.equal(store.purchases.every((p) => !p.isRefunded), true, "neither row is swept");
});

test("within one environment the LAST entry still wins — a re-buy updates its own row", () => {
  const plan = projectSubscriber(
    USER,
    {
      non_subscriptions: {
        [LIFETIME]: [
          { id: "txn-refunded", purchase_date: PAST, is_refunded: true },
          { id: "txn-rebought", purchase_date: "2026-08-10T00:00:00.000Z" },
        ],
      },
      entitlements: { pro: { product_identifier: LIFETIME } },
    },
    NOW,
  );

  assert.equal(plan.purchases.length, 1, "one environment, one row");
  assert.equal(plan.purchases[0].externalId, `${USER}:${LIFETIME}`);
  assert.equal(plan.purchases[0].data.isRefunded, false, "the re-buy restores the same row");
});

test("nothing in the projection can turn a sandbox transaction into a production right", () => {
  // The environment is read from RevenueCat's own `is_sandbox` and from
  // nothing else — no combination of dates, period types or refund flags may
  // launder a free StoreKit purchase into a production row.
  for (const expires of [FUTURE, PAST, null])
    for (const period of ["normal", "trial", "intro", undefined])
      for (const refunded of [PAST, null]) {
        const row = onlySub(
          subscriberWith({
            expires_date: expires,
            period_type: period,
            refunded_at: refunded,
            is_sandbox: true,
          }),
        );
        assert.equal(row.data.environment, "sandbox");
        assert.equal(row.data.testMode, true);
      }

  for (const refunded of [true, false, undefined]) {
    const plan = projectSubscriber(
      USER,
      {
        non_subscriptions: { [LIFETIME]: [{ id: "t", purchase_date: PAST, is_sandbox: true, is_refunded: refunded }] },
        entitlements: { pro: { product_identifier: LIFETIME } },
      },
      NOW,
    );
    assert.equal(plan.purchases[0].data.environment, "sandbox");
    assert.equal(plan.purchases[0].data.testMode, true);
    assert.equal(plan.purchases[0].externalId, `${USER}:${LIFETIME}:sandbox`);
  }
});

/* ── KI-2: an iPhone lifetime stops the desktop billing ─────────────────── */

/*
 * The double-billing hole this section pins shut: the Lemon Squeezy order
 * webhook has always cancelled the buyer's recurring plan when a DESKTOP
 * lifetime lands, but a lifetime bought on the iPhone arrived through this
 * sync and cancelled nothing — a monthly desktop subscriber who upgraded on
 * iOS kept the licence AND the live monthly charge. The sync now feeds the
 * SAME outbox-backed cancellation the webhook uses, so these tests drive
 * `syncUserFromRevenueCat` and watch the outbox.
 */

/** Pin the sandbox gate, whatever the ambient environment says. */
function sandboxGate(t: Ctx, gate: { allow: boolean; listed: string[] }) {
  const before = {
    allow: env.revenuecatAllowSandbox,
    listed: env.revenuecatSandboxAllowedUserIds,
  };
  (env as any).revenuecatAllowSandbox = gate.allow;
  (env as any).revenuecatSandboxAllowedUserIds = gate.listed;
  t.after(() => {
    (env as any).revenuecatAllowSandbox = before.allow;
    (env as any).revenuecatSandboxAllowedUserIds = before.listed;
  });
}

/** The recurring Lemon Squeezy plan the lifetime buyer still holds. */
const lsRecurring = (status = "active"): Row => ({
  userId: USER,
  provider: "lemonsqueezy",
  externalId: "ls-sub-77",
  status,
  validUntil: new Date(NOW.getTime() + 20 * 86_400_000),
  trialEndsAt: null,
  trialCancelledAt: null,
  pauseMode: null,
  providerUpdatedAt: NOW,
  createdAt: NOW,
  variantId: "1986433",
  updatedAt: NOW,
});

/**
 * The outbox, watched. The claim answers "a drain is already on it" so the
 * inline attempt never reaches the provider — the ENQUEUE is the fact under
 * test, exactly as the outbox design intends: never lose the instruction.
 */
function stubOutbox(t: Ctx, task: () => any = () => null) {
  const reads = stubMethod(t, prisma.billingTask as any, "findUnique", async () => task());
  const created = stubMethod(t, prisma.billingTask as any, "create", async (a: any) => a.data);
  stubMethod(t, prisma.billingTask as any, "updateMany", async () => ({ count: 0 }));
  const reopened = stubMethod(t, prisma.billingTask as any, "update", async (a: any) => a.data);
  return { reads, created, reopened };
}

test("a production iPhone lifetime enqueues the cancellation of the recurring LS plan", async (t) => {
  sandboxGate(t, { allow: false, listed: [] });
  stubSync(t, ok(lifetimeSubscriber()));
  const lsReads = stubMethod(t, prisma.subscription as any, "findMany", async () => [lsRecurring()]);
  const outbox = stubOutbox(t);

  await syncUserFromRevenueCat(USER);

  // Scoped exactly like the webhook's own call: this user's LS rows only.
  assert.equal(lsReads.length, 1);
  assert.equal(lsReads[0][0].where.userId, USER);
  assert.equal(lsReads[0][0].where.provider, "lemonsqueezy");
  // The instruction is durably written, through the same outbox as the webhook.
  assert.equal(outbox.created.length, 1);
  assert.equal(outbox.created[0][0].data.externalId, "ls-sub-77");
  assert.equal(outbox.created[0][0].data.kind, "cancel");
  assert.equal(outbox.created[0][0].data.reason, "lifetime-upgrade");
});

test("a SANDBOX lifetime on an unlisted account cancels nothing", async (t) => {
  // A StoreKit sandbox purchase costs nothing and is signed like a real one.
  // The read gate refuses it access; the same gate must refuse it the power to
  // cancel a subscription someone is genuinely paying for.
  sandboxGate(t, { allow: false, listed: [] });
  stubSync(
    t,
    ok({
      non_subscriptions: {
        [LIFETIME]: [{ id: "txn-sandbox", purchase_date: PAST, is_sandbox: true }],
      },
      entitlements: { pro: { product_identifier: LIFETIME } },
    }),
  );
  const lsReads = stubMethod(t, prisma.subscription as any, "findMany", async () => [lsRecurring()]);
  const outbox = stubOutbox(t);

  await syncUserFromRevenueCat(USER);

  assert.equal(lsReads.length, 0, "the LS rows are never even read");
  assert.equal(outbox.created.length, 0);
});

test("a REFUNDED lifetime cancels nothing — money returned is not an upgrade", async (t) => {
  sandboxGate(t, { allow: false, listed: [] });
  stubSync(
    t,
    ok({
      non_subscriptions: {
        [LIFETIME]: [{ id: "txn-life", purchase_date: PAST, is_sandbox: false, is_refunded: true }],
      },
      entitlements: { pro: { product_identifier: LIFETIME } },
    }),
  );
  const lsReads = stubMethod(t, prisma.subscription as any, "findMany", async () => [lsRecurring()]);
  const outbox = stubOutbox(t);

  await syncUserFromRevenueCat(USER);

  assert.equal(lsReads.length, 0);
  assert.equal(outbox.created.length, 0);
});

test("a second sync does not re-open the task once the plan is cancelled and settled", async (t) => {
  // Idempotency is the outbox's, inherited for free: the first sync writes the
  // instruction down; once the provider has confirmed and the webhook has
  // mirrored the ending, every later sync must find nothing to do — not
  // re-open a settled task and cancel into the void for ever.
  sandboxGate(t, { allow: false, listed: [] });
  stubSync(t, ok(lifetimeSubscriber()));
  let lsSub = lsRecurring();
  stubMethod(t, prisma.subscription as any, "findMany", async () => [lsSub]);
  let task: any = null;
  const outbox = stubOutbox(t, () => task);
  const created = stubMethod(t, prisma.billingTask as any, "create", async (a: any) => {
    task = { id: "task-1", ...a.data };
    return task;
  });

  await syncUserFromRevenueCat(USER);
  assert.equal(created.length, 1, "the first sync writes the instruction down");

  // The provider confirmed the cancel, the webhook mirrored the new status.
  task.doneAt = new Date();
  lsSub = lsRecurring("cancelled");

  await syncUserFromRevenueCat(USER);

  assert.equal(created.length, 1, "no second task");
  assert.equal(outbox.reopened.length, 0, "and the settled one stays settled");
});

test("a broken Lemon Squeezy read cannot fail the RevenueCat sync", async (t) => {
  // The grant has already landed; the cancellation is a follow-up. A database
  // hiccup on the LS leg must cost a retry of the CANCELLATION (next sync, or
  // the drain), never the sync that records what the customer owns.
  sandboxGate(t, { allow: false, listed: [] });
  stubSync(t, ok(lifetimeSubscriber()));
  stubMethod(t, prisma.subscription as any, "findMany", async () => {
    throw new Error("replica set unavailable");
  });
  stubOutbox(t);

  const result = await syncUserFromRevenueCat(USER);
  assert.equal(result.managementUrl, null, "the sync still answers");
});
