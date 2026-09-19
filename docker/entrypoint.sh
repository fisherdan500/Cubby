#!/bin/sh
set -eu

startup_status_file="${CUBBY_STARTUP_STATUS_FILE:-}"
case "$startup_status_file" in
  ""|"/run/cubby-acceptance-status/startup") ;;
  *) echo "cubby_startup phase=configuration status=failed" >&2; exit 1 ;;
esac

instrumentation_stage_file="${CUBBY_P13_ACCEPTANCE_INSTRUMENTATION_STAGE_FILE:-}"
case "$instrumentation_stage_file" in
  ""|"/run/cubby-acceptance-status/instrumentation-stage") ;;
  *) echo "cubby_startup phase=configuration status=failed" >&2; exit 1 ;;
esac
if [ -n "$instrumentation_stage_file" ]; then
  if node /app/scripts/p1-3-node-builtin-probe.mjs >/dev/null 2>&1; then
    (umask 077; printf 'node_builtin_ready\n' > "$instrumentation_stage_file") 2>/dev/null || true
  fi
fi

write_startup_status() {
  phase="$1"
  status="$2"
  printf 'cubby_startup phase=%s status=%s\n' "$phase" "$status"
  if [ -n "$startup_status_file" ]; then
    (umask 077; printf '%s|%s\n' "$phase" "$status" > "$startup_status_file") 2>/dev/null || true
  fi
}

write_startup_status readiness_guard starting
if ! node /app/scripts/household-deletion-readiness-guard.mjs; then
  write_startup_status readiness_guard failed
  exit 1
fi
write_startup_status migration starting
if [ -z "${MIGRATION_DATABASE_URL:-}" ] || [ -z "${AUTH_DATABASE_URL:-}" ] || [ -z "${EMAIL_DELIVERY_DATABASE_URL:-}" ] || [ -z "${INVITATION_DATABASE_URL:-}" ] || [ -z "${INVITATION_EXPIRY_DATABASE_URL:-}" ] || [ -z "${INVITATION_MAINTENANCE_DATABASE_URL:-}" ] || [ -z "${CUBBY_INVITATION_RUNTIME_DB_PASSWORD:-}" ] || [ -z "${CUBBY_INVITATION_EXPIRY_DB_PASSWORD:-}" ] || [ -z "${CUBBY_INVITATION_MAINTENANCE_DB_PASSWORD:-}" ] || [ -z "${CUBBY_THROTTLE_KEY:-}" ] || [ -z "${CUBBY_SECURITY_OPERATOR_DB_PASSWORD:-}" ]; then
  write_startup_status configuration failed >&2
  exit 1
fi
case "${CUBBY_TRUSTED_PROXY_HOPS:-0}" in 0|1) ;; *) write_startup_status configuration failed >&2; exit 1 ;; esac
cubby_throttle_key="$CUBBY_THROTTLE_KEY"
unset CUBBY_THROTTLE_KEY
unset SECURITY_OPERATOR_DATABASE_URL
unset CUBBY_MIGRATOR_DB_PASSWORD CUBBY_RUNTIME_DB_PASSWORD CUBBY_AUTH_DB_PASSWORD CUBBY_EMAIL_DELIVERY_DB_PASSWORD
if ! CUBBY_RUNTIME_DATABASE_URL="$DATABASE_URL" CUBBY_AUTH_DATABASE_URL="$AUTH_DATABASE_URL" CUBBY_EMAIL_DELIVERY_DATABASE_URL="$EMAIL_DELIVERY_DATABASE_URL" DATABASE_URL="$MIGRATION_DATABASE_URL" node provision-security-runtime-role.mjs >/dev/null 2>&1; then
  write_startup_status runtime_role failed >&2
  exit 1
fi
if ! DATABASE_URL="$MIGRATION_DATABASE_URL" node provision-invitation-runtime-roles.mjs >/dev/null 2>&1; then
  write_startup_status invitation_runtime_roles failed >&2
  exit 1
fi
unset CUBBY_INVITATION_RUNTIME_DB_PASSWORD CUBBY_INVITATION_EXPIRY_DB_PASSWORD CUBBY_INVITATION_MAINTENANCE_DB_PASSWORD
unset CUBBY_SECURITY_OPERATOR_DB_PASSWORD
if ! CUBBY_RUNTIME_DATABASE_URL="$DATABASE_URL" DATABASE_URL="$MIGRATION_DATABASE_URL" node provision-database-timezone.mjs >/dev/null 2>&1; then
  write_startup_status database_timezone failed >&2
  exit 1
fi
if ! printf 'SELECT 1;' | DATABASE_URL="$MIGRATION_DATABASE_URL" node node_modules/prisma/build/index.js db execute --stdin --schema prisma/schema.prisma >/dev/null 2>&1; then
  write_startup_status migration_connection failed >&2
  exit 1
fi
if ! DATABASE_URL="$MIGRATION_DATABASE_URL" node node_modules/prisma/build/index.js migrate deploy >/dev/null 2>&1; then
  write_startup_status migration_apply failed >&2
  exit 1
fi
if ! DATABASE_URL="$MIGRATION_DATABASE_URL" node provision-fresh-auth-attestation-keys.mjs >/dev/null 2>&1; then
  write_startup_status fresh_auth_attestation_keys failed >&2
  exit 1
fi
if ! DATABASE_URL="$MIGRATION_DATABASE_URL" node provision-email-delivery-keys.mjs >/dev/null 2>&1; then
  write_startup_status email_delivery_keys failed >&2
  exit 1
fi
if ! CUBBY_THROTTLE_KEY="$cubby_throttle_key" DATABASE_URL="$MIGRATION_DATABASE_URL" node provision-global-security-throttle-key.mjs >/dev/null 2>&1; then
  write_startup_status global_security_throttle_key failed >&2
  exit 1
fi
# Unlike the steps above, this one's stdout is kept: while no platform owner exists it prints the
# one-time setup code the operator needs from the container log. It writes only fixed text there;
# stderr, where a driver error could carry connection details, is still discarded.
if ! DATABASE_URL="$MIGRATION_DATABASE_URL" node provision-platform-setup-code.mjs 2>/dev/null; then
  write_startup_status platform_setup_code failed >&2
  exit 1
fi
write_startup_status migration succeeded
write_startup_status server starting
unset MIGRATION_DATABASE_URL
export CUBBY_THROTTLE_KEY="$cubby_throttle_key"
if [ -n "$instrumentation_stage_file" ]; then
  (umask 077; printf 'bootstrap_exec_selected\n' > "$instrumentation_stage_file") 2>/dev/null || true
  exec node --require /app/scripts/p1-3-standalone-bootstrap-probe.cjs server.js
fi
exec node server.js
