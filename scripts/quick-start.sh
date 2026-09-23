#!/bin/sh
# Prepares a fresh Cubby checkout on a Linux Docker host for `docker compose up`: a complete .env
# with a freshly generated value for every secret, the Sprout staging key, and data directories the
# container's unprivileged user can write. Needs only POSIX sh and coreutils, not Node.
#
# It never overwrites an existing .env or key, validates every option before writing anything, and
# prints no secret. Run it once, from the checkout, before the first `docker compose up --build -d`:
#
#   sudo sh scripts/quick-start.sh --url https://cubby.example.com
#
# sudo is needed only to hand the data directories to the container's user (uid 1000); run as that
# user, or pass --data-owner for a different container user, it needs no privileges.
set -eu
umask 077

fail() {
  printf 'cubby_quick_start status=failed reason=%s\n' "$1" >&2
  [ -n "${2:-}" ] && printf '%s\n' "$2" >&2
  exit 1
}

usage() {
  cat <<'USAGE'
Usage: sh scripts/quick-start.sh [options]

  --url URL                   The address people open Cubby at, scheme and host only
                              (default http://localhost:3000). Behind a TLS reverse proxy
                              this is its https:// address.
  --port PORT                 Host port Compose publishes (default: the URL's port, else 3000).
  --timezone ZONE             Household time zone, an IANA name (default America/New_York).
  --trusted-proxy-hops 0|1    1 only when every request reaches Cubby through one reverse proxy
                              that sets X-Forwarded-For (default 0).
  --data-owner UID:GID        Owner of the data directories, the container's user (default 1000:1000).
USAGE
}

url="http://localhost:3000"
port=""
timezone="America/New_York"
proxy_hops="0"
data_owner="1000:1000"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --url) [ "$#" -ge 2 ] || fail missing_value "--url needs a value"; url="$2"; shift 2 ;;
    --port) [ "$#" -ge 2 ] || fail missing_value "--port needs a value"; port="$2"; shift 2 ;;
    --timezone) [ "$#" -ge 2 ] || fail missing_value "--timezone needs a value"; timezone="$2"; shift 2 ;;
    --trusted-proxy-hops) [ "$#" -ge 2 ] || fail missing_value "--trusted-proxy-hops needs a value"; proxy_hops="$2"; shift 2 ;;
    --data-owner) [ "$#" -ge 2 ] || fail missing_value "--data-owner needs a value"; data_owner="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; fail unknown_option "Unknown option: $1" ;;
  esac
done

# An origin only: Better Auth and the trusted-origin check compare scheme, host and port exactly, and
# a browser sends the origin in lower case.
url=$(printf '%s' "$url" | tr 'A-Z' 'a-z')
printf '%s' "$url" | grep -Eq '^https?://[a-z0-9.-]+(:[0-9]{1,5})?$' \
  || fail invalid_url "--url must be a scheme and host, such as https://cubby.example.com, with no path"
if [ -z "$port" ]; then
  # A plain http address is reached directly, so Compose publishes the port the browser will use;
  # an https address is a reverse proxy's, which forwards to Cubby's default port.
  case "$url" in
    http://*:*) port=${url##*:} ;;
    http://*) port=80 ;;
    *) port=3000 ;;
  esac
fi
printf '%s' "$port" | grep -Eq '^[0-9]{1,5}$' && [ "$port" -ge 1 ] && [ "$port" -le 65535 ] \
  || fail invalid_port "--port must be a number from 1 to 65535"
printf '%s' "$timezone" | grep -Eq '^[A-Za-z0-9_+/-]{1,64}$' || fail invalid_timezone "--timezone must be an IANA name, such as Europe/London"
case "$proxy_hops" in 0|1) ;; *) fail invalid_proxy_hops "--trusted-proxy-hops must be 0 or 1" ;; esac
printf '%s' "$data_owner" | grep -Eq '^[0-9]+:[0-9]+$' || fail invalid_data_owner "--data-owner must be numeric UID:GID, such as 1000:1000"

root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
env_file="$root/.env"
data="$root/docker-data"
key_file="$data/secrets/sprout-staging.key"

[ ! -e "$env_file" ] || fail env_exists "$env_file already exists; Cubby's secrets are never regenerated over it."
[ ! -e "$key_file" ] || fail key_exists "$key_file already exists; it is never regenerated."

current_owner="$(id -u):$(id -g)"
if [ "$data_owner" != "$current_owner" ] && [ "$(id -u)" != 0 ]; then
  fail ownership "The data directories must belong to the container's user ($data_owner). Run this with sudo, or pass --data-owner $current_owner if the container runs as you."
