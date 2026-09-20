import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * One command that runs Cubby's verification gates and says which of them failed.
 *
 * The gates existed already; nothing ran them together, and nothing ran them on a schedule. Two of the
 * three disposable rehearsals were broken on main for weeks before anyone noticed, and before that two
 * browser probes were silently invalidated by a dashboard rebuild. A gate nobody runs is not a gate.
 *
 * `canonical` gates need only this checkout. `disposable` gates each boot their own throwaway Postgres
 * through Docker Compose, so they are slower and are kept as a separate group. Every gate runs even
 * after an earlier one fails, because one run should tell you everything that is broken.
 */

export type VerifyGateGroup = "canonical" | "disposable";

export type VerifyGate = {
  id: string;
  group: VerifyGateGroup;
  /** The npm script this gate runs. It is the same command a person would type. */
  script: string;
  what: string;
};

export const VERIFY_GATES: readonly VerifyGate[] = [
  { id: "typecheck", group: "canonical", script: "typecheck", what: "TypeScript over the whole tree" },
  { id: "lint", group: "canonical", script: "lint", what: "ESLint" },
  { id: "operation-registry", group: "canonical", script: "operation-registry:check", what: "operation registry structure and generated artifacts" },
  { id: "unit", group: "canonical", script: "test", what: "the unit and contract suite" },
  { id: "script-unit", group: "canonical", script: "test:scripts", what: "the self-contained tests beside the scripts" },
  { id: "integrity-suite", group: "disposable", script: "verify:integrity-suite", what: "every integrity check against real PostgreSQL" },
  { id: "activity-update-safety", group: "disposable", script: "verify:activity-update-safety", what: "activity update reauthorization and replay against real PostgreSQL" },
  { id: "browser-operation-pilot", group: "disposable", script: "verify:browser-operation-pilot", what: "browser-operation constraints against real PostgreSQL" }
];

export type VerifyGateOutcome = { id: string; group: VerifyGateGroup; passed: boolean; seconds: number };

/**
 * The heavier rehearsals that stay out of the groups above: each builds the application image, and
 * `performance-input` additionally needs a local Chrome. They are run deliberately, not on every pass.
 */
export const GATES_RUN_BY_HAND = [
  "verify:backup-recovery",
  "verify:browser-operation-save-path",
  "verify:sprout-preview-commit",
  "verify:performance-1y",
  "verify:performance-5y",
  "verify:performance-input",
  "verify:p1-3-migrator-bootstrap",
  "verify:p1-3-invitation-acceptance"
] as const;

/**
 * `verify:` scripts that are not gates at all, and why. Every `verify:` script has to appear in one of
 * these three lists, so a new rehearsal cannot be added without someone deciding whether it runs.
 */
export const NON_GATE_VERIFY_SCRIPTS: Readonly<Record<string, string>> = {
  "verify:gates": "this runner",
  "verify:gates:all": "this runner",
  "verify:gates:disposable": "this runner",
  "verify:update-rehearsal": "a second name for verify:backup-recovery",
  "verify:update-preflight": "an operator command run against a live host before an update",
  "verify:integrity": "the operator's integrity command, run against a real database"
};

export function selectedGates(args: readonly string[]) {
  const groups = new Set<VerifyGateGroup>(
    args.includes("--all")
      ? ["canonical", "disposable"]
      : args.includes("--disposable")
        ? ["disposable"]
        : ["canonical"]
  );
  return VERIFY_GATES.filter((gate) => groups.has(gate.group));
}

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

/**
 * npm's own CLI entry point, so each gate is a plain child process. Spawning `npm` by name needs a
 * shell on Windows, where it is a `.cmd`, and passing arguments through a shell is both a deprecation
 * warning and a quoting hazard.
 */
function npmCommand(script: string): { command: string; args: string[]; shell: boolean } {
  const npmCli = process.env.npm_execpath;
  if (npmCli && npmCli.endsWith(".js")) return { command: process.execPath, args: [npmCli, "run", script], shell: false };
  return { command: "npm", args: ["run", script], shell: process.platform === "win32" };
}

function runGate(gate: VerifyGate): VerifyGateOutcome {
  const startedAt = Date.now();
  console.log(`\n=== ${gate.id}: ${gate.what} ===`);
  const { command, args, shell } = npmCommand(gate.script);
  const result = spawnSync(command, args, { cwd: repositoryRoot, stdio: "inherit", shell });
  return {
    id: gate.id,
    group: gate.group,
    passed: !result.error && result.status === 0,
    seconds: Math.round((Date.now() - startedAt) / 100) / 10
  };
}

export function runVerifyGates(args: readonly string[]) {
  const gates = selectedGates(args);
  const outcomes = gates.map(runGate);

  console.log("\n=== verify-gates ===");
  for (const outcome of outcomes) {
    console.log(`${outcome.passed ? "PASS" : "FAIL"} ${outcome.id} (${outcome.group}, ${outcome.seconds}s)`);
  }
  const groups = [...new Set(gates.map((gate) => gate.group))].join(" and ");
  const failed = outcomes.filter((outcome) => !outcome.passed);
  if (failed.length) {
    console.error(`verify_gates_failed: ${failed.map((outcome) => outcome.id).join(", ")}`);
    return 1;
  }
  // Says which gates ran, so a pass is never mistaken for a pass of every gate there is.
  console.log(`verify_gates_passed: ${outcomes.length} ${groups} of ${VERIFY_GATES.length} total`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = runVerifyGates(process.argv.slice(2));
}
