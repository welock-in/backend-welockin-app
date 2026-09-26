# Measured focus events and guarded room departure

These contracts are additive. Existing `POST /api/focus-events` and
`POST /api/sync/push` remain supported. No client should send a v2 event through
either legacy route: a legacy validator can discard its measured duration.

## Event transport

- Desktop: `POST /api/sync/events/v2`, existing authentication/account guards.
- Mobile: `POST /api/focus-events/v2`, the same guards plus existing App Attest
  enforcement. This change does not enable or implement App Attest.
- Neither route writes `SyncSnapshot`, blocklists, calendars or active sessions.

```json
{
  "eventVersion": 2,
  "events": [{
    "clientEventId": "device-and-session-stable-id",
    "deviceId": "registered-device-identity",
    "platform": "windows",
    "name": "Focus",
    "startedAt": "2026-09-26T10:00:00.000Z",
    "endedAt": "2026-09-26T10:35:00.000Z",
    "plannedSeconds": 1800,
    "actualSeconds": 1800,
    "completed": true,
    "hardLock": false,
    "emergencyUsed": false,
    "killedTotal": 0
  }]
}
```

The envelope and each event are strict: extra fields are rejected. Owner/user ID
is inferred from authentication and must never appear in the payload. Each batch
has 1–50 events with distinct clientEventIds. IDs and device IDs are trimmed,
nonempty strings of at most 256 characters. `name` is trimmed and nonempty.
`platform` is `windows`, `macos`, `ios`, `ipados` or `android`.
An optional event-level `eventVersion` must also equal 2.

`plannedSeconds`, `actualSeconds` and `killedTotal` are integers 0–2147483647.
`killedTotal` defaults to 0 and `emergencyUsed` defaults to false; other displayed
fields are required. Dates accept ISO strings or epoch milliseconds, using the
existing date parser. `endedAt` is the actual session end, never upload time.

`0 <= actualSeconds <= min(plannedSeconds, floor((endedAt-startedAt)/1000))`.
The client deducts pauses once and includes confirmed focus extensions in the
final planned budget. A fixed 30-minute window with a 5-minute pause credits
1500 seconds; a 30-minute focus budget extended to 35 elapsed minutes by a pause
credits 1800 seconds. The backend never subtracts pauses again.

Register the reporting device under the authenticated account before the first
upload. An unknown/foreign device is persisted in quarantine with `credited:false`.
That verdict is immutable on retries, even after later device registration.
This is attribution validation, not proof that blocking actually occurred.

## Acknowledgement and retry

```json
{
  "eventVersion": 2,
  "results": [{
    "clientEventId": "device-and-session-stable-id",
    "status": "stored",
    "credited": true
  }]
}
```

`status` is `stored` or `deduped`. A client removes only submitted IDs explicitly
acknowledged with this version and a recognized status. `credited:false` is a
terminal persisted result, not permission to mint a replacement event ID.
Queues retain the account captured when the session began; an event belonging
to account A must never be sent with account B's token.

- 400: invalid batch; validation occurs before writes. Preserve diagnostic data,
  isolate invalid entries and continue valid ones rather than discard the queue.
- 409 with `code: "FOCUS_EVENT_CONFLICT"` and `clientEventId`: that ID already
  contains different immutable content, including a lossy legacy v1 copy.
  Preserve the entry and investigate; do not overwrite it or regenerate its ID.
- 401/403: suspend for the relevant account/authentication condition.
- 404 (including a server without v2), network error, timeout, 5xx or an
  unrecognized/missing v2 acknowledgement: keep the queue and retry with backoff.

An existing conflicting batch is checked before inserting other entries. A
concurrent conflict or server interruption may still occur after some entries
were stored. There is no whole-batch atomicity claim: retrying the identical
payload safely deduplicates those entries and finishes the rest. Deterministic
Mongo IDs scope identity to `(authenticated userId, clientEventId)` without a
new nullable unique index. The first valid stored payload is immutable.

## Statistics and rollout

All credited user/admin aggregates exclude only explicit `quarantined:true`,
including historical rows with a false, null or absent field consistently.
Measured v2 uses `actualSeconds` if valid. Legacy rows retain their raw data and
receive an explicitly estimated `min(wallSeconds, positive plannedSeconds)`.
Invalid/unknown-version/no-budget rows contribute zero duration, labelled
`unavailable`; their session existence is not erased. Pauses in old rows cannot
be reconstructed and must never be labelled measured.

`durationQuality` accompanies user/admin totals:
`measuredSeconds`, `estimatedSeconds`, `measuredEvents`, `estimatedEvents`,
`unavailableEvents`. In the user summary it covers the same 7-day window as
`focusedSecondsWeek`; on admin profile, overview and users list it covers their
all-time totals. Admin raw histories remain visible and add `credited`,
`creditedSeconds` and `durationBasis` per row. Never display a quarantined raw
wall duration as credited time.

Before deploying the historical recalculation, run the read-only aggregate
impact command against the intended backend configuration:

```text
node node_modules/tsx/dist/cli.mjs scripts/focus-duration-impact.ts
```

Its `previousUserSeconds` uses the actual old Prisma Mongo predicate, which
includes explicit null but excludes absent quarantine fields in the tested
connector; it is not inferred from deserialized booleans. It
emits only counts/durations, pages by ID, and limits the cohort to `createdAt`
at capture time. This is not a snapshot transaction: concurrent administrative
edits/deletions require another capture. Keep its report and deploy the admin
quality display with the aggregation change. No historical rewrite/backfill or
production `prisma db push` is required for the two optional scalar fields.

Deploy the v2 server before clients. Keep its reader/ingester on backend rollback
where possible; a rollback that removes the routes must leave client queues
intact. Do not roll back to silently routing v2 events through v1.

## Exact room departure

`POST /api/friend-focus/rooms/:id/leave/v2`, authenticated, strict body:
`{"expectedMemberId":"24-hex-object-id"}`. Obtain that ID from
`room.members.find(member => member.isMe).id` (not `room.me.id`).

The response is `{ "version":2, "membershipId":"...", "status":"left" }`.
Recognized terminal statuses are `left`, `already_left` and `superseded`.
An absent room/membership yields `already_left`. A newly joined participation
with a different ID yields `superseded`, preserving that new membership.
A live hard-lock room returns 409; the server deadline remains authoritative.

The current host behavior is preserved: leaving a waiting room ends it and
retains its host membership. Replaying this cancellation acknowledges
`already_left`, and other members can still read the ended room. Soft active
and expired membership departures follow existing removal rules. Validation,
membership identity and mutation share the existing room transaction lock.
The legacy leave route is unchanged. A 404 from a server lacking the v2 route
must not be treated as an acknowledgement.
