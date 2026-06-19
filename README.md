# Cubby

Cubby is a self-hostable baby-care tracker for families. It is a clean-room, original implementation inspired only by common baby-tracking product behavior.

## Current Feature Surface

- Email/password auth with first-owner setup, invite-only member onboarding, and owner-controlled registration policy.
- Household, baby, member, invite, trusted-device, session, and audit records.
- Activity logging for feeding, diaper, sleep, pumping, medicine, measurement, milestone, note, bath, play, mood, supplement, vaccine, and milk inventory.
- Persistent timers for feeding, sleep, pumping, and play with pause, resume, and stop controls.
- Dark dashboard shell with desktop sidebar, mobile bottom navigation, icon quick actions, daily summary, active timers, and timeline.
- Full log, calendar month view, report tabs, growth trend charts, heatmaps, CSV export, spreadsheet TSV export, JSON backup export, JSON restore, and Sprout Track backup import.
- Admin settings for registration policy, API keys, webhooks, backups, notifications, and sessions.
- API-key hook endpoints under `/api/hooks/v1` for babies, status, activities, latest measurements, and reference metadata.

## Docker Quick Start

1. Copy `.env.example` to `.env`.
2. Set a long random `BETTER_AUTH_SECRET`.
3. Run:

```bash
docker compose up --build
```

4. Open http://localhost:3000.

The compose stack includes the app and PostgreSQL. Postgres data is stored in the `cubby_postgres_data` named volume.

If port 3000 is already in use, set `APP_PORT=3002`, `BETTER_AUTH_URL=http://localhost:3002`, and `TRUSTED_ORIGINS=http://localhost:3002,http://127.0.0.1:3002` in `.env`, then open that port instead.

## Registration Policy

`ENABLE_REGISTRATION=true` allows the first owner account to be created. After an owner/household exists, public account creation is controlled by household owner settings at `/app/settings/admin`.

`ALLOW_PUBLIC_REGISTRATION=false` is the recommended default. With public registration disabled, the login screen hides the create-account link and `/register` only works for a valid invite link or the first owner setup. Invited users are added to the inviter household and cannot create a new household unless an owner enables new household creation.

Members are invited from `/app/settings/members`. Invite links route through `/invite/[token]` and then create or sign in the user under that household.

## Admin And Integrations

- API keys are created at `/app/settings/integrations`; only the generated secret is shown once.
- Hook clients authenticate with `Authorization: Bearer <key>`.
- Webhook endpoints are persisted and activity/timer events are queued in `WebhookDelivery` for delivery workers.
- Browser notification subscriptions and preferences are stored, and activity-created notification records are queued when enabled.
- JSON backups are exported/restored at `/app/settings/backups`; CSV and TSV activity exports are available there too.
- Sprout Track restore is available at `/app/settings/backups` for Sprout `.zip`, standalone `baby-tracker.db`, or `data.json` backups. Cubby previews the upload first, imports user-owned tracking data into the current household, preserves Sprout caretakers as historical attribution, and skips Sprout auth/API/push/email secrets.

## Local Development

```bash
npm install
npm run db:generate
npm run dev
```

For local development outside Docker, set `DATABASE_URL` to a reachable PostgreSQL database.

## Verification

```bash
npm run lint
npm run typecheck
npm run test
npm run build
docker compose up --build -d
```

## Clean-Room Note

Do not copy code, schemas, UI, file structure, assets, text, route names, credentials, or implementation details from Sprout Track. Cubby uses only product-level behavior requirements.
