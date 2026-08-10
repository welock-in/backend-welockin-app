import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { prisma } from "./prisma";
import { env } from "./env";
import {
  MAX_ATTEMPTS,
  backoffMs,
  drainCancels,
  enqueueAndAttemptCancel,
  enqueueCancel,
  replayTask,
  runCancel,
} from "./billing-tasks";

/**
 * The outbox exists because two paths owed Lemon Squeezy a cancellation and both
 * shrugged if the call failed — one of them while deleting the account that was
 * the only record of the subscription. The failure mode is a card that goes on
 * being charged with nothing left anywhere to explain it.
 *
 * So what is pinned here is DURABILITY, not the happy path: the instruction is
 * written down before it is attempted, a failure is kept and backed off, two
 * runs cannot fight over the same row, a crash mid-flight is recoverable, and a
 * task that has genuinely given up is visible instead of silently gone.
 */

/* ── a real enough Prisma double ────────────────────────────────────────────
 *
 * An in-memory store rather than per-call stubs, because the interesting
 * behaviour IS the query: the claim is an atomic conditional update, and a stub
 * that ignores its WHERE would report every concurrency test as passing.
 */

type Row = {
  id: string;
  provider: string;
  externalId: string;
  kind: string;
  reason: string;
  attempts: number;
  lastError: string | null;
  doneAt: Date | null;
  lockedAt: Date | null;
  nextAttemptAt: Date;
  createdAt: Date;
};

const DEFAULTS = (over: Partial<Row>, i: number): Row => ({
  id: over.id ?? `t${i}`,
  provider: "lemonsqueezy",
  externalId: over.externalId ?? `sub-${i}`,
  kind: "cancel",
  reason: over.reason ?? "account-deleted",
  attempts: over.attempts ?? 0,
  lastError: over.lastError ?? null,
  doneAt: over.doneAt ?? null,
  lockedAt: over.lockedAt ?? null,
  nextAttemptAt: over.nextAttemptAt ?? new Date(0),
  createdAt: over.createdAt ?? new Date(0),
  ...over,
});

/** Supports exactly the operators billing-tasks.ts uses — no more, no less. */
function matches(row: Row, where: Record<string, any>): boolean {
  for (const [k, v] of Object.entries(where)) {
    if (k === "OR") {
      if (!(v as any[]).some((sub) => matches(row, sub))) return false;
      continue;
    }
    if (k === "provider_externalId_kind") {
      if (row.provider !== v.provider || row.externalId !== v.externalId || row.kind !== v.kind) {
        return false;
      }
      continue;
    }
    const actual = (row as any)[k];
    if (v === null) {
      if (actual != null) return false;
    } else if (v instanceof Date) {
      if (!(actual instanceof Date) || actual.getTime() !== v.getTime()) return false;
    } else if (typeof v === "object") {
      const at = actual instanceof Date ? actual.getTime() : actual;
      for (const [op, bound] of Object.entries(v as Record<string, any>)) {
        const b = bound instanceof Date ? bound.getTime() : bound;
        if (op === "lte" && !(at <= b)) return false;
        if (op === "lt" && !(at < b)) return false;
        if (op === "gte" && !(at >= b)) return false;
        if (op === "gt" && !(at > b)) return false;
      }
    } else if (actual !== v) {
      return false;
    }
  }
  return true;
}

function stub(t: TestContext, target: Record<string, any>, name: string, impl: (...a: any[]) => any) {
  const original = target[name];
  target[name] = impl;
  t.after(() => {
    target[name] = original;
  });
}

function store(t: TestContext, seed: Partial<Row>[] = []) {
  const rows: Row[] = seed.map(DEFAULTS);
  let n = seed.length;
  const bt = prisma.billingTask as any;

  stub(t, bt, "findUnique", async (a: any) => rows.find((r) => matches(r, a.where)) ?? null);
  stub(t, bt, "create", async (a: any) => {
    const row = DEFAULTS(a.data, n++);
    rows.push(row);
    return row;
  });
  stub(t, bt, "update", async (a: any) => {
    const row = rows.find((r) => matches(r, a.where));
    if (!row) throw new Error("not found");
    Object.assign(row, a.data);
    return row;
  });
  stub(t, bt, "updateMany", async (a: any) => {
    const hit = rows.filter((r) => matches(r, a.where));
    for (const row of hit) Object.assign(row, a.data);
    return { count: hit.length };
  });
  stub(t, bt, "findMany", async (a: any) => {
    let hit = rows.filter((r) => matches(r, a.where ?? {}));
    if (a.orderBy?.nextAttemptAt === "asc") {
      hit = [...hit].sort((x, y) => x.nextAttemptAt.getTime() - y.nextAttemptAt.getTime());
    }
    return a.take ? hit.slice(0, a.take) : hit;
  });
  stub(t, bt, "count", async (a: any) => rows.filter((r) => matches(r, a.where ?? {})).length);

  return rows;
}

