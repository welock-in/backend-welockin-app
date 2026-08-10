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
| **Accounts & auth** | Email/password + **Sign in with Apple**, JWT sessions. |
| **Entitlement** | Server-authoritative access: a 14-day trial claimed **per machine** (not per account, which would be free), a Lemon Squeezy lifetime licence, admin comps and revocations — resolved by one pure function on the server clock. |
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
| `npm run entitlement:migrate` | Creates the `TrialClaim` unique index, then grandfathers the pre-paywall cohort with a reversible 30-day comp. `-- --dry-run` counts, `-- --revert` undoes. **Run BEFORE deploying the ledger** (see below) and before flipping `ENTITLEMENT_ENFORCED`. |
| `npm run feedback:set-admin` | Grant `User.isAdmin` to an email (feedback-board moderator). |
| `npm run reconcile:feedback` | Recompute denormalized `voteCount`/`reportCount`. |
| `npm run dev:scenario` | Put one account into any entitlement state (`expired`, `paid`, `fresh`, …). Refuses non-disposable databases. |

---

## Local development environment

The paywall, the trial-expiry copy and the post-purchase unlock are the screens
money passes through, and every one of them is normally reachable only by waiting
fourteen days, paying, or hand-editing Mongo — which is why they are the
least-looked-at screens in the product. This setup makes each of them one command
away.

**1. A disposable database.** Same Atlas cluster, different database name — free,
instant, and nothing in it can touch the real data:

```bash
cp .env.example .env    # then set DATABASE_URL to .../welockin-dev
npx prisma db push
npm run dev             # http://localhost:8787
```

Set `ENTITLEMENT_ENFORCED="true"` in that `.env`. Without it the client never
hard-gates and the paywall stays invisible however expired the account is.

You also need a **storefront that looks configured**, or enforcement is forced
back off (a paywall nobody can pay through would lock out every expired account).
Fake values are enough to reach the paywall; clicking Buy fails at Lemon Squeezy
until you drop real *test* keys in:

```
LEMONSQUEEZY_API_KEY="dev-fake-key"
LEMONSQUEEZY_WEBHOOK_SECRET="dev-fake-webhook-secret"
LEMONSQUEEZY_STORE_ID="000000"
LEMONSQUEEZY_VARIANT_ID="000000"
```

**2. Point the desktop app at it.** In the macOS repo, `.env.local`:

```
VITE_API_URL=http://localhost:8787
```

`VITE_API_URL` is baked in at build time and defaults to the deployed backend, so
this file must never be committed — a release built with it would ship a customer
an app that talks to your laptop.

**3. Jump to any state.**

```bash
npm run dev:scenario -- me@test.dev expired    # THE PAYWALL
npm run dev:scenario -- me@test.dev fresh      # a true first run: onboarding + a new window
npm run dev:scenario -- me@test.dev ending     # 20 minutes left
npm run dev:scenario -- me@test.dev paid       # lifetime licence, unlocked
npm run dev:scenario -- me@test.dev refunded   # paywall, refunded wording
npm run dev:scenario -- me@test.dev comped     # admin grant, no purchase
npm run dev:scenario -- me@test.dev revoked    # outranks even a live purchase
```

Accounts are created with the password `devdevdev`, and the script prints what the
resolver **actually** returns rather than what was intended — the two disagreeing
is precisely the bug it exists to surface.

It **refuses to run** against a database whose name does not contain
`dev`/`test`/`local`/`staging`/`sandbox`. It deletes accounts and rewrites who has
paid; pointed at production by a stale shell it would be a very bad afternoon.

---

## Environment variables

Loaded via `dotenv` at import (`src/lib/env.ts`). On Vercel, set these in the
project's environment settings.

### Core

| Var | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | `mongodb://localhost:27017/welockin` *(dev only)* | Mongo connection string (Atlas `mongodb+srv`, DB name included). **Required in production** — boot fails closed if unset. |
| `JWT_SECRET` | `change-me` *(dev only)* | HMAC secret for user JWTs. **Required in production** — boot fails closed if unset or left at the `change-me` placeholder (a guessable secret would let anyone forge tokens). |
| `JWT_EXPIRES_IN` | `30d` | User-token lifetime (`30d`, `12h`, `3600`, …). |
| `PORT` | `8787` | Local server port (ignored on Vercel). |
| `CORS_ORIGIN` | `*` | `*` or a comma-separated allow-list. |
| `NODE_ENV` | `development` | `production` tightens logging/Prisma caching. |

