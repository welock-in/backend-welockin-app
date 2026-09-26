import { PrismaClient } from "@prisma/client";

/** Add only the new collection's indexes; never reconcile the live schema.
 * Defaults to a dry run. Apply explicitly with an externally supplied DB URL.
 * No secrets are loaded or printed by this script. */
export const indexes = [
  { key: { requestKey: 1 }, name: "FriendFocusEvent_requestKey_key", unique: true },
  { key: { roomId: 1, sequence: 1 }, name: "FriendFocusEvent_roomId_sequence_idx" },
  { key: { actorUserId: 1 }, name: "FriendFocusEvent_actorUserId_idx" },
  { key: { expiresAt: 1 }, name: "FriendFocusEvent_expiresAt_idx", expireAfterSeconds: 0 },
];

export async function inspect(prisma: PrismaClient) {
  const hello: any = await prisma.$runCommandRaw({ hello: 1 });
  const collections: any = await prisma.$runCommandRaw({ listCollections: 1, filter: { name: "FriendFocusEvent" }, nameOnly: true });
  const exists = collections.cursor.firstBatch.length > 0;
  const result = { collection: "FriendFocusEvent", replicaSet: !!hello.setName,
    exists, documentCount: 0, expiredDocuments: 0, duplicateRequestKeyGroups: 0,
    indexes: [] as { name: string; key: Record<string, number>; unique: boolean; expireAfterSeconds: number | null }[] };
  if (exists) {
    result.documentCount = ((await prisma.$runCommandRaw({ count: "FriendFocusEvent", query: {} })) as any).n;
    const found: any = await prisma.$runCommandRaw({ listIndexes: "FriendFocusEvent", cursor: {} });
    result.indexes = found.cursor.firstBatch.map((x: any) => ({ name: x.name, key: x.key,
      unique: x.unique === true, expireAfterSeconds: x.expireAfterSeconds ?? null }));
    const duplicates: any = await prisma.$runCommandRaw({ aggregate: "FriendFocusEvent", pipeline: [
      { $group: { _id: "$requestKey", n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }, { $count: "groups" },
    ], cursor: {} });
    result.duplicateRequestKeyGroups = duplicates.cursor.firstBatch[0]?.groups ?? 0;
    result.expiredDocuments = ((await prisma.$runCommandRaw({ count: "FriendFocusEvent",
      query: { expiresAt: { $lte: { $date: new Date().toISOString() } } } })) as any).n;
  }
  return result;
}

export async function apply(prisma: PrismaClient) {
  const before = await inspect(prisma);
  if (!before.replicaSet || before.duplicateRequestKeyGroups) throw new Error("Event storage prerequisites not met");
  // An existing plain Prisma index may have the TTL index's name. Do not drop
  // or modify it implicitly: this must fail for explicit operator review.
  await prisma.$runCommandRaw({ createIndexes: "FriendFocusEvent", indexes });
  return { before, after: await inspect(prisma) };
}

async function main(): Promise<void> {
  const applying = process.argv.includes("--apply");
  if (!applying && !process.argv.includes("--inspect")) {
    console.log(JSON.stringify({ dryRun: true, collection: "FriendFocusEvent", indexes }, null, 2));
    return;
  }
  if (!process.env.DATABASE_URL) throw new Error("Supply DATABASE_URL explicitly for storage inspection or targeted indexes");
  const prisma = new PrismaClient();
  try {
    const result = applying ? await apply(prisma) : await inspect(prisma);
    console.log(JSON.stringify({ operation: applying ? "add-indexes" : "inspect-only", result }, null, 2));
  } finally { await prisma.$disconnect(); }
}

if (require.main === module) main().catch(() => {
  console.error("Friend Focus event index migration failed; no schema reconciliation was attempted");
  process.exitCode = 1;
});
