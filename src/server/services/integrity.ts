import { createHash } from "node:crypto";
import {
  checkIntegrityBackupEvidence,
  type IntegrityBackupReader,
  type IntegrityBackupRecord
} from "@/server/services/integrity-backup-evidence";

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
  run: () => Promise<IntegrityCheckOutcome>;
};

export type IntegrityCheckOutcome =
  | { status: "clean" }
  | { status: "findings"; count: number; evidence: string }
  | { status: "incomplete" };

export class IntegrityCheckFailure extends Error {
  constructor(code: string) {
    super(code);
    this.name = "IntegrityCheckFailure";
  }
}

function fingerprint(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function buildReport(
  startedAt: string,
  completedAt: string,
  findings: IntegrityFinding[],
  incomplete: boolean
): IntegrityReport {
  const status = incomplete ? "incomplete" : findings.length ? "findings" : "clean";
  return {
    version: INTEGRITY_REPORT_VERSION,
    status,
    startedAt,
    completedAt,
    findings,
    evidenceFingerprint: fingerprint({ version: INTEGRITY_REPORT_VERSION, status, findings })
  };
}

export async function runIntegritySuite(
  checks: readonly IntegrityCheck[],
  options: { now?: () => Date; startedAt?: string } = {}
): Promise<IntegrityReport> {
  const now = options.now ?? (() => new Date());
  const startedAt = options.startedAt ?? now().toISOString();
  const seen = new Set<string>();
  const findings: IntegrityFinding[] = [];
  let incomplete = false;

  for (const check of checks) {
    if (!check.id || seen.has(check.id)) throw new Error("integrity_duplicate_check_id");
    seen.add(check.id);

    try {
      const result = await check.run();
      if (result.status === "clean") continue;
      if (result.status === "incomplete") {
        incomplete = true;
        findings.push({
          id: check.id,
          severity: "error",
          count: 1,
          evidenceFingerprint: fingerprint({ id: check.id, result: "incomplete" })
        });
        continue;
      }
      if (result.status !== "findings" || !Number.isSafeInteger(result.count) || result.count <= 0) {
        throw new IntegrityCheckFailure("invalid_check_result");
      }
      findings.push({
        id: check.id,
        severity: "error",
        count: result.count,
        evidenceFingerprint: fingerprint({ id: check.id, evidence: result.evidence })
      });
    } catch (error) {
      incomplete = true;
      findings.push({
        id: error instanceof IntegrityCheckFailure ? check.id : "integrity_check_incomplete",
        severity: "error",
        count: 1,
        evidenceFingerprint: fingerprint({ id: check.id, result: "incomplete" })
      });
    }
  }

  return buildReport(startedAt, now().toISOString(), findings, incomplete);
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
    id: "audit_reference_consistency",
    query: `SELECT COUNT(*)::int AS count
      FROM "AuditEvent" audit
      LEFT JOIN "HouseholdMember" actor ON actor.id = audit."actorMemberId"
      WHERE audit."actorMemberId" IS NOT NULL
        AND (actor.id IS NULL OR actor."householdId" <> audit."householdId")`
  }
];

