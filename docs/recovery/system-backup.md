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

## Making One

From the Cubby checkout on the server, as the account that runs `docker compose`:

```bash
sh scripts/system-backup.sh
```

Cubby keeps running. The script copies the database first and the photos straight after, so a photo
shared in between is simply left for the next backup. It writes to `./docker-data/system-backups`,
checks the dump reads back, and keeps the newest 14 archives. `--output-dir DIR` and `--keep N`
change both. A successful run ends with:

```text
system_backup_created file=./docker-data/system-backups/cubby-system-20261004T031500Z.tar bytes=... households=2 accounts=5 photos=140
```

## Every Night, Automatically

Add a line to the crontab of the account that runs Cubby (`crontab -e`), changing the path to your
checkout:

```cron
15 3 * * * cd /home/you/cubby && sh scripts/system-backup.sh >> docker-data/system-backup.log 2>&1
```

That makes an archive at 3:15 every night and keeps two weeks of them.

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
   sh scripts/system-restore.sh --archive /path/to/cubby-system-20261004T031500Z.tar --confirm-empty-install
   ```

The script checks the archive's checksums and version, refuses any install that already has an
account, a household or a photo, and only then replaces the new install's empty database with the
archived one, puts the photos back and starts Cubby. It ends by checking the households, accounts
and photos match the archive:

```text
system_restore_complete households=2 accounts=5 photos=140 from=20261004T031500Z
```

Everyone then signs in as before. If the new version of Cubby is newer than the archive, it brings
the restored database forward on that first start, as any update does. Point your domain at the new
server and turn automated backups back on once you have checked everything is there.

If the restore stops partway, the message says what failed. Nothing is ever changed on the old
server, and an install the restore stopped on can be discarded and made again.

## Rehearsal

`npm run verify:system-backup` proves the whole path on a Linux Docker host with a throwaway
install: it creates an account, a household, a Moments post and a photo, makes a system backup,
destroys the database and the photos, restores onto a fresh start with the kept `.env`, and checks
the account signs in with its original password, the data is back, the photo's bytes are identical,
and a second restore is refused. It runs with every change, in the image rehearsals.
