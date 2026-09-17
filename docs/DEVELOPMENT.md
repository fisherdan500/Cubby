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

- `DATABASE_URL`: non-owner runtime PostgreSQL connection string. The web server must use `cubby_runtime`, never the migration owner.
- `AUTH_DATABASE_URL`: restricted `cubby_auth` connection used only by Better Auth. It can read the minimum identity/session tables and write Session rows; it cannot mutate credentials, security evidence, household data, or business data.
- `EMAIL_DELIVERY_DATABASE_URL`: separate `cubby_email_delivery` connection used only by the encrypted email worker. It has procedure execution but no direct outbox-table read access.
- `MIGRATION_DATABASE_URL`: separate `cubby_migrator` owner connection used only by the startup migration step; it is removed before Next.js starts.
- `CUBBY_RUNTIME_DB_PASSWORD`, `CUBBY_AUTH_DB_PASSWORD`, `CUBBY_EMAIL_DELIVERY_DB_PASSWORD`, `CUBBY_MIGRATOR_DB_PASSWORD`, and `CUBBY_SECURITY_OPERATOR_DB_PASSWORD`: distinct generated database-role passwords used by Compose. The operator password exists only for startup provisioning/rotation and is removed before Next.js starts. Do not reuse them or commit real values.
- `CUBBY_THROTTLE_KEY`: one stable 32-byte base64url deployment secret used only for private throttle identities, history handles, and cursors. Startup verifies its owner-table digest; it is never logged or backed up and has no ordinary rotation path.
- `CUBBY_TRUSTED_PROXY_HOPS`: exactly `0` or `1`; it controls the closed trusted-client address grammar used by layered throttling.
- `SECURITY_OPERATOR_DATABASE_URL`: a host-supplied input only for the packaged child command inside the app image, never a Compose app/server/worker variable. It must identify `cubby_security_operator` and include a password.
- `CUBBY_FRESH_AUTH_ATTESTATION_KEYRING` and `CUBBY_FRESH_AUTH_ATTESTATION_ACTIVE_KEY_VERSION`: required versioned password-transition attestation keys. Configure one active 32-byte base64url key and at most one prior key during the ten-minute rotation overlap; never reuse a version with different bytes or include these keys in household backups.
- `CUBBY_EMAIL_DELIVERY_KEYRING` and `CUBBY_EMAIL_DELIVERY_ACTIVE_KEY_VERSION`: independent versioned AES-256-GCM outbox keys. Keep every version referenced by nonterminal ciphertext configured until its reference count is zero.
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, and `EMAIL_FROM`: required authenticated email transport. Use `SMTP_SECURE=true` for implicit TLS or the default mandatory STARTTLS path; `SMTP_CA_CERT` may provide a private CA without disabling certificate verification.
- `BETTER_AUTH_SECRET`: long random secret. Do not use the example value in production.
- `BETTER_AUTH_URL`: canonical browser URL, including host port.
- `TRUSTED_ORIGINS`: comma-separated origins accepted by Better Auth.
- `ENABLE_REGISTRATION`: retained configuration only. Runtime sign-up is fail-closed until the complete Cubby-owned initial-credential registration protocol is implemented; it does not re-enable Better Auth direct password insertion.
- `APP_TIMEZONE`: app-level timezone for display, grouping, reports, imports, and redirects.
- `APP_PORT`: host port mapped by Docker Compose.

Optional variables can be added to `.env` even when they are not listed in
`.env.example`.

### Global Security Phase 8 (unreleased until Phase 9)

Layered sign-in throttling is database-clock based and records private evidence
atomically with its incident transition. A successful credential sign-in records
its event in the same database transaction as Better Auth's canonical Session
insert. Private history and export snapshots use the global transition lock with
event sequence allocation. Do not treat this candidate as a partial release.

The operator URL is supplied only for a one-off child process started by the
host; Compose does not publish PostgreSQL or provide that URL to `app`:

```bash
docker compose exec -T -e SECURITY_OPERATOR_DATABASE_URL=... app node /app/security-operator.mjs aggregate --from YYYY-MM-DD --to YYYY-MM-DD
```

The throttle key is a 32-byte deployment secret whose digest is verified at
startup. It is excluded from backups and logs; rotation is deferred to an
approved maintenance gate.

