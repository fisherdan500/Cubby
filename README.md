# Cubby

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)

Cubby is a self-hostable baby-care tracker for families. It is a clean-room,
original implementation focused on household-controlled logging, reporting,
calendar planning, backups, and integrations.

## What Cubby Does

- Email/password auth with explicit platform-owner setup, invite-only member onboarding, and closed-default platform registration policy.
- Protected household ownership, delegated admins, role-based member access, invites, personal session management, audit records, and server-side permission checks.
- Baby profiles and activity logging for feeding, diaper, sleep, pumping, medicine, measurement, milestone, note, bath, play, mood, supplement, vaccine, and milk inventory.
- Persistent timers for feeding, sleep, pumping, and play.
- Mobile-first system/light/dark app shell with a durable personal account preference, plus Log Entry, Full Log, Calendar, Reports, Nursery, and Settings areas.
- Original illustrated activity artwork and a household-selectable sage, rose, powder, butter, or terracotta accent.
- Dashboard quick actions, elapsed badges, daily summary, warning dismissal, active timers, and selected-day timeline.
- Calendar month view with events, Reports tabs including stats, milestones, growth trends, activity, heatmaps, and routine rhythm.
- CSV/TSV activity exports, checksummed JSON recovery into a fresh household, opt-in automated local versioned backups with explicit host-local recovery authorization, and Sprout Track backup import into the current household.
- API-key hook endpoints, webhook configuration, and browser notification preferences.

## Current Product Direction

Cubby's current target is a dependable private application for one household. It
runs through Docker on the home network; remote access is supplied by the
household's existing infrastructure. The next milestone is replacing the current
baby tracker for daily use and operating reliably as an always-on home service.

The browser remains network-required for logging. Cubby includes install metadata
and a lightweight service-worker shell, but offline writes and synchronization
are not supported and are low priority. Dedicated third-party integrations are
also deferred until a concrete household use case exists.

## Stack

- Next.js App Router and React
- Prisma and PostgreSQL
- Better Auth with the Prisma adapter
- Tailwind CSS, Lucide icons, Recharts
- Vitest for service/unit tests
- Docker Compose for the preferred deployment path

## Docker Quick Start

1. Copy `.env.example` to `.env`.
2. Set a long random `BETTER_AUTH_SECRET`.
3. Review `BETTER_AUTH_URL`, `TRUSTED_ORIGINS`, and `APP_PORT`. Add `APP_TIMEZONE` if you need a timezone other than the compose default.
4. Start the stack:

```bash
docker compose up --build
```

5. Open `http://localhost:3000`, or the port configured with `APP_PORT`.

### First-time setup: claim platform ownership

While Cubby has no platform owner, every start prints a one-time setup code to the
app container's log:

```bash
docker compose logs app
```

Look for `Cubby has no platform owner yet` and open `/setup`. On a new install with
no accounts, enter the code with your name, email and password: that creates the
first account and makes it the verified platform owner in one step, then you sign in
normally. On an install that already has accounts, sign in first and enter the code
at `/setup` to make that account the owner. Either way the owner starts with
household creation closed and public registration off, exactly as `bind` below
leaves it; open household creation from `/platform/settings`. The code works once and
expires after 24 hours; restarting Cubby issues a new one. Only its SHA-256 digest is
stored, and no application database role can read it.

The first account is never created or promoted without the code: whoever reaches a
new install first could otherwise take the platform. The code proves access to the
host's logs instead. General sign-up stays closed; everyone after the owner joins by
invitation.

### Bind the platform owner

Open password signup is fail-closed; the only credential-creating path is invitation
protocol v2, for the recipient of a live invitation. After the migration is deployed
and an intended owner account already exists through retained state or an approved
future protocol, bind that exact account by stable user ID and confirming email.
Cubby never guesses or selects an owner automatically, and binding requires a
verified email/password account.

Cubby does not have outbound email verification yet. Only while there is exactly
one retained credential-backed account and no platform owner, a host operator may
explicitly attest that account first. This is a separate, audited
operation with a high-friction acknowledgement; it never runs as a side effect of
binding.

```bash
npm run platform:owner -- verify-bootstrap --user-id <stable-user-id> --confirm-email <exact-email> --acknowledgement I_ACCEPT_LOCAL_BOOTSTRAP_EMAIL_VERIFICATION
```

