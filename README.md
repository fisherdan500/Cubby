# Cubby

Cubby is a self-hostable baby-care tracker for families. It is a clean-room,
original implementation focused on household-controlled logging, reporting,
calendar planning, backups, and integrations.

## What Cubby Does

- Email/password auth with first-owner setup, invite-only member onboarding, and owner-controlled public registration.
- Protected household ownership, delegated admins, role-based member access, invites, trusted devices, sessions, audit records, and server-side permission checks.
- Baby profiles and activity logging for feeding, diaper, sleep, pumping, medicine, measurement, milestone, note, bath, play, mood, supplement, vaccine, and milk inventory.
- Persistent timers for feeding, sleep, pumping, and play.
- Mobile-first light/dark app shell with Log Entry, Full Log, Calendar, Reports, Nursery, and Settings areas.
- Original illustrated activity artwork and a household-selectable sage, rose, powder, butter, or terracotta accent.
- Dashboard quick actions, elapsed badges, daily summary, warning dismissal, active timers, and selected-day timeline.
- Calendar month view with events, Reports tabs including stats, milestones, growth trends, activity, heatmaps, and routine rhythm.
- CSV/TSV activity exports, JSON backup/restore, and Sprout Track backup import into the current household.
- API-key hook endpoints, webhook configuration, and browser notification preferences.

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

The compose stack includes the app and PostgreSQL. Postgres data is stored in the
`cubby_postgres_data` named volume.

If port 3000 is already in use, set values like these in `.env`:

```dotenv
APP_PORT=3002
BETTER_AUTH_URL=http://localhost:3002
TRUSTED_ORIGINS=http://localhost:3002,http://127.0.0.1:3002
```

## Key Environment Variables

- `DATABASE_URL`: PostgreSQL connection string used by Prisma.
- `BETTER_AUTH_SECRET`: long secret for Better Auth. Change this before deployment.
- `BETTER_AUTH_URL`: canonical app URL, including the external port.
- `TRUSTED_ORIGINS`: comma-separated allowed browser origins for Better Auth.
- `ENABLE_REGISTRATION`: allows first-owner setup when no owner exists.
- `ALLOW_PUBLIC_REGISTRATION`: default public account creation policy after setup.
- `APP_TIMEZONE`: app-level display/grouping timezone, for example `America/New_York`.
- `APP_PORT`: host port mapped to container port 3000 by Docker Compose.

## Documentation

- [Architecture](docs/ARCHITECTURE.md): system shape, data model, services, permissions, imports, integrations, and time handling.
- [Development](docs/DEVELOPMENT.md): setup, workflows, verification commands, and troubleshooting.
- [Roadmap](docs/ROADMAP.md): future features, known follow-ups, and parked ideas.
- [Third-Party Assets](docs/THIRD_PARTY_ASSETS.md): local font packages and asset provenance.
- [Agent Guide](AGENTS.md): project-specific instructions for Codex and other coding agents.

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

Cubby may use Sprout Track only as product-behavior reference material. Do not
copy Sprout Track code, schemas, assets, exact UI text, credentials, route names,
or implementation structure. Cubby imports user-owned Sprout backup data through
its own importer and stores it in Cubby's schema.
