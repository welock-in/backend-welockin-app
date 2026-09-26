import { createHash, randomBytes, randomInt } from "node:crypto";
import { Router } from "express";
import type { FriendFocusEvent, FriendFocusMember, FriendFocusRoom, Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { badRequest, conflict, forbidden, notFound } from "../lib/http-error";
import { asyncHandler } from "../middleware/async-handler";
import { requireAuth } from "../middleware/auth";
import {
  friendFocusBlockedAttemptSchema,
  friendFocusAttemptSchema,
  friendFocusEventsQuerySchema,
  friendFocusCreateSchema,
  friendFocusJoinSchema,
  friendFocusReadySchema,
  friendFocusLeaveV2Schema,
} from "../validation/schemas";
import { deliver } from "../services/notifications/deliver";

export const friendFocusRouter = Router();
export const friendFocusReportRouter = Router();

const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const ROOM_LIFETIME_MS = 24 * 60 * 60 * 1000;
const ROOM_CAPACITY = 4;

function inviteCode(): string {
  return Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");
}

function attemptToken(): string {
  return randomBytes(24).toString("base64url");
}

type RoomWithMembers = FriendFocusRoom & { members: FriendFocusMember[] };
type RoomDb = Pick<Prisma.TransactionClient, "friendFocusRoom" | "friendFocusMember" | "friendFocusEvent">;
class RoomWriteConflict extends Error {}

/** Every membership/state mutation writes the parent room in the same Mongo
 * transaction. Separate member documents otherwise allow concurrent joins,
 * ready changes and starts to commit from incompatible snapshots. Retry the
 * whole read/validate/write operation after a write conflict. */
async function changeRoom<T>(
  where: Prisma.FriendFocusRoomWhereUniqueInput,
  validate: (room: RoomWithMembers) => void,
  mutate: (tx: RoomDb, room: RoomWithMembers) => Promise<T>,
  absent?: () => T,
): Promise<T> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await prisma.$transaction(async (tx) => {
        const room = await tx.friendFocusRoom.findUnique({
          where, include: { members: { orderBy: { joinedAt: "asc" } } },
        });
        if (!room) {
          if (absent) return absent();
          throw notFound("Room not found");
        }
        validate(room);
        // Explicitly advance even inside the same millisecond, so the parent
        // write cannot collapse to a no-op and admit two stale snapshots.
        const locked = await tx.friendFocusRoom.updateMany({
          where: { id: room.id, updatedAt: room.updatedAt },
          data: { updatedAt: new Date(Math.max(Date.now(), room.updatedAt.getTime() + 1)) },
        });
        if (locked.count !== 1) throw new RoomWriteConflict();
        return mutate(tx, room);
      }, { maxWait: 5_000, timeout: 10_000 });
    } catch (error) {
      const retryable = error instanceof RoomWriteConflict ||
        (typeof error === "object" && error !== null && "code" in error && error.code === "P2034");
      if (!retryable) throw error;
      if (attempt === 4) throw conflict("The room changed. Please try again.");
      await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
    }
  }
  throw conflict("The room changed. Please try again.");
}

function requireMember(room: RoomWithMembers, userId: string): void {
  if (!room.members.some((member) => member.userId === userId)) throw notFound("Room not found");
}

function toPublicRoom(room: RoomWithMembers, userId: string) {
  const naturallyEnded =
    room.status === "active" && room.endsAt != null && room.endsAt.getTime() <= Date.now();
  const expiredWaiting = room.status === "waiting" && room.expiresAt.getTime() <= Date.now();
  return {
    id: room.id,
    inviteCode: room.inviteCode,
    name: room.name,
    durationMinutes: room.durationMinutes,
    hardLock: room.hardLock,
    status: naturallyEnded || expiredWaiting ? "ended" : room.status,
    startsAt: room.startsAt,
    endsAt: room.endsAt,
    expiresAt: room.expiresAt,
    members: room.members.map((member) => ({
      id: member.id,
      displayName: member.displayName,
      ready: member.ready,
      role: member.userId === room.hostUserId ? "host" : "guest",
      isMe: member.userId === userId,
    })),
    me: {
      isHost: room.hostUserId === userId,
      ready: room.members.find((member) => member.userId === userId)?.ready ?? false,
      attemptToken: room.members.find((member) => member.userId === userId)?.attemptToken ?? null,
    },
  };
}

