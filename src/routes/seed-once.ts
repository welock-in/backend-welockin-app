// TEMPORARY one-shot seed endpoint. Loads the bundled 500+500 addiction-protection
// blocklist into Mongo from within the deployed backend (which has DATABASE_URL),
// then is REMOVED in the follow-up push. Idempotent (upsert with update:{} — never
// clobbers admin edits). Gated by a throwaway key; the route exists only briefly.
import { Router } from "express";
import { prisma } from "../lib/prisma";
import { SEED } from "./_seed-data";

const KEY = "8861151424499e1ac55593e5709b3e844f56";

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

export const seedOnceRouter = Router();

seedOnceRouter.post("/", async (req, res) => {
  const key = (req.query.key as string | undefined) ?? (req.headers["x-seed-key"] as string | undefined);
  if (key !== KEY) {
    res.status(403).json({ error: "forbidden" });
    return;
  }

  const categories = SEED.categories ?? {};
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

  const total = await prisma.protectionEntry.count();
  res.json({ ok: true, added, kept, total });
});
