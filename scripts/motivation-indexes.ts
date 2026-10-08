import "../src/lib/env";
import { PrismaClient } from "@prisma/client";

type Index = { key: Record<string, 1 | -1>; name: string; unique?: boolean };
const COLLECTIONS: Record<string, Index[]> = {
  motivation_preferences: [
    { key: { userId: 1 }, name: "uniq_motivation_user", unique: true },
    { key: { enabled: 1, nextSendAt: 1 }, name: "idx_motivation_due" },
  ],
  motivation_sends: [
    { key: { userId: 1, localDate: 1 }, name: "uniq_motivation_user_day", unique: true },
    { key: { userId: 1, createdAt: 1 }, name: "idx_motivation_recent" },
  ],
};

async function main() {
  const apply = process.argv.includes("--apply");
  const db = new PrismaClient();
  try {
    for (const [collection, expected] of Object.entries(COLLECTIONS)) {
      if (apply) {
        await db.$runCommandRaw({ createIndexes: collection, indexes: expected });
      }
      let found: Array<{ name?: string; key?: Record<string, number>; unique?: boolean }> = [];
      try {
        const result = await db.$runCommandRaw({ listIndexes: collection }) as {
          cursor?: { firstBatch?: Array<{ name?: string; key?: Record<string, number>; unique?: boolean }> };
        };
        found = result.cursor?.firstBatch ?? [];
      } catch (error) {
        if (apply) throw error;
      }
      const missing = expected.filter((want) => {
        const have = found.find((index) => index.name === want.name);
        return !have || JSON.stringify(have.key) !== JSON.stringify(want.key) ||
          Boolean(have.unique) !== Boolean(want.unique);
      }).map((index) => index.name);
      console.log(JSON.stringify({ collection, mode: apply ? "apply-additive" : "verify", missing }));
      if (missing.length) process.exitCode = 1;
    }
  } finally {
    await db.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 2;
});