async function ensureMemberAttemptToken(
  room: RoomWithMembers,
  userId: string,
  db: RoomDb = prisma,
): Promise<RoomWithMembers> {
  const current = room.members.find((member) => member.userId === userId);
  if (!current || current.attemptToken) return room;

  const nextToken = attemptToken();
  await db.friendFocusMember.update({
    where: { roomId_userId: { roomId: room.id, userId } },
    data: { attemptToken: nextToken },
  });
  return {
    ...room,
    members: room.members.map((member) =>
      member.userId === userId ? { ...member, attemptToken: nextToken } : member,
    ),
  };
}

async function roomForMember(roomId: string, userId: string, db: RoomDb = prisma): Promise<RoomWithMembers> {
  const room = await db.friendFocusRoom.findUnique({
    where: { id: roomId },
    include: { members: { orderBy: { joinedAt: "asc" } } },
  });
  if (!room || !room.members.some((member) => member.userId === userId)) {
    throw notFound("Room not found");
  }
  return ensureMemberAttemptToken(room, userId, db);
}

function isJoinable(room: RoomWithMembers | null): room is RoomWithMembers {
  return Boolean(
    room && room.status === "waiting" && room.expiresAt.getTime() > Date.now(),
  );
}

friendFocusRouter.post(
  "/rooms",
  requireAuth,
  asyncHandler(async (req, res) => {
    const input = friendFocusCreateSchema.parse(req.body);
    const userId = req.user!.id;
    const room = await prisma.friendFocusRoom.create({
      data: {
        inviteCode: inviteCode(),
        hostUserId: userId,
        name: input.name,
        durationMinutes: input.durationMinutes,
        hardLock: input.hardLock,
        expiresAt: new Date(Date.now() + ROOM_LIFETIME_MS),
        members: {
          create: {
            userId,
            displayName: input.displayName ?? "Host",
            attemptToken: attemptToken(),
          },
        },
      },
      include: { members: { orderBy: { joinedAt: "asc" } } },
    });

    res.status(201).json({ room: toPublicRoom(room, userId) });
  }),
);

friendFocusRouter.get(
  "/rooms/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    const room = await roomForMember(req.params.id, req.user!.id);
    res.json({ room: toPublicRoom(room, req.user!.id) });
  }),
);

friendFocusRouter.post(
  "/rooms/:id/ready",
  requireAuth,
  asyncHandler(async (req, res) => {
    const input = friendFocusReadySchema.parse(req.body);
    const userId = req.user!.id;
    const updated = await changeRoom({ id: req.params.id }, (room) => {
      requireMember(room, userId);
      if (!isJoinable(room)) throw conflict("This room has already started or expired");
    }, async (tx, room) => {
      if (!isJoinable(room)) throw conflict("This room has already started or expired");
      await tx.friendFocusMember.update({
        where: { roomId_userId: { roomId: room.id, userId } },
        data: { ready: input.ready },
      });
      return roomForMember(room.id, userId, tx);
    });
    res.json({ room: toPublicRoom(updated, userId) });
  }),
);

friendFocusRouter.post(
  "/rooms/:id/start",
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = req.user!.id;
    const started = await changeRoom({ id: req.params.id }, (room) => {
      requireMember(room, userId);
      if (room.hostUserId !== userId) throw forbidden("Only the host can start the room");
      if (room.status === "active") return; // idempotent, never restart the timer
      if (!isJoinable(room)) throw conflict("This room can no longer start");
      if (room.members.length < 2) throw conflict("Invite at least one friend first");
      if (room.members.some((member) => !member.ready)) {
        throw conflict("Everyone must be ready before the room starts");
      }
    }, async (tx, room) => {
      if (room.status === "active") return ensureMemberAttemptToken(room, userId, tx);
      const startsAt = new Date();
      // Expiry may pass while the transaction waits for its parent write.
      if (room.expiresAt.getTime() <= startsAt.getTime()) throw conflict("This room has expired");
      const endsAt = new Date(startsAt.getTime() + room.durationMinutes * 60_000);
      await tx.friendFocusRoom.updateMany({
        where: { id: room.id, status: "waiting" },
        data: { status: "active", startsAt, endsAt },
      });
      return roomForMember(room.id, userId, tx);
    });
    res.json({ room: toPublicRoom(started, userId) });
  }),
);

