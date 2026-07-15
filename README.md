# WeLockin Backend

The cloud backend for the WeLockin focus / app-&-site-blocking product (Windows &
macOS desktop app, iOS/Android mobile app, and a web admin console). A single
Express + TypeScript service on Prisma/**MongoDB**, deployed as one Vercel
serverless function at **`app.connect.welock.in`**.

**Stack:** Node.js + Express (TypeScript) · Prisma ORM (MongoDB provider) · JWT
auth (bcryptjs + jsonwebtoken) · zod validation · helmet + cors · Resend (email).

---

## What it does

| Area | Summary |
|---|---|
| **Accounts & auth** | Email/password + **Sign in with Apple**, JWT sessions, `plan` (`trial`/`pro`) with a 14-day trial. |
| **Multi-device sync** | The desktop pushes/pulls its local state (blocklists, focus-session cards, weekly schedules) as one last-write-wins snapshot, plus an idempotent log of completed focus events. |
| **Devices** | Device registry with a **one-active-phone-per-account** binding (takeover + rebind cooldown), and a desktop device list. |
| **Analytics** | Weekly focus stats + a consecutive-day streak, per user and (aggregated) for admins. |
| **Live sessions** | Near-real-time focus heartbeats so the admin console can see who is focusing now, with an admin **force-end**. |
| **Feedback board** | Auth-gated feature-request board (vote / report / auto-hide) with a built-in same-origin admin page. |
| **Addiction protection** | A curated global blocklist (adult / gambling, admin-managed) + a per-user **partner-OTP or dated lock** (unlock code emailed to a partner via Resend). |
| **App Attest** *(scaffolded)* | iOS device-integrity hooks for focus reporting — present but **fail-closed** until the native verifier ships. |

---

## Quick start

```bash
# 1. Install
npm install                     # runs `prisma generate` (postinstall)

# 2. Configure
cp .env.example .env            # then set DATABASE_URL + JWT_SECRET at minimum

# 3. Schema (needs a live DB — see MongoDB note below)
npx prisma db push

# 4. Run
npm run dev                     # tsx watch, hot reload → http://localhost:8787
```

> **MongoDB replica set required.** Prisma's MongoDB provider only works against a
> replica set. [MongoDB Atlas](https://www.mongodb.com/atlas) (even the free **M0**
> tier) provisions one by default and is the easiest path; a bare local `mongod`
> will not work unless started as a replica set.

### Creating an Atlas cluster (once)

1. Create a free **M0** cluster at <https://www.mongodb.com/atlas>.
2. **Database Access** → add a DB user (username + password).
3. **Network Access** → allow your IP (or `0.0.0.0/0` for dev).
4. **Connect → Drivers** → copy the `mongodb+srv://…` string; insert your
   credentials and a database name, e.g. `…/welockin?retryWrites=true&w=majority`.
5. Put it in `.env` as `DATABASE_URL`, then `npx prisma db push`.

---

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Run with `tsx watch` (hot reload). |
| `npm run build` | `prisma generate && tsc` → `dist/`. Does **not** need a live DB. |
| `npm start` | Run the compiled server (`node dist/index.js`). |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm test` | Unit/contract tests (`node:test` + supertest). No DB needed (Prisma is stubbed). |
| `npm run prisma:generate` | Regenerate the Prisma client. |
| `npm run prisma:push` | `prisma db push` (needs a live DB). |
| `npm run protection:seed` | Seed the `protection` collection from `data/protection-blocklist.json` (idempotent; never clobbers admin edits). |
| `npm run device:migrate` | One-off: backfill device columns + create the partial unique indexes for phone binding. |
| `npm run feedback:set-admin` | Grant `User.isAdmin` to an email (feedback-board moderator). |
| `npm run reconcile:feedback` | Recompute denormalized `voteCount`/`reportCount`. |

---

## Environment variables

Loaded via `dotenv` at import (`src/lib/env.ts`). On Vercel, set these in the
project's environment settings.

### Core

| Var | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | `mongodb://localhost:27017/welockin` | Mongo connection string (Atlas `mongodb+srv`, DB name included). |
| `JWT_SECRET` | `change-me` | HMAC secret for user JWTs. **Set a long random value in prod** (see security note). |
| `JWT_EXPIRES_IN` | `30d` | User-token lifetime (`30d`, `12h`, `3600`, …). |
| `PORT` | `8787` | Local server port (ignored on Vercel). |
| `CORS_ORIGIN` | `*` | `*` or a comma-separated allow-list. |
| `NODE_ENV` | `development` | `production` tightens logging/Prisma caching. |

### Sign in with Apple / device integrity

| Var | Default | Purpose |
|---|---|---|
| `APPLE_BUNDLE_ID` | `in.welock.app` | `aud` the Apple identityToken must carry (`POST /api/auth/apple`). |
| `REBIND_COOLDOWN_HOURS` | `12` | Cooldown between phone-slot takeovers. |
| `ATTEST_REQUIRED` | `false` | Hard-enforce App Attest on focus/break routes. Leave off until the native client ships (on = rejects all reporting). |
| `APP_ATTEST_ENV` | `production` | `development` for TestFlight/dev, `production` for App Store. |
| `APP_ATTEST_APP_ID` | `YF7AFPJRYH.in.welock.app` | `<AppleTeamID>.<iOSBundleID>`. |

### Admin console (`/api/admin/*`)

| Var | Default | Purpose |
|---|---|---|
| `ADMIN_USERNAME` | `admin` | Admin-API username. |
| `ADMIN_PASSWORD` | *(empty)* | Admin-API password. **Admin login is disabled while empty.** |
| `ADMIN_JWT_SECRET` | *(falls back to `JWT_SECRET`)* | Separate signing secret for admin tokens. |
| `ADMIN_JWT_EXPIRES_IN` | `12h` | Admin-token lifetime. |
| `LIVE_SESSION_STALE_SECONDS` | `660` | A live session with no heartbeat for this long is treated as ended. |

### Email (addiction-protection partner OTP)

| Var | Default | Purpose |
|---|---|---|
| `RESEND_API_KEY` | *(empty)* | Resend key. Email is a logged **no-op** while empty. |
| `RESEND_FROM` | `WeLockin <protection@welock.in>` | Verified sender (domain must be verified in Resend). |

---

## Architecture

`api/index.ts` exports `createApp()` — the whole API runs as **one** Vercel
serverless function; `vercel.json` rewrites every path to it and Express routes
internally. `src/index.ts` is the alternative long-running server (local dev /
Render / Railway / Docker) with graceful shutdown.

**Global middleware (in order):** `helmet()` → `cors()` (allow-listed headers:
`Content-Type`, `Authorization`, `X-WeLockIn-Device-Id`, `X-WeLockIn-Attest`) →
`express.json({ limit: "5mb" })` → `morgan` (skipped under test).

**Auth layers:**
- **User JWT** — `requireAuth`: `Authorization: Bearer <jwt>` → `req.user = {id, email}`.
- **Admin JWT** — `requireAdmin`: a *separate* token from `POST /api/admin/login`, signed with `ADMIN_JWT_SECRET`, role `admin`. Independent of `User.isAdmin`.
- **`User.isAdmin`** — a per-user DB flag gating the *feedback-board* admin actions (`/api/feedback/admin`, moderation) and the `/admin` HTML page. This is a different mechanism from the admin-console JWT above.
- **Device binding / App Attest** — `requireBoundDevice` + `requireAttest` on counter-crediting routes (`/api/focus-events`, `/api/breaks`).

**Error shape — every error is `{ "error": string }`** (via `src/middleware/error.ts`):

| Cause | Status | Body |
|---|---|---|
| zod validation | `400` | `{ error: "field: message; …" }` |
| `HttpError` | its status | `{ error, [code], …details }` |
| Prisma `P2002` (unique) | `409` | `{ error: "Resource already exists" }` |
| Prisma `P2023` (bad ObjectId) | `400` | `{ error: "Malformed id" }` |
| Prisma `P2025` (vanished row) | `404` | `{ error: "Not found" }` |
| unmatched route | `404` | `{ error: "Not found" }` |
| anything else | `500` | `{ error: "Internal server error" }` (real error logged) |

---

## Data model (Prisma / MongoDB)

Collections (`@@map` name in parentheses when different from the model):

- **User** — `email` (unique), `passwordHash?` (null for Apple-only), `emailVerified?`, `plan`, `trialEndsAt?`, `isAdmin?`, `status?` (`active`/`suspended`).
- **AuthProvider** — social/password identities (`provider`, `providerUid`), `@@unique([provider, providerUid])`.
- **Device** — registry; `deviceId?` (stable client UUID = real identity), `kind` (`desktop`/`phone`/`tablet`), phone-binding fields (`status`, `boundAt`, `supersededAt`, `lastRebindAt`, `idfv`), App Attest fields. `(userId, name)` is intentionally **non-unique**; uniqueness (one active phone, one row per `(userId, deviceId)`) is enforced by partial indexes from `device:migrate`.
- **DeviceTransfer** — audit trail of phone handovers (drives the rebind cooldown).
- **Break** — server-authoritative daily break budget; idempotent on `(userId, clientBreakId)`.
- **SyncSnapshot** — one per user: opaque `blocklists`/`sessions`/`schedules` JSON + `revision`.
- **FocusEvent** — completed-session log; idempotent on `clientEventId` via deterministic `_id`; `quarantined?` (anti-abuse, excluded from stats).
- **LiveSession** — a focus session happening *now*; one row per `(user, device, session)`; expired by heartbeat staleness; carries the admin `forceEnd` flag.
- **FeatureRequest / Vote / FeatureReport** — feedback board (idempotency keys, denormalized counts, auto-hide at 3 reports).
- **ProtectionEntry** (`protection`) — one curated blocklist entry (`category`, `kind` `site`/`app`, normalized `value`, `active`), `@@unique([kind, value])`.
- **ProtectionLock** (`protection_locks`) — per-user lock (`method` `partner`/`date`, `categories`, `otp?`, `otpAttempts?`, `lockedUntil?`).

---

## API reference

All routes are under `/api` and speak JSON. **User-JWT** routes need
`Authorization: Bearer <user token>`; **Admin-JWT** routes need an admin token
from `POST /api/admin/login`. `PublicUser` = the `User` record minus `passwordHash`.

### Health

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/health` | — | Liveness. `200 { ok: true, time }`. |
| `GET` | `/api/health/db` | — | Readiness (pings Mongo). `200 { db: "ok" }` or `503 { error: "Database unreachable", db: "error" }`. |

### Auth — `/api/auth` (public)

All three return `{ token, user: PublicUser }`.

- **`POST /register`** — `{ email, password (≥8) }` → `201`. `409` if the email exists. Sets `plan: "trial"`, `trialEndsAt = now + 14d`.
- **`POST /login`** — `{ email, password }` → `200`. `401 "Invalid email or password"` (same message whether the user is missing, Apple-only, or the password is wrong). *Does not check suspension.*
- **`POST /apple`** — `{ identityToken }` → `200`/`201`. Verifies the token against Apple's JWKS (`aud = APPLE_BUNDLE_ID`), then find-or-creates by `AuthProvider`. Auto-links to an existing email only if that account is `emailVerified` (anti-hijack); otherwise `409`. Client-supplied email hints are ignored.

### Me — `/api/me` (user JWT)

- **`GET /`** → `200 { user: PublicUser }` (fresh from DB). `404` if the user row is gone.
- **`DELETE /`** → `204`. Self-serve account deletion (Play/Apple requirement). Hard-deletes the user and all data keyed to them (focus events, devices, transfers, live sessions, auth providers, snapshot, breaks, votes, authored feature requests). Idempotent.

### Devices — `/api/devices` (user JWT)

- **`POST /`** — register / heartbeat. `deviceSchema` (`name`, `platform`, optional `kind`, `deviceId`, `model`, `osVersion`, `appVersion`, `pushToken`, `idfv`, `takeover`). **Desktop:** upsert, no binding (re-registering a previously deactivated desktop re-activates it). **Phone:** one-active-slot — first phone `201`; same phone `200`; a different active phone → `409 DEVICE_CONFLICT` unless `takeover:true` or an `idfv` match (reinstall grace); a recent real transfer → `429 REBIND_COOLDOWN`.
- **`POST /:id/deactivate`** — revoke by Mongo `_id` (reversible by a later re-bind). Owner-only. `{ device, reason }`.
- **`GET /`** → `200 { devices, max: 3 }` (excludes superseded/revoked). `max` is a UI hint, not enforced.
- **`DELETE /:deviceId`** — unpair by client `deviceId`, scoped to the caller. `200 { removed }` (idempotent; `removed: 0` if none).

### Sync — `/api/sync` (user JWT)

- **`POST /push`** — last-write-wins. Replaces the snapshot only when `replaceSnapshot: true`, or the payload has no `events`, or `schedules` is present; otherwise it is **append-only** (events stored, snapshot untouched — protects a newer PC snapshot from a stale mobile pull). When replacing, `blocklists` + `sessions` are required. `events[]` are idempotent per `clientEventId`. → `200 { revision, updatedAt }`.
- **`GET /pull`** → `200 { blocklists, sessions, schedules, revision, updatedAt }` (empty/`revision:0` if never pushed).

### Focus events — `/api/focus-events` (user JWT + bound-device + attest)

- **`POST /`** — ingest ONE focus event (mobile). Idempotent on `clientEventId` (`200 { event, deduped: true }` on replay, else `201 … deduped: false`). `403 DEVICE_*` for an unbound/revoked/superseded device; `501` if `ATTEST_REQUIRED` is on but the verifier isn't wired. *(Desktop reports events through `/api/sync` instead.)*

### Analytics — `/api/analytics` (user JWT)

- **`GET /summary`** → `200 { focusedSecondsWeek, sessionsCount, dayStreak, totalSessions }`. Quarantined events excluded. Streak buckets by **server-local (UTC on Vercel)** calendar days.

### Breaks — `/api/breaks` (user JWT + bound-device + attest)

- **`POST /`** — grant a break against a server-authoritative **120 min / rolling-24h** budget. Over-budget grants are still recorded (`quarantined: true`) and still return an authoritative `endsAt` so offline enforcement is never blocked. Idempotent on `clientBreakId`. → `201 { id, endsAt, durationSeconds, quarantined, remainingMinutes }`.

### Live sessions — `/api/sessions` (user JWT)

- **`POST /heartbeat`** — upsert one live session (one row per `(user, device, sessionId)`; `sessionId` defaults to `"default"`). → `200 { forceEnd }` (the admin force-stop flag as it was *before* this beat; `forceEnd` is never overwritten by a heartbeat).
- **`POST /end`** — delete the device's live-session row(s): pass `sessionId` to end one, omit to end all. → `200 { ended }`.

### Feedback board — `/api/feedback` (user JWT; some admin via `User.isAdmin`)

- **`GET /`** — visible requests, `?sort=top|new`. `200 { requests }`.
- **`GET /admin`** — *(isAdmin)* all requests incl. hidden, most-reported first.
- **`POST /`** — `{ title (3–120), body?, clientRequestId (8–64) }`. Idempotent on `(author, clientRequestId)`; author's vote created atomically (`voteCount: 1`). Soft rate-limit: `429` past 5 requests/hour.
- **`POST /:id/vote`** / **`DELETE /:id/vote`** — idempotent add/remove; atomic `voteCount`.
- **`POST /:id/report`** — `{ reason }`; one per reporter; auto-hides at 3 reports.
- **`PATCH /:id/status`** / **`PATCH /:id/hidden`** — *(isAdmin)* moderation.
- **`DELETE /:id`** — author **or** admin.

### `GET /admin` — feedback-board admin page (HTML)

Serves a self-contained single-file dashboard (login → JWT in `localStorage`;
all data gated by `User.isAdmin`). XSS-safe (`textContent`), `noindex`, with a
route-scoped CSP. Distinct from the `/api/admin` JSON console below.

### Admin console — `/api/admin` (admin JWT, env-credential)

- **`POST /login`** — `{ username, password }` vs env creds (timing-safe) → `200 { token, username }`. `503` if `ADMIN_PASSWORD` is empty.
- **`GET /me`** → `{ username }`.
- **`GET /overview`** — global rollups (users, plans, sessions, focus seconds, live count, devices…).
- **`GET /live-sessions`** — everyone focusing now (+ owner email/plan/status).
- **`GET /users`** — paginated (`search`, `skip`, `take`, `sortBy`, `sortDir`) with per-user rollups.
- **`GET /users/:id`** — full profile: identity, devices, a rich stat pack, snapshot, live sessions, last 25 events.
- **`GET /users/:id/events`** — paginated event history (`skip` clamped ≥ 0, `take` 1–200).
- **`POST /users/:id/suspend`** / **`/unsuspend`** / **`/plan`** — account moderation.
- **`DELETE /users/:id`** — permanent user + cascade delete.
- **`POST /live-sessions/:id/force-end`** — flag `forceEnd` (client stops on next beat, even hard-locked).
- **`DELETE /live-sessions/:id`** — remove a stale live-session row.

### Addiction protection (client) — `/api/addiction-protection` (user JWT)

- **`GET /`** → `200 { updatedAt, count, categories: { <cat>: { sites[], apps[] } } }` — active entries only, grouped. Fetched on app launch.
- **`GET /status`** → `200 { userId, active, method, categories, partnerContact, lockedUntil }`. `userId` lets the desktop enforcer **bind the block to this account** (a different account can't lift it). Never exposes the OTP.
- **`POST /lock`** — `{ method, categories, partnerContact?, lockedUntil? }`. `partner` needs `partnerContact` (emails a 6-digit OTP via Resend); `date` needs `lockedUntil`. → `200 { active: true, …, emailed: "sent"|"skipped"|"failed"|null }`.
- **`POST /resend`** — rotate the partner OTP and re-email it. → `200 { emailed, error }`. *(Not rate-limited — see limitations.)*
- **`POST /unlock`** — `{ code }`. `date`: refused with `403` before `lockedUntil`. `partner`: exact OTP match; wrong codes increment an **atomic** counter and past **5** attempts the OTP is invalidated (`401`, must `/resend`). → `200 { active: false }`.

### Addiction protection (admin) — `/api/admin/addiction-protection` (admin JWT)

- **`GET /`** — list entries (`category`, `kind`, `search`, `skip`, `take` 1–500).
- **`POST /`** — upsert one entry (keyed by normalized `kind`+`value`; `source` forced to `admin`).
- **`POST /import`** — bulk add many `values` to one `category`/`kind`. → `{ added, updated, submitted }`.
- **`PATCH /:id`** — partial update (`category`/`label`/`platform`/`active`; `kind`/`value` immutable).
- **`DELETE /:id`** — delete an entry.
- **`GET /active`** — every account with protection ON, **including each partner OTP** (intentional — lets an admin support/override). Sensitive.
- **`POST /active/:id/disable`** — force a user's lock OFF (for dated locks the user can't clear).

---

## Deployment

### Vercel (production — `app.connect.welock.in`)

`vercel.json` builds `api/index.ts` with `@vercel/node` and routes `/(.*)` to it.
Set the environment variables above in the Vercel project. `prisma generate` runs
on install; run `npx prisma db push` once against the production `DATABASE_URL`
(locally with that URL, or a one-off job) to create collections/indexes, and
`npm run device:migrate` once to create the phone-binding partial indexes.

### Generic Node host (Render / Railway / Docker)

Build `npm install && npm run build`, start `npm start`. Provide `DATABASE_URL`,
`JWT_SECRET` (+ the optional vars). Most hosts inject `PORT` automatically.

---

## Security notes & known limitations

Honest posture (some are intentional product decisions, some are open work):

- **No rate limiting** on `POST /api/auth/login`, `/register`, `POST /api/admin/login`, or the OTP `POST /api/addiction-protection/{lock,resend}` (the latter can email an attacker-chosen partner address repeatedly). Proper limiting on serverless needs a DB/Redis-backed limiter — tracked, not yet implemented.
- **Secrets fail *open* to public defaults when unset.** `JWT_SECRET` and `DATABASE_URL` fall back to `change-me` / `localhost`, so a missing var doesn't crash the boot — **you must set real values in production** (a `change-me` JWT secret means anyone can forge a user token).
- **Partner OTP is stored in plaintext and shown to admins** — *intentional*: it's a friction code (with a 5-try cap), not a credential.
- **Day-streak analytics use the server timezone (UTC on Vercel)**, so a streak can flip at a different local time than a non-UTC user expects.
- **App Attest is scaffolded but fail-closed** — `/api/attest/register` always returns `501` and `ATTEST_REQUIRED` must stay `false` until the native verifier is wired. Focus/break counters are binding-protected but forgeable by the account owner until then.

---

## Project structure

```
cloud-backend/
  api/index.ts             # Vercel serverless entry — export default createApp()
  vercel.json              # one function + catch-all route
  prisma/schema.prisma     # all Mongo models
  data/protection-blocklist.json   # curated 500+500 seed (protection:seed)
  scripts/                 # seed-protection, device-migrate, set-admin, reconcile-feedback
  src/
    index.ts               # long-running server (local/Render/Railway)
    app.ts                 # createApp(): middleware + route mounts + error handlers
    lib/                   # env, prisma, jwt, admin-jwt, apple, attest, resend, http-error, user, deterministic-id
    middleware/            # auth, admin-auth, bound-device, attest, async-handler, error
    routes/                # health, auth, me, devices, sync, focus-events, analytics,
                           #   feedback, attest, breaks, sessions, admin, addiction-protection,
                           #   admin-protection  (+ *.test.ts contract tests)
    services/              # analytics, admin-stats, focus-events, sync-policy
    validation/schemas.ts  # zod request schemas
    admin/page.ts          # the /admin feedback-board HTML dashboard
```
