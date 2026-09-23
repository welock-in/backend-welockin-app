import { Router } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/auth";
import { asyncHandler } from "../middleware/async-handler";
import { focusInviteCreateSchema } from "../validation/schemas";
import { readDeviceId } from "../lib/device";
import { badRequest, notFound } from "../lib/http-error";
import { resolveAudience } from "../services/notifications/audience";
import { deliver } from "../services/notifications/deliver";
import { deterministicObjectId } from "../lib/deterministic-id";

export const focusInvitesRouter = Router();

/**
 * Cross-device focus: starting a session on one device can invite the account's
 * OTHER devices to run the same session.
 *
 * The invite rows here are the source of truth, and every device polls them.
 * Push is fired too, but only as an accelerator for phones: desktops have no
 * push transport (Expo is mobile-only), a phone can be offline or have
 * notifications off, or the OS may delay presentation. Polling is what makes
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

    const now = Date.now();
    const endsAt = new Date(Math.min(
      input.endsAt ? Date.parse(input.endsAt) : now + input.durationSeconds * 1000,
      now + input.durationSeconds * 1000,
    ));
    if (!isLive(endsAt)) throw badRequest("This focus session has already ended");

    // Only ever invite devices that are actually on this account: the request
    // supplies ids, and an unchecked id would let one account push a focus onto
    // another's machine.
    const targets = await prisma.device.findMany({
      where: { userId, deviceId: { in: input.targetDeviceIds } },
      select: { deviceId: true, platform: true },
    });
    const targetIds = [...new Set(targets
      .map((d) => d.deviceId)
      .filter((id): id is string => Boolean(id) && id !== fromDeviceId))];
    const platformByDevice = new Map(targets.map((d) => [d.deviceId, d.platform]));
    const delivery: Array<{ deviceId: string; status: string }> = [...new Set(input.targetDeviceIds)]
      .filter((id) => id !== fromDeviceId && !targetIds.includes(id))
      .map((deviceId) => ({ deviceId, status: "unavailable" }));

    if (targetIds.length === 0) {
      res.status(201).json({ invites: [], invited: 0, delivery });
      return;
    }

    const origin = await prisma.device.findFirst({
      where: { userId, deviceId: fromDeviceId },
      select: { name: true },
    });

    // Minutes rounded UP, never zero: rounding down would unlock the phone
    // before the device that started the session, and the join screen treats
    // min=0 as nothing to join.
    const makePush = (invite: { id: string; endsAt: Date; fromDeviceName: string | null; sessionName: string | null; sessionId: string; hardLock: boolean }) => ({
      title: `${invite.fromDeviceName ?? "Another device"} started ${invite.sessionName ?? "a focus"}`,
      body: `${Math.max(1, Math.ceil((invite.endsAt.getTime() - Date.now()) / 60_000))} min. Tap to lock this phone too.`,
      expiration: Math.floor(invite.endsAt.getTime() / 1000),
      // The deep-link contract of the phone's NotificationRouter: a dumb
      // {route, params} the client navigates to. The params mirror what the
      // phone's own foreground poll (FocusInviteWatcher) synthesizes, so both
      // arrival paths land on the same pre-filled join screen. No blocklist in
      // here — iOS app selections are opaque tokens only the phone can resolve.
      data: {
        type: "cross_device_lock",
        inviteId: invite.id,
        route: "/start-focus",
        params: {
          source: "desktop",
          sessionId: invite.sessionId,
          min: String(Math.max(1, Math.ceil((invite.endsAt.getTime() - Date.now()) / 60_000))),
          hard: invite.hardLock ? "true" : "false",
          // The absolute end, so a LATE tap can join for the remaining time
          // (or refuse a dead invite) instead of trusting the frozen `min` —
          // a push cannot carry tap-time remaining time, only this can.
          endsAt: invite.endsAt.toISOString(),
        },
      },
    });

    const invites = [];
    for (const toDeviceId of targetIds) {
      const existing = await prisma.focusInvite.findFirst({
        where: { userId, fromDeviceId, sessionId: input.sessionId, toDeviceId },
      });
      const data = {
        fromDeviceId,
        fromDeviceName: origin?.name ?? null,
        sessionName: input.sessionName ?? null,
        hardLock: input.hardLock ?? false,
        endsAt,
      };
      // Keep legacy rows, and use the primary key to serialize concurrent new
      // creates without requiring an index migration. A retry is immutable.
      const id = deterministicObjectId("focus-invite", userId, fromDeviceId, input.sessionId, toDeviceId);
      let invite = existing;
      if (!invite) {
        try {
          invite = await prisma.focusInvite.create({
            data: { id, userId, sessionId: input.sessionId, toDeviceId, ...data },
          });
        } catch (err) {
          if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== "P2002") throw err;
          invite = await prisma.focusInvite.findUnique({ where: { id } });
          if (!invite) throw err;
        }
      }
      invites.push(invite);
    }

    // The push accelerator, strictly AFTER every row exists: the rows are the
    // source of truth each device polls, so they must never be hostage to
    // Expo's latency — several targets × a slow Expo could hit the serverless
    // timeout, and a row that was never written can't be found by polling.
    //
    // Sent the way the admin console's test send works (resolveAudience +
    // deliver, content in code), NOT through the data-driven rule engine: the
    // engine only fires if a NotificationRule and NotificationTemplate were
    // seeded into this database, and one where the seed never ran drops the
    // push with nothing but a server-side warning. Whether a phone gets
    // invited must not depend on operational data.
    //
    // Best-effort: a push failure never fails the invite (the target finds
    // the row by polling anyway), and never blocks the other targets' pushes.
    // Bounded parallelism: a slow phone must not hold up every following target.
    for (let offset = 0; offset < invites.length; offset += 6) {
      await Promise.all(invites.slice(offset, offset + 6).map(async (invite) => {
        const toDeviceId = invite.toDeviceId;
        if (invite.status !== "pending" || !isLive(invite.endsAt)) {
          delivery.push({ deviceId: toDeviceId, status: "already_handled" });
          return;
        }
        try {
          const tokens = await resolveAudience(
            { mode: "specificDevices" },
            { userId, targetDeviceIds: [toDeviceId] },
          );
          if (tokens.length === 0) {
            // Desktops land here by design — they have no push transport. A
            // PHONE here is the "invitable but mute" trap (registered on this
            // account but its push token lives on another one, or signed out,
            // or its token died): the 18/08 prod incident was exactly this,
            // invisible because nothing named it. It still gets the invite —
            // by polling — but only when its owner opens the app.
            const platform = platformByDevice.get(toDeviceId);
            const mobile = platform === "ios" || platform === "ipados" || platform === "android";
            if (mobile) {
              console.warn(
                `[focus-invites] device ${toDeviceId} (${platform}) invited but has no valid push token — it will only learn by polling`,
              );
            }
            delivery.push({ deviceId: toDeviceId, status: mobile ? "push_unavailable" : "polling" });
            return;
          }
          // Deduped per DEVICE, not per user: a client retry can't buzz the
          // same phone twice for one session, while a second phone added to
          // the session later still gets its own push.
          const summary = await deliver(tokens, makePush(invite), {
            source: "focus.invited",
            dedupeKey: `focus_invited:${fromDeviceId}:${input.sessionId}:${toDeviceId}`,
          });
          delivery.push({ deviceId: toDeviceId, status: summary.sent + summary.deduped > 0 ? "push_accepted" : "push_failed" });
        } catch (err) {
          console.error(`[focus-invites] push to device ${toDeviceId} failed:`, err);
          delivery.push({ deviceId: toDeviceId, status: "push_failed" });
        }
      }));
    }

    console.info(`[focus-invites] session=${input.sessionId} result=${JSON.stringify(delivery)}`);
    res.status(201).json({ invites: invites.map(toPublicInvite), invited: invites.length, delivery });
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
      where: { userId: req.user!.id, toDeviceId: deviceId, status: "pending", endsAt: { gt: new Date() } },
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
      if (!deviceId) throw badRequest("The receiving device id is required");
      const invite = await prisma.focusInvite.findFirst({
        where: {
          id: req.params.id,
          userId: req.user!.id,
          ...(deviceId ? { toDeviceId: deviceId } : {}),
        },
      });
      if (!invite) throw notFound("Invite not found");
      if (!isLive(invite.endsAt)) throw badRequest("This focus session has already ended");
      if (invite.status !== "pending") {
        if (invite.status === (action === "accept" ? "accepted" : "declined")) {
          res.json({ invite: toPublicInvite(invite) });
          return;
        }
        throw badRequest("This invitation is no longer pending");
      }

      const updated = await prisma.focusInvite.updateMany({
        where: { id: invite.id, status: "pending", endsAt: { gt: new Date() } },
        data: { status: action === "accept" ? "accepted" : "declined", respondedAt: new Date() },
      });
      if (updated.count === 0) throw badRequest("This invitation is no longer pending");
      res.json({ invite: toPublicInvite(invite) });
    }),
  );
}