friendFocusRouter.post(
  "/rooms/:id/leave",
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = req.user!.id;
    await changeRoom({ id: req.params.id }, (room) => {
      requireMember(room, userId);
      const isActive = room.status === "active" && room.endsAt != null && room.endsAt.getTime() > Date.now();
      if (isActive && room.hardLock) throw conflict("A Hard Lock room cannot be left before the shared timer ends");
    }, async (tx, room) => {
      // Leaving an expired waiting room remains allowed, so clients can clear it.
      if (room.hostUserId === userId && room.status === "waiting") {
        await tx.friendFocusRoom.update({ where: { id: room.id }, data: { status: "ended" } });
      } else {
        await tx.friendFocusMember.delete({ where: { roomId_userId: { roomId: room.id, userId } } });
      }
    });
    res.json({ left: true });
  }),
);

friendFocusRouter.post("/rooms/:id/leave/v2", requireAuth, asyncHandler(async (req, res) => {
  const { expectedMemberId } = friendFocusLeaveV2Schema.parse(req.body);
  if (!/^[0-9a-f]{24}$/i.test(req.params.id)) throw notFound("Room not found");
  const userId = req.user!.id;
  const ack = (status: "left" | "already_left" | "superseded") => ({ version: 2, membershipId: expectedMemberId, status });
  const result = await changeRoom({ id: req.params.id }, (room) => {
    const member = room.members.find((candidate) => candidate.userId === userId);
    if (member?.id !== expectedMemberId) return;
    const active = room.status === "active" && room.endsAt != null && room.endsAt.getTime() > Date.now();
    if (active && room.hardLock) throw conflict("A Hard Lock room cannot be left before the shared timer ends");
  }, async (tx, room) => {
    const member = room.members.find((candidate) => candidate.userId === userId);
    if (!member) return ack("already_left");
    if (member.id !== expectedMemberId) return ack("superseded");
    // Match the legacy cancellation: ending a waiting room retains its host
    // membership, so remaining clients can still read the final room state.
    // An ended room that never started is the durable acknowledgement on retry.
    if (room.hostUserId === userId && room.status === "ended" && room.startsAt == null) {
      return ack("already_left");
    }
    if (room.hostUserId === userId && room.status === "waiting") {
      await tx.friendFocusRoom.update({ where: { id: room.id }, data: { status: "ended" } });
      return ack("left");
    }
    await tx.friendFocusMember.delete({ where: { id: member.id } });
    return ack("left");
  }, () => ack("already_left"));
  res.json(result);
}));

friendFocusRouter.get(
  "/invitations/:code",
  requireAuth,
  asyncHandler(async (req, res) => {
    const parsed = friendFocusJoinSchema.pick({ code: true }).parse({ code: req.params.code });
    const room = await prisma.friendFocusRoom.findUnique({
      where: { inviteCode: parsed.code },
      include: { members: true },
    });
    if (!isJoinable(room)) throw notFound("Invitation not found or expired");

    res.json({
      invitation: {
        code: room.inviteCode,
        name: room.name,
        durationMinutes: room.durationMinutes,
        hardLock: room.hardLock,
        memberCount: room.members.length,
        capacity: ROOM_CAPACITY,
      },
    });
  }),
);

friendFocusRouter.post(
  "/join",
  requireAuth,
  asyncHandler(async (req, res) => {
    const input = friendFocusJoinSchema.parse(req.body);
    const userId = req.user!.id;
    const joined = await changeRoom({ inviteCode: input.code }, (room) => {
      if (!isJoinable(room)) throw notFound("Invitation not found or expired");
      if (input.acceptedHardLock !== room.hardLock) {
        throw conflict("The room mode changed. Review the invitation again.");
      }
      if (!room.members.some((member) => member.userId === userId) && room.members.length >= ROOM_CAPACITY) {
        throw conflict("This room is full");
      }
    }, async (tx, room) => {
      if (!isJoinable(room)) throw notFound("Invitation not found or expired");
      if (!room.members.some((member) => member.userId === userId)) {
        await tx.friendFocusMember.create({
          data: { roomId: room.id, userId, displayName: input.displayName ?? "Friend", attemptToken: attemptToken() },
        });
      }
      return roomForMember(room.id, userId, tx);
    });
    res.json({ room: toPublicRoom(joined, userId) });
  }),
);

const ATTEMPT_COOLDOWN_MS = 60_000;
const EVENT_RETENTION_MS = 24 * 60 * 60_000;
const EVENT_PAGE_SIZE = 100;

function activeRoom(room: RoomWithMembers): boolean {
  return room.status === "active" && room.endsAt != null && room.endsAt.getTime() > Date.now();
}

