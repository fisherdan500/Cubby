import { describe, expect, it } from "vitest";

describe("readAutomatedBackupConfig", () => {
  it("uses fail-closed defaults when values are absent", async () => {
    const { readAutomatedBackupConfig } = await import("@/lib/automated-backup-config");

    expect(
      readAutomatedBackupConfig({
        AUTOMATED_BACKUPS_ENABLED: undefined,
        AUTOMATED_BACKUP_DIRECTORY: undefined,
        AUTOMATED_BACKUP_INTERVAL_HOURS: undefined,
        AUTOMATED_BACKUP_RETENTION_COUNT: undefined,
        AUTOMATED_BACKUP_POLL_MINUTES: undefined,
        AUTOMATED_BACKUP_RETRY_MINUTES: undefined
      })
    ).toEqual({
      enabled: false,
      directory: "/var/lib/cubby/backups",
      intervalHours: 24,
      retentionCount: 30,
      pollMinutes: 15,
      retryMinutes: 60
    });
  });

  it.each([
    ["true", true],
    ["false", false]
  ])("parses explicit boolean %s without truthy coercion", async (value, expected) => {
    const { readAutomatedBackupConfig } = await import("@/lib/automated-backup-config");

    expect(
      readAutomatedBackupConfig({
        AUTOMATED_BACKUPS_ENABLED: value
      }).enabled
    ).toBe(expected);
  });

  it.each(["TRUE", "1", "yes", "on", ""])("rejects invalid enabled value %s", async (value) => {
    const { readAutomatedBackupConfig } = await import("@/lib/automated-backup-config");

    expect(() =>
      readAutomatedBackupConfig({
        AUTOMATED_BACKUPS_ENABLED: value
      })
    ).toThrow(/AUTOMATED_BACKUPS_ENABLED/);
  });

  it.each([
    ["AUTOMATED_BACKUP_INTERVAL_HOURS", "0"],
    ["AUTOMATED_BACKUP_INTERVAL_HOURS", "169"],
    ["AUTOMATED_BACKUP_RETENTION_COUNT", "0"],
    ["AUTOMATED_BACKUP_POLL_MINUTES", "0"],
    ["AUTOMATED_BACKUP_RETRY_MINUTES", "0"],
    ["AUTOMATED_BACKUP_RETRY_MINUTES", "abc"]
  ])("rejects out-of-range integer %s=%s", async (key, value) => {
    const { readAutomatedBackupConfig } = await import("@/lib/automated-backup-config");

    expect(() =>
      readAutomatedBackupConfig({
        [key]: value
      })
    ).toThrow(new RegExp(key));
  });

  it.each(["", "   ", "/", "C:\\", "..\\backups", "../backups"])("rejects unsafe directory %s", async (directory) => {
    const { readAutomatedBackupConfig } = await import("@/lib/automated-backup-config");

    expect(() =>
      readAutomatedBackupConfig({
        AUTOMATED_BACKUP_DIRECTORY: directory
      })
    ).toThrow(/AUTOMATED_BACKUP_DIRECTORY/);
  });

  it("projects public status without directory or raw values", async () => {
    const { readAutomatedBackupConfig, automatedBackupStatusConfig } = await import("@/lib/automated-backup-config");

    const config = readAutomatedBackupConfig({
      AUTOMATED_BACKUPS_ENABLED: "true",
      AUTOMATED_BACKUP_DIRECTORY: "/var/lib/cubby/private-backups",
      AUTOMATED_BACKUP_INTERVAL_HOURS: "12",
      AUTOMATED_BACKUP_RETENTION_COUNT: "14",
      AUTOMATED_BACKUP_POLL_MINUTES: "5",
      AUTOMATED_BACKUP_RETRY_MINUTES: "20"
    });

    expect(automatedBackupStatusConfig(config)).toEqual({
      enabled: true,
      intervalHours: 12,
      retentionCount: 14,
      pollMinutes: 5,
      retryMinutes: 20
    });
    expect(automatedBackupStatusConfig(config)).not.toHaveProperty("directory");
  });
});
