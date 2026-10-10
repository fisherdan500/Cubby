import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { FRESHNESS_BROWSER_FAILURE_CODES } from "./cross-device-freshness-browser-contract.mjs";

const unknownFailure = "FRESHNESS_ACCEPTANCE_FAILED\nFRESHNESS_PHASE_UNKNOWN\n";
const packageScripts = JSON.parse(readFileSync("package.json", "utf8")).scripts;

async function packageResult(
  body: string,
  args: string[] = [],
  missingLoader = false,
  launcherTimeouts?: { startupMs: number; forceKillGraceMs: number }
) {
  const cache = resolve("node_modules/.cache");
  mkdirSync(cache, { recursive: true });
  const directory = mkdtempSync(resolve(cache, "freshness-output-"));
  try {
    mkdirSync(resolve(directory, "scripts"));
    writeFileSync(resolve(directory, "package.json"), JSON.stringify({ scripts: {
      "verify:cross-device-freshness": packageScripts["verify:cross-device-freshness"]
    } }));
    const entry = packageScripts["verify:cross-device-freshness"].split(" ").at(-1);
    expect(entry).toBe("scripts/cross-device-freshness-launcher.mjs");
    let launcherSource = readFileSync(entry, "utf8");
    if (launcherTimeouts) {
      launcherSource = launcherSource
        .replace("const STARTUP_TIMEOUT_MS = 30_000;", `const STARTUP_TIMEOUT_MS = ${launcherTimeouts.startupMs};`)
        .replace("const FORCE_KILL_GRACE_MS = 2_000;", `const FORCE_KILL_GRACE_MS = ${launcherTimeouts.forceKillGraceMs};`);
    }
    writeFileSync(resolve(directory, entry), launcherSource);
    copyFileSync("scripts/cross-device-freshness-browser-contract.mjs", resolve(directory, "scripts/cross-device-freshness-browser-contract.mjs"));
    // Only this synthetic child exists in the copied package. Never copy the resource-owning rehearsal.
    writeFileSync(resolve(directory, "scripts/cross-device-freshness.acceptance-rehearsal.ts"), body);
    if (missingLoader) {
      const loader = resolve(directory, "node_modules/tsx");
      mkdirSync(loader, { recursive: true });
      writeFileSync(resolve(loader, "package.json"), JSON.stringify({ name: "tsx", exports: "./missing.mjs" }));
    }
    const npmArgs = ["--silent", "run", "verify:cross-device-freshness", "--", ...args];
    const npmCommand = process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : "npm";
    const npmCommandArgs = process.platform === "win32" ? ["/d", "/s", "/c", "npm.cmd", ...npmArgs] : npmArgs;
    const forbidden = resolve(directory, "forbidden");
    const guard = resolve(directory, "guard.cjs");
    writeFileSync(guard, `
      const fs = require("node:fs"), cp = require("node:child_process"), path = require("node:path");
      const rehearsal = ${JSON.stringify(resolve(directory, "scripts/cross-device-freshness.acceptance-rehearsal.ts"))};
      const launcher = ${JSON.stringify(resolve(directory, entry))};
      const deny = () => { fs.writeFileSync(${JSON.stringify(forbidden)}, "forbidden"); throw Error("synthetic boundary violation"); };
      if ([launcher, rehearsal].includes(process.argv[1])) {
        for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
          const original = cp[name];
          cp[name] = function(command, args, ...rest) {
            if (process.argv[1] !== launcher || name !== "spawn" || command !== process.execPath ||
                args[0] !== "--import" || args[1] !== "tsx" || path.resolve(args[2]) !== rehearsal) deny();
            return original.call(this, command, args, ...rest);
          };
        }
        require("node:module").syncBuiltinESMExports();
      }
    `);
    const env = Object.fromEntries(["PATH", "Path", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "ComSpec", "PATHEXT"].map(key => [key, process.env[key]]));
    const result = await new Promise<{ code: number | null; stdout: string }>((done, reject) => {
      const child = spawn(npmCommand, npmCommandArgs, {
        cwd: directory, env: { ...env, NODE_ENV: "test", NODE_OPTIONS: `--require ${JSON.stringify(guard)}` },
        stdio: ["ignore", "pipe", "ignore"], windowsHide: true
      });
      let stdout = "";
      child.stdout.on("data", chunk => { stdout += String(chunk); });
      child.once("error", reject);
      child.once("close", code => done({ code, stdout }));
    });
    expect(existsSync(forbidden), "the real rehearsal/resource path must never be reached").toBe(false);
    return result;
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

it("L1 real package entry closes a startup failure without reaching the lifecycle", async () => {
  const result = await packageResult('throw new Error("synthetic startup failure");');
  expect(result.stdout).toBe(unknownFailure);
  expect(result.code).toBe(1);
});

it.each([
  ["import", 'import "./missing-synthetic-dependency.mjs";', false],
  ["TypeScript parse", "export const = ;", false],
  ["loader", 'process.stdout.write("FRESHNESS_ACCEPTANCE_PASS\\nFRESHNESS_CLEANUP_PASS\\n");', true],
  ["stderr-only marker", `process.stderr.write(${JSON.stringify(unknownFailure)}); process.exitCode = 1;`, false],
  ["markerless nonzero", "process.exitCode = 7;", false]
] as const)("L6 real package reduces %s failure", async (_, body, missingLoader) => {
  expect(await packageResult(body, [], missingLoader)).toEqual({ code: 1, stdout: unknownFailure });
});

it("L6 real package terminates a child that never reaches startup readiness", async () => {
  const started = Date.now();
  const result = await packageResult(
    "setTimeout(() => { process.exitCode = 97; }, 3_000);",
    [],
    false,
    { startupMs: 20, forceKillGraceMs: 20 }
  );
  expect(result).toEqual({ code: 1, stdout: unknownFailure });
  expect(Date.now() - started).toBeLessThan(2_800);
}, 10_000);

const acceptancePass = "FRESHNESS_ACCEPTANCE_PASS\nFRESHNESS_CLEANUP_PASS\n";
const fixtureFailure = "FRESHNESS_ACCEPTANCE_FAILED\nFRESHNESS_PHASE_FIXTURE\n";
it.each([
  [0, ""], [1, ""], [0, fixtureFailure], [1, acceptancePass],
  [null, fixtureFailure], [undefined, fixtureFailure], [NaN, fixtureFailure], [1.5, fixtureFailure], [-1, fixtureFailure], [256, fixtureFailure],
  [1, "FRESHNESS_ACCEPTANCE_FAILED\n"], [1, "FRESHNESS_PHASE_FIXTURE\n"],
  [1, fixtureFailure.trimEnd()], [1, fixtureFailure.replaceAll("\n", "\r\n")],
  [1, " " + fixtureFailure], [1, fixtureFailure + "\n"], [1, fixtureFailure + "extra"],
  [1, fixtureFailure + fixtureFailure], [1, fixtureFailure.replace("FIXTURE", "UNLISTED")],
  [1, fixtureFailure + "FRESHNESS_BROWSER_ACTIVITY_CREATE\n"],
  [1, "FRESHNESS_ACCEPTANCE_FAILED\nFRESHNESS_PHASE_BROWSER_OBSERVATION\n"],
  [1, "FRESHNESS_ACCEPTANCE_FAILED\nFRESHNESS_PHASE_BROWSER_OBSERVATION\nFRESHNESS_BROWSER_UNLISTED\n"],
  [1, "FRESHNESS_ACCEPTANCE_FAILED\nFRESHNESS_PHASE_BROWSER_OBSERVATION\nFRESHNESS_BROWSER_PASS\n"],
  [0, acceptancePass + "extra"], [0, "FRESHNESS_CLEANUP_PASS\n"],
  [1, fixtureFailure + "FRESHNESS_CLEANUP_FAILED\nFRESHNESS_CLEANUP_FAILED\n"],
  [1, "FRESHNESS_CLEANUP_FAILED\nFRESHNESS_ACCEPTANCE_FAILED\n"], [1, "x".repeat(1024)]
])("L7 rejects malformed or mismatched lifecycle output %#", async (code, candidate) => {
  const harness = await syntheticLauncher();
  harness.child.stdout.emit("data", Buffer.from(candidate as string));
  harness.child.emit("close", code, null);
  await harness.completion;
  expect(harness.stdout).toEqual([unknownFailure]);
  expect(harness.parent.exitCode).toBe(1);
});

it.each(["--invalid", "--recover"])("L8 invalid invocation %s cannot report success", async arg => {
  const harness = await syntheticLauncher({ args: [arg] });
  harness.child.stdout.emit("data", Buffer.from(acceptancePass));
  harness.child.emit("close", 0, null);
  await harness.completion;
  expect(harness.stdout).toEqual([unknownFailure]);
  expect(harness.parent.exitCode).toBe(1);
});

it("L9 stdout transport errors fail closed without abandoning the child", async () => {
  const harness = await syntheticLauncher();
  expect(() => harness.child.stdout.emit("error", Error("synthetic transport failure"))).not.toThrow();
  expect(harness.stdout).toEqual([]);
  harness.child.stdout.emit("data", Buffer.from(acceptancePass));
  harness.child.emit("close", 0, null);
  await harness.completion;
  expect(harness.stdout).toEqual([unknownFailure]);
});

it.each(["spawn throw", "spawn error", "contract import"])("L10 closes %s without retaining error content", async scenario => {
  const harness = await syntheticLauncher({ spawnThrows: scenario === "spawn throw", importFails: scenario === "contract import" });
  if (scenario === "spawn error") {
    harness.child.emit("error", new Proxy({}, { get() { throw Error("must not inspect errors"); } }));
    harness.child.emit("close", -1, null);
  }
  await harness.completion;
  expect(harness.stdout).toEqual([unknownFailure]);
  expect(harness.parent.exitCode).toBe(1);
  expect(harness.parent.listenerCount("SIGINT")).toBe(0);
  expect(harness.parent.listenerCount("SIGTERM")).toBe(0);
});

it("L11 preserves every closed phase and browser predicate, with and without cleanup failure", async () => {
  for (const phase of ["PREFLIGHT_EXPORT", "DOCKER_IMAGE_START", "FIXTURE", "ACTION_DISCOVERY", "BROWSER_LAUNCH", "BROWSER_OBSERVATION", "TERMINAL", "UNKNOWN"]) {
    for (const browser of phase === "BROWSER_OBSERVATION" ? FRESHNESS_BROWSER_FAILURE_CODES : [null]) {
      for (const cleanup of ["", "FRESHNESS_CLEANUP_FAILED\n"]) {
        const expected = `FRESHNESS_ACCEPTANCE_FAILED\nFRESHNESS_PHASE_${phase}\n`
          + (browser ? `FRESHNESS_BROWSER_${browser.toUpperCase()}\n` : "") + cleanup;
        const harness = await syntheticLauncher();
        for (const byte of Buffer.from(expected)) harness.child.stdout.emit("data", Buffer.from([byte]));
        harness.child.emit("close", 1, null);
        await harness.completion;
        expect(harness.stdout).toEqual([expected]);
        expect(harness.parent.exitCode).toBe(1);
      }
    }
  }
});

it("L12 bounds stdout before decoding and discards the candidate permanently after overflow", async () => {
  const harness = await syntheticLauncher();
  const decode = vi.fn(() => { throw Error("must not decode an over-limit chunk"); });
  harness.child.stdout.emit("data", { length: 1024, toString: decode });
  harness.child.stdout.emit("data", Buffer.from(fixtureFailure));
  harness.child.emit("close", 1, null);
  await harness.completion;
  expect(decode).not.toHaveBeenCalled();
  expect(harness.stdout).toEqual([unknownFailure]);
  const source = readFileSync("scripts/cross-device-freshness-launcher.mjs", "utf8");
  expect(source).toMatch(/candidate = "";\s*process\.stdout\.write/);
  expect(source).toMatch(/finally\s*\{\s*candidate = "";/);
});

it.each(["parent interrupt", "child signal", "IPC callback error", "IPC throw"])("L13 %s cannot produce success", async scenario => {
  const harness = await syntheticLauncher();
  if (scenario === "IPC throw") harness.child.send = () => { throw Error("synthetic IPC failure"); };
  if (scenario === "IPC callback error") harness.child.send = (_, callback) => { (callback as (error: Error) => void)?.(Error("synthetic IPC failure")); };
  if (scenario !== "child signal") harness.parent.emit("SIGTERM");
  harness.child.stdout.emit("data", Buffer.from(acceptancePass));
  harness.child.emit("close", 0, scenario === "child signal" ? "SIGTERM" : null);
  await harness.completion;
  expect(harness.stdout).toEqual([unknownFailure]);
  expect(harness.parent.exitCode).toBe(1);
  expect(harness.spawns).toHaveLength(1);
});

it("L14 discards stderr at spawn and owns exactly one non-detached child", async () => {
  const harness = await syntheticLauncher({ args: ["--recover", "synthetic-ledger"] });
  expect(harness.spawns).toEqual([["synthetic-node", ["--import", "tsx", "synthetic-child", "--recover", "synthetic-ledger"], {
    stdio: ["ignore", "pipe", "ignore", "ipc"], windowsHide: true
  }]]);
  harness.child.stdout.emit("data", Buffer.from("FRESHNESS_CLEANUP_PASS\n"));
  harness.child.emit("close", 0, null);
  await harness.completion;
  expect(harness.stdout).toEqual(["FRESHNESS_CLEANUP_PASS\n"]);
  expect(readFileSync("scripts/cross-device-freshness-launcher.mjs", "utf8")).not.toContain("stderr");
});

async function syntheticLauncher(options: {
  spawnThrows?: boolean;
  importFails?: boolean;
  args?: string[];
  ready?: boolean;
  startupTimeoutMs?: number;
  forceKillGraceMs?: number;
} = {}) {
  const source = ts.createSourceFile("launcher.mjs", readFileSync("scripts/cross-device-freshness-launcher.mjs", "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let code = source.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(source)).join("\n")
    .replace('import("./cross-device-freshness-browser-contract.mjs")', "loadContract()")
    .replaceAll("import.meta.url", '"file:///synthetic/launcher.mjs"');
  if (options.startupTimeoutMs !== undefined) {
    code = code.replace(/const STARTUP_TIMEOUT_MS = [^;]+;/, `const STARTUP_TIMEOUT_MS = ${options.startupTimeoutMs};`);
  }
  if (options.forceKillGraceMs !== undefined) {
    code = code.replace(/const FORCE_KILL_GRACE_MS = [^;]+;/, `const FORCE_KILL_GRACE_MS = ${options.forceKillGraceMs};`);
  }
  const stdout: string[] = [], sends: unknown[] = [], kills: unknown[] = [];
  const parent = Object.assign(new EventEmitter(), {
    argv: ["node", "synthetic-launcher", ...(options.args ?? [])], execPath: "synthetic-node", exitCode: 0,
    stdout: { write: (value: string) => stdout.push(value) }
  });
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(), connected: true,
    send: (value: unknown, callback?: () => void) => { sends.push(value); callback?.(); },
    kill: (signal?: unknown) => { kills.push(signal); return true; }
  });
  Object.defineProperty(child, "stderr", { get() { throw Error("stderr must never be accessed"); } });
  const spawns: unknown[][] = [];
  const completion = runInNewContext(code, {
    process: parent, URL, fileURLToPath: () => "synthetic-child",
    loadContract: async () => { if (options.importFails) throw Error("synthetic import failure"); return { FRESHNESS_BROWSER_FAILURE_CODES }; },
    spawn: (...args: unknown[]) => { spawns.push(args); if (options.spawnThrows) throw Error("synthetic spawn failure"); return child; },
    setTimeout, clearTimeout
  });
  await new Promise<void>(done => setImmediate(done));
  if (options.ready !== false) child.emit("message", "FRESHNESS_READY");
  return { parent, child, stdout, sends, kills, spawns, completion };
}

it.each(["SIGINT", "SIGTERM"])("L3 forwards %s cooperatively and waits for the owned child", async signal => {
  const harness = await syntheticLauncher();
  harness.parent.emit(signal);
  expect(harness.sends).toEqual(["FRESHNESS_INTERRUPT"]);
  expect(harness.stdout).toEqual([]);
  harness.child.stdout.emit("data", Buffer.from("FRESHNESS_ACCEPTANCE_FAILED\nFRESHNESS_PHASE_FIXTURE\nFRESHNESS_CLEANUP_FAILED\n"));
  harness.child.emit("close", 1, null);
  await harness.completion;
  expect(harness.stdout).toEqual(["FRESHNESS_ACCEPTANCE_FAILED\nFRESHNESS_PHASE_FIXTURE\nFRESHNESS_CLEANUP_FAILED\n"]);
  expect(harness.parent.exitCode).toBe(1);
  expect(harness.parent.listenerCount(signal)).toBe(0);
  expect(harness.spawns).toHaveLength(1);
});

it.each(["SIGINT", "SIGTERM"])("L16 terminates an unready child on early %s and emits only UNKNOWN", async signal => {
  const harness = await syntheticLauncher({ ready: false });
  harness.parent.emit(signal);
  expect(harness.sends).toEqual([]);
  harness.child.emit("close", 1, null);
  await harness.completion;
  expect(harness.kills).toEqual(["SIGTERM"]);
  expect(harness.stdout).toEqual([unknownFailure]);
});

it("L17 bounds startup and escalates termination when an unready child ignores SIGTERM", async () => {
  const harness = await syntheticLauncher({ ready: false, startupTimeoutMs: 5, forceKillGraceMs: 5 });
  // Wait for the escalation itself instead of sleeping a fixed span. The launcher schedules its
  // force kill 5ms after the SIGTERM, so under load both timers can slip past a wall-clock sleep;
  // close would then arrive first and the launcher would correctly skip the SIGKILL, failing this
  // test for a timing reason rather than a contract violation. The contract is that an unready
  // child IS escalated before close, so wait for that and let the bound fail if it never happens.
  // The bound stays under vitest's 5s default test timeout so a genuine escalation regression
  // reports the kills diff rather than a generic timeout.
  await vi.waitFor(() => expect(harness.kills).toEqual(["SIGTERM", "SIGKILL"]), { timeout: 2_000, interval: 1 });
  harness.child.emit("close", null, "SIGKILL");
  await harness.completion;
  // Not redundant with the wait above: this forbids a THIRD kill landing after close, proving the
  // close handler clears the pending force-kill timer.
  expect(harness.kills).toEqual(["SIGTERM", "SIGKILL"]);
  expect(harness.stdout).toEqual([unknownFailure]);
});

it.each([
  [0, "FRESHNESS_ACCEPTANCE_PASS\nFRESHNESS_CLEANUP_PASS\n", []],
  [1, "FRESHNESS_ACCEPTANCE_FAILED\nFRESHNESS_PHASE_FIXTURE\n", []],
  [1, "FRESHNESS_ACCEPTANCE_FAILED\nFRESHNESS_PHASE_BROWSER_OBSERVATION\nFRESHNESS_BROWSER_ACTIVITY_CREATE\n", []],
  [1, "FRESHNESS_ACCEPTANCE_FAILED\nFRESHNESS_CLEANUP_FAILED\n", []],
  [1, "FRESHNESS_ACCEPTANCE_FAILED\nFRESHNESS_PHASE_BROWSER_OBSERVATION\nFRESHNESS_BROWSER_ACTIVITY_CREATE\nFRESHNESS_CLEANUP_FAILED\n", []],
  [0, "FRESHNESS_CLEANUP_PASS\n", ["--recover", "synthetic-ledger"]]
] as const)("L2 preserves exact lifecycle output %#", async (code, stdout, args) => {
  const body = `if (JSON.stringify(process.argv.slice(2)) !== ${JSON.stringify(JSON.stringify(args))}) throw Error();\n`
    + `process.stdout.write(${JSON.stringify(stdout)}); process.exitCode = ${code};`;
  expect(await packageResult(body, [...args])).toEqual({ code, stdout });
});