function alertDisplayName(name: string): string {
  const plain = name.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/gu, " ").trim();
  return Array.from(plain).slice(0, 40).join("") || "Friend";
}

/** The room write serializes request claims, cooldown and sequence allocation
 * with starts/departures. Persist before any outbound push, including when no
 * member has a mobile token. Never persist app names or browsing information. */
async function recordAttempt(
  roomId: string,
  identify: (room: RoomWithMembers) => FriendFocusMember | undefined,
  input: { kind: "app" | "website"; requestId: string },
): Promise<FriendFocusEvent | null> {
  if (!/^[0-9a-f]{24}$/i.test(roomId)) throw notFound("Room not found");
  return changeRoom({ id: roomId }, (room) => {
    if (!identify(room)) throw notFound("Room not found");
  }, async (tx, room) => {
    const actor = identify(room)!;
    if (!activeRoom(room)) return null;
    const requestKey = createHash("sha256")
      .update(JSON.stringify([room.id, actor.userId, input.requestId])).digest("hex");
    const previous = await tx.friendFocusEvent.findUnique({ where: { requestKey } });
    const now = new Date();
    if (room.endsAt!.getTime() <= now.getTime()) return null;
    if (previous) return previous;
    const suppressed = actor.lastAttemptAt != null &&
      now.getTime() - actor.lastAttemptAt.getTime() < ATTEMPT_COOLDOWN_MS;
    const sequence = suppressed ? null : (room.eventSequence ?? 0) + 1;
    const event = await tx.friendFocusEvent.create({
      data: {
        requestKey, roomId: room.id, actorUserId: actor.userId,
        actorDisplayName: alertDisplayName(actor.displayName), kind: input.kind, sequence,
        createdAt: now,
        expiresAt: new Date(room.endsAt!.getTime() + EVENT_RETENTION_MS),
      },
    });
    if (sequence != null) {
      await tx.friendFocusRoom.update({ where: { id: room.id }, data: { eventSequence: sequence } });
      await tx.friendFocusMember.update({ where: { id: actor.id }, data: { lastAttemptAt: now } });
    }
    return event;
  });
}

/** A durable claim prevents simultaneous retries from both sending the push.
 * Expo remains an accelerator: even an unavailable provider cannot erase the
 * committed event or make its desktop poll fail. Only a completed failure
 * releases the claim. A crashed send stays reserved rather than allowing a
 * slow sender and an expired-lease retry to overlap. */
async function pushAttempt(event: FriendFocusEvent, appName?: string): Promise<number> {
  if (event.sequence == null) return 0;
  const claimedAt = new Date();
  let dispatchStarted = false;
  try {
    const claim = await prisma.friendFocusEvent.updateMany({
      where: {
        id: event.id,
        AND: [
          { OR: [{ pushCompletedAt: null }, { pushCompletedAt: { isSet: false } }] },
          { OR: [{ pushClaimedAt: null }, { pushClaimedAt: { isSet: false } }] },
        ],
      },
      data: { pushClaimedAt: claimedAt },
    });
    if (claim.count === 0) return 0;
    const room = await prisma.friendFocusRoom.findUnique({ where: { id: event.roomId }, include: { members: true } });
    if (!room || !activeRoom(room) || !room.members.some((member) => member.userId === event.actorUserId)) {
      await prisma.friendFocusEvent.updateMany({ where: { id: event.id, pushClaimedAt: claimedAt }, data: { pushCompletedAt: new Date() } });
      return 0;
    }
    const recipientIds = room.members.filter((member) => member.userId !== event.actorUserId).map((member) => member.userId);
    const targets = recipientIds.length ? await prisma.pushToken.findMany({
      where: { valid: true, userId: { in: recipientIds } }, select: { token: true, userId: true },
    }) : [];
    dispatchStarted = true;
    const summary = await deliver(targets, {
      title: "Focus with Friends",
      body: appName
        ? `${alertDisplayName(event.actorDisplayName)} tried to open ${appName}, but it is blocked.`
        : `${alertDisplayName(event.actorDisplayName)} tried to open a blocked ${event.kind === "website" ? "website" : "app"}.`,
      data: { route: "/focus-with-friends/room/[id]", params: { id: room.id } },
      expiration: Math.floor(room.endsAt!.getTime() / 1_000),
    }, { source: "friend-focus:blocked-attempt", dedupeKey: `friend-focus:blocked-attempt:${event.id}` });
    await prisma.friendFocusEvent.updateMany({
      where: { id: event.id, pushClaimedAt: claimedAt },
      data: summary.failed > 0 ? { pushClaimedAt: null } : { pushCompletedAt: new Date() },
    });
    return summary.sent;
  } catch {
    // Do not include the capability, token or app name in diagnostics.
    console.warn("[friend-focus] push unavailable; room event remains available for polling");
    // Once dispatch began, a database failure can mean Expo accepted the push
    // but its audit/ack write failed. Keep that ambiguous claim reserved so a
    // request retry cannot send it twice. Failures before dispatch are safe.
    if (!dispatchStarted) {
      await prisma.friendFocusEvent.updateMany({ where: { id: event.id, pushClaimedAt: claimedAt }, data: { pushClaimedAt: null } }).catch(() => undefined);
    }
    return 0;
  }
}

