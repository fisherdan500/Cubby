import { PrismaClient } from "@prisma/client";

// Prisma writes JavaScript Date values as UTC into timestamp-without-time-zone columns, while
// database guards compare those values with clock_timestamp() in the session time zone. Any
// non-UTC session makes app-written instants look hours in the future (or past), so every
// application connection must run in UTC regardless of how PostgreSQL was initialized.
const failed = "cubby_startup phase=database_timezone status=failed\n";
const runtimeUrl = process.env.CUBBY_RUNTIME_DATABASE_URL;
if (!process.env.DATABASE_URL || !runtimeUrl) {
  process.stderr.write(failed);
  process.exit(1);
}

const owner = new PrismaClient();
const runtime = new PrismaClient({ datasourceUrl: runtimeUrl });
try {
  await owner.$executeRawUnsafe(`DO $$ BEGIN EXECUTE format('ALTER DATABASE %I SET timezone TO %L', current_database(), 'UTC'); END $$`);
  const overrides = await owner.$queryRaw`
    SELECT count(*)::int AS "count"
    FROM pg_db_role_setting s
    CROSS JOIN LATERAL unnest(s.setconfig) AS c(entry)
    WHERE s.setrole <> 0
      AND (s.setdatabase = 0 OR s.setdatabase = (SELECT oid FROM pg_database WHERE datname = current_database()))
      AND lower(split_part(c.entry, '=', 1)) = 'timezone'
      AND split_part(c.entry, '=', 2) <> 'UTC'
  `;
  if (overrides.length !== 1 || overrides[0].count !== 0) throw new Error();
  const zones = await runtime.$queryRaw`SELECT current_setting('TimeZone') AS "zone"`;
  if (zones.length !== 1 || zones[0].zone !== "UTC") throw new Error();
  process.stdout.write("cubby_startup phase=database_timezone status=succeeded\n");
} catch {
  process.stderr.write(failed);
  process.exitCode = 1;
} finally {
  await Promise.allSettled([owner.$disconnect(), runtime.$disconnect()]);
}