fi

hex() { od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n'; }
base64_bytes() { head -c "$1" /dev/urandom | base64 | tr -d '\n'; }
base64url_bytes() { base64_bytes "$1" | tr '+/' '-_' | tr -d '='; }

mkdir -p "$data/backups" "$data/sprout-staging" "$data/secrets"
chmod 700 "$data/backups" "$data/sprout-staging" "$data/secrets"

# Partly written secrets live only inside the git-ignored data directory, and an interrupted run removes
# them and a key it wrote without its .env, so it can simply be run again.
key_tmp="$data/secrets/.sprout-staging.key.tmp.$$"
env_tmp="$data/secrets/.env.tmp.$$"
completed=""
cleanup() {
  status=$?
  rm -f "$key_tmp" "$env_tmp"
  [ -n "$completed" ] || rm -f "$key_file"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
base64_bytes 32 > "$key_tmp"
chmod 400 "$key_tmp"
mv "$key_tmp" "$key_file"

if [ "$data_owner" != "$current_owner" ]; then
  # The container reads the key and writes backups and staged uploads as this user; Linux bind
  # mounts keep the host's owner and mode, so nothing else would let it.
  chown "$data_owner" "$data/backups" "$data/sprout-staging" "$key_file"
  if [ -n "${SUDO_UID:-}" ] && [ -n "${SUDO_GID:-}" ]; then
    # Compose runs as the operator, who must still be able to find the key it hands to Docker.
    chown "$SUDO_UID:$SUDO_GID" "$data" "$data/secrets"
  fi
fi

{
  printf '# Written by scripts/quick-start.sh. It holds every secret this install has: keep it private,\n'
  printf '# back it up with the data, and never regenerate it for an existing install.\n'
  printf 'BETTER_AUTH_URL=%s\n' "$url"
  printf 'TRUSTED_ORIGINS=%s\n' "$url"
  printf 'APP_PORT=%s\n' "$port"
  printf 'APP_TIMEZONE=%s\n' "$timezone"
  printf 'CUBBY_TRUSTED_PROXY_HOPS=%s\n' "$proxy_hops"
  printf 'NODE_ENV=production\n'
  printf 'BETTER_AUTH_SECRET=%s\n' "$(base64url_bytes 48)"
  for name in MIGRATOR RUNTIME AUTH EMAIL_DELIVERY INVITATION_RUNTIME INVITATION_EXPIRY INVITATION_MAINTENANCE SECURITY_OPERATOR; do
    printf 'CUBBY_%s_DB_PASSWORD=%s\n' "$name" "$(hex 32)"
  done
  printf 'CUBBY_THROTTLE_KEY=%s\n' "$(base64url_bytes 32)"
  printf 'CUBBY_FRESH_AUTH_ATTESTATION_KEYRING=1:%s\n' "$(base64url_bytes 32)"
  printf 'CUBBY_FRESH_AUTH_ATTESTATION_ACTIVE_KEY_VERSION=1\n'
  printf 'CUBBY_EMAIL_DELIVERY_KEYRING=1:%s\n' "$(base64url_bytes 32)"
  printf 'CUBBY_EMAIL_DELIVERY_ACTIVE_KEY_VERSION=1\n'
  printf 'CUBBY_BACKUP_HOST_DIR=./docker-data/backups\n'
  printf 'CUBBY_SPROUT_STAGING_HOST_DIR=./docker-data/sprout-staging\n'
  printf 'CUBBY_SPROUT_STAGING_KEY_FILE=./docker-data/secrets/sprout-staging.key\n'
  printf 'SPROUT_STAGING_KEY_VERSION=v1\n'
  printf 'AUTOMATED_BACKUPS_ENABLED=false\n'
  printf 'AUTOMATED_BACKUP_DIRECTORY=/var/lib/cubby/backups\n'
} > "$env_tmp"
chmod 600 "$env_tmp"
if [ -n "${SUDO_UID:-}" ] && [ -n "${SUDO_GID:-}" ]; then chown "$SUDO_UID:$SUDO_GID" "$env_tmp"; fi
mv "$env_tmp" "$env_file"
completed=1

printf 'cubby_quick_start status=ready\n'
printf 'Wrote %s and %s. Next:\n' "$env_file" "$key_file"
printf '  docker compose up --build -d\n'
printf '  docker compose logs app    # the one-time setup code, then open %s/setup\n' "$url"
