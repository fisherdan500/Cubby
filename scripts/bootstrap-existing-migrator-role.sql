\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
  target_migrations CONSTANT TEXT[] := ARRAY[
    '20260824140000_global_security_foundation',
    '20260829120000_global_security_throttle_core',
    '20260829170000_global_security_phase8_carriers',
    '20260829190000_global_security_private_history_reader',
    '20260829200000_global_security_operator_aggregate',
    '20260829210000_global_security_phase8_review_remediation'
  ];
BEGIN
  IF current_user <> 'cubby' OR NOT (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) THEN
    RAISE EXCEPTION 'legacy_migrator_bootstrap_authority_invalid';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='cubby_migrator') THEN
    RAISE EXCEPTION 'legacy_migrator_bootstrap_unexpected_existing_role';
  END IF;
  IF to_regclass('public."_prisma_migrations"') IS NULL
    OR (SELECT COUNT(*) FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL) <> 41 THEN
    RAISE EXCEPTION 'legacy_migrator_bootstrap_baseline_invalid';
  END IF;
  IF EXISTS (SELECT 1 FROM "_prisma_migrations" WHERE "migration_name"=ANY(target_migrations)) THEN
    RAISE EXCEPTION 'legacy_migrator_bootstrap_target_migration_present';
  END IF;
  IF coalesce(current_setting('cubby.bootstrap_migrator_password',true),'') !~ '^[A-Za-z0-9_-]{32,128}$' THEN
    RAISE EXCEPTION 'legacy_migrator_bootstrap_password_missing';
  END IF;
END $$;

SELECT format(
  'CREATE ROLE cubby_migrator LOGIN SUPERUSER CREATEDB CREATEROLE INHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT -1 VALID UNTIL %L PASSWORD %L',
  'infinity',
  current_setting('cubby.bootstrap_migrator_password',true)
) \gexec

ALTER DATABASE cubby OWNER TO cubby_migrator;
ALTER SCHEMA public OWNER TO cubby_migrator;

SELECT CASE relation.relkind
  WHEN 'S' THEN format('ALTER SEQUENCE %I.%I OWNER TO cubby_migrator', relation.schema_name, relation.object_name)
  WHEN 'v' THEN format('ALTER VIEW %I.%I OWNER TO cubby_migrator', relation.schema_name, relation.object_name)
  WHEN 'm' THEN format('ALTER MATERIALIZED VIEW %I.%I OWNER TO cubby_migrator', relation.schema_name, relation.object_name)
  WHEN 'f' THEN format('ALTER FOREIGN TABLE %I.%I OWNER TO cubby_migrator', relation.schema_name, relation.object_name)
  ELSE format('ALTER TABLE %I.%I OWNER TO cubby_migrator', relation.schema_name, relation.object_name)
END
FROM (
  SELECT namespace.nspname AS schema_name, class.relname AS object_name, class.relkind
  FROM pg_class class
  JOIN pg_namespace namespace ON namespace.oid=class.relnamespace
  WHERE namespace.nspname='public'
    AND class.relowner='cubby'::regrole
    AND class.relkind IN ('r','p','S','v','m','f')
    AND NOT EXISTS (
      SELECT 1 FROM pg_depend dependency
      WHERE dependency.classid='pg_class'::regclass
        AND dependency.objid=class.oid
        AND dependency.deptype='e'
    )
  ORDER BY class.relkind,class.relname
) relation
\gexec

SELECT format('ALTER ROUTINE %s OWNER TO cubby_migrator', routine.oid::regprocedure)
FROM pg_proc routine
JOIN pg_namespace namespace ON namespace.oid=routine.pronamespace
WHERE namespace.nspname='public'
  AND routine.proowner='cubby'::regrole
  AND NOT EXISTS (
    SELECT 1 FROM pg_depend dependency
    WHERE dependency.classid='pg_proc'::regclass
      AND dependency.objid=routine.oid
      AND dependency.deptype='e'
  )
ORDER BY routine.proname,routine.oid
\gexec

SELECT format('ALTER TYPE public.%I OWNER TO cubby_migrator', type_row.typname)
FROM pg_type type_row
JOIN pg_namespace namespace ON namespace.oid=type_row.typnamespace
WHERE namespace.nspname='public'
  AND type_row.typowner='cubby'::regrole
  AND type_row.typtype IN ('e','d')
  AND type_row.typrelid=0
  AND NOT EXISTS (
    SELECT 1 FROM pg_depend dependency
    WHERE dependency.classid='pg_type'::regclass
      AND dependency.objid=type_row.oid
      AND dependency.deptype='e'
  )
ORDER BY type_row.typname
\gexec

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_database WHERE datname='cubby' AND datdba='cubby_migrator'::regrole)
    OR NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname='public' AND nspowner='cubby_migrator'::regrole)
    OR EXISTS (
      SELECT 1 FROM pg_class class
      JOIN pg_namespace namespace ON namespace.oid=class.relnamespace
      WHERE namespace.nspname='public'
        AND class.relowner='cubby'::regrole
        AND class.relkind IN ('r','p','S','v','m','f')
        AND NOT EXISTS (SELECT 1 FROM pg_depend dependency WHERE dependency.classid='pg_class'::regclass AND dependency.objid=class.oid AND dependency.deptype='e')
    )
    OR EXISTS (
      SELECT 1 FROM pg_proc routine
      JOIN pg_namespace namespace ON namespace.oid=routine.pronamespace
      WHERE namespace.nspname='public'
        AND routine.proowner='cubby'::regrole
        AND NOT EXISTS (SELECT 1 FROM pg_depend dependency WHERE dependency.classid='pg_proc'::regclass AND dependency.objid=routine.oid AND dependency.deptype='e')
    )
    OR EXISTS (
      SELECT 1 FROM pg_type type_row
      JOIN pg_namespace namespace ON namespace.oid=type_row.typnamespace
      WHERE namespace.nspname='public'
        AND type_row.typowner='cubby'::regrole
        AND type_row.typtype IN ('e','d')
        AND type_row.typrelid=0
        AND NOT EXISTS (SELECT 1 FROM pg_depend dependency WHERE dependency.classid='pg_type'::regclass AND dependency.objid=type_row.oid AND dependency.deptype='e')
    ) THEN
    RAISE EXCEPTION 'legacy_migrator_bootstrap_verification_failed';
  END IF;
END $$;

SET ROLE cubby_migrator;
-- PostgreSQL requires the original bootstrap role to retain SUPERUSER. Remove
-- login and every non-bootstrap capability while retaining extension ownership.
ALTER ROLE cubby NOLOGIN SUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
RESET ROLE;

COMMIT;
