import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAdmin } from "../middleware/admin-auth";
import { asyncHandler } from "../middleware/async-handler";
import { badRequest, notFound } from "../lib/http-error";
import { compare, isValid, toSortKey } from "../lib/semver";
import { isSupportedTarget, supportedTargetList } from "../lib/update-targets";
import { invalidateReleaseCache } from "./updates";

// Release control plane for the desktop auto-updater. Admin-only; the matching
// PUBLIC read side is routes/updates.ts.
//
// Publishing is deliberately two steps — create a draft, then publish it — so
// building a release and exposing it to the fleet are never the same action.

export const adminReleasesRouter = Router();

const versionField = z
  .string()
  .trim()
  .refine(isValid, "Must be semver, e.g. 0.2.0");

const createSchema = z
  .object({
    version: versionField,
    url: z.string().trim().url(),
    /**
     * The human-facing artifact, when it differs from `url`.
     *
     * Optional and defaulted downstream to `url`, so the Windows pipeline —
     * where the installer and the update payload are the same setup.exe — needs
     * no change. See the field's note in the schema for why macOS cannot share
     * one file.
     */
    installerUrl: z.string().trim().url().optional(),
    signature: z.string().trim().min(1),
    notes: z.string().trim().max(4000).optional().default(""),
    sha256: z.string().trim().optional(),
    sizeBytes: z.number().int().positive().optional(),
    /**
     * Optional, defaulting to Windows.
     *
     * The default is load-bearing, not politeness: the shipped Windows
     * `release.mjs` sends neither field, so making them required would break
     * the pipeline that publishes the app most people are running.
     */
    target: z.string().trim().default("windows"),
    arch: z.string().trim().default("x86_64"),
    channel: z.string().trim().default("stable"),
  })
  /**
   * Rejected as a PAIR, against the same list the public route reads.
   *
   * A free-form string here was the quiet failure mode: `"macos"` instead of
   * `"darwin"` creates a perfectly valid-looking release that publishes, ramps,
   * and reaches nobody — because the updater asks for `darwin`, and nothing
   * anywhere reports a mismatch. The typo would surface as "the Mac update
   * doesn't work", days later, with no error to search for.
   */
  .refine((v) => isSupportedTarget(v.target, v.arch), {
    message: `Unsupported target/arch. Supported: ${supportedTargetList()}`,
    path: ["target"],
  });

const publishSchema = z.object({
  rolloutPercent: z.number().int().min(0).max(100).default(0),
});

const rolloutSchema = z.object({
  rolloutPercent: z.number().int().min(0).max(100),
});

const rollbackSchema = z.object({
  /** Release id to promote back to `live`. Omit to just pull the current one. */
  promote: z.string().trim().optional(),
});

/** Cheap deterministic offset so the same buckets aren't always first. */
function offsetFor(version: string): number {
  let h = 0;
  for (const ch of version) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return Math.abs(h) % 100;
}

/** GET / — every release, newest first. */
adminReleasesRouter.get(
  "/",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const releases = await prisma.release.findMany({
      orderBy: { versionKey: "desc" },
      take: 100,
    });
    res.json({ releases });
  }),
);

/** POST / — register a freshly-built installer as a DRAFT (offered to nobody). */
adminReleasesRouter.post(
  "/",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const input = createSchema.parse(req.body);

    const existing = await prisma.release.findFirst({
      where: {
        channel: input.channel,
        target: input.target,
        arch: input.arch,
        version: input.version,
      },
    });
    // A shipped version number is burned for good: clients that already took it
    // would never see a "new" build under the same number.
    if (existing) throw badRequest(`Version ${input.version} already exists`);

    const release = await prisma.release.create({
      data: {
        ...input,
        versionKey: toSortKey(input.version),
        pubDate: new Date(),
        status: "draft",
        rolloutPercent: 0,
        rolloutOffset: offsetFor(input.version),
        createdBy: req.admin?.username ?? null,
      },
    });
    res.status(201).json(release);
  }),
);