function withKey(t: TestContext) {
  const before = env.lemonSqueezyApiKey;
  (env as any).lemonSqueezyApiKey = "test-key";
  t.after(() => {
    (env as any).lemonSqueezyApiKey = before;
  });
}

function stubFetch(t: TestContext, impl: (...a: any[]) => any) {
  const original = globalThis.fetch;
  (globalThis as any).fetch = impl;
  t.after(() => {
    (globalThis as any).fetch = original;
  });
}

function quiet(t: TestContext) {
  const real = console.error;
  const lines: string[] = [];
  console.error = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  t.after(() => {
    console.error = real;
  });
  return lines;
}

/* ── the order that makes it durable ────────────────────────────────────── */

/*
 * If the call went first, a process killed mid-request — a serverless function
 * hitting its limit, a deploy rolling — would leave no trace that anything was
 * owed. That is precisely what the old best-effort fetch did every time Lemon
 * Squeezy was slow.
 */
test("the cancellation is recorded before it is attempted", async (t) => {
  withKey(t);
  const rows = store(t);
  const order: string[] = [];
  const bt = prisma.billingTask as any;
  const realCreate = bt.create;
  bt.create = async (a: any) => {
    order.push("write");
    return realCreate(a);
  };
  stubFetch(t, async () => {
    order.push("call");
    return { ok: true, status: 200 };
  });

  await enqueueAndAttemptCancel("sub-1", "account-deleted");

  assert.deepEqual(order, ["write", "call"]);
  assert.equal(rows.length, 1);
  assert.ok(rows[0].doneAt instanceof Date, "and settled once LS confirms");
});

test("the outbox keeps the provider reference and no personal data", async (t) => {
  const rows = store(t);
  await enqueueCancel("sub-42", "account-deleted");

  const row = rows[0];
  assert.equal(row.externalId, "sub-42", "enough to call DELETE /v1/subscriptions/:id");
  assert.equal(row.provider, "lemonsqueezy");
  // The account is about to be deleted; carrying its identity here would keep
  // the person on file precisely when they asked to be forgotten.
  assert.ok(!("userId" in row), "no user id");
  assert.ok(!("email" in row), "no email");
});

/* ── failures: what is retried, what is settled ─────────────────────────── */

test("Lemon Squeezy being down leaves the task owed, with a backoff", async (t) => {
  withKey(t);
  const rows = store(t, [{ externalId: "sub-1" }]);
  stubFetch(t, async () => {
    throw new Error("ECONNREFUSED");
  });

  const settled = await runCancel({ id: "t0", externalId: "sub-1", attempts: 0 });

  assert.equal(settled, false);
  assert.equal(rows[0].doneAt, null, "it never reached Lemon Squeezy");
  assert.equal(rows[0].attempts, 1);
  assert.equal(rows[0].lockedAt, null, "the lock is released so the next run may try");
  assert.ok(rows[0].nextAttemptAt.getTime() > Date.now(), "and it waits first");
});

test("429 and 5xx are retried, not treated as answers", async (t) => {
  withKey(t);
  for (const status of [429, 500, 503]) {
    await t.test(`HTTP ${status}`, async (t2) => {
      withKey(t2);
      const rows = store(t2, [{ externalId: "sub-1" }]);
      stubFetch(t2, async () => ({ ok: false, status }));

      const settled = await runCancel({ id: "t0", externalId: "sub-1", attempts: 0 });

      assert.equal(settled, false);
      assert.equal(rows[0].doneAt, null);
      assert.equal(rows[0].attempts, 1);
      assert.match(rows[0].lastError ?? "", new RegExp(String(status)));
    });
  }
});

/*
 * 404 is success, not failure. The subscription is not there to cancel, which IS
 * the state we wanted — retrying forever would be a task that can never settle,
 * sitting in the console implying a customer is being charged when they are not.
 */
