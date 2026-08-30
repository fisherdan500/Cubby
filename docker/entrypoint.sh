#!/bin/sh
set -eu

echo "cubby_startup phase=migration status=starting"
if [ -z "${MIGRATION_DATABASE_URL:-}" ] || [ -z "${AUTH_DATABASE_URL:-}" ] || [ -z "${EMAIL_DELIVERY_DATABASE_URL:-}" ] || [ -z "${CUBBY_THROTTLE_KEY:-}" ] || [ -z "${CUBBY_SECURITY_OPERATOR_DB_PASSWORD:-}" ]; then
  echo "cubby_startup phase=migration status=failed" >&2
  exit 1
fi
case "${CUBBY_TRUSTED_PROXY_HOPS:-0}" in 0|1) ;; *) echo "cubby_startup phase=migration status=failed" >&2; exit 1 ;; esac
cubby_throttle_key="$CUBBY_THROTTLE_KEY"
unset CUBBY_THROTTLE_KEY
unset SECURITY_OPERATOR_DATABASE_URL
unset CUBBY_MIGRATOR_DB_PASSWORD CUBBY_RUNTIME_DB_PASSWORD CUBBY_AUTH_DB_PASSWORD CUBBY_EMAIL_DELIVERY_DB_PASSWORD
if ! CUBBY_RUNTIME_DATABASE_URL="$DATABASE_URL" CUBBY_AUTH_DATABASE_URL="$AUTH_DATABASE_URL" CUBBY_EMAIL_DELIVERY_DATABASE_URL="$EMAIL_DELIVERY_DATABASE_URL" DATABASE_URL="$MIGRATION_DATABASE_URL" node provision-security-runtime-role.mjs >/dev/null 2>&1; then
  echo "cubby_startup phase=runtime_role status=failed" >&2
  exit 1
fi
unset CUBBY_SECURITY_OPERATOR_DB_PASSWORD
if ! DATABASE_URL="$MIGRATION_DATABASE_URL" node node_modules/prisma/build/index.js migrate deploy >/dev/null 2>&1; then
  echo "cubby_startup phase=migration status=failed" >&2
  exit 1
fi
if ! DATABASE_URL="$MIGRATION_DATABASE_URL" node provision-fresh-auth-attestation-keys.mjs >/dev/null 2>&1; then
  echo "cubby_startup phase=fresh_auth_attestation_keys status=failed" >&2
  exit 1
fi
if ! DATABASE_URL="$MIGRATION_DATABASE_URL" node provision-email-delivery-keys.mjs >/dev/null 2>&1; then
  echo "cubby_startup phase=email_delivery_keys status=failed" >&2
  exit 1
fi
if ! CUBBY_THROTTLE_KEY="$cubby_throttle_key" DATABASE_URL="$MIGRATION_DATABASE_URL" node provision-global-security-throttle-key.mjs >/dev/null 2>&1; then
  echo "cubby_startup phase=global_security_throttle_key status=failed" >&2
  exit 1
fi
printf '%s\n' 'cubby_startup phase=migration status=succeeded'
echo "cubby_startup phase=server status=starting"
unset MIGRATION_DATABASE_URL
export CUBBY_THROTTLE_KEY="$cubby_throttle_key"
exec node server.js
