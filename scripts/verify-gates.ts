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
 * through Docker Compose, so they are slower and are kept as a separate group. `image` gates also
 * build the application image, which is slower again, so they are a third group rather than a reason
 * to leave them unrun. Every gate runs even after an earlier one fails, because one run should tell
 * you everything that is broken.
 */

export type VerifyGateGroup = "canonical" | "disposable" | "image";

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
  { id: "baby-edit-delete", group: "disposable", script: "verify:baby-edit-delete", what: "baby edit, permanent removal and history-preserving deletion against real PostgreSQL" },
  { id: "baby-photo", group: "disposable", script: "verify:baby-photo", what: "baby photo attachment type, composite foreign key, one-served-photo-per-baby and ownership checks against real PostgreSQL" },
  { id: "user-photo", group: "disposable", script: "verify:user-photo", what: "user photo attachment type, composite member foreign key, one-current-picture-per-membership and ownership checks against real PostgreSQL" },
  { id: "photo-upload", group: "disposable", script: "verify:photo-upload", what: "a real photo upload through the real service, including the audit event it writes, against real PostgreSQL" },
  { id: "profile-photo", group: "disposable", script: "verify:profile-photo", what: "a member sets their own profile picture through the real service, against real PostgreSQL" },
  { id: "overnight-log", group: "disposable", script: "verify:overnight-log", what: "an activity that crosses midnight appears on both days, against real PostgreSQL" },
  { id: "activity-photo", group: "disposable", script: "verify:activity-photo", what: "a photo on a logged entry stays a feed photo on a real post, and cannot link across households" },
  { id: "invitation-email-delivery", group: "disposable", script: "verify:invitation-email-delivery", what: "invitation email queue, grants, sending and cancellation against real PostgreSQL" },
  { id: "browser-operation-pilot", group: "disposable", script: "verify:browser-operation-pilot", what: "browser-operation constraints against real PostgreSQL" },
  { id: "sprout-preview-commit", group: "disposable", script: "verify:sprout-preview-commit", what: "Sprout preview and commit against real PostgreSQL" },
  { id: "platform-first-account", group: "disposable", script: "verify:platform-first-account", what: "first-account setup with the setup code against real PostgreSQL" },
  { id: "backup-recovery", group: "image", script: "verify:backup-recovery", what: "backup, restore, and container replacement against a built application image" },
  { id: "browser-operation-save-path", group: "image", script: "verify:browser-operation-save-path", what: "the end-to-end save path against a built application image" },
  { id: "admin-assisted-accounts", group: "image", script: "verify:admin-assisted-accounts", what: "admin-assisted account creation, password reset and the first-login corridor against a built application image" },
  { id: "simplified-signup", group: "image", script: "verify:simplified-signup", what: "an invited user completing signup over real HTTP with no recovery codes, no typed household name and no admin acknowledgement" },
  { id: "quick-start", group: "image", script: "verify:quick-start", what: "the documented fresh-server quick start, from an empty checkout to a signed-in owner" },
  { id: "system-backup", group: "image", script: "verify:system-backup", what: "a whole-server backup, the server lost, and everything restored onto a fresh install" }
];

export type VerifyGateOutcome = { id: string; group: VerifyGateGroup; passed: boolean; seconds: number };

/**
 * The rehearsals that stay out of the groups above, each with the reason it cannot simply be run on
 * every pass. Being slow is not one of those reasons - that is what the `image` group is for. The
 * reason is recorded because its absence is what let `verify:backup-recovery` sit broken across six
 * merges: nobody could tell whether it was excluded on purpose or by neglect.
 */
export const GATES_RUN_BY_HAND: Readonly<Record<string, string>> = {
  "verify:cross-device-freshness": "separately approved disposable production-image lifecycle with two local Chrome profiles and wall-clock freshness bounds",
  "verify:performance-1y": "a wall-clock budget, and a shared CI runner's timings do not mean anything",
  "verify:performance-5y": "a wall-clock budget, and a shared CI runner's timings do not mean anything",
  "verify:performance-input": "a wall-clock budget, and it drives a real local Chrome over CDP",
  "verify:p1-3-migrator-bootstrap": "it inspects an existing local `cubby-app` image rather than building one",
  "verify:p1-3-invitation-acceptance": "it drives a real local Chrome over CDP and wants roughly 12 GB free",
  "verify:baby-photo-gate-proof": "it edits the tracked baby-photo migration in place to prove each constraint is load-bearing, so it must never run against a shared checkout",
  "verify:user-photo-gate-proof": "it edits tracked user-photo source in place to prove each protection is load-bearing, so it must never run against a shared checkout"
};

/**
 * `verify:` scripts that are not gates at all, and why. Every `verify:` script has to appear in one of
 * these three lists, so a new rehearsal cannot be added without someone deciding whether it runs.
 */
export const NON_GATE_VERIFY_SCRIPTS: Readonly<Record<string, string>> = {
  "verify:gates": "this runner",
  "verify:gates:all": "this runner",
  "verify:gates:disposable": "this runner",
  "verify:gates:image": "this runner",
  "verify:update-rehearsal": "a second name for verify:backup-recovery",
  "verify:update-preflight": "an operator command run against a live host before an update",
  "verify:integrity": "the operator's integrity command, run against a real database"
};

export function selectedGates(args: readonly string[]) {
  const groups = new Set<VerifyGateGroup>(
    args.includes("--all")
      ? ["canonical", "disposable", "image"]
      : args.includes("--disposable")
        ? ["disposable"]
        : args.includes("--image")
          ? ["image"]
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
    // On stdout with the rest of the summary: a separate stream interleaves, and this line read as
    // though it came before the results it summarizes.
    console.log(`verify_gates_failed: ${failed.map((outcome) => outcome.id).join(", ")}`);
    return 1;
  }
  // Says which gates ran, so a pass is never mistaken for a pass of every gate there is.
  console.log(`verify_gates_passed: ${outcomes.length} ${groups} of ${VERIFY_GATES.length} total`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = runVerifyGates(process.argv.slice(2));
}
