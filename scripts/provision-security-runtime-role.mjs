import { PrismaClient } from "@prisma/client";

const roleInputs = [
  ["cubby_runtime", process.env.CUBBY_RUNTIME_DATABASE_URL],
  ["cubby_auth", process.env.CUBBY_AUTH_DATABASE_URL],
  ["cubby_email_delivery", process.env.CUBBY_EMAIL_DELIVERY_DATABASE_URL]
];
const roles = [];
try {
  for (const [expectedRole, databaseUrl] of roleInputs) {
    if (!databaseUrl) throw new Error();
    const parsed = new URL(databaseUrl);
    const role = decodeURIComponent(parsed.username);
    const password = decodeURIComponent(parsed.password);
    if (role !== expectedRole || !password) throw new Error();
    roles.push({ role, password });
  }
  const operatorPassword = process.env.CUBBY_SECURITY_OPERATOR_DB_PASSWORD;
  if (!operatorPassword) throw new Error();
  roles.push({ role: "cubby_security_operator", password: operatorPassword });
  if (new Set(roles.map(({ password }) => password)).size !== roles.length) throw new Error();
} catch {
  process.stderr.write("cubby_startup phase=runtime_role status=failed\n");
  process.exit(1);
}

const quoteLiteral = (value) => `'${value.replaceAll("'", "''")}'`;
const prisma = new PrismaClient();

try {
  for (const { role, password } of roles) await prisma.$executeRawUnsafe(`
    DO $$
    DECLARE inherited_role TEXT; member_role TEXT;
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${quoteLiteral(role)}) THEN
        IF EXISTS (
          SELECT 1
          FROM pg_class
          WHERE relowner = ${quoteLiteral(role)}::regrole
          UNION ALL SELECT 1 FROM pg_proc WHERE proowner = ${quoteLiteral(role)}::regrole
          UNION ALL SELECT 1 FROM pg_type WHERE typowner = ${quoteLiteral(role)}::regrole
          UNION ALL SELECT 1 FROM pg_namespace WHERE nspowner = ${quoteLiteral(role)}::regrole
          UNION ALL SELECT 1 FROM pg_database WHERE datdba = ${quoteLiteral(role)}::regrole
          UNION ALL SELECT 1 FROM pg_tablespace WHERE spcowner = ${quoteLiteral(role)}::regrole
          UNION ALL SELECT 1 FROM pg_foreign_data_wrapper WHERE fdwowner = ${quoteLiteral(role)}::regrole
          UNION ALL SELECT 1 FROM pg_foreign_server WHERE srvowner = ${quoteLiteral(role)}::regrole
          UNION ALL SELECT 1 FROM pg_language WHERE lanowner = ${quoteLiteral(role)}::regrole
          UNION ALL SELECT 1 FROM pg_largeobject_metadata WHERE lomowner = ${quoteLiteral(role)}::regrole
          UNION ALL SELECT 1 FROM pg_publication WHERE pubowner = ${quoteLiteral(role)}::regrole
          UNION ALL SELECT 1 FROM pg_subscription WHERE subowner = ${quoteLiteral(role)}::regrole
        ) THEN
          RAISE EXCEPTION 'cubby_restricted_role_owns_objects';
        END IF;
        FOR inherited_role IN
          SELECT granted.rolname
          FROM pg_auth_members membership
          JOIN pg_roles granted ON granted.oid = membership.roleid
          JOIN pg_roles member ON member.oid = membership.member
          WHERE member.rolname = ${quoteLiteral(role)}
        LOOP
          EXECUTE format('REVOKE %I FROM %I', inherited_role, ${quoteLiteral(role)});
        END LOOP;
        FOR member_role IN
          SELECT member.rolname
          FROM pg_auth_members membership
          JOIN pg_roles granted ON granted.oid = membership.roleid
          JOIN pg_roles member ON member.oid = membership.member
          WHERE granted.rolname = ${quoteLiteral(role)}
        LOOP
          EXECUTE format('REVOKE %I FROM %I', ${quoteLiteral(role)}, member_role);
        END LOOP;
        EXECUTE format('ALTER ROLE %I LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT -1 VALID UNTIL %L PASSWORD %L', ${quoteLiteral(role)}, 'infinity', ${quoteLiteral(password)});
      ELSE
        EXECUTE format('CREATE ROLE %I LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT -1 VALID UNTIL %L PASSWORD %L', ${quoteLiteral(role)}, 'infinity', ${quoteLiteral(password)});
      END IF;
      EXECUTE format('ALTER ROLE %I RESET ALL', ${quoteLiteral(role)});
      IF ${quoteLiteral(role)}='cubby_security_operator' THEN
        EXECUTE format('REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM %I', ${quoteLiteral(role)});
        EXECUTE format('REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM %I', ${quoteLiteral(role)});
        EXECUTE format('REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM %I', ${quoteLiteral(role)});
        EXECUTE format('REVOKE ALL ON SCHEMA public FROM %I', ${quoteLiteral(role)});
        EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', ${quoteLiteral(role)});
        EXECUTE format('REVOKE ALL PRIVILEGES ON DATABASE %I FROM %I', current_database(), ${quoteLiteral(role)});
        EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), ${quoteLiteral(role)});
        IF to_regprocedure('public.read_global_security_operator_aggregate(date,date)') IS NOT NULL THEN
          EXECUTE format('GRANT EXECUTE ON FUNCTION public.read_global_security_operator_aggregate(date,date) TO %I', ${quoteLiteral(role)});
        END IF;
      END IF;
    END
    $$;
  `);
  process.stdout.write("cubby_startup phase=runtime_role status=succeeded\n");
} catch {
  process.stderr.write("cubby_startup phase=runtime_role status=failed\n");
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
