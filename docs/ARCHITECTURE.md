# Cubby Architecture

This document describes the current Cubby application structure for developers
and coding agents. It is intentionally implementation-oriented.

## Runtime Shape

Cubby is a Next.js App Router application deployed as a Docker Compose stack:

- `app`: Next.js standalone server on container port 3000.
- `postgres`: PostgreSQL 16 with the `cubby_postgres_data` named volume.

The production container runs Prisma migrations before starting the standalone
Next server. Docker Compose is the primary deployment path.

## Source Layout

- `src/app/app`: authenticated app pages such as Log Entry, Full Log, Calendar, Reports, Nursery, and Settings.
- `src/app/api`: HTTP route handlers for app actions, auth, exports, backups, hooks, notifications, timers, settings, and dashboard warnings.
- `src/components`: shared UI components and app shell pieces.
- `src/domain`: app-level domain constants such as roles and permissions.
- `src/lib`: shared runtime helpers, auth wiring, environment validation, Prisma client, and time utilities.
- `src/server/auth`: current-user and household context helpers.
- `src/server/services`: business logic used by pages and API routes.
- `prisma`: Prisma schema, migrations, and seed script.

Pages and route handlers should stay thin. Put business rules, permission checks,
data shaping, and import/export behavior in `src/server/services`.

## Auth And Household Model

Cubby uses Better Auth with the Prisma adapter for users, sessions, accounts, and
verification records. The app's household model is separate from Better Auth:

- `Household` owns babies, members, activities, settings, API keys, webhooks, backups, imports, contacts, medicines, and calendar records.
- `HouseholdMember` connects a Better Auth user to a household role.
- Roles are `owner`, `admin`, `parent`, `caretaker`, and `read_only`.
- Permissions are defined in `src/domain/roles.ts`.

The first household creator is the protected owner and has full administrative
access. Owners can appoint delegated admins. Admins manage operational household
settings and lower-access members, but cannot change the owner or grant/revoke
Admin access. Parents can manage babies, notifications, exports, and activity;
caretakers manage their own activity; read-only members cannot write.

Server-side permission enforcement is required for every household-scoped read or
write. UI hiding is not enough.

Registration is invite-first after setup:

- First owner setup is allowed when no owner/household exists and registration is enabled.
- Owners can control public registration and new-household creation policy.
- Owners and admins can invite members, while only the owner can issue an Admin invite.
- Invite links route users into the inviting household rather than letting them create a new household.

Settings pages are filtered by permission and guarded before household data is
loaded. Direct API and service calls remain authoritative; UI visibility is not
treated as an authorization boundary.

## Data Model Overview

The Prisma schema uses PostgreSQL and keeps a household boundary on user-owned
data. Important model groups include:

- Auth: `User`, `Session`, `Account`, `Verification`.
- Household: `Household`, `HouseholdMember`, `Invite`, `HouseholdSettings`.
- Babies and tracking: `Baby`, `ActivityLog`, type-specific log tables, `Reminder`, `DashboardWarningDismissal`.
- Settings and admin: `TrustedDevice`, `AuditEvent`, `BackupRecord`.
- Integrations: `ApiKey`, `WebhookEndpoint`, `WebhookDelivery`.
- Notifications: `PushSubscription`, `NotificationPreference`, `NotificationLog`.
- Imports: `ImportBatch`, `ImportedRecord`.
- Reference and calendar data: `Contact`, `MedicineCatalog`, `CalendarEvent`, event join tables, `VaccineDocument`.

## Activity Pattern

Cubby uses `ActivityLog` as the aggregate record for tracked events. It stores
common fields such as household, baby, actor, type, start/end time, timezone,
notes, source, and external attribution. Type-specific tables extend the
aggregate for feature-specific details:

- Feeding, diaper, sleep, pumping, medicine, measurement, milestone, note, bath, play, mood, supplement, vaccine, and milk inventory records.

Do not replace this with a separate-table-only model. New tracking types should
fit the aggregate pattern unless there is a clear architectural reason not to.

## Timezone And Date Rules

Timestamps are stored as instants in Prisma `DateTime` fields. User-facing date
grouping, selected-day ranges, reports, imports, and redirects use the app-level
`APP_TIMEZONE`.