### Sign in with Apple / device integrity

| Var | Default | Purpose |
|---|---|---|
| `APPLE_BUNDLE_ID` | `in.welock.app` | `aud` the Apple identityToken must carry (`POST /api/auth/apple`). |
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

### Payments — Lemon Squeezy (desktop lifetime licence)

macOS and Windows ship outside the App Store, so no store IAP is imposed and
none is possible; iOS keeps going through Adapty because Apple requires it.
Both land in the same `Purchase` table, told apart by `provider`.

| Var | Default | Purpose |
|---|---|---|
| `LEMONSQUEEZY_API_KEY` | *(empty)* | Used by `POST /api/checkout` to mint a checkout. **Test vs live is decided by which key this is** — a test key can only ever create test checkouts. |
| `LEMONSQUEEZY_WEBHOOK_SECRET` | *(empty)* | Signing secret of the webhook, set when you create it in the dashboard. Verification **fails closed** while empty: every delivery is rejected. |
| `LEMONSQUEEZY_STORE_ID` | *(empty)* | Your store. An order from any other store is refused. |
| `LEMONSQUEEZY_VARIANT_ID` | *(empty)* | **The one variant we sell.** Unset means *sell nothing*, never *sell everything* — a signature only proves the delivery is ours, not that the buyer bought the licence. |
| `LEMONSQUEEZY_VARIANTS_GRANTING` | *(empty)* | **Retired subscription variants that must keep granting** — comma-separated. The variant allowlist refuses anything it does not recognise, and a price change in Lemon Squeezy mints a *new* variant id while existing subscribers stay on the old one. Without this list, the deploy that updates the ids above cuts every one of them off, silently. Get the value from `GET /api/admin/billing/variants` before deploying. |
| `LEMONSQUEEZY_API_BASE` | `https://api.lemonsqueezy.com` | Override for tests. |
| `LEMONSQUEEZY_ALLOW_TEST_MODE` | `false` | May a **test-mode** order grant a real lifetime licence? Requires the literal `"true"`, and is deliberately *not* inferred from `NODE_ENV` — which is unset on more machines than anyone expects, and every one of those would have failed open into a free-licence tap. |

> **All-or-nothing.** The four required vars are validated together at boot
> (`checkPaymentConfig`, `src/lib/env.ts`). Setting **none** is fine — the deploy
> simply cannot sell, and `POST /api/checkout` answers 400. Setting **some**
> switches purchasing **off** and logs a loud `[env]` error, because a partial
> config fails toward lost money: with an API key but no webhook secret the
> payment page mints fine and every delivery back is rejected as unsigned, so the
> customer is charged and no licence is ever granted. An unusable storefront that
> refuses to open a checkout takes no money, so switching it off loses nothing.
>
> Outside production the same problem **throws** instead, where a failed boot
> costs a restart rather than an outage — the storefront is one feature among
> many, and it must never be able to take focus sessions, notifications and
> blocking down with it.

### The trial ledger (one free trial per machine)

| Var | Default | Purpose |
|---|---|---|
| `TRIAL_LEDGER_PEPPER` | *(derived from `JWT_SECRET`)* | Server-only HMAC key for `TrialClaim.deviceIdHash`. **Set it explicitly.** With the derived fallback, rotating `JWT_SECRET` silently orphans every claim and re-opens the trial farm. Rotating this value does the same — treat it as permanent. |
| `TRIAL_DAYS` | `14` | Trial length. Snapshotted onto each claim, so changing it never moves a window someone is already inside. |
| `TRIAL_DAYS_UNVERIFIED` | `3` | The window for a machine whose id is **resettable** (a Mac whose `IOPlatformUUID` could not be read, so the client fell back to a deletable file). Without it, breaking the hardware lookup is the bypass. |

A trial belongs to a **machine**, not to an account. Registration used to stamp
`User.trialEndsAt`, which made a trial exactly as cheap as an email address — and
`DELETE /api/me` frees the address again, so even the same one could go round
forever. `TrialClaim.deviceIdHash` is globally unique and the row **outlives the
account**: deletion nulls `firstUserId` and keeps the claim, so starting over on
the same Mac lands on the same expired window.

