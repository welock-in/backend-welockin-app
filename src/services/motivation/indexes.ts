import { prisma } from "../../lib/prisma";

// New collections can be indexed additively. A successful promise is cached per
// serverless instance; concurrent cold starts may issue the same Mongo command,
// which is safe because these index names and definitions are identical.
let ready: Promise<void> | null = null;

export function ensureMotivationIndexes(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      await prisma.$runCommandRaw({ createIndexes: "motivation_preferences", indexes: [
        { key: { userId: 1 }, name: "uniq_motivation_user", unique: true },
        { key: { enabled: 1, nextSendAt: 1 }, name: "idx_motivation_due" },
      ] });
      await prisma.$runCommandRaw({ createIndexes: "motivation_sends", indexes: [
        { key: { userId: 1, localDate: 1 }, name: "uniq_motivation_user_day", unique: true },
        { key: { userId: 1, createdAt: 1 }, name: "idx_motivation_recent" },
      ] });
    })().catch((error) => {
      ready = null;
      throw error;
    });
  }
  return ready;
}
