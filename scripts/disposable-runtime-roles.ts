// Several migrations grant execute on their SECURITY DEFINER functions to the production role names
// without first checking that the role exists, so `prisma migrate deploy` cannot complete against a
// database that has never been provisioned. A real deployment provisions these roles through the app
// image's entrypoint before migrating; a rehearsal that boots a bare postgres has to do the same.
//
// These are bare NOLOGIN roles: they exist so the grants resolve, and nothing connects as them. A
// rehearsal that needs a real restricted runtime role provisions it properly instead.

export const DISPOSABLE_RUNTIME_ROLES = [
  "cubby_runtime",
  "cubby_auth",
  "cubby_email_delivery",
  "cubby_invitation_runtime",
  "cubby_invitation_expiry_worker",
  "cubby_invitation_maintenance_worker",
  "cubby_security_operator"
] as const;

export const CREATE_DISPOSABLE_RUNTIME_ROLES_SQL = `DO $$
DECLARE role_name TEXT;
BEGIN
  FOREACH role_name IN ARRAY ARRAY[${DISPOSABLE_RUNTIME_ROLES.map((role) => `'${role}'`).join(",")}] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN', role_name);
    END IF;
  END LOOP;
END $$;`;

/** `psql` arguments that create the roles inside the rehearsal's own postgres container. */
export function createDisposableRuntimeRolesArgs(user: string, database: string) {
  return [
    "psql",
    "--username",
    user,
    "--dbname",
    database,
    "--set",
    "ON_ERROR_STOP=1",
    "--command",
    CREATE_DISPOSABLE_RUNTIME_ROLES_SQL
  ];
}