`User.trialEndsAt` is now read-only, honoured for every account created before
the ledger so none of them loses the window it is inside.

### Entitlement rollout

| Var | Default | Purpose |
|---|---|---|
| `ENTITLEMENT_ENFORCED` | `false` | Whether clients may **hard-gate** on the entitlement they are told. Echoed by `GET /api/entitlement` as `enforced` and used nowhere else server-side. |

The server *always* reports the true status; this only says whether the client
may act on it. It exists because the day the paywall ships, every account whose
trial quietly elapsed months ago turns `expired` at once — gating on status alone
would lock all of them out in a single update, with no way to stage it.

Turning it on also requires a usable storefront. Set to `true` while Lemon
Squeezy is unconfigured, it is **forced back off** with a loud `[env]` error:
a paywall nobody can pay through would lock out every expired account with no way
out, which is worse than no paywall. Check the boot logs after flipping it —
`enforced` silently staying `false` is the symptom.

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
- **App Attest** — `requireAttest` on counter-crediting routes (`/api/focus-events`, `/api/breaks`). Off by default (`ATTEST_REQUIRED`). *(The former `requireBoundDevice` device-binding layer was removed with the one-active-phone rule.)*

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
- **Device** — registry; `deviceId` (stable client id = the real identity; nullable only on pre-refactor rows), `kind` (`desktop`/`phone`/`tablet`, cosmetic), App Attest fields. `(userId, name)` is intentionally **non-unique** — every Mac used to report "Mac". Uniqueness is `(userId, deviceId)`, enforced by the `uniq_user_deviceId` partial index from `device:migrate`.
- **Break** — server-authoritative daily break budget; idempotent on `(userId, clientBreakId)`.
- **SyncSnapshot** — one per user: opaque `blocklists`/`sessions`/`schedules` JSON + `revision`.
- **FocusEvent** — completed-session log; idempotent on `clientEventId` via deterministic `_id`; `quarantined?` (anti-abuse, excluded from stats).
- **LiveSession** — a focus session happening *now*; one row per `(user, device, session)`; expired by heartbeat staleness; carries the admin `forceEnd` flag.
- **FeatureRequest / Vote / FeatureReport** — feedback board (idempotency keys, denormalized counts, auto-hide at 3 reports).
- **ProtectionEntry** (`protection`) — one curated blocklist entry (`category`, `kind` `site`/`app`, normalized `value`, `active`), `@@unique([kind, value])`.
- **ProtectionLock** (`protection_locks`) — per-user lock (`method` `partner`/`date`, `categories`, `otp?`, `otpAttempts?`, `lockedUntil?`).
- **OnboardingProfile** — one per user; the funnel answers, idempotent on `clientSubmissionId`. `ageBand` (never the exact age), `selfReportedDailyHours`, answer **slugs** (not indices), `revision`, and a rolling-hour write guard. `displayName`/`completedAt` are mirrored onto `User`.
- **Purchase** — one row per storefront transaction. `@@unique([provider, externalId])` — unique *with* the provider, never alone: two shops number their orders independently, and a collision would hand one customer's licence to another. `isRefunded` is what revokes access.
- **TrialClaim** — the anti-abuse ledger: one free window per MACHINE. `deviceIdHash` is `@unique` **globally** (not per user, which would be no constraint at all) and is `HMAC-SHA256(TRIAL_LEDGER_PEPPER, deviceId)` — keyed, so a database copy alone cannot be walked back to the machines it names. The row **outlives the account**: `DELETE /api/me` nulls `firstUserId` and keeps the claim. `endsAt` is stamped once and never moves.
- **AdminAuditLog** — every override that changes what someone may do, with a reason and before/after. Comps and revocations are the two ways a human can outrank the resolver, and an override nobody can explain later is indistinguishable from a mistake.
- **WebhookEvent** — at-least-once delivery ledger. `@@unique([provider, eventId])`, where `eventId` is `"<event_name>:<order_id>"`. `status` is `processing` → `processed` | `skipped` | `failed`; only the last two are **terminal**. A redelivery finding `processing` or `failed` re-runs the work, because treating mere existence as "done" loses the purchase of anyone whose first delivery died halfway.

