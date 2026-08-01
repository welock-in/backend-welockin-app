import { Router } from "express";
import type { Release } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { asyncHandler } from "../middleware/async-handler";
import { compare, isValid } from "../lib/semver";

// Desktop auto-update manifest. PUBLIC and unauthenticated by design — a client
// that can't reach it must simply keep working, and requiring a token would mean
// a signed-out machine could never receive a security fix.
//
// Two rules govern everything here:
//
//  1. FAIL SAFE. Any doubt — bad params, no release, feature off, an error —
//     answers 204, which the Tauri updater reads as "you're up to date". The
//     updater must never be able to break the app.
//  2. NEVER SERVE BYTES. Vercel functions cap responses around 4.5 MB and the
//     installer is ~8 MB, so the manifest only ever points at R2.

export const updatesRouter = Router();

/** Master break-glass switch. Unlike a per-release pause, this needs a redeploy. */
const UPDATES_ENABLED = (process.env.UPDATES_ENABLED ?? "true") === "true";

// The manifest is identical for everyone in a given (arch, bucket, version), so
// it caches extremely well. `stale-if-error` means a full backend outage still
// serves the last known answer from the edge for a day.
const CACHE = "public, max-age=30, s-maxage=60, stale-while-revalidate=600, stale-if-error=86400";

/** 204 is "nothing to offer" — the safe answer for every failure path. */
function nothing(res: import("express").Response): void {
  res.setHeader("Cache-Control", CACHE);
  res.status(204).end();
}

// A tiny in-process cache. Warm serverless containers then answer with zero
// Mongo round-trips, which on this stack is the dominant cost.
const TTL_MS = 30_000;
let cached: { at: number; key: string; row: Release | null } | null = null;

async function liveRelease(target: string, arch: string): Promise<Release | null> {
  const key = `${target}/${arch}`;
  if (cached && cached.key === key && Date.now() - cached.at < TTL_MS) return cached.row;

  const row = await prisma.release.findFirst({
    where: { channel: "stable", target, arch, status: "live" },
    orderBy: { versionKey: "desc" },
  });
  cached = { at: Date.now(), key, row };
  return row;
}

/** Let a write path drop the cache so a pause takes effect immediately here. */
export function invalidateReleaseCache(): void {
  cached = null;
}

/**
 * Is this client's bucket inside the rollout?
 *
 * `stable` is the literal bucket a client falls back to when it can't compute
 * its own; it only ever gets a fully-rolled-out release, so a fallback can never
 * land someone in a canary.
 */
function inRollout(bucket: string, r: Release): boolean {
  if (r.rolloutPercent >= 100) return true;
  if (bucket === "stable") return false;
  const b = Number(bucket);
  if (!Number.isInteger(b) || b < 0 || b > 99) return false;
  return (b - r.rolloutOffset + 100) % 100 < r.rolloutPercent;
}

/**
 * GET /api/updates/:target/:arch/:bucket/:version
 *
 * 200 + manifest when an eligible newer release exists, 204 otherwise.
 * The response shape is Tauri updater v2's "dynamic" format.
 */
updatesRouter.get(
  "/:target/:arch/:bucket/:version",
  asyncHandler(async (req, res) => {
    if (!UPDATES_ENABLED) return nothing(res);

    const { target, arch, bucket, version } = req.params;

    // Validate before touching the DB, so a crafted path can't cost us a query.
    if (target !== "windows" || arch !== "x86_64") return nothing(res);
    if (!/^([0-9]|[1-9][0-9]|stable)$/.test(bucket)) return nothing(res);
    if (!isValid(version)) return nothing(res);

    const rel = await liveRelease(target, arch);
    if (!rel) return nothing(res);
    // Strictly newer only. Tauri would ignore a same-or-older version anyway,
    // but answering 204 keeps the common "already current" case cheap.
    if (compare(rel.version, version) <= 0) return nothing(res);
    if (!inRollout(bucket, rel)) return nothing(res);

    res.setHeader("Cache-Control", CACHE);
    res.json({
      version: rel.version,
      notes: rel.notes,
      pub_date: rel.pubDate.toISOString(),
      url: rel.url,
      signature: rel.signature,
    });
  }),
);

/**
 * GET /api/updates/download — 302 to the current fully-rolled-out installer.
 *
 * This is the permanent download link for the website, so the site's HTML never
 * changes when a version ships. A redirect has no body, so the serverless
 * response cap doesn't apply. It is also the recovery channel for a build that
 * crashes on launch and therefore can't auto-update itself.
 */
updatesRouter.get(
  "/download",
  asyncHandler(async (_req, res) => {
    const rel = await liveRelease("windows", "x86_64");
    if (!rel || rel.rolloutPercent < 100) {
      res.status(404).json({ error: "No download is available right now" });
      return;
    }
    res.setHeader("Cache-Control", "public, max-age=60, s-maxage=60");
    res.redirect(302, rel.url);
  }),
);
