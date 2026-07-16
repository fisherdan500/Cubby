import { describe, expect, it, vi } from "vitest";
import { createV2Backup } from "@/server/services/backup-format";
import {
  BACKUP_FREE_SPACE_FLOOR_BYTES,
  DATABASE_FREE_SPACE_FLOOR_BYTES,
  MAX_BACKUP_AGE_MS,
  runPreflight,
  type CommandResult,
  type PreflightAdapters
} from "./update-preflight";

function adapters(): PreflightAdapters {
  return {
    now: () => new Date("2026-07-16T12:00:00.000Z"),
    readFile: vi.fn(),
    run: vi.fn()
  };
}

const payload = {
  household: { name: "Home" }, settings: {}, babies: [], contacts: [], catalogs: [],
  activities: [], calendarEvents: [], reminders: []
};

function validAdapters(overrides: Partial<PreflightAdapters> = {}): PreflightAdapters {
  const backup = createV2Backup(payload, "2026-07-16T11:00:00.000Z");
  const run = vi.fn((_program: string, args: readonly string[]): CommandResult => {
    const key = args.join(" ");
    if (key === "compose config --quiet") return { kind: "success", stdout: "" };
    if (key === "compose ps --format json app postgres") return { kind: "success", stdout: JSON.stringify([
      { Service: "app", State: "running", Health: "healthy" },
      { Service: "postgres", State: "running", Health: "healthy" }
    ]) };
    if (key === "compose ps -q app") return { kind: "success", stdout: "app-id\n" };
    if (key === "compose ps -q postgres") return { kind: "success", stdout: "postgres-id\n" };
    if (args[0] === "inspect" && args.at(-1) === "app-id") return { kind: "success", stdout: "bind | /var/lib/cubby/backups\n" };
    if (args[0] === "inspect" && args.at(-1) === "postgres-id") return { kind: "success", stdout: "volume | /var/lib/postgresql/data\n" };
    if (args.some((arg) => arg.includes("/api/health"))) return { kind: "success", stdout: JSON.stringify({ ok: true, body: '{"status":"ready"}' }) };
    if (args.some((arg) => arg.includes("process.env"))) return { kind: "success", stdout: '{"present":true}' };
    if (args.at(-1) === "/var/lib/cubby/backups") return { kind: "success", stdout: "Filesystem 1024-blocks Used Available Capacity Mounted on\nfs 999999 1 200000 1% /var/lib/cubby/backups\n" };
    if (args.at(-1) === "/var/lib/postgresql/data") return { kind: "success", stdout: "Filesystem 1024-blocks Used Available Capacity Mounted on\nfs 9999999 1 2000000 1% /var/lib/postgresql/data\n" };
    return { kind: "failure" };
  });
  return { now: () => new Date("2026-07-16T12:00:00.000Z"), readFile: vi.fn(() => JSON.stringify(backup)), run, ...overrides };
}

