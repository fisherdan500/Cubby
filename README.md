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
- Mobile-first light/dark app shell with Log Entry, Full Log, Calendar, Reports, Nursery, and Settings areas.
- Original illustrated activity artwork and a household-selectable sage, rose, powder, butter, or terracotta accent.
- Dashboard quick actions, elapsed badges, daily summary, warning dismissal, active timers, and selected-day timeline.
- Calendar month view with events, Reports tabs including stats, milestones, growth trends, activity, heatmaps, and routine rhythm.
- CSV/TSV activity exports, checksummed JSON recovery into a fresh household, opt-in automated local versioned backups, and Sprout Track backup import into the current household.
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

### Bind the platform owner

After the migration is deployed and the intended owner account exists, bind that
exact account by stable user ID and confirming email. Cubby never guesses or
selects an owner automatically, and binding requires a verified email/password
account.

Fresh password-signup deployments do not have outbound email verification yet.
Only while there is exactly one account and no platform owner, a host operator may
explicitly attest that bootstrap account first. This is a separate, audited
operation with a high-friction acknowledgement; it never runs as a side effect of
binding.

```bash
npm run platform:owner -- verify-bootstrap --user-id <stable-user-id> --confirm-email <exact-email> --acknowledgement I_ACCEPT_LOCAL_BOOTSTRAP_EMAIL_VERIFICATION
```

Then bind the now-verified account:

```bash
npm run platform:owner -- bind --user-id <stable-user-id> --confirm-email <exact-email>
```

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

- `DATABASE_URL`: PostgreSQL connection string used by Prisma.
- `BETTER_AUTH_SECRET`: long secret for Better Auth. Change this before deployment.
- `BETTER_AUTH_URL`: one canonical app origin, including scheme and external port when applicable.
- `TRUSTED_ORIGINS`: comma-separated exact browser origins allowed by Better Auth.
- `ENABLE_REGISTRATION`: permits only the first account while no users, households,
  platform audit history, or platform owner exist.
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

- [Architecture](docs/ARCHITECTURE.md): system shape, data model, services, permissions, imports, integrations, and time handling.
- [Development](docs/DEVELOPMENT.md): setup, workflows, verification commands, and troubleshooting.
- [Always-On Updates](docs/ALWAYS_ON_UPDATES.md): fail-closed update preflight,
  migration/startup observation, post-update checks, and recovery boundaries.
- [Backup Recovery](docs/BACKUP_RECOVERY.md): automated local backup operations plus manual version 2 recovery and rehearsal details.
- [Roadmap](docs/ROADMAP.md): future features, known follow-ups, and parked ideas.
- [Third-Party Assets](docs/THIRD_PARTY_ASSETS.md): local font packages and asset provenance.
- [Agent Guide](AGENTS.md): project-specific instructions for Codex and other coding agents.

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
