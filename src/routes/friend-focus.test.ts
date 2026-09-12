import assert from "node:assert/strict";
import { test } from "node:test";
import request from "supertest";
import { createApp } from "../app";
import { signToken } from "../lib/jwt";
import { prisma } from "../lib/prisma";
import { stubAccountGuard } from "./test-helpers";

const app = createApp();
stubAccountGuard();

const hostId = "507f1f77bcf86cd799439011";
const guestId = "507f1f77bcf86cd799439012";
const auth = {
  authorization: `Bearer ${signToken({ sub: hostId, email: "host@example.com" })}`,
};
const guestAuth = {
  authorization: `Bearer ${signToken({ sub: guestId, email: "guest@example.com" })}`,
};

function stubMethod(
  t: { after: (fn: () => void) => void },
  target: Record<string, any>,
  name: string,
  implementation: (...args: any[]) => any,
) {
  const original = target[name];
  const calls: any[][] = [];
  target[name] = (...args: any[]) => {
    calls.push(args);
    return implementation(...args);
  };
  t.after(() => {
    target[name] = original;
  });
  return calls;
}

function member(
  userId: string,
  displayName: string,
  ready = false,
  overrides: Record<string, unknown> = {},
) {
  return {
    id: userId === hostId ? "65f000000000000000000201" : "65f000000000000000000202",
    roomId: "65f000000000000000000101",
    userId,
    displayName,
    attemptToken: `${userId}-attempt-token`,
    ready,
    joinedAt: new Date(),
    ...overrides,
  };
}

function room(overrides: Record<string, unknown> = {}) {
  return {
    id: "65f000000000000000000101",
    inviteCode: "F7K9M2Q8",
    hostUserId: hostId,
    name: "Exam sprint",
    durationMinutes: 50,
    hardLock: true,
    status: "waiting",
    startsAt: null,
    endsAt: null,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    createdAt: new Date(),
    updatedAt: new Date(),
    members: [member(hostId, "Hedi")],
    ...overrides,
  };
}

test("the host creates a waiting room with one shared difficulty", async (t) => {
  const rooms = (prisma as any).friendFocusRoom as Record<string, any>;
  assert.ok(rooms, "the Friend Focus persistence model must exist");

  const creates = stubMethod(t, rooms, "create", async (args) =>
    room({
      name: args.data.name,
      durationMinutes: args.data.durationMinutes,
      hardLock: args.data.hardLock,
      expiresAt: args.data.expiresAt,
    }),
  );

  const res = await request(app).post("/api/friend-focus/rooms").set(auth).send({
    name: "Exam sprint",
    durationMinutes: 50,
    hardLock: true,
    displayName: "Hedi",
  });

  assert.equal(res.status, 201);
  assert.equal(res.body.room.hardLock, true);
  assert.equal(res.body.room.durationMinutes, 50);
  assert.equal(res.body.room.status, "waiting");
  assert.equal(res.body.room.members.length, 1);
  assert.equal(res.body.room.members[0].role, "host");
  assert.match(res.body.room.inviteCode, /^[23456789A-HJ-NP-Z]{8}$/);

  const data = creates[0][0].data;
  assert.equal(data.hostUserId, hostId);
  assert.equal(data.hardLock, true);
  assert.equal(data.members.create.userId, hostId);
});

test("preview shows the host-selected mode before the guest consents", async (t) => {
  const rooms = prisma.friendFocusRoom as unknown as Record<string, any>;
  stubMethod(t, rooms, "findUnique", async () => room());

  const res = await request(app)
    .get("/api/friend-focus/invitations/F7K9M2Q8")
    .set(guestAuth);

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.invitation, {
    code: "F7K9M2Q8",
    name: "Exam sprint",
    durationMinutes: 50,
    hardLock: true,
    memberCount: 1,
    capacity: 4,
  });
});