test("a subscription Lemon Squeezy no longer has counts as settled", async (t) => {
  withKey(t);
  const rows = store(t, [{ externalId: "gone", attempts: 3 }]);
  stubFetch(t, async () => ({ ok: false, status: 404 }));

  assert.equal(await runCancel({ id: "t0", externalId: "gone", attempts: 3 }), true);
  assert.ok(rows[0].doneAt instanceof Date);
});

test("the backoff grows and is capped at a day", () => {
  assert.ok(backoffMs(1) < backoffMs(2));
  assert.equal(backoffMs(99), 24 * 60 * 60_000, "an outage must not push a retry into next year");
});

/* ── scheduling ─────────────────────────────────────────────────────────── */

test("a task that is not due yet is left alone", async (t) => {
  withKey(t);
  const rows = store(t, [
    { externalId: "later", nextAttemptAt: new Date(Date.now() + 60 * 60_000), attempts: 1 },
  ]);
  let called = 0;
  stubFetch(t, async () => {
    called += 1;
    return { ok: true, status: 200 };
  });

  const report = await drainCancels();

  assert.equal(report.due, 0);
  assert.equal(called, 0, "the backoff is a promise not to call, not a suggestion");
  assert.equal(rows[0].doneAt, null);
});

/*
 * TWO CRON RUNS AT ONCE. Vercel will happily overlap invocations, and an operator
 * pressing Drain during a scheduled run is the same race. The claim is an atomic
 * conditional update, so the second run finds nothing to take.
 */
test("two concurrent runs divide the work instead of duplicating it", async (t) => {
  withKey(t);
  const rows = store(t, [{ externalId: "sub-1" }, { externalId: "sub-2" }]);
  const sent: string[] = [];
  stubFetch(t, async (u: string) => {
    sent.push(String(u).split("/").pop()!);
    return { ok: true, status: 200 };
  });

  const [a, b] = await Promise.all([drainCancels(), drainCancels()]);

  assert.deepEqual(sent.sort(), ["sub-1", "sub-2"], "each subscription cancelled exactly once");
  assert.equal(a.settled + b.settled, 2);
  assert.ok(rows.every((r) => r.doneAt instanceof Date));
});

test("a lock left behind by a dead run is reclaimed, not honoured for ever", async (t) => {
  withKey(t);
  // A run that claimed this row and then died. Without an expiry the task would
  // be stranded permanently — the exact failure the outbox exists to prevent,
  // reintroduced by its own lock.
  const rows = store(t, [{ externalId: "sub-1", lockedAt: new Date(Date.now() - 60 * 60_000) }]);
  stubFetch(t, async () => ({ ok: true, status: 200 }));

  const report = await drainCancels();

  assert.equal(report.settled, 1);
  assert.ok(rows[0].doneAt instanceof Date);
});

test("a lock held by a live run is respected", async (t) => {
  withKey(t);
  store(t, [{ externalId: "sub-1", lockedAt: new Date() }]);
  let called = 0;
  stubFetch(t, async () => {
    called += 1;
    return { ok: true, status: 200 };
  });

  const report = await drainCancels();

  assert.equal(report.due, 0);
  assert.equal(called, 0);
});

/* ── crash and replay ───────────────────────────────────────────────────── */

/*
 * The crash window: the provider confirmed, and the process died before the row
 * could be marked done. The task is simply retried, the provider is asked again,
 * and it answers 404 or a harmless no-op. That is the dividend of making every
 * operation repeatable rather than chasing exactly-once.
 */
test("a crash after the provider confirmed is recovered by the next run", async (t) => {
  withKey(t);
  const rows = store(t, [{ externalId: "sub-1" }]);
  quiet(t);

  // First attempt: LS accepts, then the write that records it fails.
  stubFetch(t, async () => ({ ok: true, status: 200 }));
  const bt = prisma.billingTask as any;
  const realUpdate = bt.update;
  bt.update = async () => {
    throw new Error("process died here");
  };
  await runCancel({ id: "t0", externalId: "sub-1", attempts: 0 });
  assert.equal(rows[0].doneAt, null, "nothing was recorded");

  // The next run asks again. LS has already cancelled it, so it is gone.
  bt.update = realUpdate;
  stubFetch(t, async () => ({ ok: false, status: 404 }));
  const report = await drainCancels();

  assert.equal(report.settled, 1);
  assert.ok(rows[0].doneAt instanceof Date);
});

