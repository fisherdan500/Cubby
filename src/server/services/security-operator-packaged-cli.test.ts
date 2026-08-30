import { execSync, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

type PackagedOperatorCommand = {
  parseSecurityOperatorCommand: (args: readonly string[]) => unknown;
  runSecurityOperatorCommand: (
    args: readonly string[],
    loadDatabase: () => Promise<{ aggregate: ReturnType<typeof vi.fn> }>
  ) => Promise<{ exitCode: 0 | 1; output: string; stream: "stdout" | "stderr" }>;
};

describe("packaged security-operator CLI", () => {
  let packaged: PackagedOperatorCommand;

  beforeAll(async () => {
    execSync("npm run build:security-operator", { cwd: process.cwd(), stdio: "pipe" });
    packaged = (await import(`${pathToFileURL(resolve("dist/security-operator.mjs")).href}?test=${Date.now()}`)) as PackagedOperatorCommand;
  });

  it("parses an exact UTC date aggregate command without loading a database for malformed or help input", async () => {
    expect(packaged.parseSecurityOperatorCommand([
      "aggregate", "--from", "2026-08-01", "--to", "2026-09-01"
    ])).toEqual({ kind: "aggregate", from: "2026-08-01", to: "2026-09-01" });

    const loadDatabase = vi.fn();
    await expect(packaged.runSecurityOperatorCommand(["--help"], loadDatabase)).resolves.toMatchObject({ exitCode: 0, stream: "stdout" });
    await expect(packaged.runSecurityOperatorCommand(["aggregate", "--from", "2026-02-30", "--to", "2026-03-01"], loadDatabase)).resolves.toEqual({
      exitCode: 1,
      stream: "stderr",
      output: "security_operator_command_invalid"
    });
    expect(loadDatabase).not.toHaveBeenCalled();
  });

  it("enforces the inclusive-to-exclusive 31-day bound before database initialization", async () => {
    const loadDatabase = vi.fn();
    await expect(packaged.runSecurityOperatorCommand([
      "aggregate", "--from", "2026-08-01", "--to", "2026-09-02"
    ], loadDatabase)).resolves.toEqual({
      exitCode: 1,
      stream: "stderr",
      output: "security_operator_command_invalid"
    });
    expect(loadDatabase).not.toHaveBeenCalled();
  });

  it("writes schema version one aggregate JSON and sanitizes database failures", async () => {
    const aggregate = vi.fn().mockResolvedValue([
      { layer: "deployment", state: "quiet", coarseTimeBucket: "2026-08-01", incidentCount: 4n }
    ]);
    await expect(packaged.runSecurityOperatorCommand([
      "aggregate", "--from", "2026-08-01", "--to", "2026-08-02"
    ], async () => ({ aggregate }))).resolves.toEqual({
      exitCode: 0,
      stream: "stdout",
      output: JSON.stringify({
        schemaVersion: 1,
        from: "2026-08-01",
        to: "2026-08-02",
        aggregates: [{ layer: "deployment", state: "quiet", coarseTimeBucket: "2026-08-01", incidentCount: 4 }]
      })
    });

    const sentinel = "postgresql://operator:private-password@private-host";
    await expect(packaged.runSecurityOperatorCommand([
      "aggregate", "--from", "2026-08-01", "--to", "2026-08-02"
    ], async () => ({ aggregate: vi.fn().mockRejectedValue(new Error(sentinel)) }))).resolves.toEqual({
      exitCode: 1,
      stream: "stderr",
      output: "security_operator_operation_failed"
    });
  });

  it("runs the packaged entrypoint and rejects a malformed command before consulting its URL", () => {
    const result = spawnSync(
      process.execPath,
      [resolve("dist/security-operator.mjs"), "aggregate", "--from", "2026-02-30", "--to", "2026-03-01"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, SECURITY_OPERATOR_DATABASE_URL: "not-a-database-url" }
      }
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("security_operator_command_invalid\n");
  });
});
