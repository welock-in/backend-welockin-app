import { Router } from "express";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/auth";
import { asyncHandler } from "../middleware/async-handler";
import { focusInviteCreateSchema } from "../validation/schemas";
import { readDeviceId } from "../lib/device";
import { badRequest, notFound } from "../lib/http-error";
import { dispatchEvent } from "../services/notifications/dispatcher";
import { NotificationEvents } from "../services/notifications/events";

export const focusInvitesRouter = Router();

/**
 * Cross-device focus: starting a session on one device can invite the account's
 * OTHER devices to run the same session.
 *
 * The invite rows here are the source of truth, and every device polls them.
 * Push is fired too, but only as an accelerator for phones: desktops have no
 * push transport (Expo is mobile-only), a phone can be offline or have
 * notifications off, and a killed app receives nothing. Polling is what makes
 * the feature work; the notification is what makes it feel instant.
 *
 * What this deliberately does NOT do: choose what to block on the target. iOS
 * app selections are opaque tokens that only the phone can resolve, so the
 * invite carries the INTENT (how long, how strict) and the target supplies the
 * selection.
 */

/** An invite is worthless once the origin session has ended. */
const isLive = (endsAt: Date) => endsAt.getTime() > Date.now();

function toPublicInvite(i: {
  id: string;
  sessionId: string;
  fromDeviceId: string;
  fromDeviceName: string | null;
  sessionName: string | null;
  hardLock: boolean;
  endsAt: Date;
  createdAt: Date;
}) {
  return {
    id: i.id,
    sessionId: i.sessionId,
    fromDeviceId: i.fromDeviceId,
    fromDeviceName: i.fromDeviceName,
    sessionName: i.sessionName,
    hardLock: i.hardLock,
    endsAt: i.endsAt,
    createdAt: i.createdAt,
    /** What a device joining NOW should run for. Never the original duration:
     *  a Mac that wakes up late joins the remaining time, not a fresh full one,
     *  or the devices would drift out of sync. */
    remainingSeconds: Math.max(0, Math.round((i.endsAt.getTime() - Date.now()) / 1000)),
  };
}

/**
 * Invite one or more of the account's devices to join this session. Idempotent
 * per (sessionId, toDeviceId) so a client retry never stacks invites.
 */
focusInvitesRouter.post(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const input = focusInviteCreateSchema.parse(req.body);
    const userId = req.user!.id;
    const fromDeviceId = readDeviceId(req) || input.fromDeviceId;
    if (!fromDeviceId) throw badRequest("The originating device id is required");

    const endsAt = new Date(Date.now() + input.durationSeconds * 1000);

    // Only ever invite devices that are actually on this account: the request
    // supplies ids, and an unchecked id would let one account push a focus onto
    // another's machine.
    const targets = await prisma.device.findMany({
      where: { userId, deviceId: { in: input.targetDeviceIds } },
      select: { deviceId: true },
    });
    const targetIds = targets
      .map((d) => d.deviceId)
      .filter((id): id is string => Boolean(id) && id !== fromDeviceId);

    if (targetIds.length === 0) {
      res.status(201).json({ invites: [], invited: 0 });
      return;
    }

    const origin = await prisma.device.findFirst({
      where: { userId, deviceId: fromDeviceId },
      select: { name: true },
    });

    const invites = [];
    for (const toDeviceId of targetIds) {
      const existing = await prisma.focusInvite.findFirst({
        where: { userId, sessionId: input.sessionId, toDeviceId },
      });
      const data = {
        fromDeviceId,
        fromDeviceName: origin?.name ?? null,
        sessionName: input.sessionName ?? null,
        hardLock: input.hardLock ?? false,
        endsAt,
      };
      const invite = existing
        ? await prisma.focusInvite.update({ where: { id: existing.id }, data })
        : await prisma.focusInvite.create({
            data: { userId, sessionId: input.sessionId, toDeviceId, ...data },
          });
      invites.push(invite);
    }

    // Accelerator only — a failure here never fails the request (dispatchEvent
    // swallows), because the targets will find the invite by polling anyway.
    await dispatchEvent(NotificationEvents.FOCUS_INVITED, {
      userId,
      deviceId: fromDeviceId,
      targetDeviceIds: targetIds,
      sessionId: input.sessionId,
      sessionName: input.sessionName ?? null,
      hardLock: input.hardLock ?? false,
      durationSeconds: input.durationSeconds,
      durationMinutes: Math.round(input.durationSeconds / 60),
      fromDeviceName: origin?.name ?? null,
      endsAt: endsAt.toISOString(),
    });

    res.status(201).json({ invites: invites.map(toPublicInvite), invited: invites.length });
  }),
);

/**
 * What is waiting for THIS device. The polling endpoint every platform uses —
 * on the Mac and PC it is the only way an invite ever arrives.
 */
focusInvitesRouter.get(
  "/pending",
  requireAuth,
  asyncHandler(async (req, res) => {
    const deviceId = readDeviceId(req);
    if (!deviceId) {
      // No device identity means nothing can be addressed to us. An empty list
      // is the truthful answer, not an error — polling must never spam failures.
      res.json({ invites: [] });
      return;
    }
    const rows = await prisma.focusInvite.findMany({
      where: { userId: req.user!.id, toDeviceId: deviceId, status: "pending" },
      orderBy: { createdAt: "desc" },
      take: 10,
    });
    res.json({ invites: rows.filter((r) => isLive(r.endsAt)).map(toPublicInvite) });
  }),
);

/** Accept or decline. Scoped to the caller AND to the addressed device. */
for (const action of ["accept", "decline"] as const) {
  focusInvitesRouter.post(
    `/:id/${action}`,
    requireAuth,
    asyncHandler(async (req, res) => {
      const deviceId = readDeviceId(req);
      const invite = await prisma.focusInvite.findFirst({
        where: {
          id: req.params.id,
          userId: req.user!.id,
          ...(deviceId ? { toDeviceId: deviceId } : {}),
        },
      });
      if (!invite) throw notFound("Invite not found");

      const updated = await prisma.focusInvite.update({
        where: { id: invite.id },
        data: { status: action === "accept" ? "accepted" : "declined", respondedAt: new Date() },
      });
      res.json({ invite: toPublicInvite(updated) });
    }),
  );
}
