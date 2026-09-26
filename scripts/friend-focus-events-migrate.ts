import { PrismaClient } from "@prisma/client";

/** Add only the new collection's indexes; never reconcile the live schema.
 * Defaults to a dry run. Apply explicitly with an externally supplied DB URL.
 * No secrets are loaded or printed by this script. */
const indexes = [
  { key: { requestKey: 1 }, name: "FriendFocusEvent_requestKey_key", unique: true },
  { key: { roomId: 1, sequence: 1 }, name: "FriendFocusEvent_roomId_sequence_idx" },
  { key: { actorUserId: 1 }, name: "FriendFocusEvent_actorUserId_idx" },
  { key: { expiresAt: 1 }, name: "FriendFocusEvent_expiresAt_idx", expireAfterSeconds: 0 },
];

async function main(): Promise<void> {
  if (!process.argv.includes("--apply")) {
    console.log(JSON.stringify({ dryRun: true, collection: "FriendFocusEvent", indexes }, null, 2));
    return;
  }
  if (!process.env.DATABASE_URL) throw new Error("Supply DATABASE_URL explicitly before applying the targeted indexes");
  const prisma = new PrismaClient();
  try {
    await prisma.$runCommandRaw({ createIndexes: "FriendFocusEvent", indexes });
    console.log("FriendFocusEvent indexes ready; no existing collection or index was removed");
  } finally { await prisma.$disconnect(); }
}

main().catch(() => {
  console.error("Friend Focus event index migration failed; no schema reconciliation was attempted");
  process.exitCode = 1;
});
