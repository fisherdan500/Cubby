# Always-On Updates And Migration Recovery

This runbook is the operator procedure for updating a household Cubby Docker
Compose deployment while preserving PostgreSQL data, local backup files, and a
clear recovery boundary. It is intentionally specific to the repository's
`app` and `postgres` services; it is not a general deployment platform.

## Safety Boundary

An update is not zero-downtime. The objective is a short, controlled outage with
fail-closed startup and verified recovery artifacts.

- `docker/entrypoint.sh` runs `prisma migrate deploy` before starting Next.js.
  A failed migration exits the container and the server never starts.
- `/api/health` returns `200 {"status":"ready"}` only after a database query
  succeeds. Database failure returns a sanitized `503` response.
- Compose considers `postgres` healthy only after `pg_isready`, starts `app`
  only after that dependency is healthy, and considers `app` healthy only after
  the readiness endpoint succeeds from inside the container.
- Startup logs expose phase markers only:
  `cubby_startup phase=migration status=starting|succeeded|failed` and
  `cubby_startup phase=server status=starting`.
- Cubby version 2 JSON backups are logical household snapshots. They are not
  PostgreSQL physical backups and cannot generically reverse a schema migration.

Do not use an old application image against a database after an incompatible
migration. Prefer a forward correction. If the database and old image are no
longer compatible, stop and use a separately prepared database restore/recovery
procedure instead of improvising a down migration.

## Before The Maintenance Window

1. Review every migration added since the deployed revision. Confirm that the
   current image can migrate the deployed schema forward and decide whether an
   old image would remain compatible afterward.
2. Confirm the normal stack is currently healthy and that household workflows
   are functioning. Do not continue from an already-degraded state.
3. Notify household users of the maintenance window and coordinate final timer
   shutdown.
4. Finish or stop every running or paused timer as the final permitted household
   writes.
5. Block household writes immediately after timer shutdown and keep them blocked
   until post-update verification completes.
6. Create the final Cubby version 2 JSON backup after the write freeze begins.
   Preserve its immutable file and checksum outside the container lifecycle.
7. Confirm that the PostgreSQL named volume and app backup bind mount are the
   expected persistent mounts. Never replace either with an anonymous volume.
8. Confirm sufficient free space for migration work, container/image updates,
   PostgreSQL data, and retained backup versions.
9. Record the deployed revision/image, intended revision/image, maintenance
   start time, and the chosen recovery artifact. Record configuration names, not
   secret values.

## Fail-Closed Preflight

From the repository root, run the non-mutating preflight with the selected
backup file:

```bash
npm run verify:update-preflight -- --backup-file /private/path/to/cubby-backup.json
```

The verifier executes read-only Docker/Compose inspection and health commands.
It does not run migrations, restart services, recreate containers, write the
database, or print environment values. It exits nonzero unless every marker is
`PASS`:

- `backup-argument`
- `backup-v2-checksum-freshness`
- `compose-config`
- `app-running-healthy`
- `postgres-running-healthy`
- `api-health-ready`
- `required-environment-names`
- `app-backup-persistent-mount`
- `postgres-data-persistent-mount`
- `backup-filesystem-free-space`
- `database-filesystem-free-space`
- `preflight-summary`

The backup must be a valid checksummed version 2 snapshot exported no more than
24 hours ago. The minimum free-space checks are 100 MiB on the backup filesystem
and 1 GiB on the PostgreSQL data filesystem. These are hard safety floors, not
capacity-planning targets.

Service discovery accepts both the JSON-array output used by earlier Docker
Compose releases and the newline-delimited JSON objects emitted by Docker Compose
5.2. The same exact app/PostgreSQL shape and health checks apply to both formats.
Blank, malformed, mixed, missing, extra, or unhealthy service records fail closed.

Treat timeout, malformed output, missing metadata, an unexpected container
state, or any `FAIL` marker as a stop condition. Correct the cause and rerun the
entire preflight; do not bypass a check.

## Update Procedure

After preflight succeeds and the write freeze is in effect:

