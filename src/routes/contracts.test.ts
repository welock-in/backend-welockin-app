import assert from "node:assert/strict";
import { test } from "node:test";
import request from "supertest";
import { createApp } from "../app";
import { signToken } from "../lib/jwt";
import { prisma } from "../lib/prisma";

const app = createApp();
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

test("PC sync payload replaces blocklists, sessions, and schedules", async (t) => {
  const now = new Date("2026-07-10T10:00:00.000Z");
  stubMethod(t, prisma.syncSnapshot as any, "findUnique", async () => null);
  const upsertCalls = stubMethod(t, prisma.syncSnapshot as any, "upsert", async () => ({
    revision: 1,
    updatedAt: now,
  }));

  const res = await request(app)
    .post("/api/sync/push")
    .set(auth)
    .send({
      blocklists: [{ id: "pc-list" }],
      sessions: [{ id: "pc-session" }],
      schedules: [{ id: "pc-schedule" }],
    });

  assert.equal(res.status, 200);
  assert.equal(res.body.revision, 1);
  assert.equal(upsertCalls.length, 1);
  const args = upsertCalls[0][0] as {
    update: { blocklists: unknown[]; sessions: unknown[]; schedules: unknown[] };
  };
  assert.deepEqual(args.update.blocklists, [{ id: "pc-list" }]);
  assert.deepEqual(args.update.sessions, [{ id: "pc-session" }]);
  assert.deepEqual(args.update.schedules, [{ id: "pc-schedule" }]);
});

test("legacy mobile event push appends without overwriting the PC snapshot", async (t) => {
  const now = new Date("2026-07-10T10:00:00.000Z");
  stubMethod(t, prisma.syncSnapshot as any, "findUnique", async () => ({
    revision: 8,
    updatedAt: now,
  }));
  const snapshotUpsertCalls = stubMethod(
    t,
    prisma.syncSnapshot as any,
    "upsert",
    async () => {
      throw new Error("snapshot must not be replaced");
    },
  );
  const eventCreateCalls = stubMethod(t, prisma.focusEvent as any, "create", async (args: any) => ({
    id: "507f1f77bcf86cd799439012",
    ...args.data,
  }));

  const res = await request(app)
    .post("/api/sync/push")
    .set(auth)
    .send({
      blocklists: [{ stale: true }],
      sessions: [{ stale: true }],
      events: [
        {
          name: "Android focus",
          startedAt: 1_784_000_000_000,
          endedAt: 1_784_001_800_000,
          plannedSeconds: 1800,
          completed: true,
          hardLock: false,
          platform: "android",
        },
      ],
    });

  assert.equal(res.status, 200);
  assert.equal(res.body.revision, 8);
  assert.equal(snapshotUpsertCalls.length, 0);
  assert.equal(eventCreateCalls.length, 1);
});
