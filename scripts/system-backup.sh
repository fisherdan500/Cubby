#!/bin/sh
# Whole-system backup: one archive holding everything a new server needs to bring Cubby back as it
# was, for every household at once - accounts and sign-ins, households and members, every log
# entry, Moments posts, comments, reactions and photos, and the platform's own settings.
#
#   manifest.txt      what the archive is, when it was made, the database version it came from,
#                     and how many households, accounts and photos it holds
#   checksums.sha256  a SHA-256 digest of each file below
#   database.dump     the whole database, from PostgreSQL's own pg_dump (custom format)
#   attachments.tar   every photo file, exactly as stored
#
# Requires explicit downtime: --maintenance stops the sole app (including retention and jobs)
# across the database dump, originals and counts. No external writers may run in that window.
# The server's .env holds the keys the restored accounts and email depend on and is never
# put in the archive: keep a copy of it somewhere safe of its own, such as a password manager.
# A stolen archive then still holds everyone's data but not the keys to sign in or read queued mail.
#
# Usage: sh scripts/system-backup.sh --maintenance [--output-dir DIR] [--keep N]
#   --output-dir  where archives go (default ./docker-data/system-backups)
#   --keep        how many archives to keep, oldest removed first (default 14)
# See docs/recovery/system-backup.md for scheduling it and for scripts/system-restore.sh.
set -eu
umask 077

# Each run is recorded in the database, succeeded or failed with the reason below, so Cubby's platform
# page shows the newest backup and the platform owner is emailed when they fail or stop. Recording is
# best effort: when the database itself is down the run cannot be recorded, and Cubby notices the
# missing backup instead. Only runs that got as far as starting are recorded, never a mistyped option.
started=false
record_run() {
  docker compose exec -T postgres psql -U cubby_migrator -d cubby -XAt -v ON_ERROR_STOP=1 -c "$1" > /dev/null 2>&1 \
    || printf 'system_backup_unrecorded: this run could not be recorded for the platform page\n' >&2
}
sql_text() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/''/g")"
}

fail() {
  printf 'system_backup_failed: %s\n' "$1" >&2
  if [ "$started" = true ]; then
    record_run "INSERT INTO \"SystemBackupRun\" (status, failure) VALUES ('failed', $(sql_text "$1"))"
  fi
  exit 1
}

output_dir="./docker-data/system-backups"
keep=14
maintenance=false
while [ $# -gt 0 ]; do
  case "$1" in
    --maintenance) maintenance=true; shift ;;
    --output-dir) [ $# -ge 2 ] || fail "--output-dir needs a directory"; output_dir="$2"; shift 2 ;;
    --keep) [ $# -ge 2 ] || fail "--keep needs a number"; keep="$2"; shift 2 ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) fail "unknown option $1" ;;
  esac
done
case "$keep" in ''|*[!0-9]*) fail "--keep must be a whole number of at least 1" ;; esac
[ "$keep" -ge 1 ] || fail "--keep must be a whole number of at least 1"
[ -f docker-compose.yml ] || fail "run this from the Cubby checkout, where docker-compose.yml is"

[ "$maintenance" = true ] || fail "backup requires downtime; add --maintenance after excluding external writers"
command -v node > /dev/null || fail "Node.js 22 or newer is required on the host"
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' || fail "Node.js 22 or newer is required on the host"
. ./scripts/system-maintenance.sh
maintenance_acquire

psql_value() {
  docker compose exec -T postgres psql -U cubby_migrator -d cubby -XAt -v ON_ERROR_STOP=1 -c "$1"
}

stamp=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$output_dir"
chmod 700 "$output_dir"
candidate="$output_dir/.cubby-system-$stamp.partial"
archive="$output_dir/cubby-system-$stamp.tar"
[ ! -e "$candidate" ] && [ ! -e "$archive" ] && [ ! -e "$archive.partial" ] || fail "a backup named $stamp already exists; try again in a second"
mkdir "$candidate" || fail "the private work directory could not be created"
work="$candidate"
partial="$archive.partial"
started=true
maintenance_stop

# The database: a consistent snapshot, taken by the database's own superuser inside its container.
docker compose exec -T postgres pg_dump -U cubby_migrator -d cubby --format=custom > "$work/database.dump" \
  || fail "the database could not be dumped; is the postgres service running?"
[ -s "$work/database.dump" ] || fail "the database dump is empty"
docker compose exec -T postgres pg_restore --list < "$work/database.dump" > /dev/null \
  || fail "the database dump does not read back"

# The app and its retention/jobs remain stopped through dump, bytes and counts.
docker compose run --rm --no-deps -T --entrypoint tar app --hard-dereference --exclude=./thumbnails --exclude=./restore-staging -cf - -C /var/lib/cubby/attachments . > "$work/attachments.tar" \
  || fail "the photos could not be read"
tar -tf "$work/attachments.tar" > /dev/null || fail "the photo archive does not read back"

migration=$(psql_value "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name DESC LIMIT 1") \
  || fail "the database version could not be read"
households=$(psql_value 'SELECT count(*) FROM "Household" WHERE "deletedAt" IS NULL') || fail "the households could not be counted"
accounts=$(psql_value 'SELECT count(*) FROM "User"') || fail "the accounts could not be counted"
photos=$(psql_value "SELECT count(*) FROM \"Attachment\" WHERE state <> 'purged'") || fail "the photos could not be counted"
revision=$(git rev-parse --short HEAD 2>/dev/null || printf 'unknown')

{
  printf 'format=cubby-system-backup-2\n'
  printf 'created=%s\n' "$stamp"
  printf 'revision=%s\n' "$revision"
  printf 'migration=%s\n' "$migration"
  printf 'households=%s\n' "$households"
  printf 'accounts=%s\n' "$accounts"
  printf 'photos=%s\n' "$photos"
} > "$work/manifest.txt"
(cd "$work" && sha256sum database.dump attachments.tar > checksums.sha256) || fail "the checksums could not be written"

tar -cf "$archive.partial" -C "$work" manifest.txt checksums.sha256 database.dump attachments.tar \
  || fail "the archive could not be written"
node scripts/system-archive.mjs check "$archive.partial" prisma/migrations || fail "the completed archive failed strict validation"
mv "$archive.partial" "$archive"

# Keep the newest --keep archives; only files this script names are ever removed.
ls "$output_dir" | grep -E '^cubby-system-[0-9]{8}T[0-9]{6}Z\.tar$' | sort -r | tail -n +"$((keep + 1))" | while read -r old; do
  rm -f -- "$output_dir/$old"
done

size=$(wc -c < "$archive" | tr -d ' ')
# Recorded after the archive exists, so this backup is not in its own dump; older records go after 90 days.
record_run "INSERT INTO \"SystemBackupRun\" (status, \"archiveName\", \"byteSize\", households, accounts, photos) VALUES ('succeeded', $(sql_text "$(basename "$archive")"), $size, $households, $accounts, $photos); DELETE FROM \"SystemBackupRun\" WHERE \"recordedAt\" < now() - interval '90 days'"
maintenance_resume
printf 'system_backup_created file=%s bytes=%s households=%s accounts=%s photos=%s\n' "$archive" "$size" "$households" "$accounts" "$photos"
printf 'Copy it off this server: a backup on the same disk goes with the disk.\n'