/** POST /:id/publish — draft → live at `rolloutPercent` (default 0 = nobody). */
adminReleasesRouter.post(
  "/:id/publish",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { rolloutPercent } = publishSchema.parse(req.body ?? {});
    const rel = await prisma.release.findUnique({ where: { id: req.params.id } });
    if (!rel) throw notFound("Release not found");

    // Demote whatever was live and older, so exactly one release is ever live.
    const others = await prisma.release.findMany({
      where: { channel: rel.channel, target: rel.target, arch: rel.arch, status: "live" },
    });
    for (const o of others) {
      if (o.id !== rel.id && compare(o.version, rel.version) < 0) {
        await prisma.release.update({ where: { id: o.id }, data: { status: "superseded" } });
      }
    }

    const updated = await prisma.release.update({
      where: { id: rel.id },
      data: { status: "live", rolloutPercent, publishedAt: new Date(), pausedAt: null },
    });
    invalidateReleaseCache();
    res.json(updated);
  }),
);

/** PATCH /:id/rollout — the ramp control (1 → 5 → 25 → 50 → 100). */
adminReleasesRouter.patch(
  "/:id/rollout",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { rolloutPercent } = rolloutSchema.parse(req.body);
    const rel = await prisma.release.findUnique({ where: { id: req.params.id } });
    if (!rel) throw notFound("Release not found");

    const updated = await prisma.release.update({
      where: { id: rel.id },
      data: { rolloutPercent },
    });
    invalidateReleaseCache();
    res.json(updated);
  }),
);

/**
 * POST /:id/pause — THE KILL SWITCH.
 *
 * Stops new offers within ~60s (the CDN TTL). It does NOT recall a client that
 * already fetched the manifest and is mid-download, and it cannot downgrade
 * anyone who has already installed — which is exactly why a release should be
 * ramped from 1% rather than published straight to everyone.
 */
adminReleasesRouter.post(
  "/:id/pause",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const rel = await prisma.release.findUnique({ where: { id: req.params.id } });
    if (!rel) throw notFound("Release not found");
    const updated = await prisma.release.update({
      where: { id: rel.id },
      data: { status: "paused", pausedAt: new Date() },
    });
    invalidateReleaseCache();
    res.json(updated);
  }),
);

/** POST /:id/resume — paused → live, at the same percentage it was pulled at. */
adminReleasesRouter.post(
  "/:id/resume",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const rel = await prisma.release.findUnique({ where: { id: req.params.id } });
    if (!rel) throw notFound("Release not found");
    const updated = await prisma.release.update({
      where: { id: rel.id },
      data: { status: "live", pausedAt: null },
    });
    invalidateReleaseCache();
    res.json(updated);
  }),
);

/**
 * POST /:id/rollback — pull a bad release and put an earlier one back.
 *
 * Protects only the machines that have NOT yet updated: Tauri installs strictly
 * newer versions, so anyone already on the bad build stays there until a higher
 * version ships. Fixing forward with a new patch version is the real remedy.
 */
adminReleasesRouter.post(
  "/:id/rollback",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { promote } = rollbackSchema.parse(req.body ?? {});
    const rel = await prisma.release.findUnique({ where: { id: req.params.id } });
    if (!rel) throw notFound("Release not found");

    await prisma.release.update({
      where: { id: rel.id },
      data: { status: "rolled_back", pausedAt: new Date() },
    });

    let promoted = null;
    if (promote) {
      const prev = await prisma.release.findUnique({ where: { id: promote } });
      if (!prev) throw notFound("Release to promote not found");
      promoted = await prisma.release.update({
        where: { id: prev.id },
        data: { status: "live", rolloutPercent: 100, pausedAt: null },
      });
    }
    invalidateReleaseCache();
    res.json({ rolledBack: rel.version, promoted });
  }),
);

/**
 * GET /versions — how many devices are on each app version.
 *
 * Reads `Device.appVersion`, which clients have always reported but nothing has
 * ever read. This is how the migration off the pre-updater builds is measured.
 */
adminReleasesRouter.get(
  "/versions",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const devices = await prisma.device.findMany({
      where: { lastSeenAt: { gte: since } },
      select: { appVersion: true, platform: true },
    });

    const counts = new Map<string, number>();
    for (const d of devices) {
      const key = `${d.platform ?? "unknown"}/${d.appVersion ?? "unknown"}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    res.json({
      total: devices.length,
      versions: [...counts.entries()]
        .map(([key, count]) => ({ key, count }))
        .sort((a, b) => b.count - a.count),
    });
  }),
);
