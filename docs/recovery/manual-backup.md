# Manual Backup Recovery

Cubby version 2 JSON backups are checksummed logical snapshots for recovering
approved household data into a fresh household. They are not PostgreSQL volume
backups and do not copy authentication or integration secrets. To bring back a
whole server, every household and account at once, use a
[Whole-System Backup](system-backup.md) instead.

Automated local backups use this same version 2 format. See
[Automated Local Backups](automated-local-backups.md) for enablement, retention,
status semantics, and the local download-then-upload recovery flow.

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
`cubby_postgres_data` volume. It applies committed Prisma migrations, builds the
packaged platform-owner CLI, creates source and fresh-target household fixtures,
and exercises export → ordinary-access denial after record loss → packaged
inspection and explicit authorization → restore → re-export. It removes the
project and volume in a `finally` teardown.

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
and a reminder. It also proves automated file creation; ordinary status/download
denial after automated-record loss; content-minimized packaged inspection;
explicit immutable association; platform and household audits; authorization
replay rejection; target-owner preservation; semantic equivalence after a second
export; exclusion boundaries; checksum and dangling-reference rejection;
stale-preview/non-empty rejection without partial recovery; repeat-restore
rejection; concurrent scheduler exclusion; active-timer blocking; exact
oldest-first retention while preserving an unassociated valid file; preservation
of prior versions after a failed publication; and full disposable teardown of
both the database project and generated temporary backup directory.

A second case covers Moments and plans through a backup archive. It seeds:

- a baby's planned schedule;
- captioned, caption-less and whole-family posts;
- member and named comments (one edited) on a post and on a logged entry;
- member and named reactions;
- three stored photos.

It then exports the household's `.zip` and checks that `backup.json` alone is refused. Finally it
restores into a fresh household and proves that:

- the Moments and plan re-export identically once ids are set aside;
- each photo is stored afresh under a new name with its exact original bytes;
- authors and reactors return as names, not accounts;
- a second restore is refused before any photo is stored.

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
- Each baby's planned schedule.
- Moments (the family feed): non-removed posts with their #tags, comments and reactions, and each
  post's photos (see Backups With Photos below). Memberships are not in backups, so authors and
  the people who reacted travel as names: after a restore their posts, comments and reactions show
  under those names but are no longer tied to an account, so they cannot be edited or removed by
  the person who made them.

## Backups With Photos

Once a household has feed photos (DEC-PROD-422), its backup download is one
`.zip` archive instead of a `.json` file. The archive holds:

- `backup.json`, the ordinary version 2 backup. Its `feedPhotos` section lists
  each photo's post, position, shape, byte size and SHA-256 digest, so the
  backup checksum covers every photo.
- `photos/<id>.jpg`, one file per listed photo.

Nothing else may be in the archive, and every listed photo must be present. The
archive is uncompressed (the photos are already compressed JPEGs), under 4 GiB,
and opens with any ordinary unzip tool. Cubby accepts uploads up to 2 GiB.

Restore accepts the `.zip` directly:

1. The upload is written to a private staging directory beside the photo store,
   and removed when the preview or restore finishes. Uploads left by an
   interrupted restore are cleared after a day.
2. Preview checks every photo against its listed digest before showing counts.
3. Restore checks each photo again and stores it under a new random name, then
   makes the data and photos visible together in one transaction. If anything
   fails, the photos stored for that attempt are removed.

A `backup.json` that lists photos cannot be restored on its own, because it
would silently lose them; restore the whole `.zip` instead. Households without
photos keep getting the same `.json` file as before, with an unchanged checksum.

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
