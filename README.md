# WeLockin Backend

A small, self-contained backend for the WeLockin focus/blocking app. It provides
three things:

1. **Accounts & auth** — email/password register + login, JWT sessions, and a
   `plan` field (`trial` / `pro`) with a `trialEndsAt` date.
2. **Multi-device sync** — the desktop app pushes and pulls its local state
   (blocklists, focus-session cards) plus a log of completed focus events.
3. **Analytics** — aggregates focus events into weekly summary stats and a day
   streak.

**Stack:** Node.js + Express (TypeScript), Prisma ORM with the **MongoDB**
provider, JWT auth (bcryptjs + jsonwebtoken), zod validation.

---

## Prerequisites

- **Node.js 18+**
- A **MongoDB replica set**. Prisma's MongoDB connector requires one.
  [MongoDB Atlas](https://www.mongodb.com/atlas) provides a replica set by
  default, including on the free **M0** tier — this is the easiest path. A bare
  local `mongod` will **not** work unless it is started as a replica set.

---

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Configure the environment
cp .env.example .env
#    then edit .env and set DATABASE_URL + JWT_SECRET

# 3. Generate the Prisma client (required before building/running)
npx prisma generate

# 4. Push the schema to your database (requires a live DB connection)
npx prisma db push

# 5. Run in development (hot reload)
npm run dev
```

The server listens on `http://localhost:8787` by default (`PORT` in `.env`).

### Creating a MongoDB Atlas free cluster

1. Sign up at <https://www.mongodb.com/atlas> and create a free **M0** cluster.
2. Under **Database Access**, create a database user (username + password).
3. Under **Network Access**, allow your IP (or `0.0.0.0/0` for development).
4. Click **Connect → Drivers** and copy the `mongodb+srv://...` connection
   string. Insert your user/password and add a database name, e.g.
   `.../welockin?retryWrites=true&w=majority`.
5. Paste it into `.env` as `DATABASE_URL`.
6. Run `npx prisma db push` to create the collections/indexes.

---

## Scripts

| Script                    | What it does                                              |
| ------------------------- | -------------------------------------------------------- |
| `npm run dev`             | Run with `tsx watch` (hot reload).                       |
| `npm run build`           | `prisma generate && tsc` — builds to `dist/`.            |
| `npm start`               | Run the compiled server (`node dist/index.js`).          |
| `npm run typecheck`       | Type-check only (`tsc --noEmit`).                        |
| `npm test`                | Run the lightweight test suite (node:test + supertest).  |
| `npm run prisma:generate` | Regenerate the Prisma client.                            |
| `npm run prisma:push`     | Push the schema to the database (`prisma db push`).      |

> `npm run build` does **not** need a live database — `prisma generate` only
> reads the schema. Only `prisma db push` and running the server against real
> routes need MongoDB.

---

## Environment variables

| Variable         | Default                         | Description                                        |
| ---------------- | ------------------------------- | -------------------------------------------------- |
| `DATABASE_URL`   | `mongodb://localhost:27017/...` | MongoDB connection string (Atlas `mongodb+srv`).   |
| `JWT_SECRET`     | `change-me`                     | Secret used to sign JWTs. Use a long random value. |
| `JWT_EXPIRES_IN` | `30d`                           | Token lifetime (`30d`, `12h`, `3600`, …).          |
| `PORT`           | `8787`                          | HTTP port.                                         |
| `CORS_ORIGIN`    | `*`                             | `*` or a comma-separated allow-list of origins.    |

---

## API reference

All endpoints are under `/api` and speak JSON. Errors always return
`{ "error": string }` with an appropriate HTTP status.

Authenticated endpoints require an `Authorization: Bearer <token>` header
(the token returned by register/login).

### `GET /api/health` — no auth

```json
{ "ok": true, "time": "2026-07-06T12:00:00.000Z" }
```

### `POST /api/auth/register` — no auth

Request:

```json
{ "email": "you@example.com", "password": "at-least-8-chars" }
```

Response `201`:

```json
{
  "token": "<jwt>",
  "user": {
    "id": "…",
    "email": "you@example.com",
    "plan": "trial",
    "trialEndsAt": "2026-07-20T12:00:00.000Z",
    "createdAt": "…",
    "updatedAt": "…"
  }
}
```

Sets `plan: "trial"` and `trialEndsAt = now + 14 days`. The password hash is
never returned.

### `POST /api/auth/login` — no auth

Request `{ "email", "password" }` → `{ "token", "user" }` (same shape as
register). Returns `401` on bad credentials.

### `GET /api/me` — auth

```json
{ "user": { "id": "…", "email": "…", "plan": "trial", "trialEndsAt": "…", … } }
```

### `POST /api/devices` — auth

Upserts a device by `(userId, name)` and refreshes `lastSeenAt`.

Request:

```json
{ "name": "Hedi's Laptop", "platform": "windows" }
```

Response:

```json
{
  "device": {
    "id": "…",
    "userId": "…",
    "name": "Hedi's Laptop",
    "platform": "windows",
    "lastSeenAt": "…",
    "createdAt": "…"
  }
}
```

### `POST /api/sync/push` — auth

Last-write-wins upsert of the user's snapshot, plus optional append of focus
events.

Request:

```json
{
  "blocklists": [{ "name": "Social", "domains": ["instagram.com"] }],
  "sessions": [{ "id": "card-1", "name": "Deep work", "minutes": 50 }],
  "events": [
    {
      "name": "Deep work",
      "startedAt": "2026-07-06T09:00:00.000Z",
      "endedAt": "2026-07-06T09:50:00.000Z",
      "plannedSeconds": 3000,
      "completed": true,
      "hardLock": false,
      "killedTotal": 0
    }
  ]
}
```

`startedAt` / `endedAt` accept an ISO string **or** epoch milliseconds.
`killedTotal` is optional (defaults to `0`). `events` is optional.

Response:

```json
{ "revision": 3, "updatedAt": "2026-07-06T09:50:01.000Z" }
```

### `GET /api/sync/pull` — auth

```json
{
  "blocklists": [ … ],
  "sessions": [ … ],
  "revision": 3,
  "updatedAt": "2026-07-06T09:50:01.000Z"
}
```

Returns empty arrays, `revision: 0`, `updatedAt: null` if the user has never
pushed.

### `GET /api/analytics/summary` — auth

```json
{
  "focusedSecondsWeek": 12000,
  "sessionsCount": 4,
  "dayStreak": 3,
  "totalSessions": 42
}
```

- `focusedSecondsWeek` — sum of `endedAt - startedAt` (seconds) for events in
  the last 7 days.
- `sessionsCount` — events in the last 7 days.
- `totalSessions` — all events ever.
- `dayStreak` — consecutive calendar days up to today with ≥ 1 **completed**
  event (0 if today has none).

---

## Deployment (Render / Railway)

The service is a plain Node HTTP server, so any Node host works.

**Build command:**

```bash
npm install && npm run build
```

**Start command:**

```bash
npm start
```

**Environment variables to set** on the host: `DATABASE_URL`, `JWT_SECRET`,
and optionally `JWT_EXPIRES_IN`, `PORT`, `CORS_ORIGIN`. Most hosts inject
`PORT` automatically — this server honors it.

**One-time schema push:** run `npx prisma db push` once against your production
`DATABASE_URL` (locally with the prod URL, or via a one-off job) so the
collections and indexes exist.

### Render

- New **Web Service** → connect this repo.
- Runtime: **Node**. Build: `npm install && npm run build`. Start: `npm start`.
- Add the env vars above.

### Railway

- New project → **Deploy from repo**.
- Railway auto-detects Node. Set the build/start commands and env vars as above.

---

## Project structure

```
backend/
  package.json
  tsconfig.json
  .gitignore
  .env.example
  prisma/
    schema.prisma        # User, Device, SyncSnapshot, FocusEvent (MongoDB)
  src/
    index.ts             # loads env, starts the HTTP server
    app.ts               # express app: helmet, cors, morgan, json, routes, errors
    lib/
      env.ts             # env loading/validation
      prisma.ts          # PrismaClient singleton
      jwt.ts             # sign/verify JWTs
      http-error.ts      # HttpError + helpers
      user.ts            # strip passwordHash for API responses
    middleware/
      auth.ts            # Bearer JWT -> req.user
      error.ts           # 404 + central error handler ({ error })
      async-handler.ts   # forwards async errors to the error handler
    routes/
      health.ts  auth.ts  me.ts  devices.ts  sync.ts  analytics.ts
    services/
      analytics.ts       # summary + day-streak computation
    validation/
      schemas.ts         # zod request schemas
```
