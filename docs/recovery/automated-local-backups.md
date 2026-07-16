# Automated Local Backups

Cubby's automated backups write the same checksummed version 2 JSON household
snapshots used by manual export into a dedicated local directory on the home
server. This feature is intentionally local-only: no remote provider, no cloud
credentials, and no application-level encryption or key rotation are included.

## Defaults And Enablement

- `AUTOMATED_BACKUPS_ENABLED=false` by default.
- `AUTOMATED_BACKUP_DIRECTORY=/var/lib/cubby/backups` inside the app container.
- `CUBBY_BACKUP_HOST_DIR=./docker-data/backups` as the default Compose bind
  mount on the host.
- `AUTOMATED_BACKUP_INTERVAL_HOURS=24`
- `AUTOMATED_BACKUP_POLL_MINUTES=15`
- `AUTOMATED_BACKUP_RETRY_MINUTES=60`
- `AUTOMATED_BACKUP_RETENTION_COUNT=30`

Enable automation only after creating a private host directory with restrictive
ownership and enough free space for multiple 25 MiB snapshots.

- Linux, from the repository root: run `install -d -m 0700
  ./docker-data/backups`, verify `stat -c '%a %U:%G' ./docker-data/backups`, and
  check capacity with `df -h ./docker-data/backups`.
- Windows Docker Desktop, in Command Prompt: run `mkdir
  C:\CubbyData\backups`, then `icacls C:\CubbyData\backups /inheritance:r
  /grant:r "%USERNAME%:(OI)(CI)F" "Administrators:(OI)(CI)F"`. Set
  `CUBBY_BACKUP_HOST_DIR=C:\CubbyData\backups`, verify the ACL with `icacls
  C:\CubbyData\backups`, and check capacity in PowerShell with `Get-PSDrive C`.

After startup, verify the container mount with `docker compose exec app sh -c
'test -w /var/lib/cubby/backups'`. Check free space at least weekly and alert
before the host filesystem falls below 20% free; retain additional margin beyond
`AUTOMATED_BACKUP_RETENTION_COUNT × 25 MiB`. Cubby requests private modes when
creating files, but final host ownership, ACL enforcement, capacity alerts, and
disk-health monitoring remain the operator's responsibility.

## Runtime Behavior

- Startup reconciliation deletes only recognized stale `.tmp` files in the
  backup directory and marks linked complete records failed when their file is
  missing, corrupt, or checksum-mismatched.
- The scheduler checks due households at startup and every 15 minutes after.
- A household is due when it has no successful automated backup, its newest
  successful version is at least 24 hours old, or its newest attempt failed at
  least 60 minutes ago. An older failure never suppresses a newer success.
- A running or paused timer blocks publication. Cubby records a sanitized
  `backup_active_timer` failure and retries after 60 minutes.
- A valid version is written to a same-directory temporary file, flushed, then
  atomically hard-linked into place without overwriting an existing version.
- Retention counts only healthy version 2 files with valid checksums and keeps
  the newest 30 by default.
- Empty fresh targets do not auto-create backups and do not prune existing local
  recovery files.

## Status And Failures

Settings shows whether automation is enabled, cadence, retry, retention, latest
success, latest sanitized failure code, next due estimate, healthy local version
count, discovered local versions that can be downloaded, and unhealthy/corrupt
local file warnings.

In a multi-household installation, discovery and download include only versions
linked to the current household's automated records. A sole-household fresh
target may discover unassociated valid files from the mounted recovery directory
even when backup or audit metadata exists, so disaster recovery does not depend
on the lost database.

Failure codes are intentionally sanitized. Cubby does not show full host paths,
raw stack traces, environment values, or secret material in the UI or saved
backup records.

Common failure meanings:

- `backup_active_timer`: stop or finish every running or paused timer.
- `backup_directory_unavailable`: fix the bind mount, directory existence, or
  permissions.
- `backup_write_failed`: investigate disk permissions, disk-full conditions, or
  transient host I/O problems.
- `backup_too_large`: the snapshot exceeded Cubby's 25 MiB logical-backup
  ceiling.
- `backup_invalid`: a discovered local file is corrupt or not a valid Cubby v2
  backup.

## Recovery Workflow

1. Preserve the host backup directory before troubleshooting database or app loss.
2. Start a fresh Cubby target with the same backup directory mounted and
   `AUTOMATED_BACKUPS_ENABLED=false` until recovery is verified.
3. Open Settings → Backups, review discovered local versions, and download the
   intended immutable file.
4. Upload that file through the existing restore form.
5. Use the read-only preview, confirm the checksum, and type the current target
   household name exactly.
6. Restore only into a fresh owner household.
7. Recreate excluded auth, membership, invite, webhook, API-key, notification,
   and attachment state separately after the household data is restored.
8. Re-enable automation only after the recovered state is verified.

Automated local backups are logical household recovery artifacts. They are not
PostgreSQL physical backups, do not include vaccine attachment files, do not
copy auth/session/integration runtime state, and do not protect against total
host-disk loss.

They also do not reverse database migrations. During an application update they
provide a fresh, checksummed household-data recovery artifact, but an
incompatible schema rollback requires a separately prepared database
restore/recovery plan. Prefer a forward correction after migration; never assume
that starting an older image or applying an ad hoc down migration is safe. See
[Always-On Updates And Migration Recovery](../ALWAYS_ON_UPDATES.md).
