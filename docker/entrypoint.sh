#!/bin/sh
set -eu

echo "cubby_startup phase=migration status=starting"
if ! node node_modules/prisma/build/index.js migrate deploy >/dev/null 2>&1; then
  echo "cubby_startup phase=migration status=failed" >&2
  exit 1
fi
printf '%s\n' 'cubby_startup phase=migration status=succeeded'
echo "cubby_startup phase=server status=starting"
exec node server.js
