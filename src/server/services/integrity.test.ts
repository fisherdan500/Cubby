import { describe, expect, it, vi } from "vitest";
import {
  INTEGRITY_REPORT_VERSION,
  IntegrityCheckFailure,
  integrityExitCode,
  normalizeBackupManifestRows,
  runDatabaseIntegritySuite,
  runScheduledIntegritySuite,
  runIntegritySuite,
  type IntegrityCheck
} from "@/server/services/integrity";
import type {
  IntegrityBackupReader,
  IntegrityBackupRecord
} from "@/server/services/integrity-backup-evidence";

const cleanCheck: IntegrityCheck = {
  id: "household_relation_consistency",
  run: async () => ({ status: "clean" })
};

const backupChecksum = "a".repeat(64);
const backupFilename = `cubby-backup-v2-20260727T180000Z-${backupChecksum.slice(0, 12)}.json`;
const backupManifest: IntegrityBackupRecord = {
  id: "backup-record-1",
  householdId: "household-1",
  kind: "automated_export",
  storageFilename: backupFilename,
  checksum: backupChecksum,
  byteSize: 2048,
  itemCount: 12,
  createdAt: "2026-07-27T18:00:00.000Z"
};

function fakeIntegrityDatabase(
  manifests: readonly (readonly Record<string, unknown>[])[],
  staticCounts: number[] = [],
  querySpecificCounts: ReadonlyArray<{ includes: string; count: number }> = [],
  querySpecificFailures: ReadonlyArray<{ includes: string; error: Error }> = []
) {
  const transactionEvents: string[] = [];
  const queries: string[] = [];
  let transactionIndex = 0;
  let staticCountIndex = 0;

  return {
    transactionEvents,
    queries,
    database: {
      $transaction: async <T>(
        callback: (client: {
          $executeRawUnsafe: (query: string) => Promise<unknown>;
          $queryRawUnsafe: (query: string) => Promise<readonly Record<string, unknown>[]>;
        }) => Promise<T>
      ) => {
        const snapshot = transactionIndex++;
        transactionEvents.push(`transaction-${snapshot + 1}-open`);
        const result = await callback({
          $executeRawUnsafe: async (query) => {
            transactionEvents.push(query);
          },
          $queryRawUnsafe: async (query) => {
            queries.push(query);
            if (query.includes('"BackupRecord"') && query.includes('"storageFilename"')) {
              return manifests[snapshot] ?? [];
            }
            const configuredFailure = querySpecificFailures.find(({ includes }) => query.includes(includes));
            if (configuredFailure) throw configuredFailure.error;
            const configuredCount = querySpecificCounts.find(({ includes }) => query.includes(includes));
            if (configuredCount) return [{ count: configuredCount.count }];
            return [{ count: staticCounts[staticCountIndex++] ?? 0 }];
          }
        });
        transactionEvents.push(`transaction-${snapshot + 1}-close`);
        return result;
      }
    }
  };
}

