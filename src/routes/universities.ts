import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/async-handler";
import { clientIp, consumeRateLimit } from "../lib/rate-limit";

export const universitiesRouter = Router();

type RorName = { value: string; types: string[] };
type RorRecord = {
  id: string;
  status: string;
  types: string[];
  names: RorName[];
  locations: { geonames_details?: { name?: string; country_name?: string } }[];
};
export type UniversityResult = { id: string; n: string; c: string; city: string | null };

const querySchema = z.string().trim().min(2).max(80);
const CACHE_MS = 60 * 60 * 1000;
const cache = new Map<string, { until: number; items: UniversityResult[] }>();
const inFlight = new Map<string, Promise<UniversityResult[]>>();

const fold = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
// ROR uses Elasticsearch query syntax. Keep user punctuation literal; only
// the wildcard/fuzzy operators we add below should affect the search.
const escapeRorTerm = (value: string) => value.replace(/([+\-=!(){}\[\]^"~*?:\\/|&])/g, "\\$1");

function rank(record: RorRecord, q: string): number {
  const names = record.names.map((name) => fold(name.value));
  if (names.some((name) => name === q)) return 0;
  if (names.some((name) => name.startsWith(q))) return 1;
  if (names.some((name) => name.split(/[^\p{L}\p{N}]+/u).some((word) => word.startsWith(q)))) return 2;
  if (names.some((name) => name.includes(q))) return 3;
  return 4;
}

async function rorQuery(query: string): Promise<RorRecord[]> {
  const url = new URL("https://api.ror.org/v2/organizations");
  url.searchParams.set("query", query);
  url.searchParams.set("filter", "types:education");
  const response = await fetch(url, {
    signal: AbortSignal.timeout(4000),
    headers: { Accept: "application/json", "User-Agent": "WeLockIn university search (https://welock.in)" },
  });
  if (!response.ok) throw new Error(`ROR HTTP ${response.status}`);
  const body = await response.json() as { items?: RorRecord[] };
  if (!Array.isArray(body.items)) throw new Error("Invalid ROR response");
  return body.items;
}

/** ROR's quick search is neither prefix nor typo tolerant. Add one bounded
 *  follow-up search only when its first page has few candidates. */
export async function searchRorUniversities(input: string): Promise<UniversityResult[]> {
  const q = fold(input.trim());
  const cached = cache.get(q);
  if (cached && cached.until > Date.now()) return cached.items;
  const running = inFlight.get(q);
  if (running) return running;
  const promise = (async () => {
    const terms = input.trim().split(/\s+/);
    const last = terms[terms.length - 1];
    const first = await rorQuery(terms.map(escapeRorTerm).join(" "));
    let records = first;
    if (records.length < 8 && last.length >= 3) {
      records = records.concat(await rorQuery([...terms.slice(0, -1).map(escapeRorTerm), `${escapeRorTerm(last)}*`].join(" ")));
    }
    // ROR's multi-word query can return 20 matches for a generic word such as
    // "Université" while silently ignoring a misspelled distinctive word.
    // Retry the first term absent from every candidate with edit distance 1.
    if (!records.some((record) => rank(record, q) < 4)) {
      const misspelled = terms.find((term) => term.length >= 5 && !records.some((record) =>
        record.names.some((name) => fold(name.value).includes(fold(term)))));
      if (misspelled) {
        const fuzzy = await rorQuery(terms.map((term) => term === misspelled ? `${escapeRorTerm(term)}~1` : escapeRorTerm(term)).join(" "));
        records = fuzzy.concat(records);
      }
    }
    const unique = new Map<string, RorRecord>();
    for (const record of records) {
      if (record.status === "active" && record.types.includes("education")) unique.set(record.id, record);
    }
    const items = [...unique.values()]
      .sort((a, b) => rank(a, q) - rank(b, q))
      .slice(0, 15)
      .map((record) => {
        const name = record.names.find((entry) => entry.types.includes("ror_display"))?.value;
        const location = record.locations[0]?.geonames_details;
        return { id: record.id, n: name ?? record.names[0]?.value ?? "", c: location?.country_name ?? "", city: location?.name ?? null };
      })
      .filter((item) => item.n);
    if (cache.size >= 500) cache.delete(cache.keys().next().value!);
    cache.set(q, { until: Date.now() + CACHE_MS, items });
    return items;
  })().finally(() => inFlight.delete(q));
  inFlight.set(q, promise);
  return promise;
}

universitiesRouter.get("/", asyncHandler(async (req, res) => {
  const parsed = querySchema.safeParse(req.query.q);
  if (!parsed.success) {
    res.status(400).json({ error: "Search query must be 2–80 characters." });
    return;
  }
  await consumeRateLimit(`university-search:${clientIp(req)}`, 120, 60_000);
  try {
    res.json({ items: await searchRorUniversities(parsed.data) });
  } catch (error) {
    console.warn("[universities] ROR unavailable", error);
    res.status(503).json({ error: "University search is temporarily unavailable." });
  }
}));
