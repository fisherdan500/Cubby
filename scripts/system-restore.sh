#!/bin/sh
# Brings a whole Cubby back on a new server from one scripts/system-backup.sh archive: every
# household, account, entry, post and photo, as it was when the archive was made.
#
# Before running it:
#   1. Install Cubby as usual (the quick start), with this checkout at the same or a newer version
#      than the one the archive came from.
#   2. Put the old server's .env in place of the new one if you still have it. Keeping it preserves
#      the invitation setup receipts; without it the restore adopts this install's own keys and
#      drops those receipts, reporting exactly how many. Everything else restores either way.
#   3. Leave the new install empty: do not open /setup or create any account.
#
# It refuses to touch an install that already has an account, a household or a photo, and checks the
# archive's checksums and version before it changes anything. Then it replaces the new, empty database
# with the archived one, puts the photos back, starts Cubby, and checks the households, accounts and
# photos match what the archive says it holds.
#
# Usage: sh scripts/system-restore.sh --archive FILE --confirm-empty-install --maintenance
# See docs/recovery/system-backup.md.
set -eu
umask 077

fail() {
  printf 'system_restore_failed: %s\n' "$1" >&2
  exit 1
}

archive=""
confirmed=false
maintenance=false
while [ $# -gt 0 ]; do
  case "$1" in
    --maintenance) maintenance=true; shift ;;
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

[ "$maintenance" = true ] || fail "restore requires downtime; add --maintenance after excluding external writers"
command -v node > /dev/null || fail "Node.js 22 or newer is required on the host"
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' || fail "Node.js 22 or newer is required on the host"
. ./scripts/system-maintenance.sh
maintenance_acquire

psql_value() {
  docker compose exec -T postgres psql -U cubby_migrator -d "${2:-cubby}" -XAt -v ON_ERROR_STOP=1 -c "$1"
}
manifest_value() {
  sed -n "s/^$1=//p" "$work/manifest.txt"
}

work=$(private_scratch_dir) || fail "the private work directory could not be created"
# A private copy fixes the bytes used for validation/extraction against source-file replacement.
# The operator must provide an immutable, trusted archive and adequate private scratch space.
node scripts/system-archive.mjs size "$archive" prisma/migrations || fail "invalid archive size or type"
cp -- "$archive" "$work/input.tar" || fail "the archive could not be staged"
node scripts/system-archive.mjs prepare "$work/input.tar" prisma/migrations "$work" \
  || fail "archive validation failed; no database or attachment destination was changed"

# A fresh install creates its database users and tables on first start; the restore needs both.
docker compose up -d --wait postgres app > /dev/null || {
  docker compose stop app > /dev/null 2>&1 || :
  fail "Cubby did not start; finish the install first; app restart was not attempted"
}
maintenance_stop
# This is the authoritative empty check, after all supported writers have exited.

households=$(psql_value 'SELECT count(*) FROM "Household"') || fail "the new install could not be read"
accounts=$(psql_value 'SELECT count(*) FROM "User"') || fail "the new install could not be read"
[ "$households" = 0 ] && [ "$accounts" = 0 ] \
  || fail "this install already has accounts or households; restore only into a new, empty install"
# Files only: Cubby makes its empty photo folders on every start.
stored=$(docker compose run --rm --no-deps -T --entrypoint sh app -c 'find /var/lib/cubby/attachments ! -type d -print -quit') \
  || fail "the photo directory could not be read"
[ -z "$stored" ] || fail "this install already has photos; restore only into a new, empty install"

printf 'system_restore_step: replacing the empty database\n'
psql_value 'DROP DATABASE cubby' postgres > /dev/null || fail "the empty database could not be removed"
docker compose exec -T postgres createdb -U cubby_migrator -T template0 cubby || fail "the database could not be recreated"
docker compose exec -T postgres pg_restore -U cubby_migrator -d cubby --exit-on-error --single-transaction < "$work/database.dump" \
  || fail "the database restore failed; the target may be partial and the app remains stopped; do not retry on this target"

printf 'system_restore_step: putting the photos back\n'
docker compose run --rm --no-deps -T --entrypoint tar app --no-same-owner --no-same-permissions -xf - -C /var/lib/cubby/attachments < "$work/attachments.tar" \
  || fail "the photos could not be put back"

