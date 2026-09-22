import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  GATES_RUN_BY_HAND,
  NON_GATE_VERIFY_SCRIPTS,
  VERIFY_GATES,
  selectedGates
} from "./verify-gates";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  scripts: Record<string, string>;
};
const workflow = readFileSync(new URL("../.github/workflows/verify.yml", import.meta.url), "utf8");

describe("verify gates", () => {
  it("runs a gate that actually exists as its own npm script", () => {
    for (const gate of VERIFY_GATES) {
      expect({ id: gate.id, script: gate.script in packageJson.scripts })
        .toEqual({ id: gate.id, script: true });
    }
    const ids = VERIFY_GATES.map((gate) => gate.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("classifies every verify script as automated, run by hand, or not a gate", () => {
    const classified = new Set<string>([
      ...VERIFY_GATES.map((gate) => gate.script),
      ...Object.keys(GATES_RUN_BY_HAND),
      ...Object.keys(NON_GATE_VERIFY_SCRIPTS)
    ]);
    const unclassified = Object.keys(packageJson.scripts)
      .filter((name) => name.startsWith("verify:"))
      .filter((name) => !classified.has(name));

    // A rehearsal added without being classified is one nobody has decided to run, which is exactly
    // how two of them came to be broken on main for weeks.
    expect(unclassified).toEqual([]);
  });

  it("names only real scripts in the run-by-hand and not-a-gate lists", () => {
    for (const script of [...Object.keys(GATES_RUN_BY_HAND), ...Object.keys(NON_GATE_VERIFY_SCRIPTS)]) {
      expect({ script, exists: script in packageJson.scripts }).toEqual({ script, exists: true });
    }
    for (const [script, reason] of Object.entries(NON_GATE_VERIFY_SCRIPTS)) {
      expect({ script, explained: reason.length > 8 }).toEqual({ script, explained: true });
    }
  });

  it("says why each run-by-hand rehearsal is not in CI, and never says it is merely slow", () => {
    // Slowness is what the image group is for. Leaving a rehearsal out needs a reason CI cannot fix,
    // otherwise it rots unnoticed the way verify:backup-recovery did across six merges.
    for (const [script, reason] of Object.entries(GATES_RUN_BY_HAND)) {
      expect({ script, explained: reason.length > 8 }).toEqual({ script, explained: true });
      expect({ script, excusedAsSlow: /\bslow\b|\btoo long\b/i.test(reason) })
        .toEqual({ script, excusedAsSlow: false });
    }
  });

  it("selects the canonical gates by default and the heavier groups on request", () => {
    expect(selectedGates([]).every((gate) => gate.group === "canonical")).toBe(true);
    expect(selectedGates(["--disposable"]).every((gate) => gate.group === "disposable")).toBe(true);
    expect(selectedGates(["--image"]).every((gate) => gate.group === "image")).toBe(true);
    expect(selectedGates(["--all"])).toHaveLength(VERIFY_GATES.length);
    expect(selectedGates([]).length).toBeGreaterThan(0);
    expect(selectedGates(["--disposable"]).length).toBeGreaterThan(0);
    expect(selectedGates(["--image"]).length).toBeGreaterThan(0);
  });

  it("drives continuous integration through the same runner, not a second copy of the list", () => {
    // If CI listed the gates itself, the two lists would drift and CI would quietly stop covering
    // whatever was added here.
    expect(workflow).toContain("npm run verify:gates\n");
    expect(workflow).toContain("npm run verify:gates:disposable\n");
    expect(workflow).toContain("npm run verify:gates:image\n");
    for (const gate of VERIFY_GATES) {
      expect({ id: gate.id, restated: workflow.includes(`npm run ${gate.script}`) })
        .toEqual({ id: gate.id, restated: false });
    }
  });

  it("runs every gate group in CI, so a new group cannot arrive without a job", () => {
    for (const group of new Set(VERIFY_GATES.map((gate) => gate.group))) {
      const invocation = group === "canonical" ? "npm run verify:gates\n" : `npm run verify:gates:${group}\n`;
      expect({ group, run: workflow.includes(invocation) }).toEqual({ group, run: true });
    }
  });

  it("runs on pull requests, so a broken gate is visible before a merge", () => {
    expect(workflow).toMatch(/^on:\s*$/m);
    expect(workflow).toMatch(/^\s{2}pull_request:\s*$/m);
    expect(workflow).toMatch(/^\s{2}push:\s*$/m);
    // A read-only token: verification never needs to write to the repository.
    expect(workflow).toMatch(/permissions:\s*\n\s*contents: read/);
  });
});
