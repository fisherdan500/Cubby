import { createHash } from "node:crypto";
import { isAttachmentStorageKey } from "@/domain/attachments";
import type { IntegrityCheckOutcome } from "@/server/services/integrity";

/**
 * The attachment store against its records (DEC-PROD-142, DEC-PROD-145): every staged, available or
 * recoverable photo must have exactly its recorded bytes, and nothing else may be stored. Findings are
 * counted and fingerprinted, never named. A store that cannot be read makes the check incomplete.
 */

export type AttachmentInventoryRecord = { storageKey: string; byteSize: number; sha256: string; state: string };
export type AttachmentObjectReader = (storageKey: string, expected: { byteSize: number; sha256: string }) => Promise<unknown>;

const STATES = new Set(["staging", "available", "unavailable", "deleted", "write_pending"]);
// Photos known to be unavailable are already recorded as such; their bytes are not expected.
const EXPECTS_BYTES = new Set(["staging", "available", "deleted"]);

export const ATTACHMENT_INVENTORY_QUERY = `SELECT "storageKey", "byteSize", sha256, state FROM (
  SELECT "storageKey", "byteSize", sha256, state::text AS state
  FROM "Attachment"
  WHERE state <> 'purged'
  UNION ALL
  SELECT intent."storageKey", intent."byteSize", intent.sha256, 'write_pending'::text AS state
  FROM "AttachmentWriteIntent" intent
  WHERE intent.state = 'pending' AND NOT EXISTS (
    SELECT 1 FROM "Attachment" attachment WHERE attachment."storageKey" = intent."storageKey"
  )
  ) inventory
  ORDER BY "storageKey"
  LIMIT 100001`;

export function normalizeAttachmentInventoryRows(rows: readonly Record<string, unknown>[]): AttachmentInventoryRecord[] | null {
  const records: AttachmentInventoryRecord[] = [];
  for (const row of rows) {
    const { storageKey, byteSize, sha256, state } = row;
    if (typeof storageKey !== "string" || !isAttachmentStorageKey(storageKey)) return null;
    if (typeof byteSize !== "number" || !Number.isSafeInteger(byteSize) || byteSize <= 0) return null;
    if (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256)) return null;
    if (typeof state !== "string" || !STATES.has(state)) return null;
    records.push({ storageKey, byteSize, sha256, state });
  }
  return records;
}

export async function checkAttachmentInventory(
  records: readonly AttachmentInventoryRecord[],
  storedKeys: readonly string[],
  read: AttachmentObjectReader
): Promise<IntegrityCheckOutcome> {
  const recorded = new Set(records.map((record) => record.storageKey));
  const problems: string[] = [];
  for (const record of records) {
    if (!EXPECTS_BYTES.has(record.state)) continue;
    try {
      await read(record.storageKey, { byteSize: record.byteSize, sha256: record.sha256 });
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      if (code === "attachment_bytes_missing" || code === "attachment_bytes_mismatch") problems.push(`${code}:${record.storageKey}`);
      else return { status: "incomplete" };
    }
  }
  for (const key of storedKeys) {
    if (!recorded.has(key)) problems.push(`stray:${key}`);
  }
  // A tracked in-flight/abandoned write is not an unknown orphan, nor verified Attachment bytes.
  if (problems.length === 0) return { status: records.some((record) => record.state === "write_pending") ? "incomplete" : "clean" };
  return {
    status: "findings",
    count: problems.length,
    evidence: createHash("sha256").update(JSON.stringify(problems.sort())).digest("hex")
  };
}