const SPROUT_IMPORT_MAPPING_CHECK = {
  id: "sprout_import_mapping_consistency",
  query: `SELECT COUNT(*)::int AS count
    FROM "ImportedRecord" imported
    LEFT JOIN "ImportBatch" batch ON batch.id = imported."importBatchId"
    LEFT JOIN "Baby" baby
      ON imported."targetType" = 'baby' AND baby.id = imported."targetId"
    LEFT JOIN "Contact" contact
      ON imported."targetType" = 'contact' AND contact.id = imported."targetId"
    LEFT JOIN "MedicineCatalog" medicine
      ON imported."targetType" = 'medicine_catalog' AND medicine.id = imported."targetId"
    LEFT JOIN "ActivityLog" activity
      ON imported."targetType" = 'activity' AND activity.id = imported."targetId"
    LEFT JOIN "CalendarEvent" calendar_event
      ON imported."targetType" = 'calendar_event' AND calendar_event.id = imported."targetId"
    LEFT JOIN "VaccineDocument" vaccine_document
      ON imported."targetType" = 'vaccine_document' AND vaccine_document.id = imported."targetId"
    LEFT JOIN "VaccineLog" vaccine_log
      ON imported."targetType" = 'vaccine_document'
      AND vaccine_log.id = vaccine_document."vaccineLogId"
    LEFT JOIN "ActivityLog" vaccine_activity
      ON imported."targetType" = 'vaccine_document'
      AND vaccine_activity.id = vaccine_log."activityId"
    WHERE (
      imported."sourceSystem" = 'sprout-track'
      OR batch."sourceSystem" = 'sprout-track'
    )
      AND (
        batch.id IS NULL
        OR batch."householdId" <> imported."householdId"
        OR batch."sourceSystem" <> imported."sourceSystem"
        OR batch."sourceSystem" <> 'sprout-track'
        OR batch.status <> 'complete'
        OR imported."targetType" NOT IN (
          'baby',
          'contact',
          'medicine_catalog',
          'activity',
          'calendar_event',
          'vaccine_document'
        )
        OR (imported."targetType" = 'baby'
          AND (baby.id IS NULL OR baby."householdId" <> imported."householdId"))
        OR (imported."targetType" = 'contact'
          AND (contact.id IS NULL OR contact."householdId" <> imported."householdId"))
        OR (imported."targetType" = 'medicine_catalog'
          AND (medicine.id IS NULL OR medicine."householdId" <> imported."householdId"))
        OR (imported."targetType" = 'activity'
          AND (
            activity.id IS NULL
            OR activity."householdId" <> imported."householdId"
            OR activity.source <> 'sprout-track'
          ))
        OR (imported."targetType" = 'calendar_event'
          AND (
            calendar_event.id IS NULL
            OR calendar_event."householdId" <> imported."householdId"
            OR calendar_event.source <> 'sprout-track'
          ))
        OR (imported."targetType" = 'vaccine_document'
          AND (
            vaccine_document.id IS NULL
            OR vaccine_log.id IS NULL
            OR vaccine_activity.id IS NULL
            OR vaccine_activity."householdId" <> imported."householdId"
            OR vaccine_activity.source <> 'sprout-track'
          ))
      )`
} as const;

const BACKUP_MANIFEST_QUERY = `SELECT
    id,
    "householdId",
    kind,
    "storageFilename",
    checksum,
    "byteSize",
    "itemCount",
    "createdAt"
  FROM "BackupRecord"
  WHERE status = 'complete'
    AND kind IN ('automated_export', 'recovery_authorized')
  ORDER BY "createdAt", id
  LIMIT 501`;

const IMPORT_EVIDENCE_UNAVAILABLE: IntegrityCheck = {
  id: "import_preview_operation_evidence_unavailable",
  run: async () => ({ status: "incomplete" })
};

const UNAVAILABLE_CHECKS: readonly IntegrityCheck[] = [
  { id: "backup_file_checksum_unavailable", run: async () => ({ status: "incomplete" }) },
  {
    id: "import_preview_operation_evidence_unavailable",
    run: async () => ({ status: "incomplete" })
  }
];

function countFromRows(rows: readonly Record<string, unknown>[]) {
  const value = rows[0]?.count;
  const count = typeof value === "bigint" ? Number(value) : Number(value);
  if (!Number.isSafeInteger(count) || count < 0) throw new IntegrityCheckFailure("invalid_database_count");
  return count;
}

