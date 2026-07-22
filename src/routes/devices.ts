import { Router } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/auth";
import { asyncHandler } from "../middleware/async-handler";
import { deviceSchema } from "../validation/schemas";
import { readDeviceId, toPublicDevice } from "../lib/device";
import { conflict, notFound } from "../lib/http-error";

export const devicesRouter = Router();

/**
 * The devices API is an inventory, not a permission system.
 *
 * It used to enforce ONE ACTIVE PHONE per account: a second phone got a 409, a
 * takeover superseded the first, a 12h cooldown throttled swaps, and every
 * handover wrote a DeviceTransfer row. All of that is gone by product decision —
 * changing devices is not a thing WeLockIn needs to police. It also never worked
 * as anti-abuse: the cooldown was bypassable with a DELETE followed by a POST.
 *
 * What remains is what a device list actually needs:
 *   POST   /                 register / heartbeat (idempotent upsert)
 *   POST   /heartbeat        refresh lastSeenAt for an already-registered device
 *   GET    /                 list the account's devices
 *   DELETE /:deviceId        remove one (any device on the account, not just self)
 *
 * No 409 on registration, no 429, no statuses. A row exists or it does not.
 */

/**
 * Abuse ceiling, not a product limit. Nothing in the UI mentions it and a real
 * person will never see it: with a hardware-derived deviceId a device upserts
 * its own row instead of creating new ones. It exists so a scripted client
 * inventing fresh ids cannot grow the collection without bound.
 */
const MAX_DEVICES_PER_ACCOUNT = 50;

/** Don't write lastSeenAt on every single call. */
const HEARTBEAT_THROTTLE_MS = 5 * 60 * 1000;

const isRaceError = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError &&
  (err.code === "P2002" || err.code === "P2034");

/**
 * Register or heartbeat a device. Idempotent on (userId, deviceId) — the pair a
 * unique index already enforces (scripts/device-migrate.ts). Calling it twice
 * with the same deviceId updates one row; it never creates a second.
 */
devicesRouter.post(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const input = deviceSchema.parse(req.body);
    const userId = req.user!.id;
    const now = new Date();

    const data = {
      name: input.name,
      platform: input.platform,
      lastSeenAt: now,
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.osVersion !== undefined ? { osVersion: input.osVersion } : {}),
      ...(input.appVersion !== undefined ? { appVersion: input.appVersion } : {}),
    };

    const existing = await prisma.device.findFirst({
      where: { userId, deviceId: input.deviceId },
    });

    if (existing) {
      const device = await prisma.device.update({ where: { id: existing.id }, data });
      res.json({ device: toPublicDevice(device, input.deviceId) });
      return;
    }

    const count = await prisma.device.count({ where: { userId } });
    if (count >= MAX_DEVICES_PER_ACCOUNT) {
      throw conflict(
        `This account already has ${MAX_DEVICES_PER_ACCOUNT} devices. Remove one before adding another.`,
      );
    }

    try {
      const device = await prisma.device.create({
        data: { userId, deviceId: input.deviceId, ...data },
      });
      res.status(201).json({ device: toPublicDevice(device, input.deviceId) });
    } catch (err) {
      // Two concurrent registrations of the same device raced. The unique index
      // let exactly one through — return it, so a retry looks like a success.
      if (isRaceError(err)) {
        const winner = await prisma.device.findFirst({
          where: { userId, deviceId: input.deviceId },
        });
        if (winner) {
          res.json({ device: toPublicDevice(winner, input.deviceId) });
          return;
        }
      }
      throw err;
    }
  }),
);

/**
 * Refresh this device's `lastSeenAt`. Without it, a desktop's last-activity is
 * frozen at whenever it last registered — the old `requireBoundDevice` heartbeat
 * explicitly skipped desktops, so "last seen" on a Mac or PC was a lie.
 * Throttled server-side, so calling it often is free.
 */
devicesRouter.post(
  "/heartbeat",
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = req.user!.id;
    const deviceId = readDeviceId(req);
    if (!deviceId) throw notFound("No device id on this request");

    const device = await prisma.device.findFirst({ where: { userId, deviceId } });
    if (!device) throw notFound("Device not found");

    const stale = Date.now() - device.lastSeenAt.getTime() > HEARTBEAT_THROTTLE_MS;
    if (stale) {
      await prisma.device
        .update({ where: { id: device.id }, data: { lastSeenAt: new Date() } })
        .catch(() => undefined); // best-effort: a missed heartbeat is not an error
    }
    res.status(204).end();
  }),
);

/**
 * List the account's devices. Returns a projection (see lib/device.ts), not the
 * raw row, and flags the caller's own device via the X-WeLockIn-Device-Id header
 * so no client has to work it out for itself.
 *
 * The old `status notIn [superseded, revoked]` filter is gone with the binding
 * that produced those statuses: a device the user did not delete is a device the
 * user still owns, and hiding it was how a "missing" phone went unexplained.
 */
devicesRouter.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const devices = await prisma.device.findMany({
      where: { userId: req.user!.id },
      orderBy: { createdAt: "asc" },
    });
    const current = readDeviceId(req);
    res.json({ devices: devices.map((d) => toPublicDevice(d, current)) });
  }),
);

/**
 * Remove a device from the account by its client `deviceId`.
 *
 * Any device on the account may be removed, not only the caller — that is what
 * makes a lost or sold machine removable at all, and it is what the code always
 * did despite a comment claiming otherwise. Scoped to the caller's userId, so
 * one account can never reach into another.
 */
devicesRouter.delete(
  "/:deviceId",
  requireAuth,
  asyncHandler(async (req, res) => {
    const result = await prisma.device.deleteMany({
      where: { userId: req.user!.id, deviceId: req.params.deviceId },
    });
    // Silently reporting `removed: 0` made a typo indistinguishable from a
    // success; the client now gets to tell the user something honest.
    if (result.count === 0) throw notFound("Device not found");
    res.json({ removed: result.count });
  }),
);
