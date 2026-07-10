import { Router } from "express";
import { Prisma, type Device } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/auth";
import { asyncHandler } from "../middleware/async-handler";
import { deviceSchema, deactivateDeviceSchema } from "../validation/schemas";
import { env } from "../lib/env";
import { badRequest, deviceConflict, forbidden, notFound, rebindCooldown } from "../lib/http-error";

export const devicesRouter = Router();

const DESKTOP_PLATFORMS = new Set(["windows", "macos", "mac", "linux", "desktop"]);

/** Phone-class unless the platform is clearly a desktop OS. */
function inferKind(platform: string): "phone" | "desktop" {
  return DESKTOP_PLATFORMS.has(platform.toLowerCase()) ? "desktop" : "phone";
}

const isRaceError = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError &&
  (err.code === "P2002" || err.code === "P2034");

/** Public info about the current active phone, surfaced in a 409 conflict. */
function activeDeviceInfo(d: Device) {
  return { name: d.name, model: d.model ?? null, lastSeenAt: d.lastSeenAt ?? null };
}

/**
 * Register / heartbeat a device, and — for phones — enforce ONE active phone per
 * account.
 *
 * Desktop devices keep the legacy find-then-write / (userId,name) upsert with no
 * binding (they push via /api/sync). Phones bind to the single active slot:
 *   - first phone            → bound active (first-bind, no cooldown)
 *   - a second phone         → 409 DEVICE_CONFLICT (client shows the rebind sheet)
 *   - takeover:true          → supersede the old phone, bind this one
 *   - same idfv as active    → auto-takeover ("grace"), no cooldown (reinstall)
 *   - already the active one → 200 idempotent (safe network retry)
 * The invariant is ultimately guaranteed by a partial unique index on Mongo
 * ({userId} where status:active, kind:phone) — see scripts/device-migrate.
 */