async function readStaticChecks(client: IntegritySnapshotClient) {
  const databaseOutcomes: IntegrityCheck[] = [];
  for (const check of DATABASE_CHECKS) {
    try {
      const count = countFromRows(await client.$queryRawUnsafe(check.query));
      databaseOutcomes.push({
        id: check.id,
        run: async () =>
          count === 0
            ? { status: "clean" as const }
            : { status: "findings" as const, count, evidence: `${check.id}:v1` }
      });
    } catch {
      databaseOutcomes.push({ id: check.id, run: async () => ({ status: "incomplete" as const }) });
    }
  }
  return databaseOutcomes;
}

async function readSproutImportMappingCheck(client: IntegritySnapshotClient): Promise<IntegrityCheck> {
  try {
    const count = countFromRows(await client.$queryRawUnsafe(SPROUT_IMPORT_MAPPING_CHECK.query));
    return {
      id: SPROUT_IMPORT_MAPPING_CHECK.id,
      run: async () =>
        count === 0
          ? { status: "clean" as const }
          : {
              status: "findings" as const,
              count,
              evidence: `${SPROUT_IMPORT_MAPPING_CHECK.id}:v1`
            }
    };
  } catch {
    return { id: SPROUT_IMPORT_MAPPING_CHECK.id, run: async () => ({ status: "incomplete" as const }) };
  }
}

export function normalizeBackupManifestRows(rows: readonly Record<string, unknown>[]) {
  const requiredColumns = [
    "id",
    "householdId",
    "kind",
    "storageFilename",
    "checksum",
    "byteSize",
    "itemCount",
    "createdAt"
  ];
  if (rows.some((row) => requiredColumns.some((column) => !Object.hasOwn(row, column)))) {
    return null;
  }
  return rows.map((row) => ({
    id: String(row.id),
    householdId: String(row.householdId),
    kind: String(row.kind),
    storageFilename: typeof row.storageFilename === "string" ? row.storageFilename : null,
    checksum: typeof row.checksum === "string" ? row.checksum : null,
    byteSize: typeof row.byteSize === "number" ? row.byteSize : null,
    itemCount: typeof row.itemCount === "number" ? row.itemCount : null,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt)
  }));
}

