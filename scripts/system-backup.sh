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
# It runs on the server, from the Cubby checkout, while Cubby keeps running. The database is copied
# first and the photos straight after, so a photo shared in between is simply left for the next
# backup. The server's .env holds the keys the restored accounts and email depend on and is never
# put in the archive: keep a copy of it somewhere safe of its own, such as a password manager.
# A stolen archive then still holds everyone's data but not the keys to sign in or read queued mail.
#
# Usage: sh scripts/system-backup.sh [--output-dir DIR] [--keep N]
#   --output-dir  where archives go (default ./docker-data/system-backups)
#   --keep        how many archives to keep, oldest removed first (default 14)
# See docs/recovery/system-backup.md for scheduling it and for scripts/system-restore.sh.
set -eu
umask 077

fail() {
  printf 'system_backup_failed: %s\n' "$1" >&2
  exit 1
}

output_dir="./docker-data/system-backups"
keep=14
while [ $# -gt 0 ]; do
  case "$1" in
    --output-dir) [ $# -ge 2 ] || fail "--output-dir needs a directory"; output_dir="$2"; shift 2 ;;
    --keep) [ $# -ge 2 ] || fail "--keep needs a number"; keep="$2"; shift 2 ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) fail "unknown option $1" ;;
  esac
done
case "$keep" in ''|*[!0-9]*) fail "--keep must be a whole number of at least 1" ;; esac
[ "$keep" -ge 1 ] || fail "--keep must be a whole number of at least 1"
[ -f docker-compose.yml ] || fail "run this from the Cubby checkout, where docker-compose.yml is"

psql_value() {
  docker compose exec -T postgres psql -U cubby_migrator -d cubby -XAt -v ON_ERROR_STOP=1 -c "$1"
}

stamp=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$output_dir"
chmod 700 "$output_dir"
work="$output_dir/.cubby-system-$stamp.partial"
archive="$output_dir/cubby-system-$stamp.tar"
[ ! -e "$work" ] && [ ! -e "$archive" ] || fail "a backup named $stamp already exists; try again in a second"
mkdir "$work"
trap 'rm -rf "$work" "$archive.partial"' EXIT INT TERM

# The database: a consistent snapshot, taken by the database's own superuser inside its container.
docker compose exec -T postgres pg_dump -U cubby_migrator -d cubby --format=custom > "$work/database.dump" \
  || fail "the database could not be dumped; is the postgres service running?"
[ -s "$work/database.dump" ] || fail "the database dump is empty"
docker compose exec -T postgres pg_restore --list < "$work/database.dump" > /dev/null \
  || fail "the database dump does not read back"

# The photos, read inside the app's container as the user that owns them.
if docker compose ps --status running --services 2>/dev/null | grep -qx app; then
  docker compose exec -T app tar -cf - -C /var/lib/cubby/attachments . > "$work/attachments.tar" \
    || fail "the photos could not be read"
else
  docker compose run --rm --no-deps -T --entrypoint tar app -cf - -C /var/lib/cubby/attachments . > "$work/attachments.tar" \
    || fail "the photos could not be read"
fi
tar -tf "$work/attachments.tar" > /dev/null || fail "the photo archive does not read back"

migration=$(psql_value "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name DESC LIMIT 1") \
  || fail "the database version could not be read"
households=$(psql_value 'SELECT count(*) FROM "Household" WHERE "deletedAt" IS NULL') || fail "the households could not be counted"
accounts=$(psql_value 'SELECT count(*) FROM "User"') || fail "the accounts could not be counted"
photos=$(psql_value "SELECT count(*) FROM \"Attachment\" WHERE state <> 'purged'") || fail "the photos could not be counted"
revision=$(git rev-parse --short HEAD 2>/dev/null || printf 'unknown')

{
  printf 'format=cubby-system-backup-1\n'
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
mv "$archive.partial" "$archive"

# Keep the newest --keep archives; only files this script names are ever removed.
ls "$output_dir" | grep -E '^cubby-system-[0-9]{8}T[0-9]{6}Z\.tar$' | sort -r | tail -n +"$((keep + 1))" | while read -r old; do
  rm -f -- "$output_dir/$old"
done

size=$(wc -c < "$archive" | tr -d ' ')
printf 'system_backup_created file=%s bytes=%s households=%s accounts=%s photos=%s\n' "$archive" "$size" "$households" "$accounts" "$photos"
printf 'Copy it off this server: a backup on the same disk goes with the disk.\n'