function eventCursor(roomId: string, sequence: number): string {
  return Buffer.from(JSON.stringify({ v: 1, r: roomId, s: sequence })).toString("base64url");
}

function readEventCursor(raw: string, roomId: string, highWater: number): number {
  try {
    const bytes = Buffer.from(raw, "base64url");
    if (bytes.toString("base64url") !== raw) throw new Error();
    const cursor = JSON.parse(bytes.toString("utf8"));
    if (cursor.v !== 1 || cursor.r !== roomId || !Number.isSafeInteger(cursor.s) || cursor.s < 0 || cursor.s > highWater) throw new Error();
    return cursor.s;
  } catch { throw badRequest("Invalid room events cursor"); }
}

friendFocusRouter.get("/rooms/:id/events", requireAuth, asyncHandler(async (req, res) => {
  if (!/^[0-9a-f]{24}$/i.test(req.params.id)) throw notFound("Room not found");
  const input = friendFocusEventsQuerySchema.parse(req.query);
  const room = await prisma.friendFocusRoom.findUnique({ where: { id: req.params.id }, include: { members: true } });
  const member = room?.members.find((entry) => entry.userId === req.user!.id);
  if (!room || !member) throw notFound("Room not found");
  const highWater = room.eventSequence ?? 0;
  // Bootstrap consumes the current history without creating old notifications.
  if (!input.after) {
    res.json({ events: [], nextCursor: eventCursor(room.id, highWater), hasMore: false });
    return;
  }
  const after = readEventCursor(input.after, room.id, highWater);
  const rows = await prisma.friendFocusEvent.findMany({
    where: { roomId: room.id, actorUserId: { not: req.user!.id },
      sequence: { gt: after, lte: highWater }, createdAt: { gte: member.joinedAt }, expiresAt: { gt: new Date() } },
    orderBy: { sequence: "asc" }, take: EVENT_PAGE_SIZE + 1,
  });
  const hasMore = rows.length > EVENT_PAGE_SIZE;
  const page = rows.slice(0, EVENT_PAGE_SIZE);
  res.json({
    events: page.map((event) => ({ id: event.id, kind: event.kind, actorDisplayName: alertDisplayName(event.actorDisplayName), createdAt: event.createdAt })),
    nextCursor: eventCursor(room.id, hasMore ? page[page.length - 1].sequence! : highWater), hasMore,
  });
}));

friendFocusRouter.post("/rooms/:id/attempts", requireAuth, asyncHandler(async (req, res) => {
  const input = friendFocusAttemptSchema.parse(req.body);
  const event = await recordAttempt(req.params.id, (room) => room.members.find((member) => member.userId === req.user!.id), {
    kind: input.kind, requestId: `client:${input.eventId}`,
  });
  res.status(202).json({ accepted: event?.sequence != null, notified: event ? await pushAttempt(event) : 0 });
}));

// Public by design: Apple's Screen Time extension cannot read the app's JWT.
// The high-entropy per-member token is a narrowly scoped capability: it can
// only report an attempt while this exact room is active.
friendFocusReportRouter.post(
  "/rooms/:id/blocked-attempt",
  asyncHandler(async (req, res) => {
    const input = friendFocusBlockedAttemptSchema.parse(req.body);
    const event = await recordAttempt(req.params.id, (room) => room.members.find((member) => member.attemptToken === input.attemptToken), {
      kind: "app", requestId: `legacy:${Math.floor(Date.now() / ATTEMPT_COOLDOWN_MS)}`,
    });
    res.status(202).json({ accepted: event?.sequence != null, notified: event ? await pushAttempt(event, input.appName) : 0 });
  }),
);