async function readSnapshot(
  client: IntegritySnapshotClient,
  includeStatic: true
): Promise<{
  checks: IntegrityCheck[];
  sproutMappingCheck: IntegrityCheck;
  manifest: IntegrityBackupRecord[] | null;
}>;
async function readSnapshot(
  client: IntegritySnapshotClient,
  includeStatic: false
): Promise<{
  checks: IntegrityCheck[];
  sproutMappingCheck: null;
  manifest: IntegrityBackupRecord[] | null;
}>;
async function readSnapshot(
  client: IntegritySnapshotClient,
  includeStatic: boolean
): Promise<{
  checks: IntegrityCheck[];
  sproutMappingCheck: IntegrityCheck | null;
  manifest: IntegrityBackupRecord[] | null;
}> {
  await client.$executeRawUnsafe("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
  const checks = includeStatic ? await readStaticChecks(client) : [];
  const sproutMappingCheck = includeStatic ? await readSproutImportMappingCheck(client) : null;
  let manifest: IntegrityBackupRecord[] | null;
  try {
    manifest = normalizeBackupManifestRows(await client.$queryRawUnsafe(BACKUP_MANIFEST_QUERY));
  } catch {
    manifest = null;
  }
  return { checks, sproutMappingCheck, manifest };
}

const productionBackupReader: IntegrityBackupReader = async (storageFilename) => {
  const [{ automatedBackupConfig }, { readLocalBackup }] = await Promise.all([
    import("@/lib/env"),
    import("@/server/services/local-backup-storage")
  ]);
  const file = await readLocalBackup(automatedBackupConfig.directory, storageFilename);
  return {
    version: 2,
    filename: file.filename,
    checksum: file.checksum,
    byteSize: file.size,
    itemCount: file.itemCount
  };
};

function unavailableBackupCheck(): IntegrityCheck {
  return { id: "backup_file_checksum_unavailable", run: async () => ({ status: "incomplete" }) };
}

export async function runDatabaseIntegritySuite(
  database: IntegrityDatabase,
  options: { now?: () => Date; backupReader?: IntegrityBackupReader } = {}
) {
  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();
  let firstSnapshot: {
    checks: IntegrityCheck[];
    sproutMappingCheck: IntegrityCheck;
    manifest: IntegrityBackupRecord[] | null;
  };
  try {
    firstSnapshot = await database.$transaction((client) => readSnapshot(client, true));
  } catch {
    const id = "integrity_snapshot_unavailable";
    const findings = [
      {
        id,
        severity: "error" as const,
        count: 1,
        evidenceFingerprint: fingerprint({ id, result: "incomplete" })
      }
    ];
    return buildReport(startedAt, now().toISOString(), findings, true);
  }

  if (firstSnapshot.manifest === null || firstSnapshot.manifest.length === 501) {
    return runIntegritySuite(
      [
        ...firstSnapshot.checks,
        unavailableBackupCheck(),
        firstSnapshot.sproutMappingCheck,
        IMPORT_EVIDENCE_UNAVAILABLE
      ],
      { now, startedAt }
    );
  }

  const backupResult = await checkIntegrityBackupEvidence(
    firstSnapshot.manifest,
    options.backupReader ?? productionBackupReader
  );
  const manifestFindings =
    backupResult.status === "clean" ? undefined : backupResult.manifestFindings;
  const fileFindings = backupResult.status === "clean" ? undefined : backupResult.fileFindings;
  const requiresManifestStability = backupResult.status !== "incomplete" || fileFindings !== undefined;
  let manifestStable = !requiresManifestStability;
  if (requiresManifestStability) {
    try {
      const secondSnapshot = await database.$transaction((client) => readSnapshot(client, false));
      manifestStable =
        secondSnapshot.manifest !== null &&
        JSON.stringify(secondSnapshot.manifest) === JSON.stringify(firstSnapshot.manifest);
    } catch {
      manifestStable = false;
    }
  }

  const stableFindings = [
    ...(manifestFindings ? [manifestFindings] : []),
    ...(manifestStable && fileFindings ? [fileFindings] : [])
  ];
  const count = stableFindings.reduce((total, finding) => total + finding.count, 0);
  const backupChecks: IntegrityCheck[] = [
    ...(count > 0
      ? [
          {
            id: "backup_file_checksum_consistency",
            run: async () => ({
              status: "findings" as const,
              count,
              evidence: fingerprint(stableFindings.map(({ evidenceFingerprint }) => evidenceFingerprint))
            })
          }
        ]
      : []),
    ...(backupResult.status === "incomplete" || !manifestStable ? [unavailableBackupCheck()] : [])
  ];
  return runIntegritySuite(
    [
      ...firstSnapshot.checks,
      ...backupChecks,
      firstSnapshot.sproutMappingCheck,
      IMPORT_EVIDENCE_UNAVAILABLE
    ],
    { now, startedAt }
  );
}

const INTEGRITY_SCHEDULER_LOCK = 751_208_901;

export async function runScheduledIntegritySuite(database: IntegrityDatabase) {
  const startedAt = new Date().toISOString();
  return database.$transaction(async (client) => {
    await client.$executeRawUnsafe("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const lock = await client.$queryRawUnsafe(`SELECT pg_try_advisory_xact_lock(${INTEGRITY_SCHEDULER_LOCK}) AS locked`);
    if (lock[0]?.locked !== true) return { executed: false as const };
    const checks = await readStaticChecks(client);
    const sproutMappingCheck = await readSproutImportMappingCheck(client);
    return {
      executed: true as const,
      report: await runIntegritySuite([
        ...checks,
        UNAVAILABLE_CHECKS[0]!,
        sproutMappingCheck,
        UNAVAILABLE_CHECKS[1]!
      ], { startedAt })
    };
  });
}
