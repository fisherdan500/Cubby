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
count, household-authorized local versions that can be downloaded, and warnings
for those authorized files.

Ordinary status and download paths use only complete `BackupRecord` rows linked to
the current household. They do not open, parse, enumerate in the UI, or disclose
unassociated files from the shared backup directory. Foreign, unassociated,
malformed, and nonexistent filenames all return the same not-found contract
before file I/O.
Being the sole household, owning that household, owning the platform, or having a
fresh target does not establish source-backup authority. Target freshness is only
a restore-safety predicate.

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
3. Create or preserve the intended target owner's credential-backed account, but
   do not complete normal household onboarding. Explicitly bind the intended
   platform owner and obtain the exact stable platform-owner and target-owner IDs
   through an approved host maintenance procedure. The same account may hold both
   roles.
4. With public registration disabled, household creation mode `closed`, and no
   active households, provision the one supported empty target:

   ```bash
   npm run platform:owner -- provision-backup-recovery-target --current-owner-user-id <current-platform-owner-id> --target-owner-user-id <target-owner-user-id> --confirm-target-owner-email <exact-persisted-email> --target-household-name <new-target-name> --acknowledgement I_PROVISION_EMPTY_BACKUP_RECOVERY_TARGET
   ```

   The command takes the same deployment-wide household-creation lock as ordinary
   onboarding, locks and rechecks the closed platform policy and platform authority,
   requires zero active households and an exact credential-backed target owner,
   then atomically creates one household, one owner membership, default settings,
   and platform plus household audit events. It creates no baby or other
   recoverable data. Copy the returned household ID for the authorization command.
   Do not create a normal household first; normal onboarding is intentionally
   non-empty. Authorization takes the same lock and rechecks the closed policy.
5. Inspect one explicitly named, unassociated candidate without mutating the
   database:

   ```bash
   npm run platform:owner -- inspect-backup-recovery --current-owner-user-id <current-platform-owner-id> --filename <exact-backup-filename>
   ```

   The command validates the current platform authority, canonical filename,
   document shape, checksum, source household name, size, and item count. Copy the
   exact filename, checksum, and source household name from its JSON result.
6. Authorize only that verified file for only that fresh target:

   ```bash
   npm run platform:owner -- authorize-backup-recovery --current-owner-user-id <current-platform-owner-id> --target-household-id <target-household-id> --target-owner-user-id <target-owner-user-id> --confirm-target-owner-email <exact-persisted-email> --filename <exact-backup-filename> --confirm-checksum <exact-sha256> --confirm-source-household-name <exact-source-household-name> --acknowledgement I_AUTHORIZE_EXPLICIT_BACKUP_RECOVERY
   ```

   In the production image, replace `npm run platform:owner --` with `docker
   compose exec -T app node /app/platform-owner.mjs`.
7. Authorization locks and rechecks the current platform authority, requires
   exactly one active household, verifies the named target is fresh and has the
   named user as its sole active owner with an exact email match and usable
   password credential, revalidates the file identity, and rejects an existing
   association. It then creates one complete `recovery_authorized` backup record
   and writes both platform and household audit events atomically.
8. The globally unique storage filename is the replay boundary: the same file
   cannot be authorized again or reassigned to another household. No transferable
   recovery token is created. If a command result is lost, inspect audit and backup
   state through an approved maintenance procedure rather than guessing success.
9. Open Settings → Backups. Only after authorization will the selected local
   version appear for the target household. Download that immutable file and
   upload it through the existing restore form.
10. Use the read-only preview, confirm the checksum, and type the current target
   household name exactly. Restore still rechecks target freshness inside its
   transaction.
11. Recreate excluded auth, membership, invite, webhook, API-key, notification,
    and attachment state separately after the household data is restored.
12. Re-enable automation only after the recovered state is verified.

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
