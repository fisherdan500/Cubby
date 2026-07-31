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
- `ENABLE_REGISTRATION`: permits only the first account while no users, households,
  platform audit history, or platform owner exist. Later account and household
  policy comes only from platform settings.
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
`docker/entrypoint.sh` emits sanitized migration/server phase markers and exits
without starting Next.js when migration deployment fails. PostgreSQL data
persists in the `cubby_postgres_data` named volume. The app is healthy only when
`/api/health` completes a database query and returns `{"status":"ready"}`;
PostgreSQL liveness alone is not enough.

For an existing always-on deployment, do not treat `docker compose up --build`
as the whole update procedure. Follow [Always-On Updates](ALWAYS_ON_UPDATES.md),
including a fresh checksummed backup, non-mutating preflight, write freeze,
startup phase review, and post-update auth/data/timer/backup verification.

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

## Platform Owner Binding And Recovery

Platform authority is deployment-wide and independent of every household role.
All operations below are host-local, require exact stable user IDs and email
confirmation, and write platform audit events without pretending that the target
user was the operator.

Better Auth password signup currently creates an unverified first account and
Cubby has no outbound verification-email transport. Before initial binding only,
an operator can explicitly attest the sole account. This requires no existing
platform owner, exactly one user, a usable password credential, and the exact
acknowledgement token:

```bash
npm run platform:owner -- verify-bootstrap --user-id <stable-user-id> --confirm-email <exact-email> --acknowledgement I_ACCEPT_LOCAL_BOOTSTRAP_EMAIL_VERIFICATION
```

Verification is never implicit in binding. Bind the verified account separately:

```bash
npm run platform:owner -- bind --user-id <stable-user-id> --confirm-email <exact-email>
```

Binding fails after any authority row exists, including a retry for the same user.
If an operator loses the command result, inspect the command exit/output and the
platform state through an approved maintenance procedure. Do not assume success or
rerun against a different target. Serialization conflicts return
`platform_owner_operation_retry`; retry only the identical operation after confirming
that its inputs remain current.

Emergency recovery is a compare-and-swap operation, not ordinary household-owner
transfer. It requires the exact current owner ID plus a different verified
successor account with a usable password credential.

If that credential-backed successor is unverified and no outbound verification
transport is configured, first run the explicit host-local attestation operation:

```bash
npm run platform:owner -- attest-successor --current-owner-user-id <current-id> --successor-user-id <successor-id> --confirm-successor-email <exact-successor-email> --acknowledgement I_ACCEPT_LOCAL_SUCCESSOR_EMAIL_VERIFICATION
```

Attestation checks the persisted current authority, rejects the current owner as
their own successor, requires a byte-exact email match (including case) and usable
password credential, and rejects an already-verified target. It transactionally marks
only that selected account verified and writes
`platform.owner.successor_user.verify` with source
`host_local_successor_verification`; the audit snapshots retain the confirmed
current owner ID. The audit actor remains null because this is a host-local
administrative action, not an authenticated action by the account being attested.
This operation does not send or simulate an email, prove control of the mailbox, or
transfer authority. Use it only after the operator has independently established
the selected successor's identity and mailbox ownership. If the account is already
verified through a configured transport, skip attestation.

After attestation (or existing verification), transfer authority separately:

```bash
npm run platform:owner -- recover --current-owner-user-id <current-id> --successor-user-id <successor-id> --confirm-successor-email <exact-successor-email>
```

In the production image, replace `npm run platform:owner --` with:

```bash
docker compose exec -T app node /app/platform-owner.mjs
```

The commands intentionally perform no database work for invalid/help invocations.
Do not pass credentials, passwords, or database connection strings on their command
line.

### Explicit Automated-Backup Recovery Authority

Filesystem presence, sole-household status, household ownership, platform
ownership, and target freshness do not authorize an unassociated server-local
backup. Ordinary status and download paths require a complete backup record for
the current household before opening a filename; foreign, unassociated, and
nonexistent filenames share the same `not_found` result.

Recovery from a preserved backup directory is therefore a separate host-local
workflow. After creating or preserving a credential-backed target-owner account,
binding the current platform owner, disabling public registration, setting
household creation mode to `closed`, and confirming there are zero active
households, provision the supported empty target:

```bash
npm run platform:owner -- provision-backup-recovery-target --current-owner-user-id <current-platform-owner-id> --target-owner-user-id <target-owner-user-id> --confirm-target-owner-email <exact-persisted-email> --target-household-name <new-target-name> --acknowledgement I_PROVISION_EMPTY_BACKUP_RECOVERY_TARGET
```

