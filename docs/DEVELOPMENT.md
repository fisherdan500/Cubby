# Cubby Development

This document covers local setup, Docker setup, common workflows, verification,
and troubleshooting.

## Prerequisites

- Node.js 22 is recommended because the Docker image uses Node 22.
- npm.
- Docker Desktop for the compose stack.
- PostgreSQL if running the app outside Docker.

## Environment

Start from `.env.example`:

```bash
cp .env.example .env
```

Important variables:

- `DATABASE_URL`: Prisma PostgreSQL connection string.
- `BETTER_AUTH_SECRET`: long random secret. Do not use the example value in production.
- `BETTER_AUTH_URL`: canonical browser URL, including host port.
- `TRUSTED_ORIGINS`: comma-separated origins accepted by Better Auth.
- `ENABLE_REGISTRATION`: enables first-owner setup when no owner exists.
- `ALLOW_PUBLIC_REGISTRATION`: default owner-controlled public registration state.
- `APP_TIMEZONE`: app-level timezone for display, grouping, reports, imports, and redirects.
- `APP_PORT`: host port mapped by Docker Compose.

Optional variables can be added to `.env` even when they are not listed in
`.env.example`.

For local Docker on a non-default port, keep these aligned:

```dotenv
APP_PORT=3002
BETTER_AUTH_URL=http://localhost:3002
TRUSTED_ORIGINS=http://localhost:3002,http://127.0.0.1:3002
```

If these do not match the browser URL, Better Auth can reject sign-up or sign-in
with an invalid origin error.

## Docker Workflow

Build and start:

```bash
docker compose up --build
```

Detached start:

```bash
docker compose up --build -d
```

Logs:

```bash
docker compose logs --tail 300 app
```

The app container runs `prisma migrate deploy` before starting the Next server.
Postgres data persists in the `cubby_postgres_data` named volume.

## Local Workflow

Install dependencies and generate Prisma client:

```bash
npm install
npm run db:generate
```

Run the development server:

```bash
npm run dev
```

For local development outside Docker, set `DATABASE_URL` to a reachable
PostgreSQL database.

## Prisma Workflow

Schema lives in `prisma/schema.prisma`.

Common commands:

```bash
npm run db:generate
npm run db:migrate
npm run db:deploy
npm run db:seed
```

Use `npm run db:migrate` for local migration creation. Docker production startup
uses `npm run db:deploy` through the container command.

When changing schema:

- Keep household ownership and indexes explicit.
- Add service tests for permission and cross-household behavior.
- Run Prisma validation/generation and the full app build.

## Verification Commands

Full verification set:

```bash
npm run lint
npm run typecheck
npm run test
npm run build
docker compose up --build -d
```

Use the full set for behavior, schema, auth, import, or Docker-sensitive changes.
For docs-only changes, markdown review and `git status --short` are usually
enough.

## Common Development Notes

### Activities

Activity writes should go through `src/server/services/activities.ts`. Preserve
the `ActivityLog` aggregate pattern and add type-specific details only where
needed.

### Permissions

Every household-scoped read or write must validate the current member and
permission server-side. Prefer existing context helpers and role permissions from
`src/domain/roles.ts`.

The household owner is protected and is the only role that can appoint or revoke
admins. Admins may manage parents, caretakers, and read-only members, but must not
be able to modify the owner or another admin. Settings pages must use the same
permission model as their services and APIs.

### Sessions And Sign-In Throttling

Active Sessions uses Better Auth's own session-listing and revocation endpoints.
These sensitive endpoints require a session less than 10 minutes old. Keep the
reauthentication state explicit instead of treating a `403 SESSION_NOT_FRESH`
response as an empty list.

In production, Better Auth allows three sign-in requests per client IP and
route in a 10-second window. This counts requests, not only incorrect passwords,
and is not an account lockout. The limiter currently uses Better Auth's in-memory
storage and resets when the window elapses or the app process restarts.

### Baby Selection

Log Entry, Full Log, Calendar, Reports, and Nursery use the shared header baby
selector behavior. Pages should preserve `babyId` in links and search params
where the selected baby matters.

### Timezone

Do not use browser timezone or per-baby timezone for current app grouping. Use
`APP_TIMEZONE` and existing time helpers. Store timestamps as instants, then
format/group for display using the app timezone.

### Sprout Import

Sprout import is a clean-room data importer, not a database restore. It should
map Sprout user-owned tracking data into Cubby's schema and skip incompatible
auth, secrets, sessions, email, API-key, and push runtime data.

The SQLite reader is Docker-sensitive because `sql.js` and its WASM file must be
available from runtime `node_modules`. After changing Sprout SQLite loading,
rebuild Docker and test preview/import from `/app/settings/backups`.

### Backups

Cubby JSON backup restore should validate the input and import into the current
household with permission checks. Do not bypass service-layer ownership checks
for restore paths.

### Visual Assets And Themes

Use semantic colors from `tailwind.config.ts` and `src/styles/globals.css`
instead of adding page-specific saturated color palettes. Household accents are
defined in `src/domain/appearance.ts`. Activity artwork belongs in
`public/activity-art` and should be rendered through `ActivityArtwork` so image
fallbacks, dimensions, and dark-mode framing stay consistent.

Cubby uses locally packaged Manrope and Fraunces font files through Fontsource;
the app does not depend on a font CDN at runtime. See
`docs/THIRD_PARTY_ASSETS.md` before changing font or illustration sources.

### Calendar And Reports

Calendar and Reports should use `APP_TIMEZONE`, the selected baby, and existing
service calculations. Keep filter changes auto-applying where the current UI
expects that behavior.

## Troubleshooting

### Invalid Origin During Sign-Up Or Sign-In

Check the browser URL, `BETTER_AUTH_URL`, and `TRUSTED_ORIGINS`. Include both
`localhost` and `127.0.0.1` forms if both are used.

### Port 3000 Is Already In Use

Set `APP_PORT`, `BETTER_AUTH_URL`, and `TRUSTED_ORIGINS` together, then rebuild
or restart the compose stack.

### Sprout Import Says SQLite Reader Could Not Start

Rebuild the app container and check:

```bash
docker compose logs --tail 300 app
```

The importer logs the attempted `sql.js` JavaScript and WASM paths when loading
fails. Verify `node_modules/sql.js/dist/sql-wasm.js` and `sql-wasm.wasm` are
present in the running container.

### Imported Data Appears On The Wrong Day

Confirm `APP_TIMEZONE` in `.env` and Docker Compose. Sprout offset-less datetime
strings are interpreted as UTC instants, then grouped for display by
`APP_TIMEZONE`.

### Registration Link Is Hidden

After the first owner exists, public account creation is controlled by owner
settings. New members should normally be added through `/app/settings/members`
invite links.
