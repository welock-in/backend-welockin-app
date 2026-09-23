import { randomBytes, randomInt } from "node:crypto";
import { Router } from "express";
import type { FriendFocusMember, FriendFocusRoom, Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { conflict, forbidden, notFound } from "../lib/http-error";
import { asyncHandler } from "../middleware/async-handler";
import { requireAuth } from "../middleware/auth";
import {
  friendFocusBlockedAttemptSchema,
  friendFocusCreateSchema,
  friendFocusJoinSchema,
  friendFocusReadySchema,
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
type RoomDb = Pick<Prisma.TransactionClient, "friendFocusRoom" | "friendFocusMember">;
class RoomWriteConflict extends Error {}

/** Every membership/state mutation writes the parent room in the same Mongo
 * transaction. Separate member documents otherwise allow concurrent joins,
 * ready changes and starts to commit from incompatible snapshots. Retry the
 * whole read/validate/write operation after a write conflict. */
async function changeRoom<T>(
  where: Prisma.FriendFocusRoomWhereUniqueInput,
  validate: (room: RoomWithMembers) => void,
  mutate: (tx: RoomDb, room: RoomWithMembers) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await prisma.$transaction(async (tx) => {
        const room = await tx.friendFocusRoom.findUnique({
          where, include: { members: { orderBy: { joinedAt: "asc" } } },
        });
        if (!room) throw notFound("Room not found");
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

// Public by design: Apple's Screen Time extension cannot read the app's JWT.
// The high-entropy per-member token is a narrowly scoped capability: it can
// only report an attempt while this exact room is active.
friendFocusReportRouter.post(
  "/rooms/:id/blocked-attempt",
  asyncHandler(async (req, res) => {
    if (!/^[0-9a-f]{24}$/i.test(req.params.id)) throw notFound("Room not found");
    const input = friendFocusBlockedAttemptSchema.parse(req.body);
    const room = await prisma.friendFocusRoom.findUnique({
      where: { id: req.params.id },
      include: { members: true },
    });
    const actor = room?.members.find((member) => member.attemptToken === input.attemptToken);
    if (!room || !actor) throw notFound("Room not found");

    const isActive =
      room.status === "active" && room.endsAt != null && room.endsAt.getTime() > Date.now();
    if (!isActive) {
      res.status(202).json({ accepted: false, notified: 0 });
      return;
    }

    const recipientIds = room.members
      .filter((member) => member.userId !== actor.userId)
      .map((member) => member.userId);
    const targets = recipientIds.length
      ? await prisma.pushToken.findMany({
          where: { valid: true, userId: { in: recipientIds } },
          select: { token: true, userId: true },
        })
      : [];
    const minuteBucket = Math.floor(Date.now() / 60_000);
    const summary = await deliver(
      targets,
      {
        title: "Focus with Friends",
        body: input.appName
          ? `${actor.displayName} tried to open ${input.appName}, but it is blocked.`
          : `${actor.displayName} tried to open a blocked app.`,
        data: {
          route: "/focus-with-friends/room/[id]",
          params: { id: room.id },
        },
      },
      {
        source: "friend-focus:blocked-attempt",
        dedupeKey: `friend-focus:blocked-attempt:${room.id}:${actor.userId}:${minuteBucket}`,
      },
    );

    res.status(202).json({ accepted: true, notified: summary.sent });
  }),
);
