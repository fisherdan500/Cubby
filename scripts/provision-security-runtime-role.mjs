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
  process.stdout.write("p1_3_invitation_acceptance_global_role_input_failed\n");
  process.exit(1);
}

const quoteLiteral = (value) => `'${value.replaceAll("'", "''")}'`;

function globalRoleApplyFailureCode(error) {
  const record = error && typeof error === "object" ? error : undefined;
  const meta = record && "meta" in record && record.meta && typeof record.meta === "object" ? record.meta : undefined;
  switch (meta?.code) {
    case "42501": return "p1_3_invitation_acceptance_global_role_apply_sqlstate_42501";
    case "42703": return "p1_3_invitation_acceptance_global_role_apply_sqlstate_42703";
    case "42704": return "p1_3_invitation_acceptance_global_role_apply_sqlstate_42704";
    case "42883": return "p1_3_invitation_acceptance_global_role_apply_sqlstate_42883";
    case "0A000": return "p1_3_invitation_acceptance_global_role_apply_sqlstate_0a000";
    // The provisioner's own restricted-ownership guard. A source boundary, never infrastructure.
    case "P0001": return "p1_3_invitation_acceptance_global_role_apply_sqlstate_p0001";
    // Remaining members of the charter's approved query-failure class, so a real SQLSTATE is never
    // collapsed into the unclassified bucket the way Attempts 41 and 55 were.
    case "22023": return "p1_3_invitation_acceptance_global_role_apply_sqlstate_22023";
    case "23502": return "p1_3_invitation_acceptance_global_role_apply_sqlstate_23502";
    case "23503": return "p1_3_invitation_acceptance_global_role_apply_sqlstate_23503";
    case "23505": return "p1_3_invitation_acceptance_global_role_apply_sqlstate_23505";
    case "55P03": return "p1_3_invitation_acceptance_global_role_apply_sqlstate_55p03";
    case "40001": return "p1_3_invitation_acceptance_global_role_apply_sqlstate_40001";
    case "40P01": return "p1_3_invitation_acceptance_global_role_apply_sqlstate_40p01";
    case "57014": return "p1_3_invitation_acceptance_global_role_apply_sqlstate_57014";
    case "53300": return "p1_3_invitation_acceptance_global_role_apply_sqlstate_53300";
    default: break;
  }
  // Prisma initialization and connection failures carry a P1xxx code and no SQLSTATE: the disposable
  // database was never reached, so this is an environment boundary rather than a protocol repair.
  const initialization = record && typeof record.errorCode === "string" ? record.errorCode
    : record && typeof record.code === "string" ? record.code : undefined;
  if (initialization && /^P1\d{3}$/.test(initialization)) return "p1_3_invitation_acceptance_global_role_apply_unreachable";
  return "p1_3_invitation_acceptance_global_role_apply_failed";
}
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
} catch (error) {
  process.stdout.write(`${globalRoleApplyFailureCode(error)}\n`);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