For local Docker on a non-default port, keep these aligned:

```dotenv
APP_PORT=3002
BETTER_AUTH_URL=http://localhost:3002
TRUSTED_ORIGINS=http://localhost:3002,http://127.0.0.1:3002
```

If these do not match the browser URL, Better Auth can reject sign-up or sign-in
with an invalid origin error.

### Invitation Protocol v2 (unreleased candidate)

Invitation, initial credential, and recovery-readiness operations run in the
`invitation_protocol` schema through execute-only login roles. Compose needs three
additional isolated connections and their distinct generated passwords:

```dotenv
CUBBY_INVITATION_RUNTIME_DB_PASSWORD=replace-with-a-generated-invitation-runtime-db-password
CUBBY_INVITATION_EXPIRY_DB_PASSWORD=replace-with-a-generated-invitation-expiry-db-password
CUBBY_INVITATION_MAINTENANCE_DB_PASSWORD=replace-with-a-generated-invitation-maintenance-db-password
```

Startup derives `INVITATION_DATABASE_URL`, `INVITATION_EXPIRY_DATABASE_URL`, and
`INVITATION_MAINTENANCE_DATABASE_URL` for those roles. Use distinct values from
every other role password and never commit real values.
`scripts/provision-invitation-runtime-roles.mjs` provisions or rotates the three
login roles; it refuses to proceed if a restricted role owns database objects.

Each role is execute-only. Direct table access in `invitation_protocol`, and
direct reads of the attestation key and recovery relations, are denied by design.
If you add a procedure, grant it explicitly to the role that needs it and keep the
private audit helper ungranted; the schema test and the disposable harness both
assert the exact granted set, so a new procedure must be added to both.

Recovery enrollment bridges to Global Security rather than re-implementing it.
When working on that path, keep two invariants in mind:

- Acquire the `global-security-transition:v1` advisory lock before any invitation
  advisory lock or row lock in any procedure that touches canonical security
  relations. Canonical operations take it first, so anything else inverts the
  order.
- Canonical guard triggers on those relations are security invoker and run as the
  invitation protocol owner. Several are deferred constraint triggers that fire at
  commit, so a missing execute grant on a canonical assertion helper appears as a
  late `42501` rather than at the statement that caused it.

The disposable acceptance harness has diagnostics that exist only inside its
runtime. When both `CUBBY_P13_ACCEPTANCE_ROUTE_SENTINEL=1` and
`CUBBY_P13_ACCEPTANCE_SIGN_IN_CARRIER_STAGE_FILE` equal their exact acceptance values,
the auth route writes one fixed sign-in stage to the status mount and Better Auth
receives a logger that reduces its fixed email sign-in warnings to closed
categories, kept per sign-in request. Without both values the auth configuration is
unchanged. The harness
reads only allow-listed fixed outputs, so a new probe must add its code to the
observation list or its result is always empty.

`scripts/p1-3-invitation.runtime-probe.ts` also exercises the conditional
cross-lineage re-invitation takeover directly through `createInvitationServices`
against the disposable database, with no browser involved: an existing account
binds to a first invitation, that invitation is revoked, a second invitation for
the same recipient takes over the account's `InvitationAccountSetup` origin, and a
third invitation is denied while the second remains active. Postcondition codes
for this scenario live in `p1-3-invitation.runtime-probe-contract.ts` alongside
the manual create/replace/revoke ones and follow the same fixed-code discipline.

Two harness details look optional but are not. The disposable PostgreSQL
healthcheck probes `127.0.0.1:5432`, because the image's first-start temporary
server answers a socket-only `pg_isready` while TCP is still closed. Identities
seeded directly into the database must store the lowercased email, because Better
Auth looks users up by the lowercased submitted email with case-sensitive equality;
`scripts/p1-3-invitation-browser-fixture-identity.ts` does this for seeded fixtures.

Treat this whole program as not deployed. Deployment, cutover, and live invitation
use are separately gated; do not treat merged source as a release.

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

### Rebuild speed

