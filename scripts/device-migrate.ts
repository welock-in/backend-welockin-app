/**
 * Device identity / anti-abuse migration (Part D). Run AFTER `prisma db push`
 * and BEFORE (or with) the deploy of the new code:
 *   npm run device:migrate
 *
 * Idempotent. It:
 *   1. Backfills legacy Device docs (status=active, kind by platform,
 *      boundAt=createdAt, attestCounter=0) via RAW Mongo updates — reads through
 *      the typed client are unnecessary and would be brittle pre-column.
 *   2. Collapses any user with >1 active phone down to the most-recently-seen one
 *      (supersedes the rest) so the unique index can build.
 *   3. Creates the two partial unique indexes Prisma can't express:
 *        - one active phone per user
 *        - one (userId, deviceId) row per device
 *      plus idempotency indexes for FocusEvent.clientEventId and
 *      Break.clientBreakId. Uses $type:"string" filters so null/absent legacy
 *      values are excluded (multiple nulls would otherwise break a unique index).
 */
import { prisma } from "../src/lib/prisma";

const DESKTOP_PLATFORMS = ["windows", "macos", "mac", "linux", "desktop"];

async function backfill(): Promise<void> {
  const res = (await prisma.$runCommandRaw({
    update: "Device",
    updates: [
      { q: { status: { $exists: false } }, u: { $set: { status: "active" } }, multi: true },
      // Desktop first, then everything still missing kind → phone.
      {
        q: { kind: { $exists: false }, platform: { $in: DESKTOP_PLATFORMS } },
        u: { $set: { kind: "desktop" } },
        multi: true,
      },
      { q: { kind: { $exists: false } }, u: { $set: { kind: "phone" } }, multi: true },
      // boundAt = createdAt (pipeline update to reference another field).
      { q: { boundAt: { $exists: false } }, u: [{ $set: { boundAt: "$createdAt" } }], multi: true },
      { q: { attestCounter: { $exists: false } }, u: { $set: { attestCounter: 0 } }, multi: true },
    ],
  })) as { n?: number; nModified?: number };
  console.log(`[backfill] Device matched ${res.n ?? 0}, modified ${res.nModified ?? 0}`);
}

async function collapseMultiActivePhones(): Promise<void> {
  const phones = await prisma.device.findMany({
    where: { kind: "phone", status: "active" },
    select: { id: true, userId: true, lastSeenAt: true },
  });
  const byUser = new Map<string, { id: string; lastSeenAt: Date }[]>();
  for (const d of phones) {
    const list = byUser.get(d.userId) ?? [];
    list.push({ id: d.id, lastSeenAt: d.lastSeenAt });
    byUser.set(d.userId, list);
  }
  let superseded = 0;
  for (const [, list] of byUser) {
    if (list.length <= 1) continue;
    list.sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime());
    const stale = list.slice(1).map((d) => d.id);
    await prisma.device.updateMany({
      where: { id: { in: stale } },
      data: { status: "superseded", supersededAt: new Date() },
    });
    superseded += stale.length;
  }
  console.log(`[collapse] superseded ${superseded} extra active phone(s)`);
}

/** Remove duplicate (userId, deviceId) rows (legacy find-then-create races) so the
 *  uniq_user_deviceId index can build. Keeps the most-recently-seen row. */
async function collapseDuplicateDeviceIds(): Promise<void> {
  const rows = await prisma.device.findMany({
    where: { deviceId: { not: null } },
    select: { id: true, userId: true, deviceId: true, lastSeenAt: true },
  });
  const groups = new Map<string, { id: string; lastSeenAt: Date }[]>();
  for (const d of rows) {
    if (!d.deviceId) continue;
    const key = `${d.userId}::${d.deviceId}`;
    const list = groups.get(key) ?? [];
    list.push({ id: d.id, lastSeenAt: d.lastSeenAt });
    groups.set(key, list);
  }
  let removed = 0;
  for (const [, list] of groups) {
    if (list.length <= 1) continue;
    list.sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime());
    const dupIds = list.slice(1).map((d) => d.id);
    await prisma.device.deleteMany({ where: { id: { in: dupIds } } });
    removed += dupIds.length;
  }
  console.log(`[collapse] removed ${removed} duplicate (userId, deviceId) row(s)`);
}

/** Build each partial unique index in ISOLATION — a failure on one (e.g. residual
 *  duplicate data) must not skip the others (esp. the idempotency indexes). */
async function buildIndex(collection: string, index: Record<string, unknown>): Promise<boolean> {
  try {
    await prisma.$runCommandRaw({
      createIndexes: collection,
      indexes: [index],
    } as unknown as Parameters<typeof prisma.$runCommandRaw>[0]);
    return true;
  } catch (err) {
    console.error(
      `[indexes] FAILED ${collection}.${String(index.name)}:`,
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

async function createIndexes(): Promise<void> {
  const results = await Promise.all([
    buildIndex("Device", {
      key: { userId: 1 },
      name: "uniq_active_phone_per_user",
      unique: true,
      partialFilterExpression: { status: "active", kind: "phone" },
    }),
    buildIndex("Device", {
      key: { userId: 1, deviceId: 1 },
      name: "uniq_user_deviceId",
      unique: true,
      partialFilterExpression: { deviceId: { $type: "string" } },
    }),
    buildIndex("FocusEvent", {
      key: { userId: 1, clientEventId: 1 },
      name: "uniq_user_clientEventId",
      unique: true,
      partialFilterExpression: { clientEventId: { $type: "string" } },
    }),
    buildIndex("Break", {
      key: { userId: 1, clientBreakId: 1 },
      name: "uniq_user_clientBreakId",
      unique: true,
      partialFilterExpression: { clientBreakId: { $type: "string" } },
    }),
  ]);
  const ok = results.filter(Boolean).length;
  console.log(`[indexes] created ${ok}/${results.length} partial unique indexes`);
  if (ok < results.length) {
    throw new Error("Some indexes failed to build — resolve duplicate data and re-run.");
  }
}

async function main(): Promise<void> {
  await backfill();
  await collapseMultiActivePhones();
  await collapseDuplicateDeviceIds();
  await createIndexes();
  console.log("Device migration complete.");
}

main()
  .catch((err) => {
    console.error("Device migration failed:", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
