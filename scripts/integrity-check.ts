import { fileURLToPath } from "node:url";
import { integrityExitCode, type IntegrityReport } from "../src/server/services/integrity";

export type IntegrityCommand = { format: "human" | "json"; scope: "all" };

export type IntegrityCommandOperations = {
  run: () => Promise<IntegrityReport>;
};

type LoadIntegrityCommandOperations = () => Promise<IntegrityCommandOperations>;

export function parseIntegrityCommand(args: readonly string[]): IntegrityCommand {
  if (args.length !== 4) throw new Error("integrity_command_usage");
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag || !value || !["--format", "--scope"].includes(flag) || values.has(flag)) {
      throw new Error("integrity_command_usage");
    }
    values.set(flag, value);
  }
  const format = values.get("--format");
  const scope = values.get("--scope");
  if ((format !== "json" && format !== "human") || scope !== "all" || values.size !== 2) {
    throw new Error("integrity_command_usage");
  }
  return { format, scope };
}

export function formatIntegrityReport(report: IntegrityReport, format: IntegrityCommand["format"]) {
  if (format === "json") return JSON.stringify(report);
  return [
    `Integrity ${report.status}: ${report.findings.length} finding group(s)`,
    `Report version: ${report.version}`,
    `Evidence fingerprint: ${report.evidenceFingerprint}`
  ].join("\n");
}

export async function runIntegrityCommand(
  args: readonly string[],
  loadOperations: LoadIntegrityCommandOperations,
  write: (line: string, error?: boolean) => void
) {
  try {
    const command = parseIntegrityCommand(args);
    const operations = await loadOperations();
    const report = await operations.run();
    write(formatIntegrityReport(report, command.format));
    return integrityExitCode(report);
  } catch (error) {
    const code = error instanceof Error && error.message === "integrity_command_usage" ? error.message : "integrity_command_failed";
    write(`Integrity command failed: ${code}`, true);
    return 4;
  }
}

async function loadOperations(): Promise<IntegrityCommandOperations> {
  const [{ prisma }, { runDatabaseIntegritySuite }] = await Promise.all([
    import("../src/lib/db/prisma"),
    import("../src/server/services/integrity")
  ]);
  return { run: () => runDatabaseIntegritySuite(prisma) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void runIntegrityCommand(process.argv.slice(2), loadOperations, (line, error) => {
    (error ? process.stderr : process.stdout).write(`${line}\n`);
  }).then((exitCode) => {
      process.exitCode = exitCode;
    });
}
