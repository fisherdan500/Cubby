import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createV2Backup } from "@/server/services/backup-format";
import { checkIntegrityBackupEvidence, type IntegrityBackupRecord } from "@/server/services/integrity-backup-evidence";
import { localBackupIntegrityReader } from "@/server/services/integrity";
import { publishLocalBackup, publishLocalBackupArchive } from "@/server/services/local-backup-storage";

// The other backup-evidence tests hand the check a reader's verdict. These write real backup files,
// damage them on disk the way storage or a person can, and read them back through the same reader the
// scheduled suite uses, so the detector is proven against the corruption it is named for.

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function storedBackup() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cubby-integrity-backup-"));
  tempRoots.push(directory);
  const json = JSON.stringify(
    createV2Backup({
      household: { name: "Integrity Fixture Home" },
      settings: {},
      babies: [],
      contacts: [],
      catalogs: [],
      activities: [],
      calendarEvents: [],
      reminders: []
    }, "2026-09-20T08:00:00.000Z"),
    null,
    2
  );
  const stored = await publishLocalBackup(directory, json);
  const record: IntegrityBackupRecord = {
    id: "backup-record-fixture",
    householdId: "household-fixture",
    kind: "automated_export",
    storageFilename: stored.filename,
    checksum: stored.checksum,
    byteSize: stored.size,
    itemCount: stored.itemCount,
    createdAt: "2026-09-20T08:00:01.000Z"
  };
  return { directory, record, filePath: path.join(directory, stored.filename) };
}

describe("integrity backup evidence over real backup files", () => {
  it("reports an intact backup file as clean", async () => {
    const { directory, record } = await storedBackup();

    await expect(checkIntegrityBackupEvidence([record], localBackupIntegrityReader(() => directory)))
      .resolves.toEqual({ id: "backup_file_checksum_consistency", status: "clean" });
  });

  it("reports a backup whose payload was altered after its checksum was written", async () => {
    const { directory, record, filePath } = await storedBackup();
    const original = await readFile(filePath, "utf8");
    const tampered = original.replace("Integrity Fixture Home", "Integrity Fixture Hone");
    expect(tampered).not.toBe(original);
    await writeFile(filePath, tampered, "utf8");

    // The payload no longer hashes to the checksum the file and the database both carry: the one
    // corruption a checksum consistency check exists to report, not an unreadable file.
    await expect(checkIntegrityBackupEvidence([record], localBackupIntegrityReader(() => directory)))
      .resolves.toMatchObject({
        id: "backup_file_checksum_consistency",
        status: "findings",
        count: 1,
        fileFindings: { count: 1 }
      });
  });

  it("reports a backup file rewritten to different bytes than the database recorded", async () => {
    const { directory, record, filePath } = await storedBackup();
    const compact = JSON.stringify(JSON.parse(await readFile(filePath, "utf8")));
    await writeFile(filePath, compact, "utf8");

    await expect(checkIntegrityBackupEvidence([record], localBackupIntegrityReader(() => directory)))
      .resolves.toMatchObject({ id: "backup_file_checksum_consistency", status: "findings", count: 1 });
  });

  it("reports a database record whose checksum no longer matches its intact file", async () => {
    const { directory, record } = await storedBackup();
    const drifted = { ...record, checksum: `${record.checksum!.slice(0, 63)}${record.checksum!.endsWith("0") ? "1" : "0"}` };

    await expect(checkIntegrityBackupEvidence([drifted], localBackupIntegrityReader(() => directory)))
      .resolves.toMatchObject({ id: "backup_file_checksum_consistency", status: "findings", count: 1 });
  });

  it("checks every photo in an archived backup, and reports one that changed", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "cubby-integrity-archive-"));
    tempRoots.push(directory);
    const photo = Buffer.from("a photo's bytes");
    const snapshot = createV2Backup({
      household: { name: "Integrity Fixture Home" }, settings: {}, babies: [], contacts: [], catalogs: [], activities: [], calendarEvents: [], reminders: [],
      feedPosts: [{ id: "post-1", babyId: null, body: "", tags: [], occurredAt: "2026-09-20T08:00:00.000Z", authorName: "Sam" }],
      feedPhotos: [{ id: "ph-1", postId: "post-1", position: 0, width: 10, height: 10, byteSize: photo.length, sha256: createHash("sha256").update(photo).digest("hex") }]
    }, "2026-09-20T08:00:00.000Z");
    const stored = await publishLocalBackupArchive(directory, snapshot, async () => photo);
    const record: IntegrityBackupRecord = {
      id: "backup-record-archive", householdId: "household-fixture", kind: "automated_export", storageFilename: stored.filename,
      checksum: stored.checksum, byteSize: stored.size, itemCount: stored.itemCount, createdAt: "2026-09-20T08:00:01.000Z"
    };

    await expect(checkIntegrityBackupEvidence([record], localBackupIntegrityReader(() => directory)))
      .resolves.toEqual({ id: "backup_file_checksum_consistency", status: "clean" });

    const filePath = path.join(directory, stored.filename);
    const bytes = await readFile(filePath);
    bytes[bytes.indexOf(photo)] ^= 0xff;
    await writeFile(filePath, bytes);
    await expect(checkIntegrityBackupEvidence([record], localBackupIntegrityReader(() => directory)))
      .resolves.toMatchObject({ id: "backup_file_checksum_consistency", status: "findings", fileFindings: { count: 1 } });
  });

  it("still treats a missing backup directory as unavailable evidence, not a finding", async () => {
    const { directory, record } = await storedBackup();

    await expect(checkIntegrityBackupEvidence([record], localBackupIntegrityReader(() => path.join(directory, "absent"))))
      .resolves.toMatchObject({ id: "backup_file_checksum_unavailable", status: "incomplete" });
  });
});