test("joining accepts the displayed shared mode instead of replacing it", async (t) => {
  const rooms = prisma.friendFocusRoom as unknown as Record<string, any>;
  const members = prisma.friendFocusMember as unknown as Record<string, any>;
  let reads = 0;
  stubMethod(t, rooms, "findUnique", async () => {
    reads += 1;
    return reads === 1
      ? room()
      : room({ members: [member(hostId, "Hedi"), member(guestId, "Lina")] });
  });
  const creates = stubMethod(t, members, "create", async (args) =>
    member(args.data.userId, args.data.displayName),
  );

  const res = await request(app).post("/api/friend-focus/join").set(guestAuth).send({
    code: "f7k9m2q8",
    displayName: "Lina",
    acceptedHardLock: true,
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.room.hardLock, true);
  assert.equal(res.body.room.me.isHost, false);
  assert.equal(res.body.room.members.length, 2);
  assert.equal(creates.length, 1);
  assert.equal(creates[0][0].data.userId, guestId);
});

test("a guest cannot accept a different difficulty than the room displays", async (t) => {
  const rooms = prisma.friendFocusRoom as unknown as Record<string, any>;
  const members = prisma.friendFocusMember as unknown as Record<string, any>;
  stubMethod(t, rooms, "findUnique", async () => room());
  const creates = stubMethod(t, members, "create", async () => member(guestId, "Lina"));

  const res = await request(app).post("/api/friend-focus/join").set(guestAuth).send({
    code: "F7K9M2Q8",
    displayName: "Lina",
    acceptedHardLock: false,
  });

  assert.equal(res.status, 409);
  assert.equal(creates.length, 0);
});

test("a member marks only their own local setup as ready", async (t) => {
  const rooms = prisma.friendFocusRoom as unknown as Record<string, any>;
  const members = prisma.friendFocusMember as unknown as Record<string, any>;
  let reads = 0;
  stubMethod(t, rooms, "findUnique", async () => {
    reads += 1;
    return room({
      members: [member(hostId, "Hedi"), member(guestId, "Lina", reads > 1)],
    });
  });
  const updates = stubMethod(t, members, "update", async () => member(guestId, "Lina", true));

  const res = await request(app)
    .post("/api/friend-focus/rooms/65f000000000000000000101/ready")
    .set(guestAuth)
    .send({ ready: true });

  assert.equal(res.status, 200);
  assert.equal(res.body.room.me.ready, true);
  assert.deepEqual(updates[0][0].where.roomId_userId, {
    roomId: "65f000000000000000000101",
    userId: guestId,
  });
});

test("polling returns the same absolute clock and difficulty to a guest", async (t) => {
  const rooms = prisma.friendFocusRoom as unknown as Record<string, any>;
  const startsAt = new Date();
  const endsAt = new Date(startsAt.getTime() + 50 * 60_000);
  stubMethod(t, rooms, "findUnique", async () =>
    room({
      status: "active",
      startsAt,
      endsAt,
      members: [member(hostId, "Hedi", true), member(guestId, "Lina", true)],
    }),
  );

  const res = await request(app)
    .get("/api/friend-focus/rooms/65f000000000000000000101")
    .set(guestAuth);

  assert.equal(res.status, 200);
  assert.equal(res.body.room.hardLock, true);
  assert.equal(res.body.room.startsAt, startsAt.toISOString());
  assert.equal(res.body.room.endsAt, endsAt.toISOString());
});

test("the host starts one shared clock only after everyone is ready", async (t) => {
  const rooms = prisma.friendFocusRoom as unknown as Record<string, any>;
  const readyMembers = [member(hostId, "Hedi", true), member(guestId, "Lina", true)];
  let reads = 0;
  stubMethod(t, rooms, "findUnique", async () => {
    reads += 1;
    const activeStart = new Date();
    return room({
      status: reads > 1 ? "active" : "waiting",
      startsAt: reads > 1 ? activeStart : null,
      endsAt: reads > 1 ? new Date(activeStart.getTime() + 50 * 60_000) : null,
      members: readyMembers,
    });
  });
  const updates = stubMethod(t, rooms, "updateMany", async () => ({ count: 1 }));

  const before = Date.now();
  const res = await request(app)
    .post("/api/friend-focus/rooms/65f000000000000000000101/start")
    .set(auth);
  const after = Date.now();

  assert.equal(res.status, 200);
  assert.equal(res.body.room.status, "active");
  assert.equal(res.body.room.hardLock, true);
  const data = updates[0][0].data;
  assert.ok(data.startsAt.getTime() >= before && data.startsAt.getTime() <= after);
  assert.equal(data.endsAt.getTime() - data.startsAt.getTime(), 50 * 60_000);
});

test("the host cannot start while one friend is not ready", async (t) => {
  const rooms = prisma.friendFocusRoom as unknown as Record<string, any>;
  stubMethod(t, rooms, "findUnique", async () =>
    room({ members: [member(hostId, "Hedi", true), member(guestId, "Lina", false)] }),
  );
  const updates = stubMethod(t, rooms, "updateMany", async () => ({ count: 1 }));

  const res = await request(app)
    .post("/api/friend-focus/rooms/65f000000000000000000101/start")
    .set(auth);

  assert.equal(res.status, 409);
  assert.equal(updates.length, 0);
});

test("a guest cannot start the room", async (t) => {
  const rooms = prisma.friendFocusRoom as unknown as Record<string, any>;
  stubMethod(t, rooms, "findUnique", async () =>
    room({ members: [member(hostId, "Hedi", true), member(guestId, "Lina", true)] }),
  );
  const updates = stubMethod(t, rooms, "updateMany", async () => ({ count: 1 }));

  const res = await request(app)
    .post("/api/friend-focus/rooms/65f000000000000000000101/start")
    .set(guestAuth);

  assert.equal(res.status, 403);
  assert.equal(updates.length, 0);
});

test("an active Hard Lock member cannot leave early", async (t) => {
  const rooms = prisma.friendFocusRoom as unknown as Record<string, any>;
  const members = prisma.friendFocusMember as unknown as Record<string, any>;
  stubMethod(t, rooms, "findUnique", async () =>
    room({
      status: "active",
      startsAt: new Date(),
      endsAt: new Date(Date.now() + 50 * 60_000),
      members: [member(hostId, "Hedi", true), member(guestId, "Lina", true)],
    }),
  );
  const deletes = stubMethod(t, members, "delete", async () => member(guestId, "Lina", true));

  const res = await request(app)
    .post("/api/friend-focus/rooms/65f000000000000000000101/leave")
    .set(guestAuth);

  assert.equal(res.status, 409);
  assert.equal(deletes.length, 0);
});

test("a blocked-app attempt notifies every other active room member, never the actor", async (t) => {
  const rooms = prisma.friendFocusRoom as unknown as Record<string, any>;
  const pushTokens = prisma.pushToken as unknown as Record<string, any>;
  const deliveries = prisma.notificationDelivery as unknown as Record<string, any>;
  const actorToken = "actor-attempt-token-with-enough-entropy";

  stubMethod(t, rooms, "findUnique", async () =>
    room({
      status: "active",
      startsAt: new Date(Date.now() - 5 * 60_000),
      endsAt: new Date(Date.now() + 45 * 60_000),
      members: [
        member(hostId, "Hedi", true, { attemptToken: actorToken }),
        member(guestId, "Lina", true, { attemptToken: "guest-attempt-token-with-enough-entropy" }),
      ],
    }),
  );
  const tokenReads = stubMethod(t, pushTokens, "findMany", async () => [
    { token: "ExponentPushToken[guest-device]", userId: guestId },
  ]);
  stubMethod(t, deliveries, "findMany", async () => []);
  const deliveryWrites = stubMethod(t, deliveries, "createMany", async () => ({ count: 1 }));

  const originalFetch = global.fetch;
  const expoRequests: Array<{ url: string; init?: RequestInit }> = [];
  global.fetch = async (url, init) => {
    expoRequests.push({ url: String(url), init });
    return new Response(JSON.stringify({ data: [{ status: "ok", id: "ticket-1" }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  t.after(() => {
    global.fetch = originalFetch;
  });

  const res = await request(app)
    .post("/api/friend-focus/rooms/65f000000000000000000101/blocked-attempt")
    .send({ attemptToken: actorToken });

  assert.equal(res.status, 202);
  assert.deepEqual(tokenReads[0][0].where, { valid: true, userId: { in: [guestId] } });
  assert.equal(expoRequests.length, 1);
  const messages = JSON.parse(String(expoRequests[0].init?.body));
  assert.deepEqual(messages.map((message: { to: string }) => message.to), [
    "ExponentPushToken[guest-device]",
  ]);
  assert.equal(messages[0].body, "Hedi a essayé d’ouvrir une app bloquée.");
  assert.equal(deliveryWrites[0][0].data[0].userId, guestId);
  assert.match(deliveryWrites[0][0].data[0].dedupeKey, /^friend-focus:blocked-attempt:/);
});

test("an invalid blocked-attempt token reveals no room and sends nothing", async (t) => {
  const rooms = prisma.friendFocusRoom as unknown as Record<string, any>;
  const pushTokens = prisma.pushToken as unknown as Record<string, any>;
  stubMethod(t, rooms, "findUnique", async () =>
    room({
      status: "active",
      startsAt: new Date(Date.now() - 5 * 60_000),
      endsAt: new Date(Date.now() + 45 * 60_000),
      members: [member(hostId, "Hedi", true, { attemptToken: "real-attempt-token-with-enough-entropy" })],
    }),
  );
  const tokenReads = stubMethod(t, pushTokens, "findMany", async () => []);

  const res = await request(app)
    .post("/api/friend-focus/rooms/65f000000000000000000101/blocked-attempt")
    .send({ attemptToken: "wrong-attempt-token-with-enough-entropy" });

  assert.equal(res.status, 404);
  assert.equal(tokenReads.length, 0);
});
