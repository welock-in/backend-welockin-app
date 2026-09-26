# Study Room attempt notifications

Additive contract to the iOS `friend-focus` room API, based on backend
`dcb2c4658c71eb24b31c62c784b1a41707773fb4`. No change to `focus-invites`
(one account's selected devices), admin notifications, room starts or departures.

## Report from Windows

`POST /api/friend-focus/rooms/:id/attempts`, with the usual current-account JWT:

```json
{"kind":"website","eventId":"4988929f-e471-4ec5-a159-8f70bc671769"}
```

`kind` is `app` or `website`. `eventId` is a stable client request ID, 1–128
characters from `[A-Za-z0-9._:-]`; reuse it for every retry. Never send an app
name, executable path, URL, domain, blocklist or the iOS capability.

Response is HTTP 202, `{"accepted":true,"notified":0}`. `accepted:false`
means an ended/waiting room or a request suppressed by the actor's cooldown.
`notified` counts Expo ticket acceptance, never desktop receipt or a displayed
banner. A retry of an accepted request returns its original accepted result
while the room remains active, without allocating a new event. An unauthenticated
caller gets 401; a nonmember gets 404. Hard Lock does not suppress reporting.

## Preserve iOS

`POST /api/friend-focus/rooms/:id/blocked-attempt` stays public at the mount
point because the Screen Time extension has no app JWT. It still requires
`attemptToken` (24–128 characters) and accepts optional `appName` (1–80).
Its response keeps `{accepted, notified}`. The capability identifies a current
member of this exact active room and is never included in the event feed.
Legacy reports without appName produce the existing generic app message.
If appName is provided, the legacy push copy is preserved, but the new event
record and feed contain no app name. Existing push delivery logs retain their
existing title/body behavior.

Both routes serialize against the parent room transaction. A rolling 60-second
cooldown applies per actor/room across both platforms. Request keys are unique;
even a suppressed request is reserved so a later retry cannot become a new
alert. iOS has no request ID, so its legacy key uses the minute bucket in
addition to the rolling cooldown. This is a reported attempt, not proof of an
unblocked application or evidence of cheating.

## Receive on desktop

`GET /api/friend-focus/rooms/:id/events?after=<opaque-base64url-cursor>`, with
the current account JWT. Only current members can read; the server excludes
their own reports and events before their membership joinedAt.

```json
{
  "events":[{"id":"65f000000000000000000301","kind":"app","actorDisplayName":"Alex","createdAt":"2026-09-24T18:00:00.000Z"}],
  "nextCursor":"opaque-base64url-value",
  "hasMore":false
}
```

`id` is a 24-character hexadecimal ObjectId. `createdAt` is UTC ISO 8601.
The cursor is at most 256 characters, versioned and bound to the room. Treat it
as opaque. With no `after`, the server returns an empty bootstrap and a cursor
at the current committed high-water sequence: joining/opening does not replay
old notifications. A malformed, cross-room or future cursor returns 400.

Pages contain at most 100 events, ordered by a monotonically increasing
per-room sequence. The sequence and event commit in the same transaction;
events cannot commit behind a consumed cursor, even at identical timestamps.
When `hasMore:true`, immediately request the next page. A terminal page advances
to its captured high-water mark, including self/suppressed/expired gaps.

Windows stores the cursor for the current account and room before showing a
toast, consumes it while muted, clears it on account/room changes and does not
show events older than five minutes. Its local receiving preference defaults
to enabled and affects its toast/sound only. It does not disable blocking,
room synchronization, reporting, iOS alerts or notifications on other devices.
Polling requires the desktop GUI process to remain running, including in tray.

## Delivery and retention

An event commits before Expo is called, even with no mobile tokens or a provider
outage. A durable send claim prevents simultaneous request retries from both
dispatching, without a timed lease that could expire during a slow send. A
completed failed send releases its claim for another request to retry. A crash
leaves the claim reserved: provider acceptance remains ambiguous and is not
retried automatically. This is not an exactly-once push guarantee. Expo
receives the room deadline as expiration. Receipt checks and
invalid-token handling reuse the existing notification pipeline.

New optional fields `FriendFocusRoom.eventSequence` and
`FriendFocusMember.lastAttemptAt` preserve existing room documents. The new
`FriendFocusEvent` collection retains request reservations and events until
24 hours after the room deadline; its TTL index removes them asynchronously.
Room/actor relations also cascade during account deletion.

Before deployment, review and apply only
`scripts/friend-focus-events-migrate.ts --apply` with the target DATABASE_URL
provided externally. Without `--apply` it prints the proposed indexes and does
not connect. The command only creates indexes on the new collection; it never
runs `prisma db push`, drops indexes or rewrites existing data. A preexisting
incompatible index causes a failure requiring review. Generate Prisma Client
as part of the normal build. Local Mongo integration tests may use db push
only against their explicitly asserted disposable localhost replica set.

No backend preference has been introduced. The backend changes are not public
until separately reviewed, migrated and deployed; unit/integration tests do
not establish delivery to a physical iPhone or Windows notification center.

## Local verification — 2026-09-24

- 48 existing targeted tests passed across room routes, device invitations,
  notification token registration, delivery, receipts and Expo parsing/retries.
- 21 real disposable Mongo replica-set tests passed, including concurrent room
  mutations and the new event contracts, authorization, self filtering,
  cross-platform cooldown, request idempotence, cursor/bootstrap races,
  pagination at equal timestamps, rollback, leave/end checks, unavailable Expo,
  ambiguous post-send database failure and actor-deletion cascade.
- Prisma Client generation, TypeScript typecheck and diff whitespace checks
  passed. The targeted migration was inspected in dry-run mode only.

The Mongo suite is `tests/mongo/friend-focus.mongo.test.ts`; run it with the
local `tsx --test` executable. Its harness asserts a localhost URI and creates
an isolated replica set. No production database, real provider or installed
desktop/mobile application was used by these checks.