describe("update preflight", () => {
  it("rejects a missing backup argument before using adapters", () => {
    const io = adapters();
    const result = runPreflight([], io);

    expect(result.exitCode).toBe(1);
    expect(result.lines).toEqual(["FAIL backup-argument", "FAIL preflight-summary"]);
    expect(io.readFile).not.toHaveBeenCalled();
    expect(io.run).not.toHaveBeenCalled();
  });

  it("rejects malformed backup arguments before using adapters", () => {
    for (const args of [["--backup-file"], ["--backup-file", ""], ["--other", "backup.json"], ["--backup-file", "a", "extra"]]) {
      const io = adapters();
      expect(runPreflight(args, io).exitCode).toBe(1);
      expect(io.readFile).not.toHaveBeenCalled();
      expect(io.run).not.toHaveBeenCalled();
    }
  });

  it("accepts only a canonical checksummed v2 backup within the documented freshness limit", () => {
    expect(MAX_BACKUP_AGE_MS).toBe(24 * 60 * 60 * 1_000);
    expect(runPreflight(["--backup-file", "selected.json"], validAdapters()).lines).toContain("PASS backup-v2-checksum-freshness");

    const v1 = validAdapters({ readFile: () => JSON.stringify({ version: 1, babies: [], activities: [] }) });
    expect(runPreflight(["--backup-file", "selected.json"], v1).lines).toContain("FAIL backup-v2-checksum-freshness");
    const stale = createV2Backup(payload, new Date(Date.parse("2026-07-16T12:00:00.000Z") - MAX_BACKUP_AGE_MS - 1).toISOString());
    expect(runPreflight(["--backup-file", "selected.json"], validAdapters({ readFile: () => JSON.stringify(stale) })).lines).toContain("FAIL backup-v2-checksum-freshness");
    const corrupt = { ...createV2Backup(payload), checksum: "0".repeat(64) };
    expect(runPreflight(["--backup-file", "selected.json"], validAdapters({ readFile: () => JSON.stringify(corrupt) })).lines).toContain("FAIL backup-v2-checksum-freshness");
  });

  it("passes every named check with complete healthy read-only results", () => {
    const result = runPreflight(["--backup-file", "selected.json"], validAdapters());
    expect(result.exitCode).toBe(0);
    expect(result.lines).toEqual([
      "PASS backup-argument", "PASS backup-v2-checksum-freshness", "PASS compose-config",
      "PASS app-running-healthy", "PASS postgres-running-healthy", "PASS api-health-ready",
      "PASS required-environment-names", "PASS app-backup-persistent-mount",
      "PASS postgres-data-persistent-mount", "PASS backup-filesystem-free-space",
      "PASS database-filesystem-free-space", "PASS preflight-summary"
    ]);
  });

  it("accepts newline-delimited service objects from Docker Compose 5.2", () => {
    for (const separator of ["\n", String.fromCharCode(13, 10)]) {
      const base = validAdapters();
      const original = base.run;
      base.run = vi.fn((program: string, args: readonly string[]): CommandResult =>
        args.join(" ") === "compose ps --format json app postgres"
          ? {
              kind: "success",
              stdout: [
                JSON.stringify({ Service: "app", State: "running", Health: "healthy" }),
                JSON.stringify({ Service: "postgres", State: "running", Health: "healthy" })
              ].join(separator)
            }
          : original(program, args)
      );

      const result = runPreflight(["--backup-file", "selected.json"], base);

      expect(result.exitCode).toBe(0);
      expect(result.lines).toContain("PASS app-running-healthy");
      expect(result.lines).toContain("PASS postgres-running-healthy");
    }
  });

  it("fails closed for unsafe newline-delimited service output", () => {
    const app = JSON.stringify({ Service: "app", State: "running", Health: "healthy" });
    const postgres = JSON.stringify({ Service: "postgres", State: "running", Health: "healthy" });
    const unsafeOutputs = [
      "",
      `${app}\nnot-json`,
      app,
      `${app}\n${postgres}\n${JSON.stringify({ Service: "extra", State: "running", Health: "healthy" })}`,
      `${app}\n\n${postgres}`,
      `${app}\n${app}`,
      `${app}\n${JSON.stringify({ Service: "postgres", State: "running", Health: "unhealthy" })}`
    ];

    for (const stdout of unsafeOutputs) {
      const base = validAdapters();
      const original = base.run;
      base.run = vi.fn((program: string, args: readonly string[]): CommandResult =>
        args.join(" ") === "compose ps --format json app postgres"
          ? { kind: "success", stdout }
          : original(program, args)
      );

      const result = runPreflight(["--backup-file", "selected.json"], base);

      expect(result.exitCode).toBe(1);
      expect(result.lines).toContain("FAIL preflight-summary");
      expect(result.lines.some((line) =>
        line === "FAIL app-running-healthy" || line === "FAIL postgres-running-healthy"
      )).toBe(true);
    }
  });

  it("fails closed for command failure, timeout, malformed, partial, and oversized results", () => {
    const badResults: CommandResult[] = [
      { kind: "failure", stderr: "secret" }, { kind: "timeout", error: new Error("secret") },
      { kind: "success", stdout: "not-json" }, { kind: "success", stdout: '{"present":true}' },
      { kind: "success", stdout: "x".repeat(64 * 1024 + 1) }
    ];
    for (const bad of badResults) {
      const base = validAdapters();
      const original = base.run;
      base.run = vi.fn((program: string, args: readonly string[]): CommandResult =>
        args.join(" ") === "compose ps --format json app postgres" ? bad : original(program, args));
      const result = runPreflight(["--backup-file", "selected.json"], base);
      expect(result.exitCode).toBe(1);
      expect(result.lines).toContain("FAIL app-running-healthy");
      expect(result.lines).toContain("FAIL postgres-running-healthy");
    }
  });

  it("fails closed when a command adapter throws", () => {
    const base = validAdapters({
      run: () => {
        throw new Error("postgresql://private-value");
      }
    });

    expect(() => runPreflight(["--backup-file", "selected.json"], base)).not.toThrow();
    const result = runPreflight(["--backup-file", "selected.json"], base);
    expect(result.exitCode).toBe(1);
    expect(result.lines).toContain("FAIL compose-config");
    expect(result.lines.join("\n")).not.toContain("private-value");
  });

  it("requires exact mount targets and documented free-space floors", () => {
    expect(BACKUP_FREE_SPACE_FLOOR_BYTES).toBe(100 * 1024 * 1024);
    expect(DATABASE_FREE_SPACE_FLOOR_BYTES).toBe(1024 * 1024 * 1024);
    const base = validAdapters();
    const original = base.run;
    base.run = vi.fn((program: string, args: readonly string[]): CommandResult => {
      if (args[0] === "inspect") return { kind: "success", stdout: "/wrong/target\n" };
      if (args.at(-1) === "/var/lib/cubby/backups" || args.at(-1) === "/var/lib/postgresql/data")
        return { kind: "success", stdout: "Filesystem 1024-blocks Used Available Capacity Mounted on\nfs 1 1 1 99% /\n" };
      return original(program, args);
    });
    const result = runPreflight(["--backup-file", "selected.json"], base);
    expect(result.lines.filter((line) => line.startsWith("FAIL"))).toEqual([
      "FAIL app-backup-persistent-mount", "FAIL postgres-data-persistent-mount",
      "FAIL backup-filesystem-free-space", "FAIL database-filesystem-free-space", "FAIL preflight-summary"
    ]);
  });

  it("emits only named checks and redacts paths, secrets, URLs, payloads, Docker output, and child errors", () => {
    const sensitive = [
      "C:\\private\\family-backup.json", "super-secret-value", "postgresql://user:pass@db/cubby",
      '{"Mounts":[{"Source":"/private/source"}]}', JSON.stringify(createV2Backup(payload)), "spawn docker ENOENT"
    ];
    const io = validAdapters({
      readFile: () => { throw new Error(sensitive.join(" ")); },
      run: () => ({ kind: "failure", stdout: sensitive.join(" "), stderr: sensitive.join(" "), error: new Error(sensitive.join(" ")) })
    });
    const result = runPreflight(["--backup-file", sensitive[0]], io);
    const output = result.lines.join("\n");
    expect(result.lines.every((line) => /^(PASS|FAIL) [a-z0-9-]+$/.test(line))).toBe(true);
    for (const value of sensitive) expect(output).not.toContain(value);
  });
});
