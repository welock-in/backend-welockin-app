import assert from "node:assert/strict";
import { test } from "node:test";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { upsertFocusEvent } from "./focus-events";
import { focusEventInputSchema } from "../validation/schemas";

function stubMethod(
  t: { after: (fn: () => void) => void },
  target: Record<string, any>,
  name: string,
  implementation: (...args: any[]) => any,
) {
  const original = target[name];
  target[name] = implementation;
  t.after(() => {
    target[name] = original;
  });
}

test("concurrent replay of one clientEventId stores one event", async (t) => {
  const stored = new Map<string, any>();
  stubMethod(t, prisma.focusEvent as any, "findFirst", async () => null);
  stubMethod(t, prisma.focusEvent as any, "findUnique", async (args: any) => {
    return stored.get(args.where.id) ?? null;
  });
  stubMethod(t, prisma.focusEvent as any, "create", async (args: any) => {
    const id = args.data.id as string;
    if (stored.has(id)) {
      throw new Prisma.PrismaClientKnownRequestError("duplicate event", {
        code: "P2002",
        clientVersion: "5.22.0",
      });
    }
    const event = { ...args.data, createdAt: new Date() };
    stored.set(id, event);
    return event;
  });

  const input = focusEventInputSchema.parse({
    name: "Offline mobile focus",
    startedAt: 1_784_000_000_000,
    endedAt: 1_784_001_800_000,
    plannedSeconds: 1800,
    completed: true,
    hardLock: true,
    platform: "android",
    clientEventId: "mobile-event-42",
  });

  const results = await Promise.all([
    upsertFocusEvent("507f1f77bcf86cd799439011", input),
    upsertFocusEvent("507f1f77bcf86cd799439011", input),
  ]);

  assert.equal(stored.size, 1);
  assert.equal(results.filter((result) => result.deduped).length, 1);
  assert.equal(results[0].event.id, results[1].event.id);
});
