import { describe, expect, it, vi } from "vitest";
import {
  checkIntegrityBackupEvidence,
  type IntegrityBackupRecord,
  type IntegrityBackupReader,
  type IntegrityBackupReadResult
} from "@/server/services/integrity-backup-evidence";

const checksum = "a".repeat(64);
const filename = `cubby-backup-v2-20260727T180000Z-${checksum.slice(0, 12)}.json`;

const record: IntegrityBackupRecord = {
  id: "backup-record-secret",
  householdId: "household-secret",
  kind: "automated_export",
  storageFilename: filename,
  checksum,
  byteSize: 2048,
  itemCount: 12,
  createdAt: "2026-07-27T18:00:00.000Z"
};

const trustedRead: IntegrityBackupReadResult = {
  version: 2,
  filename,
  checksum,
  byteSize: 2048,
  itemCount: 12
};

function readerReturning(result: IntegrityBackupReadResult = trustedRead) {
  return vi.fn<IntegrityBackupReader>(async () => result);
}

describe("integrity backup evidence", () => {
  it("reports a matching linked v2 record as clean", async () => {
    await expect(checkIntegrityBackupEvidence([record], readerReturning())).resolves.toEqual({
      id: "backup_file_checksum_consistency",
      status: "clean"
    });
  });

  it("accepts the canonical discriminator-bearing v2 filename emitted by automated backups", async () => {
    const discriminatedFilename = `cubby-backup-v2-20260727T180000Z-${checksum.slice(0, 12)}-${"b".repeat(32)}.json`;

    await expect(
      checkIntegrityBackupEvidence(
        [{ ...record, storageFilename: discriminatedFilename }],
        readerReturning({ ...trustedRead, filename: discriminatedFilename })
      )
    ).resolves.toEqual({
      id: "backup_file_checksum_consistency",
      status: "clean"
    });
  });

  it.each([
    ["storageFilename", { storageFilename: null }],
    ["checksum", { checksum: "not-a-checksum" }],
    ["byteSize", { byteSize: -1 }],
    ["itemCount", { itemCount: -1 }]
  ] satisfies ReadonlyArray<[string, Partial<IntegrityBackupRecord>]>)(
    "reports a content-free finding for malformed required field %s",
    async (_field, malformed) => {
      const read = readerReturning();
      const result = await checkIntegrityBackupEvidence([{ ...record, ...malformed }], read);

      expect(result).toEqual({
        id: "backup_file_checksum_consistency",
        status: "findings",
        count: 1,
        evidenceFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        manifestFindings: {
          count: 1,
          evidenceFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/)
        }
      });
      expect(read).not.toHaveBeenCalled();
    }
  );

  it("fails closed as incomplete when the trusted reader fails", async () => {
    const read = vi.fn<IntegrityBackupReader>(async () => {
      throw new Error("reader failure at C:\\private\\backup-root");
    });

    await expect(checkIntegrityBackupEvidence([record], read)).resolves.toEqual({
      id: "backup_file_checksum_unavailable",
      status: "incomplete",
      count: 1,
      evidenceFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/)
    });
  });

  it("retains proven malformed evidence when another selected backup is unavailable", async () => {
    const secondChecksum = "b".repeat(64);
    const secondFilename = `cubby-backup-v2-20260727T190000Z-${secondChecksum.slice(0, 12)}.json`;
    const unavailableRecord: IntegrityBackupRecord = {
      ...record,
      id: "second-record-secret",
      storageFilename: secondFilename,
      checksum: secondChecksum
    };
    const read = vi.fn<IntegrityBackupReader>(async () => {
      throw new Error("reader failure at C:\\private\\backup-root");
    });

    await expect(
      checkIntegrityBackupEvidence([{ ...record, checksum: "malformed" }, unavailableRecord], read)
    ).resolves.toEqual({
      id: "backup_file_checksum_unavailable",
      status: "incomplete",
      count: 1,
      evidenceFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      manifestFindings: {
        count: 1,
        evidenceFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/)
      }
    });
  });

  it("reports a safe finding when trusted v2 evidence mismatches the linked record", async () => {
    const result = await checkIntegrityBackupEvidence(
      [record],
      readerReturning({ ...trustedRead, itemCount: trustedRead.itemCount + 1 })
    );

    expect(result).toEqual({
      id: "backup_file_checksum_consistency",
      status: "findings",
      count: 1,
      evidenceFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      fileFindings: {
        count: 1,
        evidenceFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/)
      }
    });
  });

  it("reports zero selected records as clean without invoking the reader", async () => {
    const read = readerReturning();

    await expect(checkIntegrityBackupEvidence([], read)).resolves.toEqual({
      id: "backup_file_checksum_consistency",
      status: "clean"
    });
    expect(read).not.toHaveBeenCalled();
  });

  it("passes only record-selected filenames to the injected reader", async () => {
    const secondChecksum = "b".repeat(64);
    const secondFilename = `cubby-backup-v2-20260727T190000Z-${secondChecksum.slice(0, 12)}.json`;
    const secondRecord: IntegrityBackupRecord = {
      ...record,
      id: "second-record-secret",
      storageFilename: secondFilename,
      checksum: secondChecksum
    };
    const read = vi.fn<IntegrityBackupReader>(async (selectedFilename) =>
      selectedFilename === filename
        ? trustedRead
        : { ...trustedRead, filename: secondFilename, checksum: secondChecksum }
    );

    await checkIntegrityBackupEvidence([record, secondRecord], read);

    expect(read.mock.calls.map(([selectedFilename]) => selectedFilename)).toEqual([filename, secondFilename]);
    expect(read).not.toHaveBeenCalledWith("unassociated-backup.json");
  });

  it("returns deterministic safe redacted output", async () => {
    const privateValues = [
      record.id,
      record.householdId,
      filename,
      checksum,
      "C:\\private\\backup-root",
      "reader exploded"
    ];
    const failingReader = vi.fn<IntegrityBackupReader>(async () => {
      throw new Error("reader exploded at C:\\private\\backup-root");
    });

    const first = await checkIntegrityBackupEvidence([record], failingReader);
    const second = await checkIntegrityBackupEvidence([record], failingReader);
    const serialized = JSON.stringify(first);

    expect(second).toEqual(first);
    for (const privateValue of privateValues) {
      expect(serialized).not.toContain(privateValue);
    }
  });
});
