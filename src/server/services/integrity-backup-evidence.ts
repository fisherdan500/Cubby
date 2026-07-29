import { createHash } from "node:crypto";
import { isLocalBackupFilename } from "@/server/services/local-backup-storage";

export interface IntegrityBackupRecord extends Record<string, unknown> {
  id: string;
  householdId: string;
  kind: string;
  storageFilename: string | null;
  checksum: string | null;
  byteSize: number | null;
  itemCount: number | null;
  createdAt: string;
}

export interface IntegrityBackupReadResult {
  version: number;
  filename: string;
  checksum: string;
  byteSize: number;
  itemCount: number;
}

export type IntegrityBackupReader = (
  storageFilename: string
) => Promise<IntegrityBackupReadResult>;

type IntegrityBackupEvidenceResult =
  | {
      id: "backup_file_checksum_consistency";
      status: "clean";
    }
  | {
      id: "backup_file_checksum_consistency";
      status: "findings";
      count: number;
      evidenceFingerprint: string;
      manifestFindings?: {
        count: number;
        evidenceFingerprint: string;
      };
      fileFindings?: {
        count: number;
        evidenceFingerprint: string;
      };
    }
  | {
      id: "backup_file_checksum_unavailable";
      status: "incomplete";
      count: number;
      evidenceFingerprint: string;
      manifestFindings?: {
        count: number;
        evidenceFingerprint: string;
      };
      fileFindings?: {
        count: number;
        evidenceFingerprint: string;
      };
    };

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ISO_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const ELIGIBLE_KINDS = new Set(["automated_export", "recovery_authorized"]);

function isSafeInteger(value: unknown, minimum: number): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum
  );
}

function isFiniteIsoInstant(value: unknown): value is string {
  return (
    typeof value === "string" &&
    ISO_INSTANT_PATTERN.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function recordIssue(record: IntegrityBackupRecord): string | null {
  if (!ELIGIBLE_KINDS.has(record.kind)) return "record_kind_invalid";
  if (
    typeof record.storageFilename !== "string" ||
    !isLocalBackupFilename(record.storageFilename)
  ) {
    return "record_filename_invalid";
  }
  if (
    typeof record.checksum !== "string" ||
    !SHA256_PATTERN.test(record.checksum)
  ) {
    return "record_checksum_invalid";
  }
  if (!isSafeInteger(record.byteSize, 1)) return "record_byte_size_invalid";
  if (!isSafeInteger(record.itemCount, 0)) return "record_item_count_invalid";
  if (!isFiniteIsoInstant(record.createdAt)) return "record_created_at_invalid";
  return null;
}

function isTrustedReadResult(
  value: unknown
): value is IntegrityBackupReadResult {
  if (typeof value !== "object" || value === null) return false;
  const result = value as Partial<IntegrityBackupReadResult>;

  return (
    result.version === 2 &&
    typeof result.filename === "string" &&
    isLocalBackupFilename(result.filename) &&
    typeof result.checksum === "string" &&
    SHA256_PATTERN.test(result.checksum) &&
    isSafeInteger(result.byteSize, 1) &&
    isSafeInteger(result.itemCount, 0)
  );
}

function fingerprint(status: "findings" | "incomplete", issues: string[]) {
  const safeEvidence = JSON.stringify({
    check: "backup_file_checksum_consistency",
    status,
    issues
  });
  return createHash("sha256").update(safeEvidence).digest("hex");
}

export async function checkIntegrityBackupEvidence(
  records: readonly IntegrityBackupRecord[],
  reader: IntegrityBackupReader
): Promise<IntegrityBackupEvidenceResult> {
  const manifestFindings: string[] = [];
  const fileFindings: string[] = [];
  const unavailable: string[] = [];

  for (const record of records) {
    const malformedIssue = recordIssue(record);
    if (malformedIssue) {
      manifestFindings.push(malformedIssue);
      continue;
    }

    const storageFilename = record.storageFilename as string;
    let trusted: IntegrityBackupReadResult;
    try {
      trusted = await reader(storageFilename);
    } catch {
      unavailable.push("reader_failed");
      continue;
    }

    if (!isTrustedReadResult(trusted)) {
      unavailable.push("trusted_result_invalid");
      continue;
    }

    if (
      trusted.filename !== storageFilename ||
      trusted.checksum !== record.checksum ||
      trusted.byteSize !== record.byteSize ||
      trusted.itemCount !== record.itemCount
    ) {
      fileFindings.push("trusted_result_mismatch");
    }
  }

  if (unavailable.length > 0) {
    return {
      id: "backup_file_checksum_unavailable",
      status: "incomplete",
      count: unavailable.length,
      evidenceFingerprint: fingerprint("incomplete", unavailable),
      ...(manifestFindings.length > 0
        ? {
            manifestFindings: {
              count: manifestFindings.length,
              evidenceFingerprint: fingerprint("findings", manifestFindings)
            }
          }
        : {}),
      ...(fileFindings.length > 0
        ? {
            fileFindings: {
              count: fileFindings.length,
              evidenceFingerprint: fingerprint("findings", fileFindings)
            }
          }
        : {})
    };
  }

  const findings = [...manifestFindings, ...fileFindings];
  if (findings.length > 0) {
    return {
      id: "backup_file_checksum_consistency",
      status: "findings",
      count: findings.length,
      evidenceFingerprint: fingerprint("findings", findings),
      ...(manifestFindings.length > 0
        ? {
            manifestFindings: {
              count: manifestFindings.length,
              evidenceFingerprint: fingerprint("findings", manifestFindings)
            }
          }
        : {}),
      ...(fileFindings.length > 0
        ? {
            fileFindings: {
              count: fileFindings.length,
              evidenceFingerprint: fingerprint("findings", fileFindings)
            }
          }
        : {})
    };
  }

  return {
    id: "backup_file_checksum_consistency",
    status: "clean"
  };
}