Current rules:

- `APP_TIMEZONE` is set through Docker Compose and validated by `src/lib/env.ts`.
- New activity rows store `ActivityLog.timezone` from `APP_TIMEZONE`.
- Baby timezone columns are kept for compatibility but should not drive current date grouping.
- Sprout imports treat offset-less Sprout datetime strings as UTC instants, then Cubby displays and groups them with `APP_TIMEZONE`.
- Calendar-date-only values should remain stable as dates, not shifted into a different local day.

Use the existing time utilities and service helpers rather than hand-rolling date
math in pages.

## Feature Areas

### Appearance

Authenticated app routes are wrapped by `src/app/app/layout.tsx`, which resolves
the household accent and exposes it through `data-accent`. Semantic color tokens
in `src/styles/globals.css` provide light and dark palettes for the five curated
accent choices. Appearance changes go through `src/server/services/appearance.ts`
and require `household.manage`.

Activity recognition uses Cubby-original raster artwork under
`public/activity-art` through the shared `ActivityArtwork` component. Utility
actions such as navigation, settings, editing, and deletion continue to use
Lucide icons so controls remain familiar and accessible.

### Log Entry And Dashboard

`src/server/services/dashboard.ts` builds the Log Entry view: selected baby,
selected date, quick-action data, elapsed badges, daily summary, warning items,
active timers, and grouped timeline records.

Dashboard warnings are household-wide dismissible records keyed by baby, warning
type, and fingerprint. A warning reappears only when its underlying trigger
changes.

### Activities And Timers

`src/server/services/activities.ts` owns activity creation, updates, deletes,
undo behavior, timer transitions, and webhook/notification side effects. Pages
and API routes should call this service instead of writing activity tables
directly.

### Calendar

`src/server/services/calendar.ts` builds month data and event details. Calendar
pages filter by the header-selected baby and use `APP_TIMEZONE` for month/day
display.

### Reports

`src/server/services/reports.ts` computes report windows, statistics, growth
trends, activity summaries, heatmaps, and the Routine tab. Routine windows are
trailing `1w`, `2w`, or `1m` windows anchored to the Reports end date.

### Backups And Sprout Import

`src/server/services/backups.ts` exports and restores Cubby JSON backups,
including the household appearance accent when present. Older version 1 backups
without appearance settings remain valid and use the default sage accent.
`src/server/services/sprout-import.ts` previews and imports Sprout Track backup
uploads into the current Cubby household.

Sprout restore accepts Sprout `.zip`, standalone `baby-tracker.db`, and `data.json`
backup shapes. It imports user-owned tracking data, matches or creates babies,
preserves caretaker names as historical attribution, and skips Sprout auth,
runtime secrets, API keys, push subscriptions, sessions, and email config.

SQLite reading uses `sql.js` loaded from runtime `node_modules` in a server-only
path. Docker-sensitive changes here should be verified inside the container.

### Hooks, Webhooks, And Notifications

API-key hooks live under `/api/hooks/v1`. Hook clients authenticate with
`Authorization: Bearer <key>`, and keys are stored hashed with prefix display and
revocation metadata.

Webhook endpoint and delivery records are stored for activity/timer event
delivery. Browser push subscriptions, notification preferences, and notification
logs are stored for notification workflows.

## Clean-Room Boundary

Cubby can implement product behavior inspired by common baby-tracking workflows,
including workflows observed in Sprout Track. Cubby must not copy Sprout Track
code, schemas, assets, exact UI text, credentials, route names, or implementation
structure.

## Testing Map

Service tests live near services in `src/server/services/*.test.ts`. Add focused
tests near the service that owns the behavior:

- Registration and invite policy: `registration.test.ts`, `invites.test.ts`.
- Role and member access policy: `roles.test.ts`, `member-access.test.ts`.
- Dashboard, warnings, date grouping: `dashboard.test.ts`.
- Reports and routine analytics: `reports.test.ts`.
- Sprout parsing/import mapping: `sprout-import.test.ts`.

For UI, auth, schema, Docker, or import changes, use the verification guidance in
[Development](DEVELOPMENT.md).