# The archive carries the old server's attestation keys; a NEW .env mints different ones under the
# same version numbers. Startup refuses to replace a key that issued rows were created against, and
# a RESTRICT foreign key from the setup receipts enforces that refusal in PostgreSQL rather than in
# policy - so an install restored with a new .env would restart-loop with every byte of household
# data intact but unreachable.
#
# Only act when the keys genuinely differ. Reusing the original .env is the supported path and must
# lose nothing: the versions match, the material matches, and this block does not run.
#
# When they do differ, the receipts cannot be carried over. Each records that one invitation setup
# was genuine, signed by a key that died with the old machine; nothing re-signs them and nothing
# still live reads them. Dropping them lets this install adopt its own keys. Households, accounts,
# memberships and invitations are untouched.
env_keyring=$(sed -n 's/^CUBBY_FRESH_AUTH_ATTESTATION_KEYRING=//p' .env | tr -d '"' | tr -d "'" | head -1)
archive_keyring=$(psql_value "SELECT string_agg(\"keyVersion\" || ':' || translate(encode(\"verificationKey\",'base64'),'+/=','-_'), ',' ORDER BY \"keyVersion\") FROM \"FreshAuthAttestationKey\"")
if [ -n "$env_keyring" ] && [ -n "$archive_keyring" ] && [ "$env_keyring" != "$archive_keyring" ]; then
  receipts=$(psql_value 'SELECT count(*) FROM invitation_protocol."InvitationSetupCorridorAttestationReceipt"')
  archive_keys=$(psql_value 'SELECT count(*) FROM "FreshAuthAttestationKey"')
  printf 'system_restore_step: this .env is not the one that made the archive; adopting its keys\n'
  psql_value 'DELETE FROM invitation_protocol."InvitationSetupCorridorAttestationReceipt"' > /dev/null \
    || fail "the restored setup receipts could not be cleared, so this install cannot adopt its own keys"
  psql_value 'DELETE FROM "FreshAuthAttestationKey"' > /dev/null \
    || fail "the old attestation keys could not be cleared, so this install cannot adopt its own keys"
  printf 'system_restore_keys_adopted receipts_dropped=%s old_keys_dropped=%s\n' "$receipts" "$archive_keys"
  printf 'Setup receipts from the old server were dropped; they could not be verified here. Nothing else changed.\n'

  # The same collision stops the next startup phase: the restored EmailDeliveryEncryptionKey rows
  # hold digests this .env cannot reproduce, and the provisioner refuses to replace a key that
  # queued mail was encrypted under.
  #
  # Mail still waiting to go out is the one thing here that is not merely history. Its body cannot
  # be decrypted without the dead machine's key, so it can never be sent from this install - but it
  # must not vanish silently either. Fail loudly instead, and let the operator decide, unless the
  # queue is empty.
  pending=$(psql_value "SELECT (SELECT count(*) FROM \"EmailChangeDelivery\" WHERE \"state\" IN ('queued','dispatching','retryable_failed')) + (SELECT count(*) FROM \"InvitationEmailDelivery\" WHERE \"state\" IN ('queued','dispatching','retryable_failed'))")
  if [ "${pending:-0}" -gt 0 ]; then
    fail "the archive holds $pending unsent email(s) encrypted with the old server's key, which this install cannot read or send; restore with the original .env, or clear those queues on the old server first"
  fi
  email_keys=$(psql_value 'SELECT count(*) FROM "EmailDeliveryEncryptionKey"')
  if [ "${email_keys:-0}" -gt 0 ]; then
    # A constraint trigger requires exactly one active key AT COMMIT, so emptying the table can
    # never commit on its own - startup is what puts this install's key back, one phase later.
    # Disable that single guard for the delete and re-enable it in the same implicit transaction,
    # so a failure anywhere rolls back the disable too and never leaves the table unguarded.
    #
    # The other trigger stays on: EmailDeliveryEncryptionKey_ciphertext_reference_guard refuses to
    # drop a key that queued mail still references. The explicit check above gives the operator a
    # better message, and this remains the backstop if it is ever wrong.
    psql_value 'ALTER TABLE "EmailDeliveryEncryptionKey" DISABLE TRIGGER "EmailDeliveryEncryptionKey_exactly_one_active_guard"; DELETE FROM "EmailDeliveryEncryptionKey"; ALTER TABLE "EmailDeliveryEncryptionKey" ENABLE TRIGGER "EmailDeliveryEncryptionKey_exactly_one_active_guard"' > /dev/null \
      || fail "the old email delivery keys could not be cleared, so this install cannot adopt its own keys"
    printf 'system_restore_email_keys_adopted old_keys_dropped=%s pending_mail=0\n' "$email_keys"
  fi

  # Third and last of the key phases. The throttle key is a single row that only rate limiting reads;
  # nothing references it and startup recreates it from this .env on the next boot.
  throttle_keys=$(psql_value 'SELECT count(*) FROM "GlobalSecurityThrottleKey"')
  if [ "${throttle_keys:-0}" -gt 0 ]; then
    psql_value 'DELETE FROM "GlobalSecurityThrottleKey"' > /dev/null \
      || fail "the old throttle key could not be cleared, so this install cannot adopt its own keys"
    printf 'system_restore_throttle_key_adopted old_keys_dropped=%s\n' "$throttle_keys"
  fi
fi

households=$(psql_value 'SELECT count(*) FROM "Household" WHERE "deletedAt" IS NULL')
accounts=$(psql_value 'SELECT count(*) FROM "User"')
photos=$(psql_value "SELECT count(*) FROM \"Attachment\" WHERE state <> 'purged'")
[ "$households" = "$(manifest_value households)" ] && [ "$accounts" = "$(manifest_value accounts)" ] && [ "$photos" = "$(manifest_value photos)" ] \
  || fail "the restored counts differ from the archive (households=$households accounts=$accounts photos=$photos)"

# Verify while still quiescent; startup retention/migrations must not race the counts.
printf 'system_restore_step: starting Cubby\n'
maintenance_was_running=true
maintenance_resume
printf 'system_restore_complete households=%s accounts=%s photos=%s from=%s\n' "$households" "$accounts" "$photos" "$(manifest_value created)"
printf 'Sign in as before. Turn automated backups back on once you have checked everything is there.\n'
