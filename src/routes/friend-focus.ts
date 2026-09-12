import { randomInt } from "node:crypto";
import { Router } from "express";
import type { FriendFocusMember, FriendFocusRoom } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { conflict, forbidden, notFound } from "../lib/http-error";
import { asyncHandler } from "../middleware/async-handler";
import { requireAuth } from "../middleware/auth";
import {
  friendFocusCreateSchema,
  friendFocusJoinSchema,
  friendFocusReadySchema,
} from "../validation/schemas";

export const friendFocusRouter = Router();

const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const ROOM_LIFETIME_MS = 24 * 60 * 60 * 1000;
const ROOM_CAPACITY = 4;

function inviteCode(): string {
  return Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");
}

type RoomWithMembers = FriendFocusRoom & { members: FriendFocusMember[] };

function toPublicRoom(room: RoomWithMembers, userId: string) {
  const naturallyEnded =
    room.status === "active" && room.endsAt != null && room.endsAt.getTime() <= Date.now();
  return {
    id: room.id,
    inviteCode: room.inviteCode,
    name: room.name,
    durationMinutes: room.durationMinutes,
    hardLock: room.hardLock,
    status: naturallyEnded ? "ended" : room.status,
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
    },
  };
}

async function roomForMember(roomId: string, userId: string): Promise<RoomWithMembers> {
  const room = await prisma.friendFocusRoom.findUnique({
    where: { id: roomId },
    include: { members: { orderBy: { joinedAt: "asc" } } },
  });
  if (!room || !room.members.some((member) => member.userId === userId)) {
    throw notFound("Room not found");
  }
  return room;
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
    const room = await roomForMember(req.params.id, userId);
    if (room.status !== "waiting") throw conflict("This room has already started");

    await prisma.friendFocusMember.update({
      where: { roomId_userId: { roomId: room.id, userId } },
      data: { ready: input.ready },
    });
    const updated = await roomForMember(room.id, userId);
    res.json({ room: toPublicRoom(updated, userId) });
  }),
);

friendFocusRouter.post(
  "/rooms/:id/start",
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = req.user!.id;
    const room = await roomForMember(req.params.id, userId);
    if (room.hostUserId !== userId) throw forbidden("Only the host can start the room");
    if (room.status === "active") {
      res.json({ room: toPublicRoom(room, userId) });
      return;
    }
    if (room.status !== "waiting") throw conflict("This room can no longer start");
    if (room.members.length < 2) throw conflict("Invite at least one friend first");
    if (room.members.some((member) => !member.ready)) {
      throw conflict("Everyone must be ready before the room starts");
    }

    const startsAt = new Date();
    const endsAt = new Date(startsAt.getTime() + room.durationMinutes * 60_000);
    await prisma.friendFocusRoom.updateMany({
      where: { id: room.id, status: "waiting" },
      data: { status: "active", startsAt, endsAt },
    });
    const started = await roomForMember(room.id, userId);
    res.json({ room: toPublicRoom(started, userId) });
  }),
);

friendFocusRouter.post(
  "/rooms/:id/leave",
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = req.user!.id;
    const room = await roomForMember(req.params.id, userId);
    const isActive =
      room.status === "active" && room.endsAt != null && room.endsAt.getTime() > Date.now();
    if (isActive && room.hardLock) {
      throw conflict("A Hard Lock room cannot be left before the shared timer ends");
    }

    if (room.hostUserId === userId && room.status === "waiting") {
      await prisma.friendFocusRoom.update({
        where: { id: room.id },
        data: { status: "ended" },
      });
    } else {
      await prisma.friendFocusMember.delete({
        where: { roomId_userId: { roomId: room.id, userId } },
      });
    }
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
    const room = await prisma.friendFocusRoom.findUnique({
      where: { inviteCode: input.code },
      include: { members: { orderBy: { joinedAt: "asc" } } },
    });
    if (!isJoinable(room)) throw notFound("Invitation not found or expired");
    if (input.acceptedHardLock !== room.hardLock) {
      throw conflict("The room mode changed. Review the invitation again.");
    }

    const existing = room.members.find((member) => member.userId === userId);
    if (!existing) {
      if (room.members.length >= ROOM_CAPACITY) throw conflict("This room is full");
      await prisma.friendFocusMember.create({
        data: {
          roomId: room.id,
          userId,
          displayName: input.displayName ?? "Friend",
        },
      });
    }

    const joined = await prisma.friendFocusRoom.findUnique({
      where: { id: room.id },
      include: { members: { orderBy: { joinedAt: "asc" } } },
    });
    if (!joined) throw notFound("Room not found");
    res.json({ room: toPublicRoom(joined, userId) });
  }),
);