devicesRouter.post(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const input = deviceSchema.parse(req.body);
    const userId = req.user!.id;
    const now = new Date();
    const kind = input.kind ?? inferKind(input.platform);

    const meta = {
      platform: input.platform,
      lastSeenAt: now,
      kind,
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.osVersion !== undefined ? { osVersion: input.osVersion } : {}),
      ...(input.appVersion !== undefined ? { appVersion: input.appVersion } : {}),
      ...(input.pushToken !== undefined ? { pushToken: input.pushToken } : {}),
      ...(input.idfv !== undefined ? { idfv: input.idfv } : {}),
    };

    // ---------- Desktop: legacy behaviour, no binding ----------
    // find-then-write (no (userId,name) unique anymore); match on deviceId when
    // present, else on name (legacy name-only desktop clients).
    if (kind !== "phone") {
      const existing = input.deviceId
        ? await prisma.device.findFirst({ where: { userId, deviceId: input.deviceId } })
        : await prisma.device.findFirst({ where: { userId, name: input.name } });
      const device = existing
        ? await prisma.device.update({ where: { id: existing.id }, data: { name: input.name, ...meta } })
        : await prisma.device.create({
            data: {
              userId,
              name: input.name,
              status: "active",
              ...(input.deviceId ? { deviceId: input.deviceId } : {}),
              ...meta,
            },
          });
      res.json({ device });
      return;
    }

    // ---------- Phone: one-active-phone binding ----------
    const deviceId = input.deviceId;
    if (!deviceId) throw badRequest("deviceId is required for phone devices");

    const self = await prisma.device.findFirst({ where: { userId, deviceId } });
    const otherActive = await prisma.device.findFirst({
      where: { userId, kind: "phone", status: "active", deviceId: { not: deviceId } },
    });

    // No conflicting active phone → bind / re-activate / heartbeat this one.
    if (!otherActive) {
      const wasActive = self?.status === "active" || (self != null && self.status == null);
      // A rebind that's more than a heartbeat spends the cooldown too, so a
      // deactivate-then-register can't bypass it. Exempt: a genuine first-ever bind
      // (no prior real transfer → lastReal null passes) and re-activating the SAME
      // device you just deactivated (reversible revoke).
      const reversibleRevoke = self?.status === "revoked";
      if (!wasActive && !reversibleRevoke) {
        const cooldownMs = env.rebindCooldownHours * 60 * 60 * 1000;
        const lastReal = await prisma.deviceTransfer.findFirst({
          where: { userId, reason: { in: ["takeover", "revoke"] } },
          orderBy: { createdAt: "desc" },
        });
        if (lastReal && now.getTime() - lastReal.createdAt.getTime() < cooldownMs) {
          throw rebindCooldown();
        }
      }

      try {
        const device = self
          ? await prisma.device.update({
              where: { id: self.id },
              data: {
                name: input.name,
                status: "active",
                ...meta,
                ...(wasActive ? {} : { boundAt: now, lastRebindAt: now }),
              },
            })
          : await prisma.device.create({
              data: { userId, name: input.name, deviceId, status: "active", boundAt: now, ...meta },
            });

        // Record a first-bind transfer the first time this device becomes the
        // active phone (never counts toward the rebind cooldown).
        if (!wasActive) {
          await prisma.deviceTransfer.create({
            data: { userId, fromDeviceId: null, toDeviceId: deviceId, reason: "first-bind" },
          });
        }
        res.status(self ? 200 : 201).json({ device });
      } catch (err) {
        // Concurrent same-deviceId create raced us — return the winner idempotently.
        if (isRaceError(err)) {
          const winner = await prisma.device.findFirst({ where: { userId, deviceId } });
          if (winner) {
            res.json({ device: winner });
            return;
          }
        }
        throw err;
      }
      return;
    }

    // A different phone is active. Same physical phone reinstalled (idfv match) →
    // auto-takeover without spending the cooldown.
    const grace = Boolean(input.idfv && otherActive.idfv && input.idfv === otherActive.idfv);

    if (!input.takeover && !grace) {
      throw deviceConflict(activeDeviceInfo(otherActive));
    }

    // Cooldown: block rapid device-hopping. `grace` (reinstall) and `first-bind`
    // are exempt. Uses the last REAL transfer, not the one we're about to write.
    if (!grace) {
      const cooldownMs = env.rebindCooldownHours * 60 * 60 * 1000;
      const lastReal = await prisma.deviceTransfer.findFirst({
        where: { userId, reason: { in: ["takeover", "revoke"] } },
        orderBy: { createdAt: "desc" },
      });
      if (lastReal && now.getTime() - lastReal.createdAt.getTime() < cooldownMs) {
        throw rebindCooldown();
      }
    }

    // Atomic handover: supersede the old phone FIRST, then activate this one, so no
    // committed state ever has two active phones (the partial unique index is the
    // ultimate backstop under concurrency).
    try {
      const device = await prisma.$transaction(async (tx) => {
        await tx.device.update({
          where: { id: otherActive.id },
          data: { status: "superseded", supersededAt: now },
        });
        const bound = self
          ? await tx.device.update({
              where: { id: self.id },
              data: { name: input.name, status: "active", boundAt: now, lastRebindAt: now, ...meta },
            })
          : await tx.device.create({
              data: {
                userId,
                name: input.name,
                deviceId,
                status: "active",
                boundAt: now,
                lastRebindAt: now,
                ...meta,
              },
            });
        await tx.deviceTransfer.create({
          data: { userId, fromDeviceId: otherActive.deviceId, toDeviceId: deviceId, reason: "takeover" },
        });
        return bound;
      });
      res.json({ device, takeover: true });
    } catch (err) {
      if (isRaceError(err)) {
        // Our own retried/concurrent takeover already won the slot → idempotent success.
        const mine = await prisma.device.findFirst({
          where: { userId, deviceId, status: "active" },
        });
        if (mine) {
          res.json({ device: mine, takeover: true });
          return;
        }
        // A DIFFERENT new phone won the slot — the loser sees it as the conflict.
        const winner = await prisma.device.findFirst({
          where: { userId, kind: "phone", status: "active", deviceId: { not: deviceId } },
        });
        throw deviceConflict(winner ? activeDeviceInfo(winner) : activeDeviceInfo(otherActive));
      }
      throw err;
    }
  }),
);

/**
 * Deactivate (revoke) a device — reversible by a later re-bind (a future POST
 * /api/devices with this deviceId re-activates it). Only the owner may deactivate.
 */
devicesRouter.post(
  "/:id/deactivate",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const userId = req.user!.id;
    const { reason } = deactivateDeviceSchema.parse(req.body ?? {});

    const device = await prisma.device.findUnique({ where: { id } });
    if (!device) throw notFound("Device not found");
    if (device.userId !== userId) throw forbidden("Not your device");

    const updated = await prisma.device.update({
      where: { id },
      data: { status: "revoked", supersededAt: new Date() },
    });
    await prisma.deviceTransfer.create({
      data: {
        userId,
        fromDeviceId: device.deviceId,
        toDeviceId: device.deviceId ?? device.id,
        reason: "revoke",
      },
    });
    res.json({ device: updated, reason: reason ?? null });
  }),
);