1. Fetch or build only the intended reviewed revision/image.
2. Reconfirm the exact revision and review `docker compose config` without
   copying its environment expansion into tickets or chat.
3. Recreate the stack with the normal Compose project. Do not delete named
   volumes and do not use `down --volumes`:

   ```bash
   docker compose up --build -d
   ```

4. Follow sanitized startup logs:

   ```bash
   docker compose logs --tail 300 -f app
   ```

5. Require migration `starting` then `succeeded`, followed by server `starting`.
   If migration reports `failed`, stop. The server must not start.
6. Wait for both services to report healthy:

   ```bash
   docker compose ps
   ```

7. Confirm meaningful application readiness:

   ```bash
   docker compose exec -T app node -e "fetch('http://127.0.0.1:3000/api/health').then(async r => { console.log(r.status, await r.text()); process.exit(r.ok ? 0 : 1) })"
   ```

Expected body: `{"status":"ready"}`. PostgreSQL liveness alone is not
application readiness.

## Post-Update Verification

Keep household writes blocked until all checks pass:

1. Sign in through the configured household URL.
2. Open the dashboard and confirm the expected household and baby are visible.
3. Confirm recent historical activity is readable.
4. Confirm running/paused timer state and timestamps are unchanged from the
   pre-update record. Do not mutate timers merely to test the update.
5. Open Settings > Backups and confirm healthy local versions are discovered.
6. Download the selected local version and verify that the response is a valid
   immutable backup file.
7. Recheck `/api/health`, `docker compose ps`, and app logs for migration,
   database, auth, or background-worker errors.
8. Record the migrated revision/image and verification result, then release the
   write freeze.

A separately authorized smoke write may be performed only after read-only
verification succeeds and a fresh recovery artifact remains available.

## Failure Handling

### Migration fails before the server starts

Leave the failed app container stopped and preserve logs, the PostgreSQL volume,
and backup directory. Do not repeatedly rerun a partially understood migration.
Determine whether the migration is safely rerunnable and prepare a forward fix.
If forward correction cannot preserve compatibility, use a separately designed
database restore/recovery procedure. Do not start an older image merely because
it is available.

### Migration succeeds but readiness fails

Treat the deployment as unavailable. Inspect sanitized app/PostgreSQL logs and
verify database connectivity, expected migration state, environment-name
presence, mount identity, and resource capacity. Prefer a forward application or
configuration correction when the migrated schema is valid.

### Application regression after readiness

Keep writes blocked. If the schema remains compatible with the prior image, an
image rollback may be considered only after that compatibility is explicitly
verified. Otherwise forward-fix or restore a database artifact captured for that
purpose. A Cubby JSON household backup can recover included household data into
a fresh target; it does not restore auth/session state or reverse the database
schema.

### Host or database loss

Preserve the local backup directory before rebuilding. Follow
[Backup Recovery](BACKUP_RECOVERY.md). Recovery is download-then-upload into a
fresh owner household and requires recreation of excluded operational state.

## Rehearsal Before A Real Update

The repository provides a disposable rehearsal:

```bash
npm run verify:update-rehearsal
```

It starts a unique loopback-only Compose project with generated credentials,
applies migrations only through fixed baseline
`20260714220000_reversible_baby_inactivity`, seeds representative auth,
household, activity, running/paused timer, and stopped-play data, then runs the
current migration chain. It verifies authentication, data/timer preservation,
local backup discovery/download, container replacement persistence, and a
representative migration failure that never starts the server or becomes
healthy. Cleanup is project-scoped and runs in `finally`.

This command intentionally executes Docker and must be authorized separately
from code implementation or static/unit verification. It never loads `.env` and
must never target the normal Compose project.

### Consequential activity-mutation changes

Activity receipt/replay changes additionally require this separately gated
disposable PostgreSQL contract before publication:

```bash
npm run verify:activity-update-safety
```

It applies the complete candidate migration chain to a generated-credential,
loopback-only database and exercises real activity services. It covers receipt
immutability, exact replay, transaction-time authorization, race/conflict
handling, and audit/webhook durability. It neither starts the app nor reads
`.env`, sends webhook requests, or targets the normal Compose project.
