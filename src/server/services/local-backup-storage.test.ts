import { afterEach, describe, expect, it } from "vitest";
import { access, mkdir, mkdtemp, readdir, rename, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createV2Backup, MAX_BACKUP_BYTES } from "@/server/services/backup-format";
import {
  formatBackupFilename,
  publishLocalBackup,
  readLocalBackup,
  reconcileLocalBackupTemps,
  removeLocalBackup,
  scanLocalBackups
} from "@/server/services/local-backup-storage";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(async (dir) => import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true, force: true }))));
});

describe("local backup storage", () => {
  it("formats deterministic canonical filenames", () => {
    expect(formatBackupFilename("2026-07-15T21:50:13.000Z", "a".repeat(64))).toBe(
      "cubby-backup-v2-20260715T215013Z-aaaaaaaaaaaa.json"
    );
    expect(formatBackupFilename(
      "2026-07-15T21:50:13.000Z",
      "a".repeat(64),
      "b".repeat(32)
    )).toBe("cubby-backup-v2-20260715T215013Z-aaaaaaaaaaaa-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.json");
  });

  it("treats an absent read-only scan directory as having no local versions", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "cubby-backup-storage-"));
    tempRoots.push(parent);

    await expect(scanLocalBackups(path.join(parent, "not-created"))).resolves.toEqual([]);
  });

  it("publishes, reads, and scans a valid v2 backup", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cubby-backup-storage-"));
    tempRoots.push(dir);
    const json = JSON.stringify(
      createV2Backup({
        household: { name: "Home" },
        settings: {},
        babies: [],
        contacts: [],
        catalogs: [],
        activities: [],
        calendarEvents: [],
        reminders: []
      }, "2026-07-15T21:50:13.000Z"),
      null,
      2
    );

    const stored = await publishLocalBackup(dir, json);
    expect(stored.filename).toBe("cubby-backup-v2-20260715T215013Z-" + stored.checksum.slice(0, 12) + ".json");
    expect((await readLocalBackup(dir, stored.filename)).householdName).toBe("Home");
    expect(await scanLocalBackups(dir)).toEqual([expect.objectContaining({ healthy: true, filename: stored.filename })]);
  });

  it("never overwrites an existing immutable version", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cubby-backup-storage-"));
    tempRoots.push(dir);
    const json = JSON.stringify(createV2Backup({
      household: { name: "Home" }, settings: {}, babies: [], contacts: [], catalogs: [], activities: [], calendarEvents: [], reminders: []
    }, "2026-07-15T21:50:13.000Z"));

    await publishLocalBackup(dir, json);
    await expect(publishLocalBackup(dir, json)).rejects.toThrow("backup_already_exists");
    expect((await scanLocalBackups(dir)).filter((file) => file.healthy)).toHaveLength(1);
  });

  it("rejects a configured backup root that is a symlink", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "cubby-backup-symlink-"));
    tempRoots.push(parent);
    const target = path.join(parent, "target");
    const linkedRoot = path.join(parent, "linked-root");
    await mkdir(target);
    await symlink(target, linkedRoot, process.platform === "win32" ? "junction" : "dir");
    const json = JSON.stringify(createV2Backup({
      household: { name: "Home" }, settings: {}, babies: [], contacts: [], catalogs: [], activities: [], calendarEvents: [], reminders: []
    }, "2026-07-15T21:50:13.000Z"));

    await expect(publishLocalBackup(linkedRoot, json)).rejects.toThrow("backup_directory_unavailable");
    expect(await import("node:fs/promises").then((fs) => fs.readdir(target))).toEqual([]);
  });

  it("rejects publication when the validated root is replaced before opening the temp file", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "cubby-backup-root-race-"));
    tempRoots.push(parent);
    const backupRoot = path.join(parent, "backups");
    const movedRoot = path.join(parent, "moved-backups");
    const outside = path.join(parent, "outside");
    await mkdir(backupRoot);
    await mkdir(outside);
    const json = JSON.stringify(createV2Backup({
      household: { name: "Home" }, settings: {}, babies: [], contacts: [], catalogs: [], activities: [], calendarEvents: [], reminders: []
    }, "2026-07-15T21:50:13.000Z"));

    await expect(publishLocalBackup(backupRoot, json, {
      afterRootValidated: async () => {
        await rename(backupRoot, movedRoot);
        await rename(outside, backupRoot);
      }
    })).rejects.toThrow("backup_directory_unavailable");
    expect(await readdir(backupRoot)).toEqual([]);
    expect(await readdir(movedRoot)).toEqual([]);
  });

  it("rejects publication when the root is replaced before final verification", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "cubby-backup-final-read-race-"));
    tempRoots.push(parent);
    const backupRoot = path.join(parent, "backups");
    const movedRoot = path.join(parent, "moved-backups");
    const replacementRoot = path.join(parent, "replacement");
    await mkdir(backupRoot);
    await mkdir(replacementRoot);
    const json = JSON.stringify(createV2Backup({
      household: { name: "Home" }, settings: {}, babies: [], contacts: [], catalogs: [], activities: [], calendarEvents: [], reminders: []
    }, "2026-07-15T21:50:13.000Z"));
    const parsed = JSON.parse(json) as { checksum: string; exportedAt: string };
    const filename = formatBackupFilename(parsed.exportedAt, parsed.checksum);
    await writeFile(path.join(replacementRoot, filename), json);

    await expect(publishLocalBackup(backupRoot, json, {
      beforeFinalRead: async () => {
        await rename(backupRoot, movedRoot);
        await rename(replacementRoot, backupRoot);
      }
    })).rejects.toThrow("backup_directory_unavailable");
    await expect(access(path.join(backupRoot, filename))).resolves.toBeUndefined();
    await expect(access(path.join(movedRoot, filename))).resolves.toBeUndefined();
  });

  it("does not unlink a final file after the root drifts during failure cleanup", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "cubby-backup-cleanup-race-"));
    tempRoots.push(parent);
    const backupRoot = path.join(parent, "backups");
    const movedRoot = path.join(parent, "moved-backups");
    const replacementRoot = path.join(parent, "replacement");
    await mkdir(backupRoot);
    await mkdir(replacementRoot);
    const json = JSON.stringify(createV2Backup({
      household: { name: "Home" }, settings: {}, babies: [], contacts: [], catalogs: [], activities: [], calendarEvents: [], reminders: []
    }, "2026-07-15T21:50:13.000Z"));
    const parsed = JSON.parse(json) as { checksum: string; exportedAt: string };
    const filename = formatBackupFilename(parsed.exportedAt, parsed.checksum);
    await writeFile(path.join(replacementRoot, filename), "outside-marker");

    await expect(publishLocalBackup(backupRoot, json, {
      afterFinalLinked: () => {
        throw new Error("force cleanup");
      },
      afterFailedTempUnlinked: async () => {
        await rename(backupRoot, movedRoot);
        await rename(replacementRoot, backupRoot);
      }
    })).rejects.toThrow("backup_write_failed");
    await expect(access(path.join(backupRoot, filename))).resolves.toBeUndefined();
    await expect(access(path.join(movedRoot, filename))).resolves.toBeUndefined();
  });

  it("rejects deletion when the validated root is replaced before unlink", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "cubby-backup-delete-race-"));
    tempRoots.push(parent);
    const backupRoot = path.join(parent, "backups");
    const movedRoot = path.join(parent, "moved-backups");
    const outside = path.join(parent, "outside");
    await mkdir(backupRoot);
    await mkdir(outside);
    const json = JSON.stringify(createV2Backup({
      household: { name: "Home" }, settings: {}, babies: [], contacts: [], catalogs: [], activities: [], calendarEvents: [], reminders: []
    }, "2026-07-15T21:50:13.000Z"));
    const stored = await publishLocalBackup(backupRoot, json);
    await writeFile(path.join(outside, stored.filename), "outside-marker");

    await expect(removeLocalBackup(backupRoot, stored.filename, {
      beforeUnlink: async () => {
        await rename(backupRoot, movedRoot);
        await rename(outside, backupRoot);
      }
    })).rejects.toThrow("backup_directory_unavailable");
    await expect(access(path.join(backupRoot, stored.filename))).resolves.toBeUndefined();
    await expect(access(path.join(movedRoot, stored.filename))).resolves.toBeUndefined();
  });

  it("rejects a recognized final-file symlink even when O_NOFOLLOW is unavailable", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "cubby-backup-leaf-symlink-"));
    tempRoots.push(parent);
    const outside = path.join(parent, "outside");
    const backupRoot = path.join(parent, "backups");
    await mkdir(outside);
    await mkdir(backupRoot);
    const json = JSON.stringify(createV2Backup({
      household: { name: "Outside" }, settings: {}, babies: [], contacts: [], catalogs: [], activities: [], calendarEvents: [], reminders: []
    }, "2026-07-15T21:50:13.000Z"));
    const outsideFile = await publishLocalBackup(outside, json);
    const linkedEntry = path.join(backupRoot, outsideFile.filename);
    if (process.platform === "win32") {
      const junctionTarget = path.join(parent, "outside-junction-target");
      await mkdir(junctionTarget);
      await symlink(junctionTarget, linkedEntry, "junction");
    } else {
      await symlink(path.join(outside, outsideFile.filename), linkedEntry, "file");
    }

    await expect(readLocalBackup(backupRoot, outsideFile.filename)).rejects.toThrow("backup_invalid");
    expect(await scanLocalBackups(backupRoot)).toEqual([
      { healthy: false, filename: outsideFile.filename, errorCode: "backup_invalid" }
    ]);
  });

  it("does not let unrelated entries consume the recognized candidate scan limit", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cubby-backup-storage-"));
    tempRoots.push(dir);
    await Promise.all(Array.from({ length: 500 }, (_, index) => writeFile(path.join(dir, `aaa-note-${String(index).padStart(3, "0")}.txt`), "ignore")));
    const json = JSON.stringify(createV2Backup({
      household: { name: "Home" }, settings: {}, babies: [], contacts: [], catalogs: [], activities: [], calendarEvents: [], reminders: []
    }, "2026-07-15T21:50:13.000Z"));
    const stored = await publishLocalBackup(dir, json);

    expect(await scanLocalBackups(dir)).toEqual([
      expect.objectContaining({ healthy: true, filename: stored.filename })
    ]);
  });

  it("rejects a valid envelope stored under a mismatched canonical filename", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cubby-backup-storage-"));
    tempRoots.push(dir);
    const json = JSON.stringify(createV2Backup({
      household: { name: "Home" }, settings: {}, babies: [], contacts: [], catalogs: [], activities: [], calendarEvents: [], reminders: []
    }, "2026-07-15T21:50:13.000Z"));
    const stored = await publishLocalBackup(dir, json);
    const mismatched = stored.filename.replace(stored.checksum.slice(0, 12), "b".repeat(12));
    await rename(path.join(dir, stored.filename), path.join(dir, mismatched));

    await expect(readLocalBackup(dir, mismatched)).rejects.toThrow("backup_invalid");
    expect(await scanLocalBackups(dir)).toEqual([
      { healthy: false, filename: mismatched, errorCode: "backup_invalid" }
    ]);
  });

  it("rejects an oversized generated backup before publishing a final file", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cubby-backup-storage-"));
    tempRoots.push(dir);
    const json = JSON.stringify(createV2Backup({
      household: { name: "Home" }, settings: {}, babies: [], contacts: [], catalogs: [], activities: [], calendarEvents: [], reminders: []
    }, "2026-07-15T21:50:13.000Z")) + " ".repeat(MAX_BACKUP_BYTES);

    await expect(publishLocalBackup(dir, json)).rejects.toThrow("backup_too_large");
    expect(await scanLocalBackups(dir)).toEqual([]);
  });

  it("removes the synced temp file when publication fails before linking", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cubby-backup-storage-"));
    tempRoots.push(dir);
    const json = JSON.stringify(createV2Backup({
      household: { name: "Home" }, settings: {}, babies: [], contacts: [], catalogs: [], activities: [], calendarEvents: [], reminders: []
    }, "2026-07-15T21:50:13.000Z"));

    await expect(publishLocalBackup(dir, json, {
      afterTempFileSynced: () => {
        throw Object.assign(new Error("simulated disk failure"), { code: "ENOSPC" });
      }
    })).rejects.toThrow("backup_write_failed");
    expect(await import("node:fs/promises").then((fs) => fs.readdir(dir))).toEqual([]);
  });

  it("cleans up only stale recognized temp files", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cubby-backup-storage-"));
    tempRoots.push(dir);
    const stale = path.join(dir, ".cubby-backup-v2-20260715T215013Z-aaaaaaaaaaaa.json.stale.tmp");
    const fresh = path.join(dir, ".cubby-backup-v2-20260715T215014Z-bbbbbbbbbbbb.json.fresh.tmp");
    await writeFile(stale, "stale");
    await writeFile(fresh, "fresh");
    await utimes(stale, new Date("2026-07-13T21:50:13.000Z"), new Date("2026-07-13T21:50:13.000Z"));
    await writeFile(path.join(dir, "notes.txt"), "keep");

    await reconcileLocalBackupTemps(dir, new Date("2026-07-15T21:50:13.000Z"));

    await expect(import("node:fs/promises").then((fs) => fs.access(stale))).rejects.toThrow();
    await expect(import("node:fs/promises").then((fs) => fs.access(fresh))).resolves.toBeUndefined();
  });

  it("rejects stale-temp cleanup when the validated root is replaced before unlink", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "cubby-backup-temp-race-"));
    tempRoots.push(parent);
    const backupRoot = path.join(parent, "backups");
    const movedRoot = path.join(parent, "moved-backups");
    const outside = path.join(parent, "outside");
    await mkdir(backupRoot);
    await mkdir(outside);
    const tempName = ".cubby-backup-v2-20260715T215013Z-aaaaaaaaaaaa.json.stale.tmp";
    await writeFile(path.join(backupRoot, tempName), "inside");
    await writeFile(path.join(outside, tempName), "outside");
    await utimes(
      path.join(backupRoot, tempName),
      new Date("2026-07-13T21:50:13.000Z"),
      new Date("2026-07-13T21:50:13.000Z")
    );

    await expect(reconcileLocalBackupTemps(backupRoot, new Date("2026-07-15T21:50:13.000Z"), {
      beforeUnlink: async () => {
        await rename(backupRoot, movedRoot);
        await rename(outside, backupRoot);
      }
    })).rejects.toThrow("backup_directory_unavailable");
    await expect(access(path.join(backupRoot, tempName))).resolves.toBeUndefined();
    await expect(access(path.join(movedRoot, tempName))).resolves.toBeUndefined();
  });
});
