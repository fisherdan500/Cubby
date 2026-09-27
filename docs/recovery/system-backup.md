# Whole-System Backup

A system backup is one archive holding everything needed to bring a whole Cubby back on a new
server, exactly as it was: every household and its members, every account and sign-in, every log
entry, Moments posts, comments, reactions and photos, and the platform's own settings. It is the
backup for losing the server itself.

It sits beside the household backups in Settings → Backups, which each household owner makes for
their own household. Those remain the way to move one household to a different Cubby. A system
backup is for the platform owner, runs on the server, and brings back all households at once.

| | Household backup | System backup |
|---|---|---|
| Who makes it | Each household owner, in Settings | The platform owner, on the server |
| Holds | One household's data and photos | Every household, account and photo, and platform settings |
| Accounts and sign-ins | Not included; people are invited again | Included; everyone signs in as before |
| Restores into | An empty household on any Cubby | A new, empty Cubby install |

## What Is In The Archive

`cubby-system-<UTC time>.tar` holds four files:

- `manifest.txt`: the archive format, when it was made, the Cubby revision and database version it
  came from, and how many households, accounts and photos it holds.
- `checksums.sha256`: a SHA-256 digest of each of the two files below.
- `database.dump`: the whole database, made by PostgreSQL's own `pg_dump`.
- `attachments.tar`: every stored photo, exactly as stored.

It does not hold `.env`. That file holds the keys the restored accounts, sign-ins and queued email
depend on, and Cubby will not start against restored data without the same keys. Keep a copy of
`.env` somewhere safe of its own, such as a password manager, and update that copy whenever `.env`
changes. A stolen archive then still holds everyone's data but not the keys to sign in with it.
Treat the archives as private either way: they hold every household's data and every account's
password hash.

Also left out: the household backup files in `docker-data/backups` (the database lists them, and
Cubby marks any that are missing after a restore) and the temporary Sprout import files.

## Prerequisites, Exclusion And Format Limits

- Supported operational platform: Linux with Docker Compose, GNU tar/coreutils and **host Node.js
  22 or newer** (`node` on the operator and cron PATH). The validator uses Node builtins only; no npm
  install is needed. The scripts fail before Docker if Node is missing/too old. Refresh all four
  `system-backup.sh`, `system-restore.sh`, `system-maintenance.sh`, `system-archive.mjs` files together.
- One Compose app/Node process owns the database and attachment store. All backup/restore operators
  use the same checkout and lock. Stop external admin writers, migrations, helper jobs, independent
  app instances and deployment automation for the entire window. This is **not** a database fence
  against arbitrary clients or a distributed lock across different checkouts. PostgreSQL remains up.
- Lock contention fails closed; a stale lock is never stolen by age. After an uncatchable kill or host
  crash, inspect the operation and app state before manually removing an orphaned lock. Caught failure
  releases only this operation's lock and temporary files, never an earlier partial directory.
- Provide private disk space for the dump, photo tar and final archive during backup, and roughly
  twice the input archive plus restored destination data during restore (private input copy plus
  prepared payloads). Keep the input immutable. Shell signals cannot guarantee cleanup after SIGKILL.
- The closed parser accepts basic USTAR/GNU headers, not PAX/longname/sparse extensions, links,
  devices, alternate path spellings or duplicate members. It reads payloads in 64 KiB chunks and
  bounds metadata (4 KiB manifest, 256-byte checksum file), entries (1,000,000), stored photo members
  (25 MiB each), and total archive size (1 TiB). Unsigned GNU base-256 sizes support outer payloads
  larger than 8 GiB without buffering them. Larger-than-1-TiB installations need a separately reviewed
  format extension; backup refuses before publishing or rotating archives.
- New archives are format **v2**; restore accepts **v1 and v2** within these strict bounds. Household
  JSON/ZIP formats are unchanged. Legacy v1 thumbnail and incoming restore-upload members are
  validated but discarded, not restored as recovery truth. New v2 backups exclude those directories.
  Originals, including removed/staged photos, and deterministic `.KEY.write-v1.tmp` files are kept;
  the complete dump includes `AttachmentWriteIntent` durable cleanup ownership. Historical random
  object temp files are validated but discarded on restore. No live orphan cleanup is performed.
- A v1 archive made online may already contain inconsistent data; structural acceptance cannot
  retroactively make it coherent. Counts/checksums do not prove every photo agrees with database
  digests or repair historical missing/corrupt bytes. Check recovered photos and application integrity.
- Backups are trusted administrator inputs, **not safe arbitrary uploads**. The PostgreSQL dump can
  execute privileged SQL. SHA-256 detects accidental corruption, not authenticity; it does not cover
  the manifest. Keep trusted custody of the whole archive and the original keys.

