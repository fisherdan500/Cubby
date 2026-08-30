#!/bin/sh
set -eu

# Runtime-role provisioning is intentionally performed by the app entrypoint
# through MIGRATION_DATABASE_URL for both fresh and existing PostgreSQL volumes.
# This compatibility placeholder is not mounted into docker-entrypoint-initdb.d.
exit 0
