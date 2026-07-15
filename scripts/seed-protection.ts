/**
 * Seed the `protection` collection from data/protection-blocklist.json.
 *
 *   npm run protection:seed
 *
 * Idempotent: it only ENSURES the seed entries exist (source: "seed"). It never
 * overrides admin edits (category / active / label of an existing row), so it is
 * safe to re-run after adding new entries to the JSON.
 */
import fs from "node:fs";
import path from "node:path";
import { prisma } from "../src/lib/prisma";

type Group = { label?: string; sites?: string[]; apps?: string[] };
type Seed = { categories?: Record<string, Group> };

function normalizeValue(kind: "site" | "app", value: string): string {
  let v = value.trim().toLowerCase();
  if (kind === "site") {
    v = v
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .split("/")[0]
      .split("?")[0]
      .split("#")[0]
      .trim();
  }
  return v;
}

async function main(): Promise<void> {
  const file = path.join(__dirname, "..", "data", "protection-blocklist.json");
  const seed = JSON.parse(fs.readFileSync(file, "utf8")) as Seed;
  const categories = seed.categories ?? {};

  let added = 0;
  let kept = 0;
  for (const [category, group] of Object.entries(categories)) {
    for (const kind of ["site", "app"] as const) {
      const list = kind === "site" ? group.sites : group.apps;
      for (const raw of list ?? []) {
        const value = normalizeValue(kind, raw);
        if (!value) continue;
        const existing = await prisma.protectionEntry.findUnique({
          where: { kind_value: { kind, value } },
        });
        await prisma.protectionEntry.upsert({
          where: { kind_value: { kind, value } },
          update: {}, // never override admin edits — only ensure existence
          create: {
            category,
            kind,
            value,
            label: group.label ?? null,
            platform: "all",
            active: true,
            source: "seed",
          },
        });
        if (existing) kept += 1;
        else added += 1;
      }
    }
  }
  console.log(`seed-protection: ${added} added, ${kept} already present`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
