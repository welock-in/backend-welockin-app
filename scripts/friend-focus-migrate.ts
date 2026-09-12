import { PrismaClient } from "@prisma/client";

/**
 * Create only the indexes Friend Focus needs. This is safe to run repeatedly
 * and intentionally avoids `prisma db push`, which could reconcile unrelated
 * indexes in the production Mongo database.
 */
const prisma = new PrismaClient();

async function buildIndex(collection: string, index: Record<string, unknown>): Promise<void> {
  await prisma.$runCommandRaw({
    createIndexes: collection,
    indexes: [index],
  } as unknown as Parameters<typeof prisma.$runCommandRaw>[0]);
  console.log(`[friend-focus] ${collection}.${String(index.name)} ready`);
}

async function main(): Promise<void> {
  await buildIndex("FriendFocusRoom", {
    key: { inviteCode: 1 },
    name: "FriendFocusRoom_inviteCode_key",
    unique: true,
  });
  await buildIndex("FriendFocusRoom", {
    key: { hostUserId: 1, status: 1 },
    name: "FriendFocusRoom_hostUserId_status_idx",
  });
  await buildIndex("FriendFocusRoom", {
    key: { expiresAt: 1 },
    name: "FriendFocusRoom_expiresAt_idx",
  });
  await buildIndex("FriendFocusMember", {
    key: { roomId: 1, userId: 1 },
    name: "FriendFocusMember_roomId_userId_key",
    unique: true,
  });
  await buildIndex("FriendFocusMember", {
    key: { userId: 1, joinedAt: 1 },
    name: "FriendFocusMember_userId_joinedAt_idx",
  });
}

main()
  .catch((error) => {
    console.error("Friend Focus migration failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