> ⚠️ **Both `@@unique` above must exist in the production database before the
> first real order.** They are not decoration — they *are* the idempotency and the
> concurrency lock. `npx prisma db push` creates them; verify with
> `db.purchases.getIndexes()` / `db.webhookevents.getIndexes()`.

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
- **`DELETE /`** → `204`. Self-serve account deletion (Play/Apple requirement). Hard-deletes the user and all data keyed to them (focus events, devices, live sessions, auth providers, snapshot, breaks, votes, authored feature requests). Idempotent.

### Devices — `/api/devices` (user JWT)

Devices are an **inventory, not a permission system**. There is no binding, no
one-active-phone rule, no takeover and no cooldown — registering a device never
returns `409`/`429`, and no device is ever hidden behind a status.

- **`POST /`** — register / heartbeat; an idempotent upsert on `(userId, deviceId)`. `deviceSchema` = `name` (≤120), `platform` (enum `ios|ipados|macos|windows|android`, aliases `mac`/`darwin`/`osx`/`win`/`win32` normalised), **`deviceId` REQUIRED** (`^[A-Za-z0-9._:-]{8,128}$`), optional `kind` (`desktop|phone|tablet`, cosmetic), `model`, `osVersion`, `appVersion`. Unknown keys are stripped. → `200 { device }` when it already existed, `201` on first registration. `409` only when the account is already at **50** devices (an abuse ceiling, not a product limit). Registration also un-quarantines focus events this device reported before it was known.
- **`POST /heartbeat`** — refresh `lastSeenAt` for the device in `X-WeLockIn-Device-Id`. Throttled to one write per 5 min. → `204`; `404` if the header is missing or the device is unknown.
- **`GET /`** → `200 { devices: PublicDevice[] }` — an allow-listed projection: `id, deviceId, name, platform, kind, model, osVersion, appVersion, lastSeenAt, createdAt, isCurrent`. `isCurrent` is computed server-side from `X-WeLockIn-Device-Id`. No `max`, and no status filter.
- **`DELETE /:deviceId`** — remove a device by client `deviceId`, scoped to the caller's account. Any of your devices, not just the calling one. → `200 { removed }`, or `404` when nothing matched.

### Entitlement — `/api/entitlement` (user JWT)

- **`POST /trial`** → `200 EntitlementView`. Claim the free trial **for this machine**, from `X-WeLockIn-Device-Id`. Body (all optional): `idfv` (iOS secondary key), `hardwareBacked` (did the client read the id from hardware, or fall back to a deletable file — self-reported, so it can only ever make a claim *weaker*), `clientTime` (recorded as an abuse signal, never used for timing).
  **Create-only and idempotent**: a caller that already has a claim gets it back, elapsed or not — never a fresh window. The check-then-act gap is closed by the global unique index, not by the read. `400` without a device id. There is deliberately no reset here; that belongs behind the admin surface, with a reason and an audit row.
  `POST /api/auth/register` and the new-account branch of `/api/auth/apple` also claim, best-effort, so clients that predate this endpoint keep working.

- **`GET /`** → `200 EntitlementView`. The single authority on "may this user use the app right now, and until when". Read-only, and it **never creates a claim** — seeing your status must not be the thing that consumes your trial.
  `{ status, isPro, trialEndsAt, serverTime, trialDurationDays, productId, canStartTrial, enforced }`.
  `status` is one of `trialing` | `active` | `expired` | `refunded` | `comped` | `revoked`, resolved by a pure function (`src/lib/entitlement.ts`) with the precedence **revoked > active purchase > comp > active trial > refunded > expired**.
  The client **must** anchor its countdown to `serverTime`, never to the local clock — a Mac set to 1990 must not extend a trial. `enforced` echoes `ENTITLEMENT_ENFORCED` and is the only field a client may gate on. `404 ACCOUNT_NOT_FOUND` for a valid token whose account is gone.
  The computed status is mirrored onto `User.entitlementStatus` / `isProCached` / `plan` for the admin console — a **cache**, never read back for gating.

### Checkout — `/api/checkout` (user JWT)

- **`POST /`** → `201 { url }`. Mints a Lemon Squeezy checkout **server-side** and returns its URL for the desktop app to open in the real browser.
  Minting it here is the whole point: the webhook credits whoever `meta.custom_data.user_id` names, so if the app built that URL the *buyer* would be choosing which account gets the licence. The id comes from the caller's own token, before the payment page exists.
  `409` when the account already owns a live licence (a lifetime SKU bought twice costs us the fee and them the goodwill). `400` when the storefront is unconfigured or the provider is unreachable — never echoing the upstream error, which can quote the API key back.

