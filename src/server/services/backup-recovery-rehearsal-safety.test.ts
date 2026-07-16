import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assertDisposableRehearsalConfig,
  createDisposableDatabaseUrl,
  parsePublishedAppPort,
  parsePublishedPostgresPort
} from "../../../scripts/backup-recovery-rehearsal";

describe("backup recovery rehearsal safety", () => {
  it("accepts only the isolated rehearsal compose identity", () => {
    expect(() =>
      assertDisposableRehearsalConfig({
        projectName: "cubby_backup_rehearsal_20260715_abcdef12",
        databaseName: "cubby_backup_rehearsal",
        databaseUser: "cubby_rehearsal",
        composeFile: "scripts/backup-recovery-rehearsal.compose.yml",
        backupDirectory: "/tmp/cubby-backup-rehearsal-files-abcd1234"
      })
    ).not.toThrow();
  });

  it.each([
    ["normal project", { projectName: "cubby" }],
    ["normal database", { databaseName: "cubby" }],
    ["normal user", { databaseUser: "cubby" }],
    ["normal compose file", { composeFile: "docker-compose.yml" }],
    ["environment file", { composeFile: ".env" }]
  ])("refuses %s access", (_label, override) => {
    expect(() =>
      assertDisposableRehearsalConfig({
        projectName: "cubby_backup_rehearsal_20260715_abcdef12",
        databaseName: "cubby_backup_rehearsal",
        databaseUser: "cubby_rehearsal",
        composeFile: "scripts/backup-recovery-rehearsal.compose.yml",
        backupDirectory: "/tmp/cubby-backup-rehearsal-files-abcd1234",
        ...override
      })
    ).toThrow("refusing_non_disposable_backup_rehearsal");
  });

  it("refuses a non-disposable backup directory", () => {
    expect(() =>
      assertDisposableRehearsalConfig({
        projectName: "cubby_backup_rehearsal_20260715_abcdef12",
        databaseName: "cubby_backup_rehearsal",
        databaseUser: "cubby_rehearsal",
        composeFile: "scripts/backup-recovery-rehearsal.compose.yml",
        backupDirectory: "/var/lib/cubby/backups"
      })
    ).toThrow("refusing_non_disposable_backup_rehearsal");
  });

  it("accepts only a loopback Docker-published PostgreSQL port", () => {
    expect(parsePublishedPostgresPort("127.0.0.1:49157\n")).toBe(49157);
    expect(() => parsePublishedPostgresPort("0.0.0.0:49157")).toThrow(
      "refusing_non_loopback_backup_rehearsal"
    );
    expect(() => parsePublishedPostgresPort("127.0.0.1:5432")).toThrow(
      "refusing_default_postgres_port"
    );
  });

  it("accepts only a loopback non-default Docker-published app port", () => {
    expect(parsePublishedAppPort("127.0.0.1:49158\n")).toBe(49158);
    expect(() => parsePublishedAppPort("0.0.0.0:49158")).toThrow(
      "refusing_non_loopback_backup_rehearsal"
    );
    expect(() => parsePublishedAppPort("127.0.0.1:3000")).toThrow(
      "refusing_default_app_port"
    );
  });

  it("URL-encodes the generated disposable credential for authentication", () => {
    expect(createDisposableDatabaseUrl(49157, "temporary p@ssword:/?#")).toBe(
      "postgresql://cubby_rehearsal:temporary%20p%40ssword%3A%2F%3F%23@127.0.0.1:49157/cubby_backup_rehearsal?schema=public"
    );
  });

  it("uses one explicit timezone for the disposable app and host-side timer probe", () => {
    const compose = readFileSync(
      new URL("../../../scripts/backup-recovery-rehearsal.compose.yml", import.meta.url),
      "utf8"
    );
    const probe = readFileSync(
      new URL("../../../scripts/backup-container-replacement-probe.mjs", import.meta.url),
      "utf8"
    );

    expect(compose).toContain("APP_TIMEZONE: Etc/UTC");
    expect(probe).toContain('timeZone: "Etc/UTC"');
  });

  it("requires the write freeze before creating the selected final backup", () => {
    const runbook = readFileSync(
      new URL("../../../docs/ALWAYS_ON_UPDATES.md", import.meta.url),
      "utf8"
    );
    const preparation = runbook.slice(
      runbook.indexOf("## Before The Maintenance Window"),
      runbook.indexOf("## Fail-Closed Preflight")
    );

    expect(preparation).toMatch(
      /Block household writes[\s\S]*Create the final Cubby version 2 JSON backup/
    );
  });
});
