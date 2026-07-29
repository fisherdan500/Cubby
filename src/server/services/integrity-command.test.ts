import { describe, expect, it } from "vitest";
import {
  formatIntegrityReport,
  parseIntegrityCommand,
  type IntegrityCommandOperations,
  runIntegrityCommand
} from "../../../scripts/integrity-check";

describe("integrity command", () => {
  it("accepts only the all-scope JSON command", () => {
    expect(parseIntegrityCommand(["--format", "json", "--scope", "all"])).toEqual({
      format: "json",
      scope: "all"
    });
    expect(() => parseIntegrityCommand(["--format", "json", "--unexpected", "value"])).toThrow(
      "integrity_command_usage"
    );
  });

  it("rejects malformed input before loading operations and marks it as stderr output", async () => {
    const writes: Array<{ line: string; error: boolean | undefined }> = [];
    const load = async () => {
      throw new Error("must_not_load");
    };

    const code = await runIntegrityCommand(["--format", "json"], load, (line, error) => {
      writes.push({ line, error });
    });

    expect(code).toBe(4);
    expect(writes).toEqual([{ line: "Integrity command failed: integrity_command_usage", error: true }]);
  });

  it("emits one versioned JSON report and returns the report exit code", async () => {
    const writes: string[] = [];
    const operations: IntegrityCommandOperations = {
      run: async () => ({
        version: 1,
        status: "findings",
        startedAt: "2026-07-27T15:30:00.000Z",
        completedAt: "2026-07-27T15:30:01.000Z",
        findings: [
          {
            id: "timer_state_consistency",
            severity: "error",
            count: 1,
            evidenceFingerprint: "a".repeat(64)
          }
        ],
        evidenceFingerprint: "b".repeat(64)
      })
    };

    const code = await runIntegrityCommand(["--format", "json", "--scope", "all"], async () => operations, (line) => {
      writes.push(line);
    });

    expect(code).toBe(2);
    expect(writes).toEqual([expect.stringContaining('"status":"findings"')]);
    expect(writes[0]).not.toContain("DATABASE_URL");
    expect(formatIntegrityReport(JSON.parse(writes[0]), "json")).toBe(writes[0]);
  });

  it("emits one redacted versioned incomplete report with exit code 3", async () => {
    const writes: string[] = [];
    const operations: IntegrityCommandOperations = {
      run: async () => ({
        version: 1,
        status: "incomplete",
        startedAt: "2026-07-27T15:30:00.000Z",
        completedAt: "2026-07-27T15:30:01.000Z",
        findings: [
          {
            id: "backup_file_checksum_unavailable",
            severity: "error",
            count: 1,
            evidenceFingerprint: "a".repeat(64)
          },
          {
            id: "import_preview_operation_evidence_unavailable",
            severity: "error",
            count: 1,
            evidenceFingerprint: "b".repeat(64)
          }
        ],
        evidenceFingerprint: "c".repeat(64)
      })
    };

    const code = await runIntegrityCommand(["--format", "json", "--scope", "all"], async () => operations, (line) => {
      writes.push(line);
    });

    expect(code).toBe(3);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('"version":1');
    expect(writes[0]).toContain('"status":"incomplete"');
    expect(writes[0]).not.toContain("DATABASE_URL");
  });
});