test("re-enqueuing a settled subscription re-opens it", async (t) => {
  // A settled task means that subscription was cancelled once. Being asked again
  // means it is live again (resumed in the customer portal, say) — and a unique
  // key that silently swallowed the second instruction would be a subscription
  // nobody ever cancels.
  const rows = store(t, [{ externalId: "sub-1", doneAt: new Date(), attempts: 4 }]);

  await enqueueCancel("sub-1", "lifetime-upgrade");

  assert.equal(rows.length, 1, "still one row — the unique key holds");
  assert.equal(rows[0].doneAt, null, "but it is owed again");
  assert.equal(rows[0].attempts, 0, "with a clean slate");
  assert.equal(rows[0].reason, "lifetime-upgrade");
});

test("re-enqueuing a PENDING task does not reset its backoff", async (t) => {
  const soon = new Date(Date.now() + 30 * 60_000);
  const rows = store(t, [{ externalId: "sub-1", attempts: 3, nextAttemptAt: soon }]);

  await enqueueCancel("sub-1", "account-deleted");

  assert.equal(rows[0].attempts, 3, "a repeat call must not hammer a struggling provider");
  assert.equal(rows[0].nextAttemptAt.getTime(), soon.getTime());
});

/* ── the dead letter ────────────────────────────────────────────────────── */

test("a task past its attempt limit is dead-lettered, reported, and not retried", async (t) => {
  withKey(t);
  const rows = store(t, [{ externalId: "stuck", attempts: MAX_ATTEMPTS }]);
  const errors = quiet(t);
  let called = 0;
  stubFetch(t, async () => {
    called += 1;
    return { ok: true, status: 200 };
  });

  const report = await drainCancels();

  assert.equal(report.due, 0, "retrying it every quarter hour for ever would bury the alert");
  assert.equal(called, 0);
  assert.equal(report.deadLettered, 1, "but it is counted");
  assert.equal(report.stillOwed, 1);
  assert.ok(
    errors.some((l) => l.includes("dead-lettered")),
    "and shouted about — this is a card still being charged",
  );
  assert.equal(rows[0].doneAt, null);
});

test("the last failing attempt names the subscription in the alert", async (t) => {
  withKey(t);
  store(t, [{ externalId: "stuck", attempts: MAX_ATTEMPTS - 1 }]);
  const errors = quiet(t);
  stubFetch(t, async () => ({ ok: false, status: 500 }));

  await runCancel({ id: "t0", externalId: "stuck", attempts: MAX_ATTEMPTS - 1 });

  assert.ok(errors.some((l) => l.includes("DEAD-LETTERED") && l.includes("stuck")));
});

test("replay puts a dead-lettered task back in the queue", async (t) => {
  withKey(t);
  const rows = store(t, [{ externalId: "stuck", attempts: MAX_ATTEMPTS, lastError: "HTTP 401" }]);

  assert.equal(await replayTask("t0"), true);
  assert.equal(rows[0].attempts, 0);
  assert.equal(rows[0].lastError, null);

  stubFetch(t, async () => ({ ok: true, status: 200 }));
  const report = await drainCancels();
  assert.equal(report.settled, 1, "and the next drain finishes it");
});

test("replaying an already-settled task is refused rather than re-sent", async (t) => {
  store(t, [{ externalId: "done", doneAt: new Date() }]);
  assert.equal(await replayTask("t0"), false);
});

/* ── never break the caller ─────────────────────────────────────────────── */

test("an unreachable database never throws into the caller", async (t) => {
  // The callers are account deletion and a licence grant. Neither may fail
  // because billing is slow: the deletion is a compliance obligation and the
  // grant is money already taken.
  withKey(t);
  const errors = quiet(t);
  stub(t, prisma.billingTask as any, "findUnique", async () => {
    throw new Error("mongo is down");
  });

  await enqueueAndAttemptCancel("sub-1", "account-deleted");

  assert.ok(errors.length > 0, "but it is never silent about it either");
});

test("no API key is a recorded failure, not a settled task", async (t) => {
  const before = env.lemonSqueezyApiKey;
  (env as any).lemonSqueezyApiKey = "";
  t.after(() => {
    (env as any).lemonSqueezyApiKey = before;
  });
  const rows = store(t, [{ externalId: "sub-1" }]);

  assert.equal(await runCancel({ id: "t0", externalId: "sub-1", attempts: 0 }), false);
  assert.equal(rows[0].doneAt, null, "a missing key must never look like a cancellation");
  assert.match(rows[0].lastError ?? "", /API key/);
});