### Lemon Squeezy webhook — `/api/webhooks/lemonsqueezy` (signature, **no** bearer token)

- **`POST /`** — the receiving half of the purchase flow. Handles `order_created` and `order_refunded`; anything else is recorded and skipped, never guessed at.
  Four rules shape every branch: **(1)** verify the HMAC before reading the body, logging it, or touching the DB; **(2)** claim → work → mark done, in that order, with the unique index as the lock; **(3)** status codes are instructions — an event we deliberately ignored gets `200` or it is redelivered forever, a failure on *our* side gets `500` precisely so it *is* retried; **(4)** a signature is not an entitlement — that the order was **paid** and **for our variant** are both checked explicitly.
  `401 INVALID_SIGNATURE` · `503 WRITE_CONFLICT` (claim did not land — please redeliver) · `200` otherwise.
  Covered by `src/routes/webhooks-lemonsqueezy.test.ts`.

### Sync — `/api/sync` (user JWT)

- **`POST /push`** — last-write-wins. Replaces the snapshot only when `replaceSnapshot: true`, or the payload has no `events`, or `schedules` is present; otherwise it is **append-only** (events stored, snapshot untouched — protects a newer PC snapshot from a stale mobile pull). When replacing, `blocklists` + `sessions` are required. `events[]` are idempotent per `clientEventId`. → `200 { revision, updatedAt }`.
- **`GET /pull`** → `200 { blocklists, sessions, schedules, revision, updatedAt }` (empty/`revision:0` if never pushed).

### Focus events — `/api/focus-events` (user JWT + attest)

- **`POST /`** — ingest ONE focus event (mobile). Idempotent on `clientEventId` (`200 { event, deduped: true }` on replay, else `201 … deduped: false`). An event citing a `deviceId` with no Device row is stored `quarantined` (excluded from stats) and released once that device registers; `501` if `ATTEST_REQUIRED` is on but the verifier isn't wired. *(Desktop reports events through `/api/sync` instead.)*

### Analytics — `/api/analytics` (user JWT)

- **`GET /summary`** → `200 { focusedSecondsWeek, sessionsCount, dayStreak, totalSessions }`. Quarantined events excluded. Streak buckets by **server-local (UTC on Vercel)** calendar days.

### Breaks — `/api/breaks` (user JWT + attest)

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

**Production checklist (boot fails closed without the required secrets):**

- [ ] `DATABASE_URL` — the Atlas connection string (**required**; boot throws otherwise).
- [ ] `JWT_SECRET` — a long random value, **not** `change-me` (**required**; boot throws otherwise).
- [ ] `ADMIN_USERNAME` + `ADMIN_PASSWORD` — a strong password (admin login is disabled while the password is empty).
- [ ] `APPLE_BUNDLE_ID` = `in.welock.app` (if Sign in with Apple is used).
- [ ] `RESEND_API_KEY` + `RESEND_FROM` — for the addiction-protection partner OTP email.
- [ ] `CORS_ORIGIN` — the web/admin origins (not `*`) if browser clients call the API. ⚠️ The desktop app is a Tauri webview on the `tauri://localhost` origin — narrow this only after checking it still passes.
- [ ] Run `npx prisma db push` and `npm run device:migrate` once, and `npm run protection:seed` to load the curated blocklist.

**Deploying the trial ledger — run the migration BEFORE the code:**

MongoDB creates a collection implicitly on first insert, **without any index**.
A deploy that lands before the migration therefore gets a `TrialClaim` collection
with no unique constraint on `deviceIdHash`: every claim succeeds, the anti-farm
protection is silently absent, and by the time anyone notices there are duplicate
rows that make the index impossible to build.

```bash
DATABASE_URL="<prod>" npm run entitlement:migrate -- --dry-run   # index + a count, no writes
DATABASE_URL="<prod>" npm run entitlement:migrate                # index + grandfather
```

The script refuses to continue if the index cannot be built, because without it
the ledger enforces nothing.

**Going live with payments — order matters, because the first mistake is unrecoverable:**

