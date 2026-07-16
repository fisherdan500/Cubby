# Manual Backup Recovery

Cubby version 2 JSON backups are checksummed logical snapshots for recovering
approved household data into a fresh household. They are not PostgreSQL volume
backups and do not copy authentication or integration secrets.

## Disposable PostgreSQL Rehearsal

### Prerequisites

- Docker Desktop (or Docker Engine with Compose v2) is running.
- Node.js 22 and npm dependencies are installed in this checkout.
- No Cubby development or household deployment configuration is required.

From the repository root, run exactly:

```bash
npm run verify:backup-recovery
```

The command creates a uniquely named `cubby_backup_rehearsal_*` Compose project
from `scripts/backup-recovery-rehearsal.compose.yml`. That file starts only a
PostgreSQL 16 service with a project-scoped disposable volume and a random
loopback-only host port. The harness does not load `.env`, does not use
`docker-compose.yml`, and does not connect to the normal `cubby` database or
`cubby_postgres_data` volume. It applies committed Prisma migrations, creates
source and fresh-target household fixtures, exercises export → restore →
re-export, and removes the project and volume in a `finally` teardown.

A successful run ends with output similar to:

```text
Test Files  1 passed (1)
Tests  1 passed (1)
BACKUP RECOVERY REHEARSAL PASSED
```

The command also prints the unique disposable project name and every subprocess
it runs. Failure returns a non-zero exit code. If Docker teardown itself fails,
the final error prints the exact project-scoped `docker compose ... down
--volumes --remove-orphans` command to run; never substitute the normal Cubby
Compose project in that command.

The rehearsal covers allowlisted settings, active and inactive babies, a stopped
timer with historical source attribution, contact-linked medicine history,
medicine and supplement catalogs, vaccine history, calendar baby/contact links,
and a reminder. It proves target-owner preservation, semantic equivalence after
a second export, exclusion boundaries, checksum and dangling-reference rejection,
stale-preview/non-empty rejection without partial recovery, and repeat-restore
rejection.

## What Version 2 Includes

- Household name and non-security household settings, including appearance and
  unit preferences.
- Active and inactive babies, baby preferences, and warning thresholds.
- Non-deleted activities and type-specific details.
- Safe historical source/external attribution and coherent stopped-timer state.
  Running or paused timers block export and are never revived by recovery.
- Non-deleted contacts and medicine/supplement catalogs.
- Non-deleted calendar events with baby/contact links.
- Non-deleted reminders.

## What Is Excluded

- Users, accounts/credentials, sessions, household memberships, roles, and
  suspension state.
- Invitations and registration-policy settings.
- API keys, webhook endpoints/secrets/deliveries, push subscriptions,
  user-bound notification preferences, and notification logs.
- Audit events, import history, backup history, and dashboard-warning
  dismissals, except for new sanitized recovery audit/backup records generated
  in the target.
- Vaccine attachment metadata, local attachment paths, **and the attachment file
  bytes themselves**. A restored vaccine activity may retain its ordinary
  vaccine fields, but any attached document must be recovered separately from
  verified storage and reattached.

After recovery, recreate invitations, API keys, webhooks, browser push
subscriptions, and notification preferences in the target household. Keep
separate host-level protection for PostgreSQL volumes and attachment storage.

## Fresh-Target Requirement

Restore is recovery, not merge or replacement. The target must have exactly one
active, non-deleted member: the currently authenticated owner. It must contain no
babies, activities, contacts, catalogs, calendar events, reminders, invites,
API keys, webhooks, push state, or notification state. Default household settings,
setup audit rows, and previous failed/preview/export backup records do not by
themselves make a target non-empty.

Preview is read-only, but it is not the final safety boundary. Restore rechecks
the owner and complete empty-target predicate inside the same serializable
transaction that writes recovered data. The target owner user, membership,
credentials, and sessions are preserved.

## Version 1 Limitation

Legacy version 1 backups remain accepted only for explicitly labeled partial
recovery into a fresh target. They contain only the older limited baby/activity
shape and optional appearance/unit settings, have no version 2 checksum claim,
and cannot recover the additional version 2 model groups. Do not treat a version
1 restore as a complete household recovery.

Sprout Track import remains a separate additive clean-room migration path; it is
not Cubby backup recovery and does not relax the fresh-target rule for Cubby JSON
restore.