Then bind the now-verified account:

```bash
npm run platform:owner -- bind --user-id <stable-user-id> --confirm-email <exact-email>
```

If a later credential-backed successor is still unverified because no outbound
verification transport is configured, a host operator may explicitly attest that
specific account before recovery. This records a host-local audit event and marks
the selected account verified; it does not send email, prove email delivery, or
transfer platform authority. The confirmation email must match the persisted value
byte-for-byte, including case.

```bash
npm run platform:owner -- attest-successor --current-owner-user-id <current-id> --successor-user-id <successor-id> --confirm-successor-email <exact-successor-email> --acknowledgement I_ACCEPT_LOCAL_SUCCESSOR_EMAIL_VERIFICATION
```

After attestation succeeds, run the separate `recover` operation documented in
[Development](docs/DEVELOPMENT.md#platform-owner-binding-and-recovery). Skip
attestation when the successor is already verified.

Unassociated automated-backup files are never ordinary household discoveries,
including on a fresh sole-household target. Recovering one from a preserved host
directory uses host-local `provision-backup-recovery-target`,
`inspect-backup-recovery`, and `authorize-backup-recovery` commands with an empty
credential-backed target and exact source, checksum, platform-owner,
target-household, target-owner, and email confirmations. See
[Automated Local Backups](docs/recovery/automated-local-backups.md#recovery-workflow).

For the standard Docker image, the same bundled operations are available in the
running app container:

```bash
docker compose exec -T app node /app/platform-owner.mjs bind --user-id <stable-user-id> --confirm-email <exact-email>
```

Binding creates platform settings in `closed` mode. The bound owner can then visit
`/platform/settings` to choose `closed`, `invitation-only`, or `open` household
creation and separately control public account registration. See
[Development](docs/DEVELOPMENT.md#platform-owner-binding-and-recovery) for
bootstrap verification, recovery, retry, audit, rollback, and backup boundaries.

The compose stack includes the app and PostgreSQL. Postgres data is stored in the
`cubby_postgres_data` named volume. Container startup applies migrations before
starting Next.js and fails closed if migration deployment fails. Compose reports
the app healthy only when `/api/health` can query PostgreSQL successfully.

If port 3000 is already in use, set values like these in `.env`:

```dotenv
APP_PORT=3002
BETTER_AUTH_URL=http://localhost:3002
TRUSTED_ORIGINS=http://localhost:3002,http://127.0.0.1:3002
```

### Browser Origin Profiles

Docker publishes `APP_PORT` to the host network, so other devices can normally
reach Cubby once the host firewall allows that port. Better Auth separately
requires every browser origin to be trusted. An origin is the exact combination
of scheme, hostname or IP, and port.

For direct LAN access with a fixed address:

```dotenv
APP_PORT=3002
BETTER_AUTH_URL=http://192.168.1.50:3002
TRUSTED_ORIGINS=http://localhost:3002,http://127.0.0.1:3002,http://192.168.1.50:3002
```

Use the server's actual LAN address and reserve it in DHCP so it does not
change. For long-term live use, prefer one stable local DNS name behind an HTTPS
reverse proxy:

```dotenv
BETTER_AUTH_URL=https://cubby.home.arpa
TRUSTED_ORIGINS=https://cubby.home.arpa
```

HTTPS is recommended for secure cookies, PWA/service-worker behavior, and
browser notifications. See [Development](docs/DEVELOPMENT.md#network-and-origin-configuration)
for setup and troubleshooting details.

## Key Environment Variables

- `DATABASE_URL`: non-owner `cubby_runtime` PostgreSQL connection used by the running server.
- `AUTH_DATABASE_URL`: isolated `cubby_auth` connection used only by Better Auth for identity/session reads and Session persistence. Ordinary application SQL cannot directly create, update, or delete sessions.
- `EMAIL_DELIVERY_DATABASE_URL`: isolated `cubby_email_delivery` connection retained only by the encrypted SMTP worker; it can claim and finalize delivery receipts but cannot read delivery tables directly.
- `INVITATION_DATABASE_URL`, `INVITATION_EXPIRY_DATABASE_URL`, and `INVITATION_MAINTENANCE_DATABASE_URL`: isolated `cubby_invitation_runtime`, `cubby_invitation_expiry_worker`, and `cubby_invitation_maintenance_worker` connections for the invitation protocol candidate. Each is execute-only: it can call the reviewed fixed-search-path procedures for its purpose but cannot read or write `invitation_protocol` tables directly, and cannot read the attestation key or recovery relations.
- `CUBBY_INVITATION_RUNTIME_DB_PASSWORD`, `CUBBY_INVITATION_EXPIRY_DB_PASSWORD`, and `CUBBY_INVITATION_MAINTENANCE_DB_PASSWORD`: distinct generated passwords for those three roles. Never commit real values.
- `MIGRATION_DATABASE_URL`: separate `cubby_migrator` owner connection used only while applying migrations; startup removes it before the server begins.
- `CUBBY_RUNTIME_DB_PASSWORD`, `CUBBY_AUTH_DB_PASSWORD`, `CUBBY_EMAIL_DELIVERY_DB_PASSWORD`, `CUBBY_MIGRATOR_DB_PASSWORD`, and `CUBBY_SECURITY_OPERATOR_DB_PASSWORD`: distinct generated database-role passwords for Compose; the operator password is used only to provision or rotate the isolated login role and is removed before Next.js starts. Never commit real values.
- `CUBBY_THROTTLE_KEY`: stable 32-byte base64url deployment secret for private throttle identities, history handles, and cursors. Startup verifies its digest; the key is excluded from logs and backups and has no ordinary rotation path.
- `CUBBY_TRUSTED_PROXY_HOPS`: closed `0`/`1` trusted-proxy policy used to derive privacy-preserving client throttle identity.
- `SECURITY_OPERATOR_DATABASE_URL`: host-local input only for the packaged security aggregate command. It is never a Compose app variable or server/worker runtime setting. The database has no host port; invoke the packaged child in the running app container: `docker compose exec -T -e SECURITY_OPERATOR_DATABASE_URL=... app node /app/security-operator.mjs aggregate --from YYYY-MM-DD --to YYYY-MM-DD`. The range is UTC, inclusive/exclusive, and at most 31 days.
- `CUBBY_FRESH_AUTH_ATTESTATION_KEYRING` and `CUBBY_FRESH_AUTH_ATTESTATION_ACTIVE_KEY_VERSION`: one active versioned 32-byte base64url key and, during rotation, at most one prior key. The prior key verifies only during its database-enforced ten-minute overlap. Reusing a version with different bytes fails startup. These keys are deployment secrets and are excluded from household backups.
- `CUBBY_EMAIL_DELIVERY_KEYRING` and `CUBBY_EMAIL_DELIVERY_ACTIVE_KEY_VERSION`: separate versioned 32-byte base64url AES-256-GCM delivery keys. Every nonterminal ciphertext key must remain configured and digest-matched; keys and encrypted outbox rows are excluded from household backups.
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, and `EMAIL_FROM`: authenticated security-email transport. `SMTP_SECURE=true` selects implicit TLS; otherwise STARTTLS is mandatory. `SMTP_CA_CERT` optionally supplies a private CA while certificate verification remains enabled.
- `BETTER_AUTH_SECRET`: long secret for Better Auth. Change this before deployment.
- `BETTER_AUTH_URL`: one canonical app origin, including scheme and external port when applicable.
- `TRUSTED_ORIGINS`: comma-separated exact browser origins allowed by Better Auth.
- `ENABLE_REGISTRATION`: retained configuration only; runtime sign-up is fail-closed until the complete Cubby-owned initial-credential registration protocol is available.
- `APP_TIMEZONE`: app-level display/grouping timezone, for example `America/New_York`.
- `APP_PORT`: host port mapped to container port 3000 by Docker Compose.
- `AUTOMATED_BACKUPS_ENABLED`: opt-in local-only automated JSON backups, disabled by default.
- `AUTOMATED_BACKUP_DIRECTORY`: private in-container directory; defaults to `/var/lib/cubby/backups`.
- `AUTOMATED_BACKUP_INTERVAL_HOURS`: successful-backup cadence; defaults to `24`.
- `AUTOMATED_BACKUP_RETENTION_COUNT`: healthy associated versions retained per household; defaults to `30`.
- `AUTOMATED_BACKUP_POLL_MINUTES`: due-scan cadence; defaults to `15`.
- `AUTOMATED_BACKUP_RETRY_MINUTES`: retry delay after the newest attempt fails; defaults to `60`.
- `CUBBY_BACKUP_HOST_DIR`: host path bind-mounted into `/var/lib/cubby/backups` for automated local versions.

## Documentation

## Global Security Phase 8 Candidate

Phase 8 adds database-clock layered sign-in throttling and account-private,
cursor-paginated security history. Credential success evidence is created only by
the canonical Better Auth session insert; failure evidence shares the incident
transaction. History/export snapshots serialize with event allocation, so later
events cannot enter an established snapshot. The aggregate operator remains a
host-initiated, child-only command and never receives a Compose runtime URL.
Throttle keys are versionless 32-byte deployment secrets: provision/verify the
digest during startup, do not log or back up the key, and do not rotate it until
a separately approved maintenance gate exists. This complete security program is
unreleased until Phase 9.

- [Architecture](docs/ARCHITECTURE.md): system shape, data model, services, permissions, imports, integrations, and time handling.
- [Development](docs/DEVELOPMENT.md): setup, workflows, verification commands, and troubleshooting.
- [Always-On Updates](docs/ALWAYS_ON_UPDATES.md): fail-closed update preflight,
  migration/startup observation, post-update checks, and recovery boundaries.
- [Backup Recovery](docs/BACKUP_RECOVERY.md): automated local backup operations plus manual version 2 recovery and rehearsal details.
- [Roadmap](docs/ROADMAP.md): future features, known follow-ups, and parked ideas.
- [Third-Party Assets](docs/THIRD_PARTY_ASSETS.md): local font packages and asset provenance.
- [Agent Guide](AGENTS.md): project-specific instructions for Codex and other coding agents.

## Invitation Protocol v2 Candidate

Membership invitation, initial credential creation, and recovery readiness run in
the dedicated `invitation_protocol` schema as fixed-search-path definer
procedures, reached only through execute-only login roles with no direct table
rights. A raw invitation token is accepted once from the URL fragment, the browser
address is cleaned before the single token-bearing request, and only the token
hash is persisted. The claim reference is an HttpOnly strict-same-site cookie and
never a token.

Recovery enrollment bridges to the existing Global Security lifecycle instead of
duplicating it: the canonical operation identity is created server-side and
authorized against the server-held mapping before any fresh-authentication grant
exists, fresh authentication is explicit password re-entry, and ten recovery codes
are issued display-once behind an issuance MAC that binds the credential, session,
and set versions to the verifier batch digest. Replay returns authenticated status
without redisclosure and never mints a second batch. Rehearsal consumes exactly
one code and leaves nine active.

Every bridged procedure takes the canonical `global-security-transition:v1` lock
before its own locks so the order matches canonical operations. This program is not
deployed: deployment, cutover, and live invitation use are separately gated, and it
is not released behavior until then.

## License And Contributions

Cubby is free and open-source software licensed under the
[GNU Affero General Public License v3.0 only](LICENSE) (`AGPL-3.0-only`). You may
use Cubby privately or commercially, modify it, and redistribute it under the
license terms. Modified versions made available to users over a network must
offer those users the corresponding source code under the same license.

The Cubby name and Cradle Cubby logo are governed separately by the
[Cubby Trademark Policy](TRADEMARKS.md). The software license does not grant
permission to present a modified distribution as an official Cubby release.

Unless explicitly stated otherwise, contributions submitted to this repository
are accepted under `AGPL-3.0-only`. Cubby does not require a contributor license
agreement in this release.

## Verification

Use the full verification set for behavior changes:

```bash
npm run lint
npm run typecheck
npm run test
npm run build
docker compose up --build -d
```

Docs-only changes usually only need markdown review plus `git status --short`.

## Clean-Room Sprout Track Boundary

Sprout Track is supported only as a clean-room, one-time migration source for
household-owned data. Cubby does not pursue ongoing Sprout workflow parity or
compatibility after migration needs are met. Do not copy Sprout code, schemas,
assets, exact UI text, credentials, route names, or implementation structure.