describe("read-only integrity suite", () => {
  it("returns a versioned clean report when every required check is clean", async () => {
    const report = await runIntegritySuite([cleanCheck], { now: () => new Date("2026-07-27T15:30:00.000Z") });

    expect(report).toEqual({
      version: INTEGRITY_REPORT_VERSION,
      status: "clean",
      startedAt: "2026-07-27T15:30:00.000Z",
      completedAt: "2026-07-27T15:30:00.000Z",
      findings: [],
      evidenceFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/)
    });
    expect(integrityExitCode(report)).toBe(0);
  });

  it("reports stable content-free findings without exposing a record identifier", async () => {
    const report = await runIntegritySuite([
      {
        id: "timer_state_consistency",
        run: async () => ({ status: "findings", count: 2, evidence: "timer-state-v1" })
      }
    ]);

    expect(report.status).toBe("findings");
    expect(report.findings).toEqual([
      {
        id: "timer_state_consistency",
        severity: "error",
        count: 2,
        evidenceFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/)
      }
    ]);
    expect(JSON.stringify(report)).not.toContain("record-");
    expect(integrityExitCode(report)).toBe(2);
  });

  it("fails closed as incomplete when a required check cannot run", async () => {
    const report = await runIntegritySuite([
      {
        id: "audit_reference_consistency",
        run: async () => {
          throw new IntegrityCheckFailure("snapshot_unavailable");
        }
      }
    ]);

    expect(report).toMatchObject({
      version: INTEGRITY_REPORT_VERSION,
      status: "incomplete",
      findings: [expect.objectContaining({ id: "audit_reference_consistency", severity: "error", count: 1 })]
    });
    expect(integrityExitCode(report)).toBe(3);
  });

  it("retains every independently safe result after incomplete checks in declared order", async () => {
    const report = await runIntegritySuite([
      cleanCheck,
      {
        id: "backup_file_checksum_unavailable",
        run: async () => ({ status: "incomplete" })
      },
      {
        id: "timer_state_consistency",
        run: async () => ({ status: "findings", count: 2, evidence: "timer-state-v1" })
      },
      {
        id: "import_preview_operation_evidence_unavailable",
        run: async () => ({ status: "incomplete" })
      }
    ]);

    expect(report.status).toBe("incomplete");
    expect(report.findings).toEqual([
      expect.objectContaining({ id: "backup_file_checksum_unavailable", count: 1 }),
      expect.objectContaining({ id: "timer_state_consistency", count: 2 }),
      expect.objectContaining({ id: "import_preview_operation_evidence_unavailable", count: 1 })
    ]);
    expect(integrityExitCode(report)).toBe(3);
  });

  it("fails closed without database claims when snapshot setup fails", async () => {
    const queries: string[] = [];
    const report = await runDatabaseIntegritySuite({
      $transaction: async (callback) =>
        callback({
          $executeRawUnsafe: async () => {
            throw new Error("connection details must stay private");
          },
          $queryRawUnsafe: async (query) => {
            queries.push(query);
            return [{ count: 7 }];
          }
        })
    });

    expect(report).toMatchObject({
      version: INTEGRITY_REPORT_VERSION,
      status: "incomplete",
      findings: [expect.objectContaining({ id: "integrity_snapshot_unavailable", count: 1 })]
    });
    expect(queries).toEqual([]);
    expect(JSON.stringify(report)).not.toContain("connection details");
  });

  it("rejects duplicate check IDs before claiming a result", async () => {
    await expect(runIntegritySuite([cleanCheck, cleanCheck])).rejects.toThrow("integrity_duplicate_check_id");
  });

  it("preserves raw nullable backup fields before manifest validation", () => {
    const normalized = normalizeBackupManifestRows([
      {
        ...backupManifest,
        storageFilename: null,
        checksum: null,
        byteSize: null,
        itemCount: null,
        createdAt: new Date(backupManifest.createdAt)
      }
    ]);

    expect(normalized).toEqual([
      expect.objectContaining({ storageFilename: null, checksum: null, byteSize: null, itemCount: null })
    ]);
  });

  it("runs every database probe in one read-only repeatable-read snapshot", async () => {
    const executed: string[] = [];
    const queries: string[] = [];
    const report = await runDatabaseIntegritySuite({
      $transaction: async (callback) =>
        callback({
          $executeRawUnsafe: async (query) => {
            executed.push(query);
          },
          $queryRawUnsafe: async (query) => {
            queries.push(query);
            return [{ count: 0 }];
          }
        })
    });

    expect(report.status).toBe("incomplete");
    expect(report.findings).toEqual([
      expect.objectContaining({ id: "backup_file_checksum_unavailable", severity: "error", count: 1 }),
      expect.objectContaining({
        id: "import_preview_operation_evidence_unavailable",
        severity: "error",
        count: 1
      })
    ]);
    expect(executed).toEqual(["SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"]);
    expect(queries).toHaveLength(6);
    expect(queries.join("\n")).toContain('"ActivityLog"');
    expect(queries.join("\n")).toContain('"AuditEvent"');
    expect(queries.join("\n")).toContain('"BackupRecord"');
  });

  it("captures clean fixed Sprout mapping-ledger evidence without exposing source identifiers", async () => {
    const rawSourceId = "sprout-secret-source-record-991";
    const rawSourceSystem = "sprout-secret-source-system";
    const fake = fakeIntegrityDatabase([[], []]);

    const report = await runDatabaseIntegritySuite(fake.database);

    expect(report.status).toBe("incomplete");
    expect(report.findings).toEqual([
      expect.objectContaining({
        id: "import_preview_operation_evidence_unavailable",
        severity: "error",
        count: 1
      })
    ]);

    const mappingQueries = fake.queries.filter((query) => query.includes('"ImportedRecord"'));
    expect(mappingQueries).toHaveLength(1);
    const mappingQuery = mappingQueries[0]!;
    for (const targetType of [
      "baby",
      "contact",
      "medicine_catalog",
      "activity",
      "calendar_event",
      "vaccine_document"
    ]) {
      expect(mappingQuery).toContain(`imported."targetType" = '${targetType}'`);
      expect(mappingQuery).toContain(`'${targetType}'`);
    }
    for (const tableName of [
      "ImportedRecord",
      "ImportBatch",
      "Baby",
      "Contact",
      "MedicineCatalog",
      "ActivityLog",
      "CalendarEvent",
      "VaccineDocument",
      "VaccineLog"
    ]) {
      expect(mappingQuery).toContain(`"${tableName}"`);
    }
    expect(mappingQuery).toMatch(/COUNT\s*\(\s*\*\s*\)/i);
    expect(mappingQuery).toMatch(/"householdId"/);
    expect(mappingQuery).toMatch(/"sourceSystem"/);
    expect(mappingQuery).toMatch(
      /WHERE\s*\(\s*imported\."sourceSystem"\s*=\s*'sprout-track'\s*OR\s*batch\."sourceSystem"\s*=\s*'sprout-track'\s*\)/i
    );
    expect(mappingQuery).toMatch(/status\s*<>\s*'complete'/i);
    expect(mappingQuery).toMatch(/batch\.id\s+IS\s+NULL/i);
    expect(mappingQuery).not.toMatch(/batch\.id\s*<>\s*imported\."importBatchId"/i);
    expect(mappingQuery).toMatch(/batch\."householdId"\s*<>\s*imported\."householdId"/i);
    expect(mappingQuery).toMatch(/batch\."sourceSystem"\s*<>\s*imported\."sourceSystem"/i);
    expect(mappingQuery).toMatch(
      /imported\."targetType"\s+NOT\s+IN\s*\(\s*'baby'\s*,\s*'contact'\s*,\s*'medicine_catalog'\s*,\s*'activity'\s*,\s*'calendar_event'\s*,\s*'vaccine_document'\s*\)/i
    );
    expect(mappingQuery).toMatch(
      /OR\s+\(imported\."targetType"\s*=\s*'baby'\s+AND\s+\(baby\.id\s+IS\s+NULL\s+OR\s+baby\."householdId"\s*<>\s*imported\."householdId"\)\s*\)/i
    );
    expect(mappingQuery).toMatch(
      /OR\s+\(imported\."targetType"\s*=\s*'contact'\s+AND\s+\(contact\.id\s+IS\s+NULL\s+OR\s+contact\."householdId"\s*<>\s*imported\."householdId"\)\s*\)/i
    );
    expect(mappingQuery).toMatch(
      /OR\s+\(imported\."targetType"\s*=\s*'medicine_catalog'\s+AND\s+\(medicine\.id\s+IS\s+NULL\s+OR\s+medicine\."householdId"\s*<>\s*imported\."householdId"\)\s*\)/i
    );
    expect(mappingQuery).toMatch(
      /OR\s+\(imported\."targetType"\s*=\s*'activity'\s+AND\s+\(\s*activity\.id\s+IS\s+NULL\s+OR\s+activity\."householdId"\s*<>\s*imported\."householdId"\s+OR\s+activity\.source\s*<>\s*'sprout-track'\s*\)\s*\)/i
    );
    expect(mappingQuery).toMatch(
      /OR\s+\(imported\."targetType"\s*=\s*'calendar_event'\s+AND\s+\(\s*calendar_event\.id\s+IS\s+NULL\s+OR\s+calendar_event\."householdId"\s*<>\s*imported\."householdId"\s+OR\s+calendar_event\.source\s*<>\s*'sprout-track'\s*\)\s*\)/i
    );
    expect(mappingQuery).toMatch(
      /OR\s+\(imported\."targetType"\s*=\s*'vaccine_document'\s+AND\s+\(\s*vaccine_document\.id\s+IS\s+NULL\s+OR\s+vaccine_log\.id\s+IS\s+NULL\s+OR\s+vaccine_activity\.id\s+IS\s+NULL\s+OR\s+vaccine_activity\."householdId"\s*<>\s*imported\."householdId"\s+OR\s+vaccine_activity\.source\s*<>\s*'sprout-track'\s*\)\s*\)/i
    );
    expect(mappingQuery).toMatch(/"targetId"/);
    expect(mappingQuery).toMatch(/"targetType"[\s\S]*(NOT\s+IN|ELSE)/i);
    expect(mappingQuery).toMatch(/"VaccineDocument"[\s\S]*"VaccineLog"[\s\S]*"ActivityLog"/);
    expect(mappingQuery).toMatch(/activity\.source\s*<>\s*'sprout-track'/i);
    expect(mappingQuery).toMatch(/calendar_event\.source\s*<>\s*'sprout-track'/i);
    expect(mappingQuery).toMatch(/vaccine_activity\.source\s*<>\s*'sprout-track'/i);
    expect(mappingQuery).not.toContain(rawSourceId);
    expect(mappingQuery).not.toContain(rawSourceSystem);
    expect(JSON.stringify(report)).not.toContain(rawSourceId);
    expect(JSON.stringify(report)).not.toContain(rawSourceSystem);
  });

  it("emits the fixed Sprout mapping violation count after backup evidence and before unavailable import evidence", async () => {
    const oversizedManifest = Array.from({ length: 501 }, (_, index) => ({
      ...backupManifest,
      id: `backup-record-${index}`,
      storageFilename: `${index}-${backupFilename}`
    }));
    const fake = fakeIntegrityDatabase(
      [oversizedManifest],
      [],
      [{ includes: '"ImportedRecord"', count: 2 }]
    );

    const report = await runDatabaseIntegritySuite(fake.database);

    expect(report.status).toBe("incomplete");
    expect(report.findings).toEqual([
      expect.objectContaining({ id: "backup_file_checksum_unavailable", count: 1 }),
      expect.objectContaining({ id: "sprout_import_mapping_consistency", count: 2 }),
      expect.objectContaining({ id: "import_preview_operation_evidence_unavailable", count: 1 })
    ]);
    expect(report.findings.filter(({ id }) => id === "sprout_import_mapping_consistency")).toEqual([
      expect.objectContaining({ count: 2 })
    ]);
  });

  it("reads matching backup evidence between two stable read-only manifests", async () => {
    const fake = fakeIntegrityDatabase([[backupManifest], [backupManifest]]);
    const backupReader = vi.fn<IntegrityBackupReader>(async (selectedFilename) => {
      fake.transactionEvents.push(`reader:${selectedFilename}`);
      return {
        version: 2,
        filename: backupFilename,
        checksum: backupChecksum,
        byteSize: 2048,
        itemCount: 12
      };
    });

    const report = await runDatabaseIntegritySuite(fake.database, {
      now: () => new Date("2026-07-27T19:00:00.000Z"),
      backupReader
    });

    expect(report.findings.map(({ id }) => id)).not.toContain("backup_file_checksum_consistency");
    expect(report.findings.map(({ id }) => id)).not.toContain("backup_file_checksum_unavailable");
    expect(backupReader).toHaveBeenCalledOnce();
    expect(backupReader).toHaveBeenCalledWith(backupFilename);
    expect(fake.transactionEvents).toEqual([
      "transaction-1-open",
      "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
      "transaction-1-close",
      `reader:${backupFilename}`,
      "transaction-2-open",
      "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
      "transaction-2-close"
    ]);

    const manifestQueries = fake.queries.filter(
      (query) => query.includes('"BackupRecord"') && query.includes('"storageFilename"')
    );
    expect(manifestQueries).toHaveLength(2);
    for (const query of manifestQueries) {
      expect(query).toContain("status = 'complete'");
      expect(query).toMatch(/kind\s+IN\s*\(\s*'automated_export'\s*,\s*'recovery_authorized'\s*\)/);
      expect(query).toMatch(/ORDER BY[\s\S]*"createdAt"[\s\S]*id/i);
      expect(query).toMatch(/LIMIT\s+501/i);
    }
  });

  it("retains a completed static finding when a later static probe fails", async () => {
    const fake = fakeIntegrityDatabase(
      [[backupManifest], [backupManifest]],
      [1],
      [],
      [{ includes: 'FROM "Household" household', error: new Error("query failed") }]
    );

    const report = await runDatabaseIntegritySuite(fake.database, {
      backupReader: async () => ({
        version: 2,
        filename: backupFilename,
        checksum: backupChecksum,
        byteSize: 2048,
        itemCount: 12
      })
    });

    expect(report.status).toBe("incomplete");
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "household_relation_consistency", count: 1 }),
        expect.objectContaining({ id: "active_owner_membership_consistency", count: 1 })
      ])
    );
  });

  it("bounds report timing around backup evidence collection", async () => {
    const events: string[] = [];
    const timestamps = [
      new Date("2026-07-27T19:00:00.000Z"),
      new Date("2026-07-27T19:00:03.000Z")
    ];
    const now = vi.fn(() => {
      events.push(`now:${timestamps.length}`);
      return timestamps.shift()!;
    });
    const fake = fakeIntegrityDatabase([[backupManifest], [backupManifest]]);
    const report = await runDatabaseIntegritySuite(fake.database, {
      now,
      backupReader: async () => {
        events.push("reader");
        return { version: 2, filename: backupFilename, checksum: backupChecksum, byteSize: 2048, itemCount: 12 };
      }
    });

    expect(report.startedAt).toBe("2026-07-27T19:00:00.000Z");
    expect(report.completedAt).toBe("2026-07-27T19:00:03.000Z");
    expect(events).toEqual(["now:2", "reader", "now:1"]);
  });

  it.each(["storageFilename", "checksum", "byteSize", "itemCount"] as const)(
    "reports nullable database %s evidence instead of coercing it",
    async (field) => {
      const malformedManifest = [{ ...backupManifest, [field]: null }];
      const fake = fakeIntegrityDatabase([malformedManifest, malformedManifest]);
      const backupReader = vi.fn<IntegrityBackupReader>();

      const report = await runDatabaseIntegritySuite(fake.database, { backupReader });

      expect(report.status).toBe("incomplete");
      expect(report.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "backup_file_checksum_consistency", count: 1 }),
          expect.objectContaining({ id: "import_preview_operation_evidence_unavailable", count: 1 })
        ])
      );
      expect(backupReader).not.toHaveBeenCalled();
    }
  );

  it("reports known backup corruption alongside a separate unavailable file read", async () => {
    const secondChecksum = "b".repeat(64);
    const secondFilename = `cubby-backup-v2-20260727T190000Z-${secondChecksum.slice(0, 12)}.json`;
    const manifest = [
      { ...backupManifest, checksum: "malformed" },
      {
        ...backupManifest,
        id: "backup-record-2",
        storageFilename: secondFilename,
        checksum: secondChecksum
      }
    ];
    const fake = fakeIntegrityDatabase([manifest]);
    const backupReader = vi.fn<IntegrityBackupReader>(async () => {
      throw new Error("private reader failure");
    });

    const report = await runDatabaseIntegritySuite(fake.database, { backupReader });

    expect(report.status).toBe("incomplete");
    expect(report.findings).toEqual([
      expect.objectContaining({ id: "backup_file_checksum_consistency", count: 1 }),
      expect.objectContaining({ id: "backup_file_checksum_unavailable", count: 1 }),
      expect.objectContaining({ id: "import_preview_operation_evidence_unavailable", count: 1 })
    ]);
    expect(backupReader).toHaveBeenCalledOnce();
    expect(backupReader).toHaveBeenCalledWith(secondFilename);
  });

  it("publishes a stable file mismatch alongside an unavailable sibling after reconciliation", async () => {
    const secondChecksum = "b".repeat(64);
    const secondFilename = `cubby-backup-v2-20260727T190000Z-${secondChecksum.slice(0, 12)}.json`;
    const unavailableRecord = {
      ...backupManifest,
      id: "backup-record-2",
      storageFilename: secondFilename,
      checksum: secondChecksum
    };
    const manifest = [backupManifest, unavailableRecord];
    const fake = fakeIntegrityDatabase([manifest, manifest]);
    const backupReader = vi.fn<IntegrityBackupReader>(async (selectedFilename) => {
      if (selectedFilename === secondFilename) throw new Error("private reader failure");
      return {
        version: 2,
        filename: backupFilename,
        checksum: backupChecksum,
        byteSize: 2048,
        itemCount: 13
      };
    });

    const report = await runDatabaseIntegritySuite(fake.database, { backupReader });

    expect(report.status).toBe("incomplete");
    expect(report.findings).toEqual([
      expect.objectContaining({ id: "backup_file_checksum_consistency", count: 1 }),
      expect.objectContaining({ id: "backup_file_checksum_unavailable", count: 1 }),
      expect.objectContaining({ id: "import_preview_operation_evidence_unavailable", count: 1 })
    ]);
    expect(fake.transactionEvents.filter((event) => event.endsWith("-open"))).toHaveLength(2);
  });

  it("does not publish a file mismatch when an unavailable sibling coincides with manifest drift", async () => {
    const secondChecksum = "b".repeat(64);
    const secondFilename = `cubby-backup-v2-20260727T190000Z-${secondChecksum.slice(0, 12)}.json`;
    const unavailableRecord = {
      ...backupManifest,
      id: "backup-record-2",
      storageFilename: secondFilename,
      checksum: secondChecksum
    };
    const firstManifest = [backupManifest, unavailableRecord];
    const driftedManifest = [{ ...backupManifest, itemCount: 13 }, unavailableRecord];
    const fake = fakeIntegrityDatabase([firstManifest, driftedManifest]);
    const backupReader = vi.fn<IntegrityBackupReader>(async (selectedFilename) => {
      if (selectedFilename === secondFilename) throw new Error("private reader failure");
      return {
        version: 2,
        filename: backupFilename,
        checksum: backupChecksum,
        byteSize: 2048,
        itemCount: 13
      };
    });

    const report = await runDatabaseIntegritySuite(fake.database, { backupReader });

    expect(report.status).toBe("incomplete");
    expect(report.findings).toEqual([
      expect.objectContaining({ id: "backup_file_checksum_unavailable", count: 1 }),
      expect.objectContaining({ id: "import_preview_operation_evidence_unavailable", count: 1 })
    ]);
    expect(report.findings.map(({ id }) => id)).not.toContain("backup_file_checksum_consistency");
    expect(fake.transactionEvents.filter((event) => event.endsWith("-open"))).toHaveLength(2);
  });

  it("retains manifest corruption but suppresses a file mismatch when an ordinary reconciliation drifts", async () => {
    const firstManifest = [{ ...backupManifest, checksum: "malformed" }, backupManifest];
    const driftedManifest = [{ ...backupManifest, checksum: "malformed" }, { ...backupManifest, itemCount: 13 }];
    const fake = fakeIntegrityDatabase([firstManifest, driftedManifest]);
    const backupReader = vi.fn<IntegrityBackupReader>(async (selectedFilename) => ({
      version: 2,
      filename: selectedFilename,
      checksum: backupChecksum,
      byteSize: 2048,
      itemCount: selectedFilename === backupFilename ? 13 : 12
    }));

    const report = await runDatabaseIntegritySuite(fake.database, { backupReader });

    expect(report.status).toBe("incomplete");
    expect(report.findings).toEqual([
      expect.objectContaining({ id: "backup_file_checksum_consistency", count: 1 }),
      expect.objectContaining({ id: "backup_file_checksum_unavailable", count: 1 }),
      expect.objectContaining({ id: "import_preview_operation_evidence_unavailable", count: 1 })
    ]);
    expect(fake.transactionEvents.filter((event) => event.endsWith("-open"))).toHaveLength(2);
  });

  it("fails backup evidence closed on manifest drift while preserving safe static findings", async () => {
    const driftedManifest = [{ ...backupManifest, checksum: "b".repeat(64) }];
    const fake = fakeIntegrityDatabase([[backupManifest], driftedManifest], [2]);
    const backupReader = vi.fn<IntegrityBackupReader>(async () => {
      fake.transactionEvents.push("reader");
      return {
        version: 2,
        filename: backupFilename,
        checksum: backupChecksum,
        byteSize: 2048,
        itemCount: 12
      };
    });

    const report = await runDatabaseIntegritySuite(fake.database, { backupReader });

    expect(report.status).toBe("incomplete");
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "household_relation_consistency", count: 2 }),
        expect.objectContaining({ id: "backup_file_checksum_unavailable", count: 1 })
      ])
    );
    expect(report.findings.map(({ id }) => id)).not.toContain("backup_file_checksum_consistency");
    expect(backupReader).toHaveBeenCalledOnce();
    expect(fake.transactionEvents.indexOf("transaction-1-close")).toBeLessThan(
      fake.transactionEvents.indexOf("reader")
    );
    expect(fake.transactionEvents.indexOf("reader")).toBeLessThan(
      fake.transactionEvents.indexOf("transaction-2-open")
    );
  });

  it("fails closed when the bounded manifest exceeds 500 rows without reading backup files", async () => {
    const oversizedManifest = Array.from({ length: 501 }, (_, index) => ({
      ...backupManifest,
      id: `backup-record-${index}`,
      storageFilename: `${index}-${backupFilename}`
    }));
    const fake = fakeIntegrityDatabase([oversizedManifest]);
    const backupReader = vi.fn<IntegrityBackupReader>();

    const report = await runDatabaseIntegritySuite(fake.database, { backupReader });

    expect(report.status).toBe("incomplete");
    expect(report.findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "backup_file_checksum_unavailable", count: 1 })])
    );
    expect(report.findings.map(({ id }) => id)).not.toContain("backup_file_checksum_consistency");
    expect(backupReader).not.toHaveBeenCalled();
    expect(fake.transactionEvents.filter((event) => event.endsWith("-open"))).toEqual(["transaction-1-open"]);
    const manifestQuery = fake.queries.find(
      (query) => query.includes('"BackupRecord"') && query.includes('"storageFilename"')
    );
    expect(manifestQuery).toMatch(/LIMIT\s+501/i);
  });

  it("runs the complete scheduled suite in deterministic order after acquiring the lock", async () => {
    const events: string[] = [];
    let staticQueryIndex = 0;
    const result = await runScheduledIntegritySuite({
      $transaction: async (callback) =>
        callback({
          $executeRawUnsafe: async (query) => {
            events.push(`execute:${query}`);
          },
          $queryRawUnsafe: async (query) => {
            events.push(`query:${query}`);
            if (query.includes("pg_try_advisory_xact_lock")) return [{ locked: true }];
            if (query.includes('"ImportedRecord"')) return [{ count: 2 }];
            return [{ count: staticQueryIndex++ === 0 ? 1 : 0 }];
          }
        })
    });

    expect(result).toMatchObject({
      executed: true,
      report: {
        status: "incomplete",
        findings: [
          expect.objectContaining({ id: "household_relation_consistency", count: 1 }),
          expect.objectContaining({ id: "backup_file_checksum_unavailable", count: 1 }),
          expect.objectContaining({ id: "sprout_import_mapping_consistency", count: 2 }),
          expect.objectContaining({ id: "import_preview_operation_evidence_unavailable", count: 1 })
        ]
      }
    });
    expect(events).toHaveLength(7);
    expect(events[0]).toBe("execute:SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(events[1]).toContain("query:SELECT pg_try_advisory_xact_lock");
    expect(events[2]).toContain('query:SELECT COUNT(*)::int AS count\n      FROM "ActivityLog" activity');
    expect(events[3]).toContain('query:SELECT COUNT(*)::int AS count\n      FROM "Household" household');
    expect(events[4]).toContain('query:SELECT COUNT(*)::int AS count\n      FROM "ActivityLog" activity');
    expect(events[5]).toContain('query:SELECT COUNT(*)::int AS count\n      FROM "AuditEvent" audit');
    expect(events[6]).toContain('query:SELECT COUNT(*)::int AS count\n    FROM "ImportedRecord" imported');
  });

  it("skips a scheduled run when another process holds the advisory lock", async () => {
    const queries: string[] = [];
    const executed: string[] = [];
    const result = await runScheduledIntegritySuite({
      $transaction: async (callback) =>
        callback({
          $executeRawUnsafe: async (query) => {
            executed.push(query);
          },
          $queryRawUnsafe: async (query) => {
            queries.push(query);
            return [{ locked: false }];
          }
        })
    });

    expect(result).toEqual({ executed: false });
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain("pg_try_advisory_xact_lock");
    expect(executed).toEqual(["SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"]);
  });
});