## Making One

From the Cubby checkout on the server, as the account that runs `docker compose`:

```bash
sh scripts/system-backup.sh --maintenance
```

This is a **maintenance backup, not an online snapshot**. `--maintenance` acknowledges downtime
and that you have excluded every external writer. The script holds the shared checkout-local
`.cubby-system-maintenance.lock`, stops the sole Compose app (including requests, retention and
scheduled jobs), verifies it is no longer running, then copies the database, originals and counts
while stopped. It resumes only an app that was running when backup stopped it, and only on success.
It writes to `./docker-data/system-backups`,
checks the dump reads back, and keeps the newest 14 archives. `--output-dir DIR` and `--keep N`
change both. A successful run ends with:

```text
system_backup_created file=./docker-data/system-backups/cubby-system-20261004T031500Z.tar bytes=... households=2 accounts=5 photos=140
```

## Every Night, Automatically

Add a line to the crontab of the account that runs Cubby (`crontab -e`), changing the path to your
checkout:

```cron
15 3 * * * cd /home/you/cubby && sh scripts/system-backup.sh --maintenance >> docker-data/system-backup.log 2>&1
```

That opts into downtime at 3:15 every night and keeps two weeks of archives. Review existing cron
entries explicitly: old invocations without `--maintenance` now fail before Docker. The scripts do
not add or edit schedules, enable household backups, or change settings. Monitor the host log and
exit status externally: if a backup fails after stopping Cubby, Cubby stays stopped and cannot email
its own alert. After investigating the failure, the operator decides whether to restart it.

Each run records itself in the database: what it made, or why it failed. Platform administration
(`/platform/settings`) shows the newest backup under **Backups and storage**. Cubby checks every hour
and **emails the platform owner** when:

- the last run failed;
- no run has succeeded for 36 hours, once the first one has been made;
- households' automatic backups have stopped;
- the disk holding photos or backups falls under a fifth free.

It sends one email when a problem starts, then one a day until it is fixed. If the database is down,
a run cannot record itself, and Cubby notices the missing backup instead.
`docker-data/system-backup.log` still has each run's own output.

## Copy It Off The Server

An archive on the server's disk goes with the disk. Copy archives somewhere else, for example
another computer, a NAS or an external drive. Any regular copy works:

```bash
rsync -a /home/you/cubby/docker-data/system-backups/ you@other-machine:cubby-backups/
```

A cron line after the backup (say at 4:00) keeps the copy current. At the very least, download the
newest archive to your own computer each week.

## Restoring Onto A New Server

1. Install Cubby on the new server as usual (see the quick start in the README), using the same or a
   newer version than the one the archive came from.
2. Put your saved copy of the old `.env` in the checkout, replacing the one the quick start wrote.
   Keep the new `docker-data` directories the quick start made.
3. Do not open `/setup` or create any account: the restore needs an empty install.
4. Copy the archive onto the new server and run, from the checkout:

   ```bash
   sh scripts/system-restore.sh --archive /path/to/cubby-system-20261004T031500Z.tar --confirm-empty-install --maintenance
   ```

The script validates both tar levels, exact checksum coverage and the strict manifest before any
Docker call or payload extraction. It bootstraps the new schema if needed, **stops and verifies the
app before the authoritative account/household/storage empty checks**, and holds exclusion through
replacement, photo extraction and restored-count verification. It rejects any non-directory storage
entry, including symlinks. Only after verification does it start Cubby. Successful restore explicitly
starts the app; backup, unlike restore, never starts an originally stopped app. It reports:

```text
system_restore_complete households=2 accounts=5 photos=140 from=20261004T031500Z
```

Everyone then signs in as before. If the new version of Cubby is newer than the archive, it brings
the restored database forward on that first start, as any update does. Point your domain at the new
server and turn automated backups back on once you have checked everything is there.

Before database replacement, refusal preserves committed target data (bootstrap may already have
initialized/migrated the new schema). After DROP or a partial restore, the target may be partially
restored, **not necessarily empty**. Failures after quiescence leave the app stopped; there is no
automatic rollback or destructive retry. Inspect the failure and use a separately prepared fresh
target rather than clearing the refused target blindly. A failed final app start triggers a stop
attempt; if Docker itself fails, manually establish its state. Nothing changes the source server.

## Rehearsal

`npm run verify:system-backup` proves the whole path on a Linux Docker host with a throwaway
install: it creates an account, a household, a Moments post and a photo, makes a system backup,
destroys the database and the photos, restores onto a fresh start with the kept `.env`, and checks
the account signs in with its original password, the data is back, the photo's bytes are identical,
and a second restore is refused. It runs with every change, in the image rehearsals.