1. [ ] In the Lemon Squeezy dashboard: create the store, the **Lifetime licence** product with a single variant, and note `store_id` + `variant_id`. They **differ between test and live** — copying a product to live mode assigns it a new id.
2. [ ] Create the webhook → `https://<domain>/api/webhooks/lemonsqueezy`, events `order_created` and `order_refunded`. Keep **test and live as separate webhooks** pointing at separate deployments with separate databases; that is cleaner than `LEMONSQUEEZY_ALLOW_TEST_MODE`, which risks being left on in production.
3. [ ] Set **all four** required vars *before* the store can take an order. A half-configured deploy switches purchasing off and says so in the boot log; an order that still arrives is recorded as `failed` (retryable) rather than dropped — but the safe path is simply to configure first, in one go.
4. [ ] Confirm `npx prisma db push` created the `Purchase` and `WebhookEvent` unique indexes (see the data-model note).
5. [ ] Send a **test-mode order** end to end and confirm a `Purchase` row appears and `GET /api/entitlement` flips to `active`. This is also the check that the raw body survives the platform: `verifyWebhookSignature` fails closed on an empty `rawBody`, so a silent regression there looks exactly like a wrong secret — and the tempting fix is to stop verifying.
6. [ ] Only then, and only after grandfathering the existing cohort, set `ENTITLEMENT_ENFORCED=true`. Boot refuses this while the storefront is unconfigured.

### Generic Node host (Render / Railway / Docker)

Build `npm install && npm run build`, start `npm start`. Provide `DATABASE_URL`,
`JWT_SECRET` (+ the optional vars). Most hosts inject `PORT` automatically.

---

## Security notes & known limitations

Honest posture (some are intentional product decisions, some are open work):

- **No rate limiting** on `POST /api/auth/login`, `/register`, `POST /api/admin/login`, or the OTP `POST /api/addiction-protection/{lock,resend}` (the latter can email an attacker-chosen partner address repeatedly). Proper limiting on serverless needs a DB/Redis-backed limiter — tracked, not yet implemented.
- **Secrets fail *closed* in production.** With `NODE_ENV=production`, boot throws if `DATABASE_URL` or `JWT_SECRET` is unset (or `JWT_SECRET` is still the `change-me` placeholder) — no silent fallback to a guessable secret. In dev/test the fallbacks keep zero-config runs working.
- **Partner OTP is stored in plaintext and shown to admins** — *intentional*: it's a friction code (with a 5-try cap), not a credential.
- **Day-streak analytics use the server timezone (UTC on Vercel)**, so a streak can flip at a different local time than a non-UTC user expects.
- **App Attest is scaffolded but fail-closed** — `/api/attest/register` always returns `501` and `ATTEST_REQUIRED` must stay `false` until the native verifier is wired. Focus/break counters are binding-protected but forgeable by the account owner until then.
- **`deviceId` is client-supplied, so the trial ledger has a ceiling.** The macOS app derives it from `IOPlatformUUID` (`src-tauri/src/device.rs`), which survives reinstall and disk erase — but it travels in a header, and a patched build can send whatever it likes. The ledger's job is to stop "make another account" from being a bypass, not to be unforgeable. Raising the ceiling further means attestation, which does not exist for Developer-ID macOS apps today.
- **Nothing server-side is gated on entitlement.** `computeEntitlement` is read by its own route and nothing else: no endpoint refuses service to a non-pro user. Enforcement is entirely the client's decision, which means it is only as strong as the client.
- **No admin comp/revoke routes yet.** The columns and the resolver support both, and `npm run entitlement:migrate` writes comps, but `POST /api/admin/users/:id/suspend` and `.../plan` still change columns the resolver does not read — they do **not** take access away.
- **No trial-claim reset endpoint.** A replaced logic board or a resold Mac currently has no self-service path; it needs a hand-edit until the admin surface lands.
- **The refund path is all-or-nothing.** Any `order_refunded` revokes the licence, including what Lemon Squeezy classes as a partial refund.

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
    lib/                   # env, prisma, jwt, admin-jwt, apple, attest, resend, http-error, user, device, deterministic-id
    middleware/            # auth, admin-auth, attest, async-handler, error
    routes/                # health, auth, me, devices, sync, focus-events, analytics,
                           #   feedback, attest, breaks, sessions, admin, addiction-protection,
                           #   admin-protection  (+ *.test.ts contract tests)
    services/              # analytics, admin-stats, focus-events, sync-policy
    validation/schemas.ts  # zod request schemas
    admin/page.ts          # the /admin feedback-board HTML dashboard
```
