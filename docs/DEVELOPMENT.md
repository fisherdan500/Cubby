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

## Network And Origin Configuration

Docker Compose publishes `${APP_PORT}:3000` without a loopback-only host binding,
so Cubby listens on the host's network interfaces. LAN reachability still
depends on the host firewall and network policy. Better Auth origin validation
is a separate security boundary and should remain enabled.

An origin must match the browser address exactly:

- Scheme: `http` and `https` are different origins.
- Host: `localhost`, a LAN IP, and a DNS hostname are different origins.
- Port: `3000` and `3002` are different origins.
- Paths are not part of an origin and should not be added to `TRUSTED_ORIGINS`.

### Localhost-Only

```dotenv
APP_PORT=3000
BETTER_AUTH_URL=http://localhost:3000
TRUSTED_ORIGINS=http://localhost:3000,http://127.0.0.1:3000
```

### Direct LAN Address

Use the exact address opened by other devices. Reserve the server address in
DHCP before treating an IP-based configuration as permanent.

```dotenv
APP_PORT=3002
BETTER_AUTH_URL=http://192.168.1.50:3002
TRUSTED_ORIGINS=http://localhost:3002,http://127.0.0.1:3002,http://192.168.1.50:3002
```

Better Auth supports origin wildcard patterns, but a subnet pattern such as
`http://192.168.1.*:3002` broadens the accepted origins and should be limited to
temporary development. `BETTER_AUTH_URL` must still be one exact canonical
origin.

### Stable Live Hostname

For long-term deployment, create a local DNS record such as
`cubby.home.arpa`, point it to the Cubby host, and terminate HTTPS through a
reverse proxy such as Caddy, Nginx, or Traefik.

```dotenv
BETTER_AUTH_URL=https://cubby.home.arpa
TRUSTED_ORIGINS=https://cubby.home.arpa
```

All household devices should use that same URL. HTTPS provides transport
security and the secure browser context needed for reliable service workers,
PWA installation, push notifications, and secure-cookie behavior.

The existing manifest and service worker support installation and a lightweight
shell only. Activity logging remains network-required; there is no offline write
queue, synchronization, or conflict resolution.

After changing only `.env`, recreate the app container so it receives the new
values; an image rebuild is not required:

```bash
docker compose up -d --force-recreate app
```

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
needed. New activity and timer writes must lock and re-read the baby and acting
membership inside the transaction and reject inactive babies there, not only in
pre-transaction page or API checks.

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

Member suspension is household-scoped. Resolve household access only through
membership queries that require both `deletedAt: null` and `disabledAt: null`.
Users with another active household membership may sign in, but users whose only
current memberships are suspended receive exactly `Your account is disabled.`
after credential verification. Do not remove the uncached server session lookup
or the migration's guarded `Session` insert trigger: together with transactional
session deletion, they close stale-cookie and concurrent-sign-in gaps. The trigger
uses the dedicated `CUB01` SQLSTATE; the Better Auth Prisma adapter wrapper must
translate only that marker plus the exact message to `403 / ACCOUNT_DISABLED`.

Role, removal, suspension, and restoration mutations must acquire deterministic
row locks for the acting and target membership, then re-read and authorize inside
the transaction. Suspension writes `member.suspend`, restoration writes
`member.restore`, and only a real state transition writes an audit event.

### Baby Selection

Log Entry, Full Log, Calendar, Reports, and Nursery use the shared header baby
selector behavior. Active tracking surfaces such as Log Entry, Dashboard, and
Nursery should offer active babies only and render an intentional `No active
babies` state when none remain. Historical surfaces such as Full Log, Calendar,
Reports, activity detail, and edit should retain inactive babies and label them
explicitly. Pages should preserve `babyId` in links and search params where the
selected baby matters.

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

Cubby version 2 JSON recovery validates format, limits, references, timer state,
and checksum before writing. It restores only into a fresh household whose
current member is the sole active owner; preview does not replace the locked
empty-target recheck inside the serializable restore transaction. Do not bypass
service-layer ownership checks or turn this path into merge/replace behavior.

Backups intentionally exclude auth users, credentials, sessions, memberships,
invitations, registration policy, integration secrets/runtime records,
notifications, operational history, warning dismissals, and vaccine attachment
metadata and bytes. Restore must preserve the target owner identity and
membership. Version 1 recovery is partial and fresh-target-only. Sprout import
remains a separate additive clean-room importer.

Run the isolated real-PostgreSQL rehearsal only with:

```bash
npm run verify:backup-recovery
```

The harness never loads `.env` or the normal Compose stack and always attempts
project-scoped volume teardown. See [Manual Backup Recovery](recovery/manual-backup.md)
for prerequisites, expected output, complete inclusion/exclusion rules, and
recovery limitations.

### Visual Assets And Themes

Use semantic colors from `tailwind.config.ts` and `src/styles/globals.css`
instead of adding page-specific saturated color palettes. Household accents are
defined in `src/domain/appearance.ts`. Activity artwork belongs in
`public/activity-art` and should be rendered through `ActivityArtwork` so image
fallbacks, dimensions, and dark-mode framing stay consistent.

Cubby uses locally packaged Manrope and Fraunces font files through Fontsource;
the app does not depend on a font CDN at runtime. See
`docs/THIRD_PARTY_ASSETS.md` before changing font or illustration sources.

The Cradle Cubby logo source lives under `public/brand`, while browser and PWA
PNG outputs live under `public/icons`. After editing the source SVGs, regenerate
and validate every raster size with:

```bash
npm run brand:icons
```

Keep the logo's fixed sage/ivory identity separate from household accent themes.
Use `BrandMark` or `BrandLockup` instead of adding one-off logo markup.

### Calendar And Reports

Calendar and Reports should use `APP_TIMEZONE`, the selected baby, and existing
service calculations. Keep filter changes auto-applying where the current UI
expects that behavior.

## Troubleshooting

### Invalid Origin During Sign-Up Or Sign-In

1. Read the origin from the failing device's address bar: scheme, host, and port.
2. Set `BETTER_AUTH_URL` to the canonical origin Cubby should use.
3. Add every intentionally supported browser origin to `TRUSTED_ORIGINS`.
4. Run `docker compose up -d --force-recreate app`.
5. Refresh the browser. If an installed PWA still shows an old build, clear its
   site data or reinstall it.

Include both `localhost` and `127.0.0.1` only when both forms are intentionally
used. Do not disable origin validation or dynamically trust arbitrary request
hosts to work around this error.

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