The image build requires BuildKit, which Docker Compose v2 and `docker build` use
by default. Two BuildKit cache mounts hold only recomputable caches - the npm
download cache and Next's incremental compiler cache - so a cold builder produces
the same image, just more slowly. Runtime dependencies install from the lockfile
in their own stage rather than by copying the builder's `node_modules` and pruning
it, so that layer stays cached until `package.json`, `package-lock.json` or the
Prisma schema changes. Runtime files are installed and copied as the unprivileged
`node` user, because a recursive `chown` of `/app` in a late stage rewrote every
`node_modules` and `.next` file into a fresh layer and measured about five minutes
of every rebuild. Source-only rebuilds therefore redo the application build and
little else. `src/server/services/image-build-cache-contract.test.ts` pins
this arrangement, including the Prisma CLI staying a runtime dependency because
the entrypoint runs `migrate deploy`.

The app container provisions or rotates the non-owner `cubby_runtime`, `cubby_auth`, `cubby_email_delivery`, and `cubby_security_operator` roles through the migration-owner connection, runs `prisma migrate deploy` with `MIGRATION_DATABASE_URL`, reconciles the fresh-auth and email-delivery keyrings into runtime-inaccessible owner tables, then removes migration-role and component-password variables before starting the Next server. Ordinary services use `DATABASE_URL`, Better Auth alone uses `AUTH_DATABASE_URL`, and only the encrypted SMTP worker uses `EMAIL_DELIVERY_DATABASE_URL`. The security operator role is not an app runtime role: it has no memberships, object ownership, or table privileges and can execute only its aggregate function. This applies on fresh and existing volumes and fails closed for absent, malformed, version-mismatched, or referenced-but-missing key material. Do not manually grant `cubby_runtime` direct Session DML, delivery receipt authority, or credential/key-table privileges.

