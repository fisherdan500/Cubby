import { createHash } from "node:crypto";

export const INTEGRITY_REPORT_VERSION = 1;

export type IntegrityFinding = {
  id: string;
  severity: "error";
  count: number;
  evidenceFingerprint: string;
};

export type IntegrityReport = {
  version: typeof INTEGRITY_REPORT_VERSION;
  status: "clean" | "findings" | "incomplete";
  startedAt: string;
  completedAt: string;
  findings: IntegrityFinding[];
  evidenceFingerprint: string;
};

export type IntegrityCheck = {
  id: string;
  run: () => Promise<{ count: number; evidence: string }>;
};

export class IntegrityCheckFailure extends Error {
  constructor(code: string) {
    super(code);
    this.name = "IntegrityCheckFailure";
  }
}

function fingerprint(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export async function runIntegritySuite(
  checks: readonly IntegrityCheck[],
  options: { now?: () => Date } = {}
): Promise<IntegrityReport> {
  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const seen = new Set<string>();
  const findings: IntegrityFinding[] = [];

  for (const check of checks) {
    if (!check.id || seen.has(check.id)) throw new Error("integrity_duplicate_check_id");
    seen.add(check.id);

    try {
      const result = await check.run();
      if (!Number.isSafeInteger(result.count) || result.count < 0) {
        throw new IntegrityCheckFailure("invalid_check_result");
      }
      if (result.count > 0) {
        findings.push({
          id: check.id,
          severity: "error",
          count: result.count,
          evidenceFingerprint: fingerprint({ id: check.id, evidence: result.evidence })
        });
      }
    } catch (error) {
      findings.push({
        id: error instanceof IntegrityCheckFailure ? check.id : "integrity_check_incomplete",
        severity: "error",
        count: 1,
        evidenceFingerprint: fingerprint({ id: check.id, result: "incomplete" })
      });
      const completedAt = now().toISOString();
      return {
        version: INTEGRITY_REPORT_VERSION,
        status: "incomplete",
        startedAt,
        completedAt,
        findings,
        evidenceFingerprint: fingerprint({ version: INTEGRITY_REPORT_VERSION, status: "incomplete", findings })
      };
    }
  }

  const completedAt = now().toISOString();
  const status = findings.length ? "findings" : "clean";
  return {
    version: INTEGRITY_REPORT_VERSION,
    status,
    startedAt,
    completedAt,
    findings,
    evidenceFingerprint: fingerprint({ version: INTEGRITY_REPORT_VERSION, status, findings })
  };
}

export function integrityExitCode(report: IntegrityReport) {
  if (report.status === "clean") return 0;
  if (report.status === "findings") return 2;
  return 3;
}

export type IntegritySnapshotClient = {
  $executeRawUnsafe: (query: string) => Promise<unknown>;
  $queryRawUnsafe: (query: string) => Promise<readonly Record<string, unknown>[]>;
};

export type IntegrityDatabase = {
  $transaction: <T>(callback: (client: IntegritySnapshotClient) => Promise<T>) => Promise<T>;
};

const DATABASE_CHECKS: ReadonlyArray<{ id: string; query: string }> = [
  {
    id: "household_relation_consistency",
    query: `SELECT COUNT(*)::int AS count
      FROM "ActivityLog" activity
      LEFT JOIN "Baby" baby ON baby.id = activity."babyId"
      LEFT JOIN "HouseholdMember" actor ON actor.id = activity."actorMemberId"
      WHERE baby.id IS NULL
        OR actor.id IS NULL
        OR baby."householdId" <> activity."householdId"
        OR actor."householdId" <> activity."householdId"`
  },
  {
    id: "active_owner_membership_consistency",
    query: `SELECT COUNT(*)::int AS count
      FROM "Household" household
      WHERE household."deletedAt" IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM "HouseholdMember" member
          WHERE member."householdId" = household.id
            AND member.role = 'owner'
            AND member."disabledAt" IS NULL
            AND member."deletedAt" IS NULL
        )`
  },
  {
    id: "timer_state_consistency",
    query: `SELECT COUNT(*)::int AS count
      FROM "ActivityLog" activity
      WHERE activity."deletedAt" IS NULL
        AND (
          (activity."timerState" IN ('running', 'paused') AND activity."startedAt" IS NULL)
          OR (activity."timerState" = 'stopped' AND (activity."startedAt" IS NULL OR activity."endedAt" IS NULL))
          OR (activity."timerState" = 'none' AND (activity."pausedAt" IS NOT NULL OR activity."pausedSeconds" <> 0))
        )`
  },
  {
    id: "backup_record_consistency",
    query: `SELECT COUNT(*)::int AS count
      FROM "BackupRecord" backup
      WHERE backup.status = 'complete'
        AND (
          backup."storageFilename" IS NULL
          OR backup.checksum IS NULL
          OR backup."itemCount" IS NULL
          OR backup."itemCount" < 0
          OR backup."byteSize" IS NULL
          OR backup."byteSize" <= 0
        )`
  },
  {
    id: "audit_reference_consistency",
    query: `SELECT COUNT(*)::int AS count
      FROM "AuditEvent" audit
      LEFT JOIN "HouseholdMember" actor ON actor.id = audit."actorMemberId"
      WHERE audit."actorMemberId" IS NOT NULL
        AND (actor.id IS NULL OR actor."householdId" <> audit."householdId")`
  }
];

const UNAVAILABLE_CHECKS: readonly IntegrityCheck[] = [
  {
    id: "backup_file_checksum_unavailable",
    run: async () => {
      throw new IntegrityCheckFailure("backup_file_checksum_unavailable");
    }
  },
  {
    id: "import_operation_consistency_unavailable",
    run: async () => {
      throw new IntegrityCheckFailure("import_operation_consistency_unavailable");
    }
  }
];

function countFromRows(rows: readonly Record<string, unknown>[]) {
  const value = rows[0]?.count;
  const count = typeof value === "bigint" ? Number(value) : Number(value);
  if (!Number.isSafeInteger(count) || count < 0) throw new IntegrityCheckFailure("invalid_database_count");
  return count;
}

function runIntegrityChecks(client: IntegritySnapshotClient, options: { now?: () => Date }) {
  return runIntegritySuite(
    [
      ...DATABASE_CHECKS.map((check) => ({
        id: check.id,
        run: async () => ({
          count: countFromRows(await client.$queryRawUnsafe(check.query)),
          evidence: `${check.id}:v1`
        })
      })),
      ...UNAVAILABLE_CHECKS
    ],
    options
  );
}

async function runIntegritySnapshot(client: IntegritySnapshotClient, options: { now?: () => Date }) {
  await client.$executeRawUnsafe("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
  return runIntegrityChecks(client, options);
}

export async function runDatabaseIntegritySuite(database: IntegrityDatabase, options: { now?: () => Date } = {}) {
  return database.$transaction((client) => runIntegritySnapshot(client, options));
}

const INTEGRITY_SCHEDULER_LOCK = 751_208_901;

export async function runScheduledIntegritySuite(database: IntegrityDatabase) {
  return database.$transaction(async (client) => {
    await client.$executeRawUnsafe("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const lock = await client.$queryRawUnsafe(`SELECT pg_try_advisory_xact_lock(${INTEGRITY_SCHEDULER_LOCK}) AS locked`);
    if (lock[0]?.locked !== true) return { executed: false as const };
    return { executed: true as const, report: await runIntegrityChecks(client, {}) };
  });
}
