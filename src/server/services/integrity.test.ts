import { describe, expect, it } from "vitest";
import {
  INTEGRITY_REPORT_VERSION,
  IntegrityCheckFailure,
  integrityExitCode,
  runDatabaseIntegritySuite,
  runScheduledIntegritySuite,
  runIntegritySuite,
  type IntegrityCheck
} from "@/server/services/integrity";

const cleanCheck: IntegrityCheck = {
  id: "household_relation_consistency",
  run: async () => ({ count: 0, evidence: "relations-v1" })
};

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
        run: async () => ({ count: 2, evidence: "timer-state-v1" })
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

  it("rejects duplicate check IDs before claiming a result", async () => {
    await expect(runIntegritySuite([cleanCheck, cleanCheck])).rejects.toThrow("integrity_duplicate_check_id");
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
      expect.objectContaining({ id: "backup_file_checksum_unavailable", severity: "error", count: 1 })
    ]);
    expect(executed).toEqual(["SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"]);
    expect(queries).toHaveLength(5);
    expect(queries.join("\n")).toContain('"ActivityLog"');
    expect(queries.join("\n")).toContain('"AuditEvent"');
    expect(queries.join("\n")).toContain('"BackupRecord"');
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