For a pre-P1-3 existing volume that is still owned by legacy bootstrap role
`cubby`, follow [Existing-volume migration-owner bootstrap](ALWAYS_ON_UPDATES.md#existing-volume-migration-owner-bootstrap)
before app startup. Do not improvise `REASSIGN OWNED`; the fixed-baseline rehearsal
must pass before any live ownership transition.

### Host-local security aggregate

The primary Compose package does not publish PostgreSQL. A host operator queries the content-free global incident aggregate by starting a one-off child in the running app image. Do not put the operator URL in Compose, an app environment file, or a worker configuration.

```bash
docker compose exec -T -e SECURITY_OPERATOR_DATABASE_URL=... app node /app/security-operator.mjs aggregate --from 2026-08-01 --to 2026-08-08
```

Set `SECURITY_OPERATOR_DATABASE_URL` only on this `docker compose exec` child. The URL must use `cubby_security_operator` with a nonempty password and the container-reachable PostgreSQL service address. Dates are exact UTC calendar dates; `from` is inclusive, `to` is exclusive, and the command and database both reject ranges over 31 days. Successful stdout is schema-versioned JSON containing only `layer`, `state`, `coarseTimeBucket`, and `incidentCount`; failures use a fixed sanitized stderr message.
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

Runtime password signup is currently fail-closed pending Cubby's complete
initial-credential protocol. The commands below apply only to an already existing
credential-backed account created through an approved future protocol or retained
deployment state. Cubby has no outbound verification-email transport; before
initial binding only, an operator can explicitly attest the sole account. This
requires no existing platform owner, exactly one user, a usable password credential,
and the exact acknowledgement token:

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

Database role/privilege changes (grants, revokes, row-lock or SECURITY DEFINER
functions) and session-freshness changes additionally require the separately
gated disposable end-to-end save-path rehearsal:

```bash
npm run verify:browser-operation-save-path
```

It boots the real app image against a disposable Postgres with the exact
production role/grant topology (the app's own entrypoint provisioning scripts
create it), signs in over real HTTP, and saves an activity twice - once
immediately and once on a session artificially aged past
`SESSION_FRESH_AGE_SECONDS` - while asserting `cubby_runtime` still has no
`UPDATE` grant on `"Session"`. This is the exact reproduction shape that found
the two 2026-08-24 to 2026-09-16 live incidents (`requireFreshSession()` on
every mutation; the row-lock helper needing a privilege `cubby_runtime` no
longer had), which no unit test caught because the service layer is normally
exercised directly, bypassing the real restricted database role a running app
connects as.

The aged session then exercises one mutation per context helper that takes the
session row lock, because a privilege or freshness regression in any of them is
invisible to the activity path alone:

| Family | Context helper | Endpoint(s) | Asserted result |
| --- | --- | --- | --- |
| Timer stop | `getBrowserOperationContextForBaby` | `POST /api/timers/{id}/stop` | `timerState` is `stopped` with an `endedAt` |
| Unit preferences | `getBrowserOperationContextForHousehold` | `POST /api/settings/units/issue` then `PATCH /api/settings/units` | `HouseholdSettings.unitPreferences` actually changed |
| Account appearance | `lockCurrentAccountActor` | `POST /api/account/appearance/issue` then `PATCH /api/account/appearance` | `User.appearanceMode` actually changed |

Unit preferences and account appearance issue their opening in a separate call,
so the two-step form is covered as well as the activity route's single call.
Account appearance is the only family that locks `"User"` alongside `"Session"`.

The operation-registry checker's own test harness
(`src/server/operation-registry/operation-registry.test.mjs`) is a large,
sequential, non-vitest script (a plain `node` entrypoint with its own minimal
`test()` collector, not wired into the vitest `include` glob): most of its
~165 cases run in milliseconds, but 49 of them each build the full
real-repository TypeScript program from scratch (no shared cache across
cases) and take roughly two minutes apiece, so a full run takes well over an
hour. Routine work should use the fast subset, which skips those (tagged
`[slow]` in their names) and finishes in roughly 20 minutes instead - still
dominated by the ~100 remaining cases that each build a small synthetic
`ts.Program` from scratch (no shared TypeScript lib cache), just without the
49 full-repository builds:

```bash
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON src/server/operation-registry/operation-registry.test.mjs --fast
```

The fast subset currently reproduces 1 pre-existing failure, unchanged by
tagging or by skipping the slow cases: `resolves single static client
property assignments and rejects ambiguous property flow`. Root cause is
identified: `resolveStaticMemberValue`'s whole-file assignment scan
(`checker.ts`) collects children with `ts.forEachChild(node, (n) =>
pendingNodes.push(n))`, and `Array.prototype.push` returns the array's new
length - a truthy number - which makes `forEachChild` stop after the very
first child instead of visiting every sibling. In production this silently
limits static property-flow resolution (e.g. `obj.prop = fetch; ...;
obj.prop(...)`) to whatever the first top-level statement of a file happens
to touch; it fails closed (emits `unsupported_client_binding`) rather than
mis-resolving, so it is a completeness gap, not a false-negative safety
issue. Wrapping the callbacks in a block (so they return `undefined`) fixes
this test in isolation, but unlocking the intended whole-file traversal at
real-repository scale currently causes `RangeError: Maximum call stack size
exceeded` in ~30 other fast-subset cases: `nodeContainsSymbol`'s recursive
`ts.forEachChild(node, visit)` walk overflows first, and converting that one
function to an iterative work-list (the same pattern already used elsewhere
in this file) only moves the overflow into `resolveStaticRootFlow`'s own
mutual recursion over multi-candidate (`unsupported`-kind) static values.
That resolver family (`resolveStaticRootFlow` /
`resolveStaticMemberValue` / `resolveStaticVariableValue` /
`resolveGlobalFetchBinding`) has no depth bound or trampolining, only cycle
guards (`seen/seenMembers`), so fixing this for real needs a deliberate
depth-limited or iterative redesign across that family, not a local patch -
out of scope for a routine fix and deferred pending that design decision.

Run the full command (drop `--fast`) before a registry-affecting release,
since the slow cases are the ones that actually type-check discovery against
the live source tree. This is intentionally not a package.json script: the
checker's own `unsupported_package_command_owner`/appendix rules mean adding
one would require either giving this harness a real operation declaration or
threading it through the same hardcoded self-reference the checker uses for
`scripts/operation-registry.ts` itself, and this file changes often enough
that isn't worth the upkeep for an already-optional command.

Household browser-operation schema, status, retention, compaction, and tombstone changes require focused source contracts plus the separately authorized disposable PostgreSQL acceptance. Ordinary Cubby JSON household backups deliberately exclude browser-operation bindings, full receipts, tombstones, and integrity state; full-system recovery must restore that database infrastructure before readiness enables writes.

Global account appearance uses a separate non-household operation binding/full/tombstone ledger. Tests must prove no household lookup or member authority enters Personal appearance, while Session/User revision reauthorization, same-ID status, compaction, and 410 behavior remain equivalent to the household operation contract.

Family accent and Units forms require a browser operation identity before submit. Tests must cover retained-ID reconciliation, stale HouseholdSettings snapshots, expired/unknown status, and full-document Units replacement. Do not reintroduce the pre-P1-2 direct `PATCH` mutation path.

Notification-preference migration and service tests must preserve zero-legacy-row = no document/external delivery off, exactly-one deterministic translation only, and content-minimized inactive needs-review evidence for ambiguous legacy groups. Do not run this migration against a normal database; the required PostgreSQL migration/deduplication/delivery acceptance remains a separately authorized disposable gate.

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

Active Sessions is a global-user, household-independent Cubby surface. It lists
only opaque handles, current-device status, coarse device labels, and lifetime
timestamps through the guarded Cubby API; raw Better Auth list/revoke/sign-out
endpoints remain denied. Revocation requires explicit confirmation and a current
password proof, and current/all lost responses reconcile through authoritative
status after normal sign-in rather than Better Auth `freshAge`.

Better Auth's independent in-memory limiter is disabled. Cubby's database-clock
account/client/deployment throttle records failed credential evidence durably,
enters a fixed 15-minute quiet period on the fifth failure in one 15-minute
window, never extends that quiet deadline, and does not clear evidence on success.
Existing and nonexistent accounts retain neutral public behavior.

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

PostgreSQL itself must run in UTC. Prisma writes JavaScript `Date` values as
UTC into `timestamp without time zone` columns, while database guards compare
them with `clock_timestamp()` in the session time zone, so a non-UTC database
makes app-written instants look hours in the future and fails security guards
(this once blocked every new sign-in). The container entrypoint's
`database_timezone` phase runs `ALTER DATABASE ... SET timezone TO 'UTC'` on
every start and refuses to boot if any role-level override or the runtime
connection is not UTC. Keep `TZ: UTC` on the postgres service; `APP_TIMEZONE`
is an app-only display setting. The disposable backup rehearsal deliberately
initializes PostgreSQL with `TZ: America/New_York` to catch regressions.

### Line Endings

Prisma migration `.sql` files (and `scripts/bootstrap-existing-migrator-role.sql`)
are committed LF-only, matching what Linux/Docker checkouts (CI, production)
read. `.gitattributes` pins `*.sql text eol=lf` so a Windows checkout with
`core.autocrlf=true` does not silently rewrite them to CRLF. Before that rule
existed, a Windows-only CRLF checkout made two migration-content tests fail
locally that always passed in the real (LF) checkout used everywhere else
(`browser-operation-household-foundation-migration.test.ts`,
`global-security-persistence-migration.test.ts`), while masking a third,
already-latent bug in `invitation-recovery-notice-and-cross-lineage-takeover.test.ts`
that only happened to pass because of the same accidental CRLF. If a git
checkout still shows CRLF in a `.sql` file, delete the file and run
`git checkout -- <path>` (a plain `git checkout --` on an unmodified path can
no-op without re-applying the attribute).

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

### Registration Is Unavailable

Open runtime account creation is intentionally fail-closed. Platform registration
settings do not enable a signup form or password writer. The only credential-creating
path is the unreleased Invitation Protocol v2 candidate described above, which
creates a first credential solely for the recipient of a live invitation.

### Invitation Page Says It Cannot Continue

The invitation corridor fails neutral rather than revealing whether an invitation
exists, so a generic message covers several distinct causes. Check, in order:
the invitation is still pending and unexpired; the recipient email matches the
invitation case-insensitively; the browser kept the HttpOnly
`cubby_invitation_claim` cookie for the claim; and the three invitation role
connections are configured. A raw token is only ever accepted from the URL
fragment on first load, so a link whose fragment was already consumed, stripped
by a client, or reloaded after cleanup cannot be re-claimed and needs a
replacement link.
