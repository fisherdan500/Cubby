#!/bin/sh
# Brings a whole Cubby back on a new server from one scripts/system-backup.sh archive: every
# household, account, entry, post and photo, as it was when the archive was made.
#
# Before running it:
#   1. Install Cubby as usual (the quick start), with this checkout at the same or a newer version
#      than the one the archive came from.
#   2. Put the old server's .env in place of the new one. The restored accounts, sign-ins and queued
#      email depend on the keys in it; Cubby will not start against the restored data without them.
#   3. Leave the new install empty: do not open /setup or create any account.
#
# It refuses to touch an install that already has an account, a household or a photo, and checks the
# archive's checksums and version before it changes anything. Then it replaces the new, empty database
# with the archived one, puts the photos back, starts Cubby, and checks the households, accounts and
# photos match what the archive says it holds.
#
# Usage: sh scripts/system-restore.sh --archive FILE --confirm-empty-install
# See docs/recovery/system-backup.md.
set -eu
umask 077

fail() {
  printf 'system_restore_failed: %s\n' "$1" >&2
  exit 1
}

archive=""
confirmed=false
while [ $# -gt 0 ]; do
  case "$1" in
    --archive) [ $# -ge 2 ] || fail "--archive needs a file"; archive="$2"; shift 2 ;;
    --confirm-empty-install) confirmed=true; shift ;;
    -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
    *) fail "unknown option $1" ;;
  esac
done
[ -n "$archive" ] || fail "name the archive with --archive"
[ -f "$archive" ] || fail "no archive at $archive"
[ "$confirmed" = true ] || fail "this replaces the new install's database; add --confirm-empty-install to go ahead"
[ -f docker-compose.yml ] || fail "run this from the Cubby checkout, where docker-compose.yml is"
[ -f .env ] || fail "put the old server's .env in this checkout first"

psql_value() {
  docker compose exec -T postgres psql -U cubby_migrator -d "${2:-cubby}" -XAt -v ON_ERROR_STOP=1 -c "$1"
}
manifest_value() {
  sed -n "s/^$1=//p" "$work/manifest.txt"
}

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT INT TERM

# The archive: exactly the four files a backup writes, each matching its checksum.
names=$(tar -tf "$archive" 2>/dev/null | sort | tr '\n' ' ') || fail "the archive does not open"
[ "$names" = "attachments.tar checksums.sha256 database.dump manifest.txt " ] || fail "this is not a Cubby system backup"
tar -xf "$archive" -C "$work" || fail "the archive does not unpack"
[ "$(manifest_value format)" = "cubby-system-backup-1" ] || fail "this archive's format is not one this version reads"
(cd "$work" && sha256sum -c --quiet checksums.sha256) || fail "the archive is damaged: a checksum does not match"
tar -tf "$work/attachments.tar" > /dev/null || fail "the photo archive is damaged"

# The code must know every change the archived database has had; an older checkout would not.
migration=$(manifest_value migration)
[ -n "$migration" ] && [ -d "prisma/migrations/$migration" ] \
  || fail "the archive comes from a newer Cubby ($migration); update this checkout first"

# A fresh install creates its database users and tables on first start; the restore needs both.
docker compose up -d --wait postgres app || fail "Cubby did not start; finish the install first"

households=$(psql_value 'SELECT count(*) FROM "Household"') || fail "the new install could not be read"
accounts=$(psql_value 'SELECT count(*) FROM "User"') || fail "the new install could not be read"
[ "$households" = 0 ] && [ "$accounts" = 0 ] \
  || fail "this install already has accounts or households; restore only into a new, empty install"
# Files only: Cubby makes its empty photo folders on every start.
stored=$(docker compose exec -T app sh -c 'find /var/lib/cubby/attachments -type f -print | head -n 1') \
  || fail "the photo directory could not be read"
[ -z "$stored" ] || fail "this install already has photos; restore only into a new, empty install"

printf 'system_restore_step: replacing the empty database\n'
docker compose stop app > /dev/null || fail "Cubby could not be stopped"
psql_value 'DROP DATABASE cubby' postgres > /dev/null || fail "the empty database could not be removed"
docker compose exec -T postgres createdb -U cubby_migrator -T template0 cubby || fail "the database could not be recreated"
docker compose exec -T postgres pg_restore -U cubby_migrator -d cubby --exit-on-error --single-transaction < "$work/database.dump" \
  || fail "the database could not be restored; the install is now empty, and nothing else was changed"

printf 'system_restore_step: putting the photos back\n'
docker compose run --rm --no-deps -T --entrypoint tar app -xf - -C /var/lib/cubby/attachments < "$work/attachments.tar" \
  || fail "the photos could not be put back"

printf 'system_restore_step: starting Cubby\n'
docker compose up -d --wait app || fail "Cubby did not start on the restored data; is the old server's .env in place?"

households=$(psql_value 'SELECT count(*) FROM "Household" WHERE "deletedAt" IS NULL')
accounts=$(psql_value 'SELECT count(*) FROM "User"')
photos=$(psql_value "SELECT count(*) FROM \"Attachment\" WHERE state <> 'purged'")
[ "$households" = "$(manifest_value households)" ] && [ "$accounts" = "$(manifest_value accounts)" ] && [ "$photos" = "$(manifest_value photos)" ] \
  || fail "the restored counts differ from the archive (households=$households accounts=$accounts photos=$photos)"

printf 'system_restore_complete households=%s accounts=%s photos=%s from=%s\n' "$households" "$accounts" "$photos" "$(manifest_value created)"
printf 'Sign in as before. Turn automated backups back on once you have checked everything is there.\n'