This serializable operation shares a deployment-wide advisory lock with ordinary
onboarding, locks and rechecks the closed platform policy, and creates exactly one
household, sole owner membership, default settings, and both audit events. It
creates no baby or other recoverable data, and fails closed if the policy is open,
any active household already exists, or the target owner lacks a usable password
credential. Authorization takes the same lock and policy check. Normal household
onboarding is not a recovery target because it creates recoverable data.

Next inspect one exact candidate without database mutation:

```bash
npm run platform:owner -- inspect-backup-recovery --current-owner-user-id <current-platform-owner-id> --filename <exact-backup-filename>
```

Then copy the exact filename, checksum, and source household name from that result
into the authorization command together with the exact fresh target identity:

```bash
npm run platform:owner -- authorize-backup-recovery --current-owner-user-id <current-platform-owner-id> --target-household-id <target-household-id> --target-owner-user-id <target-owner-user-id> --confirm-target-owner-email <exact-persisted-email> --filename <exact-backup-filename> --confirm-checksum <exact-sha256> --confirm-source-household-name <exact-source-household-name> --acknowledgement I_AUTHORIZE_EXPLICIT_BACKUP_RECOVERY
```

The authorization operation performs a non-mutating platform-owner and replay
precheck before opening the file, then rechecks authority and target state and
reopens the exact candidate inside a serializable transaction immediately before
association. It requires exactly one active household, the named
credential-backed user as that household's sole active owner, zero recoverable
operational rows, exact byte-for-byte email and source-name confirmations, and an
unassociated globally unique storage filename. It creates one complete
`recovery_authorized` `BackupRecord` plus `platform.backup_recovery.authorize`
and `backup.recovery.authorize` audit events atomically. Audit actors remain null
because the operation is host-local; confirmed stable IDs are retained in the
audit snapshots instead of attributing the action to the target account.

The backup record is the durable, one-file/one-household authorization and its
unique storage filename prevents replay or reassignment. No bearer recovery token
is issued. The selected version becomes visible to that household's ordinary
backup UI only after authorization. Download does not consume the association;
restore preview, checksum confirmation, typed target name, and in-transaction
fresh-target checks remain separate safety gates. See
[Automated Local Backups](recovery/automated-local-backups.md#recovery-workflow).

The additive migration retains legacy household registration columns, but new code
does not synchronize them. Before starting a rollback image, freeze writes, set the
legacy `ALLOW_PUBLIC_REGISTRATION` environment value to `false`, and reconcile
`ENABLE_REGISTRATION` with the intended rollback posture. Then explicitly reconcile
every legacy household registration value to the intended platform policy. Older
code combines those environment values and legacy columns, so skipping any part of
this fence can reopen or close registration incorrectly. Migration application,
rollback reconciliation, owner operations, and deployment each require their own
approved maintenance step.

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

Update/migration changes also provide focused non-Docker contracts and a
separately gated disposable Docker rehearsal:

```bash
npx vitest run --config scripts/update-preflight.vitest.config.ts
npm run verify:update-preflight -- --backup-file /private/path/to/cubby-backup.json
npm run verify:update-rehearsal
```

The focused preflight test is non-Docker and covers both legacy JSON-array and
Docker Compose 5.2 newline-delimited service output. The preflight command itself
inspects the current normal stack and therefore belongs in an approved maintenance
preflight. The rehearsal creates only a unique
loopback-bound disposable project with generated credentials and fixed historical
migration baseline; do not run it implicitly during ordinary unit verification.

Consequential activity receipt/replay changes additionally require the separately
gated disposable PostgreSQL contract before publication:

```bash
npm run verify:activity-update-safety
```

It runs against generated credentials in a loopback-only project and never reads
`.env` or targets the normal Compose project.

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

Automated local backups are disabled by default and remain local-only. Compose
bind mounts `${CUBBY_BACKUP_HOST_DIR:-./docker-data/backups}` into
`/var/lib/cubby/backups`. Do not expose host paths, raw filesystem errors,
secrets, or `.env` values through Settings, logs, or saved backup records.
Normal GET or prefetch requests must never create a backup; manual export stays
POST-only and local recovery uses download-then-upload of an existing immutable
file.

Run the isolated real-PostgreSQL rehearsal only with:

```bash
npm run verify:backup-recovery
```

The harness never loads `.env` or the normal Compose stack, uses its own
generated temporary backup directory, and always attempts project-scoped volume
teardown. See [Backup Recovery](BACKUP_RECOVERY.md) for prerequisites, expected
output, complete inclusion/exclusion rules, and recovery limitations.

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
