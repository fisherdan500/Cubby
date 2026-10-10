import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { expect, it, vi } from "vitest";
import { GATES_RUN_BY_HAND } from "./verify-gates";
import * as rehearsal from "./cross-device-freshness.acceptance-rehearsal";
import { FRESHNESS_BROWSER_FAILURE_CODES, browserFailure, browserFailureCode, formatBrowserFailure } from "./cross-device-freshness-browser-contract.mjs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import ts from "typescript";
import { runInNewContext } from "node:vm";
import { createRequire } from "node:module";
import { discoverPackageCommands, discoverStructuralExclusions } from "../src/server/operation-registry/checker";
import { EventEmitter } from "node:events";

const textOfNode = (node: ts.Node) => node.getSourceFile()
  ? node.getText(node.getSourceFile()) : String((node as { kind: number }).kind);
const read = (path: string) => existsSync(path) ? readFileSync(path, "utf8") : "";

it("D1 retains one primary phase when cleanup succeeds", async () => {
  const events: string[] = [];
  const failure = await rehearsal.withFreshnessCleanup(
    async () => { events.push("body"); throw Error("synthetic private child output"); },
    async () => { events.push("cleanup"); },
    () => "fixture"
  ).catch((error: unknown) => error);
  expect(events).toEqual(["body", "cleanup"]);
  expect(rehearsal.formatFreshnessFailure(failure)).toBe("FRESHNESS_ACCEPTANCE_FAILED\nFRESHNESS_PHASE_FIXTURE\n");
});

it("D2 retains the primary phase separately from cleanup failure", async () => {
  const events: string[] = [];
  const failure = await rehearsal.withFreshnessCleanup(
    async () => { events.push("body"); throw Error("synthetic primary details"); },
    async () => { events.push("cleanup"); throw Error("synthetic cleanup details"); },
    () => "fixture"
  ).catch((error: unknown) => error);
  expect(events).toEqual(["body", "cleanup"]);
  expect(rehearsal.formatFreshnessFailure(failure)).toBe("FRESHNESS_ACCEPTANCE_FAILED\nFRESHNESS_PHASE_FIXTURE\nFRESHNESS_CLEANUP_FAILED\n");
});

it("D3 reports cleanup-only failure without fabricating a primary phase", async () => {
  const events: string[] = [];
  const failure = await rehearsal.withFreshnessCleanup(
    async () => { events.push("observations passed"); },
    async () => { events.push("cleanup"); throw undefined; },
    () => "browser_observation"
  ).catch((error: unknown) => error);
  expect(events).toEqual(["observations passed", "cleanup"]);
  expect(rehearsal.formatFreshnessFailure(failure)).toBe("FRESHNESS_ACCEPTANCE_FAILED\nFRESHNESS_CLEANUP_FAILED\n");
});

function harnessFunction(name: string, bindings: Record<string, unknown>) {
  const source = ts.createSourceFile("rehearsal.ts", read("scripts/cross-device-freshness.acceptance-rehearsal.ts"), ts.ScriptTarget.Latest, true);
  const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  expect(declaration).toBeDefined();
  const javascript = ts.transpile(`(${declaration!.getText(source).replace(/^export /, "")})`, { target: ts.ScriptTarget.ESNext });
  return runInNewContext(javascript, bindings) as (...args: unknown[]) => Promise<void>;
}

function probeFunction(name: string, bindings: Record<string, unknown>) {
  const source = ts.createSourceFile("probe.mjs", read("scripts/cross-device-freshness-browser-probe.mjs"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  expect(declaration).toBeDefined();
  return runInNewContext(`(${declaration!.getText(source)})`, bindings) as (...args: unknown[]) => Promise<unknown>;
}

function simulatedLedger(platform = "win32", options: { rejectCommand?: boolean; mode?: number; uid?: number; unverifiableOwner?: boolean; redirected?: string } = {}) {
  const events: string[] = [];
  const directory = resolve(tmpdir(), "cubby-freshness-ledgers");
  const project = "cubby_freshness_0123456789abcdef";
  const ledger = { version: 1, project, image: `${project}:acceptance`, directory: resolve(tmpdir(), `${project}-0123456789ab`), exportedCommit: "a".repeat(40), pid: 1234 };
  const run = vi.fn(async (_command: string, _args: string[]) => {
    events.push("secure-command");
    if (options.rejectCommand) throw Error();
    return "";
  });
  const mkdir = vi.fn(() => { events.push("mkdir"); });
  const write = vi.fn(() => { events.push("write"); });
  const persist = harnessFunction("persistLedger", {
    ...rehearsal, resolve, tmpdir, ledgerDirectory: () => directory,
    process: { platform, getuid: options.unverifiableOwner ? undefined : () => 1000 },
    assertOwnedPath: (path: string) => { events.push(`owned:${path}`); if (path === options.redirected) throw Error(); },
    mkdirSync: mkdir, run, osEnvironment: () => ({}),
    lstatSync: () => ({ mode: options.mode ?? 0o700, uid: options.uid ?? 1000 }),
    writeFileSync: write,
    openSync: (path: string, flag: string) => { events.push("open"); expect(path).toBe(resolve(directory, `${project}.json`)); expect(flag).toBe("r+"); return 42; },
    fsyncSync: (descriptor: number) => { expect(descriptor).toBe(42); events.push("fsync"); },
    closeSync: (descriptor: number) => { expect(descriptor).toBe(42); events.push("close"); },
    fail: () => { throw Error(); }
  });
  return { persist: () => persist(ledger), run, mkdir, write, events, ledger, directory };
}

it("ACL1 atomically creates the Windows ledger directory with DirectorySecurity and never Set-Acl", async () => {
  const harness = simulatedLedger();
  await harness.persist();
  const [command, args] = harness.run.mock.calls[0];
  expect(command).toBe("powershell.exe");
  expect(args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-Command"]);
  const script = args[3];
  expect(script).not.toMatch(/Set-Acl|icacls|chmod/i);
  expect(script).toContain("$directory = New-Object System.IO.DirectoryInfo($env:FRESHNESS_LEDGER_DIRECTORY)");
  expect(script).toMatch(/if \(!\$directory\.Exists\) \{\s*\$acl = New-Object System\.Security\.AccessControl\.DirectorySecurity/);
  expect(script).toContain("$acl.SetAccessRuleProtection($true, $false)");
  expect(script).toContain("$acl.SetOwner($sid)");
  expect(script).toContain("New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')");
  expect(script).toMatch(/\$acl\.AddAccessRule\(\$rule\)\s*\$directory\.Create\(\$acl\)\s*\}/);
  expect(script).toBe((rehearsal as Record<string, unknown>).WINDOWS_LEDGER_DIRECTORY_COMMAND);
});

it("ACL2 never pre-creates the Windows ledger directory with Node mkdir", async () => {
  const harness = simulatedLedger();
  await harness.persist();
  expect(harness.mkdir).not.toHaveBeenCalled();
  expect(harness.events.slice(0, 3)).toEqual([`owned:${tmpdir()}`, `owned:${harness.directory}`, "secure-command"]);
  expect(harness.events.indexOf("write")).toBeGreaterThan(harness.events.lastIndexOf(`owned:${harness.directory}`));
  expect(harness.events.lastIndexOf(`owned:${harness.directory}`)).toBeGreaterThan(harness.events.indexOf("secure-command"));
});

it("ACL3 validates the exact actual Windows ACL for both new and existing directories and fails silently", async () => {
  const harness = simulatedLedger();
  await harness.persist();
  const script = harness.run.mock.calls[0][1][3];
  expect(script).toContain("$ErrorActionPreference = 'Stop'");
  expect(script).toContain("$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User");
  expect(script).toMatch(/\$directory\.Create\(\$acl\)\s*\}\s*\$actual = \$directory\.GetAccessControl\(\)/);
  expect(script).toContain("$rules = @($actual.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))");
  expect(script).toMatch(/if \(\$actual\.GetOwner\(\[System\.Security\.Principal\.SecurityIdentifier\]\)\.Value -ne \$sid\.Value -or\s*!\$actual\.AreAccessRulesProtected -or \$rules\.Count -ne 1\) \{ exit 1 \}/);
  expect(script).toMatch(/\$rule = \$rules\[0\]\s*if \(\$rule\.IsInherited -or \$rule\.IdentityReference\.Value -ne \$sid\.Value -or\s*\$rule\.AccessControlType -ne \[System\.Security\.AccessControl\.AccessControlType\]::Allow -or\s*\$rule\.FileSystemRights -ne \[System\.Security\.AccessControl\.FileSystemRights\]::FullControl -or\s*\$rule\.InheritanceFlags -ne \(\[System\.Security\.AccessControl\.InheritanceFlags\]::ContainerInherit -bor \[System\.Security\.AccessControl\.InheritanceFlags\]::ObjectInherit\) -or\s*\$rule\.PropagationFlags -ne \[System\.Security\.AccessControl\.PropagationFlags\]::None\) \{ exit 1 \}/);
  expect(script).toMatch(/try \{[\s\S]+\} catch \{ exit 1 \}\s*$/);
  expect(script).not.toMatch(/Write-|\$_|throw|Set-Acl|SetAccessControl/i);
});

it("ACL4 refuses a ledger write when the Windows security command rejects creation or ACL validation", async () => {
  const harness = simulatedLedger("win32", { rejectCommand: true });
  expect(await harness.persist().then(() => false, () => true)).toBe(true);
  expect(harness.run).toHaveBeenCalledTimes(1);
  expect(harness.write).not.toHaveBeenCalled();
  expect(harness.events).not.toContain("fsync");
});

it.each(["temporary root", "ledger directory"])("ACL5 refuses a redirected %s before security commands or writes", async (boundary) => {
  const harness = simulatedLedger("win32", { redirected: boundary === "temporary root" ? tmpdir() : resolve(tmpdir(), "cubby-freshness-ledgers") });
  expect(await harness.persist().then(() => false, () => true)).toBe(true);
  expect(harness.run).not.toHaveBeenCalled();
  expect(harness.write).not.toHaveBeenCalled();
});

it.each(["win32", "linux"])("ACL6 permits only the exclusive content-free ledger write and fsync after validation on %s", async (platform) => {
  const harness = simulatedLedger(platform);
  await harness.persist();
  expect(harness.write).toHaveBeenCalledTimes(1);
  expect(harness.write).toHaveBeenCalledWith(resolve(harness.directory, `${harness.ledger.project}.json`), JSON.stringify(harness.ledger), { mode: 0o600, flag: "wx" });
  expect(harness.events.slice(-4)).toEqual(["write", "open", "fsync", "close"]);
  if (platform !== "win32") {
    expect(harness.run).not.toHaveBeenCalled();
    expect(harness.mkdir).toHaveBeenCalledWith(harness.directory, { recursive: true, mode: 0o700 });
  }
});

it.each([
  { mode: 0o770 }, { mode: 0o707 }, { uid: 1001 }, { unverifiableOwner: true }
])("ACL7 fails closed on non-Windows with insecure or unverifiable ownership/mode %j", async (options) => {
  const harness = simulatedLedger("linux", options);
  expect(await harness.persist().then(() => false, () => true)).toBe(true);
  expect(harness.run).not.toHaveBeenCalled();
  expect(harness.write).not.toHaveBeenCalled();
  expect(harness.events).not.toContain("fsync");
});

function simulatedAcceptance(failedPhase?: string, cleanupFails = false, browserCode?: string) {
  const stdout: string[] = [];
  const cleanup = vi.fn(async () => { if (cleanupFails) throw Error("synthetic cleanup detail"); });
  const lifecycle = vi.fn(rehearsal.withFreshnessCleanup);
  const persist = vi.fn(async () => "synthetic-ledger");
  const child = { stderr: { on: (_: string, receive: (chunk: string) => void) => receive("DevTools listening on ws://127.0.0.1:12345/devtools/browser/synthetic") }, once: () => {} };
  const rejectAt = (phase: string) => { if (failedPhase === phase) throw phase === "browser_observation" && browserCode ? browserFailure(browserCode) : Error("synthetic private failure"); };
  const processStub = { platform: "win32", pid: 123, env: { CUBBY_FRESHNESS_ACCEPTED_COMMIT: "a".repeat(40) }, on: () => {}, off: () => {}, stdout: { write: (value: string) => stdout.push(value) } };
  const run = harnessFunction("runCrossDeviceFreshnessRehearsal", {
    ...rehearsal, process: processStub, root: "synthetic-root", AbortController,
    resolve, basename: () => "chrome.exe", tmpdir: () => "synthetic-temp", existsSync: () => true,
    randomBytes: () => ({ toString: () => "synthetic" }), pause: async () => {},
    run: async (_: string, args: string[]) => { rejectAt("preflight_export"); return args[0] === "rev-parse" ? "a".repeat(40) : ""; },
    persistLedger: persist, cleanLedger: cleanup,
    withFreshnessCleanup: lifecycle,
    mkdirSync: () => {}, rmSync: () => {}, writeFileSync: () => {},
    readFileSync: (path: string) => path.endsWith(".yml") ? "context: ..\n  app:\n" : `"${"a".repeat(40)}":x.createCalendarEventAction`,
    childEnvironments: () => ({ compose: {}, chrome: {}, fixture: {}, node: {} }),
    execute: async (_: unknown, command: string, args: string[], ...options: unknown[]) => {
      if (args.includes("up")) rejectAt("docker_image_start");
      if (args.includes("exec")) rejectAt("fixture");
      if (args.includes("cp")) rejectAt("action_discovery");
      if (args.includes("port")) return "127.0.0.1:12345";
      if (args.includes("ps")) return "a".repeat(12);
      if (args.includes("inspect")) return "npipe:////./pipe/synthetic";
      if (args.includes("rev-parse")) return "a".repeat(40);
      if (command === undefined) { expect(options[4]).toBe(true); rejectAt("browser_observation"); return ""; }
      return "";
    },
    spawn: () => { rejectAt("browser_launch"); return child; },
    setTimeout: () => 1, clearTimeout: () => {},
    freshnessTerminalOutcome: (passed: boolean, aborted: boolean) => { rejectAt("terminal"); return rehearsal.freshnessTerminalOutcome(passed, aborted); },
    fail: () => { throw Error("synthetic validation failure"); }
  });
  return { run, stdout, cleanup, lifecycle, persist };
}

it.each(["message", "disconnect"])("L4 CLI routes launcher %s to the existing signal path", async event => {
  const processStub = Object.assign(new EventEmitter(), { exitCode: 0, connected: true, send: vi.fn() });
  let interrupted: (() => boolean) | undefined, finish: (() => void) | undefined;
  const abort = vi.fn();
  processStub.on("SIGTERM", abort);
  const main = harnessFunction("main", {
    process: processStub,
    parseFreshnessArguments: () => ({ recoveryPath: null }),
    runCrossDeviceFreshnessRehearsal: (check: () => boolean) => {
      interrupted = check;
      return new Promise<void>(done => { finish = done; });
    },
    recoverFreshnessLedger: () => { throw Error("unexpected recovery"); }
  });
  const pending = main([]);
  expect(processStub.send).toHaveBeenCalledWith("FRESHNESS_READY", expect.any(Function));
  processStub.emit("message", "unrecognized");
  expect(abort).not.toHaveBeenCalled();
  processStub.emit(event, "FRESHNESS_INTERRUPT");
  expect(abort).toHaveBeenCalledTimes(1);
  expect(interrupted?.()).toBe(true);
  expect(processStub.exitCode).toBe(1);
  finish!(); await pending;
  expect(processStub.listenerCount("message")).toBe(0);
  expect(processStub.listenerCount("disconnect")).toBe(0);
});

it("L5 an early launcher interruption fails before ledger or resource creation", async () => {
  const acceptance = simulatedAcceptance();
  const failure = await acceptance.run(() => true).catch((error: unknown) => error);
  expect(rehearsal.formatFreshnessFailure(failure)).toBe("FRESHNESS_ACCEPTANCE_FAILED\nFRESHNESS_PHASE_PREFLIGHT_EXPORT\n");
  expect(acceptance.persist).not.toHaveBeenCalled();
  expect(acceptance.lifecycle).not.toHaveBeenCalled();
  expect(acceptance.stdout).toEqual([]);
});

it("L5 interruption during ledger persistence still reaches cleanup exactly once", async () => {
  const acceptance = simulatedAcceptance();
  let checks = 0;
  const failure = await acceptance.run(() => ++checks > 1).catch((error: unknown) => error);
  expect(rehearsal.formatFreshnessFailure(failure)).toBe("FRESHNESS_ACCEPTANCE_FAILED\nFRESHNESS_PHASE_PREFLIGHT_EXPORT\n");
  expect(acceptance.persist).toHaveBeenCalledTimes(1);
  expect(acceptance.cleanup).toHaveBeenCalledTimes(1);
  expect(acceptance.lifecycle).toHaveBeenCalledTimes(1);
  expect(acceptance.stdout).toEqual([]);
});

it("D6 preserves exact success and recovery markers through production control flow", async () => {
  const acceptance = simulatedAcceptance();
  await acceptance.run();
  expect(acceptance.stdout.join("")).toBe("FRESHNESS_ACCEPTANCE_PASS\nFRESHNESS_CLEANUP_PASS\n");
  expect(acceptance.cleanup).toHaveBeenCalledTimes(1);
  expect(acceptance.lifecycle).toHaveBeenCalledTimes(1);
  const stdout: string[] = [];
  const cleanup = vi.fn(async () => {});
  const recovery = harnessFunction("recoverFreshnessLedger", {
    process: { platform: "win32", kill: () => { throw { code: "ESRCH" }; }, on: () => {}, off: () => {}, stdout: { write: (value: string) => stdout.push(value) } },
    resolve, tmpdir: () => "synthetic-temp", ledgerDirectory: () => "synthetic-ledgers",
    validateLedgerPath: () => {}, assertOwnedPath: () => {}, readFileSync: () => "{}", validateLedger: () => ({ pid: 123 }), cleanLedger: cleanup
  });
  await recovery("synthetic-ledger");
  expect(stdout.join("")).toBe("FRESHNESS_CLEANUP_PASS\n");
  expect(cleanup).toHaveBeenCalledTimes(1);
});

it("D7 outermost CLI emits fixed failures only on stdout", async () => {
  const source = ts.createSourceFile("rehearsal.ts", read("scripts/cross-device-freshness.acceptance-rehearsal.ts"), ts.ScriptTarget.Latest, true);
  const entry = source.statements.at(-1);
  expect(entry && ts.isIfStatement(entry)).toBe(true);
  const block = (entry as ts.IfStatement).thenStatement as ts.Block;
  const expression = (block.statements[0] as ts.ExpressionStatement).expression.getText(source);
  for (const [bodyFails, cleanupFails] of [[true, false], [true, true], [false, true]]) {
    const failure = await rehearsal.withFreshnessCleanup(
      async () => { if (bodyFails) throw Error("synthetic primary secret"); },
      async () => { if (cleanupFails) throw Error("synthetic cleanup secret"); },
      () => "fixture"
    ).catch((error: unknown) => error);
    const stdout: string[] = [], stderr: string[] = [];
    const processStub = { argv: ["node", "synthetic-cli"], stdout: { write: (value: string) => stdout.push(value) }, stderr: { write: (value: string) => stderr.push(value) }, exitCode: 0 };
    await runInNewContext(expression, { process: processStub, main: async () => { throw failure; }, formatFreshnessFailure: rehearsal.formatFreshnessFailure });
    expect(stdout.join("")).toBe(rehearsal.formatFreshnessFailure(failure));
    expect(stderr).toEqual([]);
    expect(processStub.exitCode).toBe(1);
  }
});

it("D8 attributes production boundaries and retains the primary across cleanup", async () => {
  for (const phase of rehearsal.FRESHNESS_PHASES.filter(phase => phase !== "unknown")) {
    for (const cleanupFails of [false, true]) {
      const acceptance = simulatedAcceptance(phase, cleanupFails);
      const failure = await acceptance.run().catch((error: unknown) => error);
      // A failed cleanup prevents the later terminal check from running.
      const cleanupOnly = phase === "terminal" && cleanupFails;
      const expectedCleanup = cleanupFails && phase !== "preflight_export";
      expect(rehearsal.formatFreshnessFailure(failure)).toBe("FRESHNESS_ACCEPTANCE_FAILED\n"
        + (cleanupOnly ? "" : `FRESHNESS_PHASE_${phase.toUpperCase()}\n`)
        + (phase === "browser_observation" ? "FRESHNESS_BROWSER_UNKNOWN\n" : "")
        + (expectedCleanup ? "FRESHNESS_CLEANUP_FAILED\n" : ""));
      expect(acceptance.stdout).toEqual([]);
      expect(acceptance.cleanup).toHaveBeenCalledTimes(phase === "preflight_export" ? 0 : 1);
    }
  }
});

it("D4 maps unknown thrown values to a content-free unknown phase", async () => {
  for (const value of [undefined, null, "synthetic secret", Error("synthetic path"), { phase: "fixture", message: "synthetic payload" }, { toString() { throw Error("must not render"); } }]) {
    const failure = await rehearsal.withFreshnessCleanup(async () => { throw value; }, async () => {}).catch((error: unknown) => error);
    expect(rehearsal.formatFreshnessFailure(failure)).toBe("FRESHNESS_ACCEPTANCE_FAILED\nFRESHNESS_PHASE_UNKNOWN\n");
    expect(rehearsal.formatFreshnessFailure(value)).toBe("FRESHNESS_ACCEPTANCE_FAILED\nFRESHNESS_PHASE_UNKNOWN\n");
  }
});

it("D5 exhausts the closed phase vocabulary and rejects arbitrary strings", () => {
  const phases = ["preflight_export", "docker_image_start", "fixture", "action_discovery", "browser_launch", "browser_observation", "terminal", "unknown"] as const;
  expect(rehearsal.FRESHNESS_PHASES).toEqual(phases);
  expect(Object.isFrozen(rehearsal.FRESHNESS_PHASES)).toBe(true);
  for (const phase of phases) {
    const failure = rehearsal.freshnessPhaseFailure(phase, Error("synthetic child stdout/stderr"));
    expect(rehearsal.formatFreshnessFailure(failure)).toBe(`FRESHNESS_ACCEPTANCE_FAILED\nFRESHNESS_PHASE_${phase.toUpperCase()}\n`
      + (phase === "browser_observation" ? "FRESHNESS_BROWSER_UNKNOWN\n" : ""));
  }
  for (const phase of ["", "constructor", "toString", "FIXTURE", "fixture\nFRESHNESS_CLEANUP_FAILED", "synthetic-resource-identity"]) {
    const failure = rehearsal.freshnessPhaseFailure(phase as typeof phases[number], Error("synthetic credentials"));
    expect(rehearsal.formatFreshnessFailure(failure)).toBe("FRESHNESS_ACCEPTANCE_FAILED\nFRESHNESS_PHASE_UNKNOWN\n");
  }
});

function fixtureData(model: string) {
  const source = ts.createSourceFile("fixture.mjs", read("scripts/cross-device-freshness-fixture.mjs"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const data: ts.ObjectLiteralExpression[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(source) === `prisma.${model}.create`) {
      const argument = node.arguments[0];
      if (argument && ts.isObjectLiteralExpression(argument)) {
        const property = argument.properties.find((item) => ts.isPropertyAssignment(item) && item.name.getText(source) === "data");
        if (property && ts.isPropertyAssignment(property) && ts.isObjectLiteralExpression(property.initializer)) data.push(property.initializer);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return data.map((object) => Object.fromEntries(object.properties.map((property) =>
    ts.isPropertyAssignment(property) ? [property.name.getText(source), property.initializer.getText(source)] : [property.getText(source), "spread-or-shorthand"])));
}

it("B fixture running sleep initializes pause tracking at the start instant", () => {
  const sleeps = fixtureData("activityLog").filter((activity) => activity.type === "'sleep'");
  expect(sleeps).toHaveLength(1);
  expect(sleeps[0]).toMatchObject({
    timerState: "'running'", startedAt: "now",
    pauseTrackingStartedAt: "now", pauseTrackingBaselineSeconds: "0"
  });
});

it("B tenant fixture includes a foreign household-wide null-baby post", () => {
  expect(fixtureData("feedPost")).toContainEqual({
    householdId: "foreign.householdId", babyId: "null", authorMemberId: "'fresh-member-foreign'", body: "'FOREIGN_FRESHNESS_SENTINEL'"
  });
});

it("B tenant fixture explicitly retains a foreign unlinked household-wide calendar event", () => {
  const events = fixtureData("calendarEvent");
  expect(events).toContainEqual({ householdId: "foreign.householdId", title: "'FOREIGN_FRESHNESS_SENTINEL'", startTime: "now" });
  expect(events.every((event) => !("babies" in event) && !("babyId" in event))).toBe(true);
});

it.each([["/app", "log"], ["/app/moments", "moments"], ["/app/calendar", "calendar"]])(
  "B tenant probe requests a hostile foreign baby on %s before recording isolation", (route, surface) => {
    const source = read("scripts/cross-device-freshness-browser-probe.mjs");
    const navigation = source.indexOf(`await navigate(b, "${route}?babyId=fresh-baby-foreign")`);
    const assertion = source.indexOf(`await assertDisplayIsolation(b, "foreign_${surface}")`, navigation);
    const recorded = source.indexOf('observations.add("tenant_isolation")');
    expect(navigation).toBeGreaterThan(0);
    expect(assertion).toBeGreaterThan(navigation);
    expect(recorded).toBeGreaterThan(assertion);
    const navigate = source.slice(source.indexOf("async function navigate("), source.indexOf("async function textPresent("));
    expect(navigate).toContain("15_000");
    expect(navigate).toContain("location.search");
    const isolation = source.slice(source.indexOf("async function assertDisplayIsolation("), source.indexOf("async function navigate("));
    for (const forbidden of ["FOREIGN_FRESHNESS_SENTINEL", "fresh-baby-foreign", "fresh-household-foreign", "fresh-user-foreign", "fresh-member-foreign"]) {
      expect(isolation).toContain(forbidden);
    }
    expect(isolation).toContain('.some(value =>');
    expect(isolation).toContain('fail("tenant_isolation")');
  }
);

it("B tenant display checks distinguish rendered foreign data from submitted route metadata", () => {
  const source = ts.createSourceFile("probe.mjs", read("scripts/cross-device-freshness-browser-probe.mjs"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const helper = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "renderedIsolationMarkup");
  expect(helper).toBeDefined();
  const markup = runInNewContext(`(${helper!.getText(source)})`) as (node: Node) => string;
  const { JSDOM } = createRequire(import.meta.url)("jsdom");
  const dom: { window: { document: Document; close(): void } } = new JSDOM('<main><script>searchParams = { babyId: "fresh-baby-foreign" }</script><a data-baby="fresh-baby-own">Own</a></main>');
  try {
    const main = dom.window.document.querySelector("main")!;
    expect(markup(main)).not.toContain("fresh-baby-foreign");
    expect(markup(main.querySelector("script")!)).toBe("");
    expect(markup(main.querySelector("script")!.firstChild!)).toBe("");
    for (const forbidden of ["FOREIGN_FRESHNESS_SENTINEL", "fresh-baby-foreign", "fresh-household-foreign", "fresh-user-foreign", "fresh-member-foreign"]) {
      main.querySelector("a")!.textContent = forbidden;
      expect(markup(main)).toContain(forbidden);
      main.querySelector("a")!.textContent = "Own";
      main.querySelector("a")!.setAttribute("data-baby", forbidden);
      expect(markup(main)).toContain(forbidden);
    }
  } finally { dom.window.close(); }
});

it("fails closed for an interrupt after observation succeeds and cleanup completes", () => {
  expect(rehearsal).toHaveProperty("freshnessTerminalOutcome");
  expect(() => rehearsal.freshnessTerminalOutcome(true, true)).toThrow("freshness_interrupted");
  expect(() => rehearsal.freshnessTerminalOutcome(false, true)).toThrow("freshness_interrupted");
  expect(() => rehearsal.freshnessTerminalOutcome(false, false)).toThrow("freshness_observation_invalid");
  expect(rehearsal.freshnessTerminalOutcome(true, false)).toBe("FRESHNESS_ACCEPTANCE_PASS\nFRESHNESS_CLEANUP_PASS\n");
  const source = read("scripts/cross-device-freshness.acceptance-rehearsal.ts");
  const terminal = "process.stdout.write(freshnessTerminalOutcome(passed, controller.signal.aborted))";
  expect(source).toContain(terminal);
  expect(source.indexOf(terminal)).toBeGreaterThan(source.indexOf("await cleanup()"));
  expect(source).toContain('process.stdout.write(formatFreshnessFailure(error))');
});
it("B7 keeps explicit recovery argument parsing compatible with launcher governance", () => {
  expect(rehearsal).toHaveProperty("parseFreshnessArguments");
  expect(rehearsal.parseFreshnessArguments([])).toEqual({ recoveryPath: null });
  expect(rehearsal.parseFreshnessArguments(["--recover", "ledger.json"])).toEqual({ recoveryPath: "ledger.json" });
  for (const args of [["--recover"], ["--recover", "a", "b"], ["unknown"]]) expect(() => rehearsal.parseFreshnessArguments(args)).toThrow();
  const program = ts.createProgram([resolve("scripts/cross-device-freshness-launcher.mjs")], { noResolve: true, allowJs: true, target: ts.ScriptTarget.ESNext });
  const result = discoverPackageCommands(program, resolve("."), JSON.stringify({ scripts: { "verify:cross-device-freshness": JSON.parse(read("package.json")).scripts["verify:cross-device-freshness"] } }));
  expect(result.diagnostics).toEqual([]);
  expect(result.observations).toEqual([expect.objectContaining({
    kind: "package_script", ownerModule: "scripts/cross-device-freshness-launcher.mjs",
    symbol: "verify:cross-device-freshness", target: "package.json#scripts.verify:cross-device-freshness"
  })]);
  expect(discoverStructuralExclusions(resolve(".")).exclusions).toContainEqual(expect.objectContaining({
    ownerModule: "scripts/cross-device-freshness-launcher.mjs", category: "rehearsal", packageScripts: ["verify:cross-device-freshness"]
  }));
});
it("B8 documents only unexecuted source guarantees and separate lifecycle gates", () => {
  const docs = read("docs/DEVELOPMENT.md");
  for (const text of ["CUBBY_FRESHNESS_ACCEPTED_COMMIT", "clean tracked and nonignored-untracked", "Git-object export", "cubby-freshness-ledgers", "--recover", "Windows", "display/read isolation", "runtime acceptance remains **pending**", "FileList"]) expect(docs).toContain(text);
  expect(docs).toContain("not a hostile mutation or side-effect audit");
  expect(docs).toContain("No archive, Docker, Chrome or recovery lifecycle was run");
  expect(docs).toContain("closed `FRESHNESS_BROWSER_` predicate code");
  expect(docs).toContain("Malformed, extra or unclassified probe output maps to `FRESHNESS_BROWSER_UNKNOWN`");
});
it("B7 validates one content-free ledger and rejects unsafe recovery scope", () => {
  expect(rehearsal).toHaveProperty("validateLedger");
  const project = "cubby_freshness_0123456789abcdef";
  const ledger = { version: 1, project, image: `${project}:acceptance`, directory: resolve(tmpdir(), `${project}-0123456789ab`), exportedCommit: "a".repeat(40), pid: 1234 };
  const path = resolve(tmpdir(), "cubby-freshness-ledgers", `${project}.json`);
  expect(rehearsal.validateLedger(ledger, path)).toEqual(ledger);
  for (const change of [{ project: "cubby" }, { image: "cubby-app" }, { directory: resolve(tmpdir()) }, { directory: resolve(tmpdir(), "..", "normal") }, { exportedCommit: "HEAD" }, { pid: 0 }, { secret: "forbidden" }]) expect(() => rehearsal.validateLedger({ ...ledger, ...change }, path)).toThrow();
  expect(() => rehearsal.validateLedger(ledger, resolve(tmpdir(), "wrong.json"))).toThrow();
  expect(rehearsal).toHaveProperty("validateLedgerPath");
  expect(() => rehearsal.validateLedgerPath(resolve(tmpdir(), ".env"))).toThrow();
  expect(() => rehearsal.validateLedgerPath(path)).not.toThrow();
});
it("B7 independently removes authenticated state and aggregates cleanup failures", async () => {
  expect(rehearsal).toHaveProperty("cleanupScope");
  const events: string[] = [];
  const failures = await rehearsal.cleanupScope({
    stopChrome: async () => { events.push("chrome"); throw Error(); },
    removeDocker: async () => { events.push("docker"); throw Error(); },
    removeProfiles: async () => { events.push("profiles"); },
    removeRoot: async () => { events.push("root"); },
    verify: async () => { events.push("verify"); throw Error(); }
  });
  expect(events).toEqual(["chrome", "docker", "profiles", "root", "verify"]);
  expect(failures).toEqual(["chrome", "docker", "verification"]);
});
it("B7 persists before creation, handles signals once and recovers only exact resources", () => {
  const source = read("scripts/cross-device-freshness.acceptance-rehearsal.ts");
  expect(source).toContain('process.on("SIGINT", onSignal)');
  expect(source).toContain('process.on("SIGTERM", onSignal)');
  expect(source).toContain("cleanupPromise ??=");
  expect(source).toContain('mode: 0o600, flag: "wx"');
  expect(source.indexOf("persistLedger(ledger)")).toBeLessThan(source.indexOf("mkdirSync(directory"));
  expect(source.indexOf("persistLedger(ledger)")).toBeLessThan(source.indexOf("attempted = true"));
  expect(source).toContain('operation === "--recover"');
  expect(source).toContain('`label=com.docker.compose.project=${ledger.project}`');
  expect(source).toContain('actualLabel !== ledger.project');
  expect(source).toContain('imageExists(ledger.image)');
  expect(source).toContain('profilePaths(ledger).some(existsSync)');
  expect(source).toContain('await chromeProcesses(ledger)');
  expect(source).toContain('if (failures.length) fail("cleanup_incomplete")');
  expect(source.indexOf('if (failures.length) fail("cleanup_incomplete")')).toBeLessThan(source.indexOf("rmSync(ledgerPath)"));
  expect(source).not.toContain("if (clean &&");
  expect(source).not.toContain("spawnSync");
});
it("B6 watches all exercised shared displays and retains an authorized foreign timer read", () => {
  const source = read("scripts/cross-device-freshness-browser-probe.mjs");
  expect(source).toContain('"Page.addScriptToEvaluateOnNewDocument"');
  expect(source).toContain("new MutationObserver(checkIsolation)");
  expect(source).toContain("window.__freshIsolationViolation = true");
  for (const surface of ["log", "moments", "calendar", "timer_status"]) expect(source).toContain(`assertDisplayIsolation(b, "${surface}")`);
  expect(source).toContain("fresh-baby-foreign&requestToken=");
  expect(source).toContain("body.data.timers.length === 0");
  const fixture = read("scripts/cross-device-freshness-fixture.mjs");
  expect(fixture).toContain('name: suffix === "foreign" ? "FOREIGN_FRESHNESS_SENTINEL" : "Fixture own"');
  for (const model of ["activityLog", "feedPost", "calendarEvent"]) expect(fixture).toContain(`prisma.${model}.create`);
  expect(source.indexOf('observations.add("tenant_isolation")')).toBeGreaterThan(source.indexOf('if (!denied) fail("tenant_isolation")'));
});
it("B5 compares nonzero scroll and exact selected FileList across refresh", () => {
  const source = read("scripts/cross-device-freshness-browser-probe.mjs");
  expect(source).toContain("spacer.style.height = '2000px'");
  expect(source).toContain("scrollTo(0, 200)");
  expect(source).toContain("if (scrollY <= 0) throw Error()");
  expect(source).toContain("files: [...file.files].map(({ name, type, size }) => ({ name, type, size }))");
  expect(source).toContain("s.files.length === 1");
  expect(source).toContain("s.file.files.length === s.files.length");
  expect(source).toContain("file.name === s.files[index].name && file.type === s.files[index].type && file.size === s.files[index].size");
  expect(source).toContain("s.scroll > 0 && scrollY === s.scroll");
  expect(source).toContain("document.querySelector('input[type=file]') === s.file");
  expect(source).toContain("s.photo.src === s.photoSrc");
  expect(source).toContain("input.files = window.__freshSelectedFiles");
  expect(source.indexOf("input.files = window.__freshSelectedFiles")).toBeGreaterThan(source.indexOf('"chosen_photo_missing"'));
});
it("separates the primed cached instant from the newer live timer request by a bounded delay", () => {
  const source = read("scripts/cross-device-freshness-browser-probe.mjs");
  const prime = source.indexOf(".put(cacheUrl, new Response");
  const liveRequest = source.indexOf("window.dispatchEvent(new Event('cubby:active-timers-changed'))", prime);
  const delay = source.indexOf("await new Promise(done => setTimeout(done, 25));", prime);
  expect(prime).toBeGreaterThan(0);
  expect(delay).toBeGreaterThan(prime);
  expect(delay).toBeLessThan(liveRequest);
  expect(source.slice(prime, liveRequest)).toContain("setTimeout(() => reject(Error()), 5_000)");
  expect(source.slice(prime, liveRequest)).toContain("Date.parse(newer.data.confirmedAt) > Date.parse(body.data.confirmedAt)");
  expect(source).toContain("Date.parse(body.data.confirmedAt) < Date.parse(window.__freshNewerInstant)");
});
it("B4 proves an exact tokenized cached response reached the production loader without confirming freshness", () => {
  const source = read("scripts/cross-device-freshness-browser-probe.mjs");
  expect(source).toContain("const cacheUrl = `${base}/api/timers/active?${new URLSearchParams({ requestToken: cacheToken, babyId })}`");
  expect(source).toContain(".put(cacheUrl, new Response");
  expect(source).toContain("response.url === cacheUrl && response.fromServiceWorker");
  expect(source).toContain('headers["x-cubby-freshness-cache-proof"] === "1"');
  expect(source).toContain("crypto.getRandomValues = nativeRandom");
  expect(source).toContain("finally { crypto.getRandomValues = nativeRandom;");
  expect(source).toContain("Date.parse(body.data.confirmedAt) < Date.parse(window.__freshNewerInstant)");
  expect(source).toContain('await observe("service_worker_cache",');
  expect(source).not.toContain('observations.add("service_worker_cache")');
  expect(source).toContain("window.__freshCacheProof.consumed === 1");
  expect(source).toContain("window.__freshCacheProof.exactBody");
  expect(source).not.toMatch(/fetch\('\/api\/timers\/active\?babyId=\$\{babyId\}'/);
});
it("B3 separates child capabilities and preflights before resource attempts", () => {
  expect(rehearsal).toHaveProperty("childEnvironments");
  const ambient = { PATH: "bin", ProgramFiles: "programs", ProgramW6432: "programs64", ProgramData: "data", LOCALAPPDATA: "local", APPDATA: "app", ComSpec: "cmd", PATHEXT: ".EXE", DATABASE_URL: "forbidden", BETTER_AUTH_SECRET: "forbidden", SMTP_PASSWORD: "forbidden", NODE_OPTIONS: "forbidden", COMPOSE_FILE: "forbidden", DOCKER_HOST: "forbidden" };
  const maps = rehearsal.childEnvironments(ambient, { CUBBY_SAVE_PATH_REHEARSAL_PASSWORD: "infrastructure" }, "fixture");
  expect(maps.chrome).toEqual(Object.fromEntries(Object.entries(ambient).filter(([key]) => !/DATABASE|SECRET|SMTP|NODE_|COMPOSE|DOCKER/.test(key))));
  expect(maps.compose.CUBBY_SAVE_PATH_REHEARSAL_PASSWORD).toBe("infrastructure");
  expect(decodeURIComponent(new URL(maps.fixture.REHEARSAL_SEED_URL).password) === maps.compose.CUBBY_SAVE_PATH_REHEARSAL_PASSWORD).toBe(true);
  expect(Object.keys(maps.fixture).sort()).toEqual(["REHEARSAL_APP_PASSWORD", "REHEARSAL_SEED_URL"]);
  expect(maps.chrome.REHEARSAL_APP_PASSWORD).toBeUndefined();
  expect(maps.node).toEqual({ PATH: "bin" });
  for (const map of Object.values(maps)) expect(Object.values(map)).not.toContain("forbidden");
  const source = read("scripts/cross-device-freshness.acceptance-rehearsal.ts");
  expect(source).toContain('env: environments.chrome');
  expect(source).toContain('directory, probeEnvironment, undefined, 600_000');
  expect(source).toContain('...environments.chrome, ...environments.fixture');
  expect(source).toContain('exec env -i REHEARSAL_SEED_URL="$REHEARSAL_SEED_URL" REHEARSAL_APP_PASSWORD="$REHEARSAL_APP_PASSWORD" /usr/local/bin/node --input-type=module');
  expect(source).not.toMatch(/\.\.\.process\.env|env: environment\b/);
  const main = source.slice(source.indexOf("export async function runCrossDeviceFreshnessRehearsal("));
  for (const preflight of ['["compose", "version"]', 'fail("docker_endpoint_not_local")']) {
    expect(main.indexOf(preflight)).toBeGreaterThan(0);
    expect(main.indexOf(preflight)).toBeLessThan(main.indexOf("attempted = true"));
  }
  expect(main).toContain('assertAcceptedTree(acceptedCommit, await execute');
});
it("B2 requires a clean exact accepted commit and a secret-free Git object export", () => {
  expect(rehearsal).toHaveProperty("assertAcceptedTree");
  const commit = "a".repeat(40);
  expect(() => rehearsal.assertAcceptedTree(commit, commit, "")).not.toThrow();
  for (const [accepted, head, status] of [["", commit, ""], ["HEAD", commit, ""], [commit, "b".repeat(40), ""], [commit, commit, " M tracked"], [commit, commit, "?? untracked"]]) {
    expect(() => rehearsal.assertAcceptedTree(accepted, head, status)).toThrow();
  }
  for (const path of [".env", "smtp-password", "worker-runtime/data", "node_modules/x", "docker-data/x", "x/credentials.json", "../escape"]) {
    expect(() => rehearsal.assertExportEntry("100644", path)).toThrow();
  }
  expect(() => rehearsal.assertExportEntry("120000", "link")).toThrow();
  expect(() => rehearsal.assertExportEntry("160000", "submodule")).toThrow();
  expect(() => rehearsal.assertExportEntry("100644", "src/app/page.tsx")).not.toThrow();
  for (const path of ["src/app/api/backups/export/route.ts", "src/app/api/invitations/credentials/submit/route.ts"]) expect(() => rehearsal.assertExportEntry("100644", path)).not.toThrow();
  const source = read("scripts/cross-device-freshness.acceptance-rehearsal.ts");
  expect(source).toContain('"status", "--porcelain=v1", "--untracked-files=all"');
  expect(source).toContain('"archive", "--format=tar", "--output", archive, acceptedCommit!');
  expect(source).toContain('readFileSync(resolve(exportedSource, "scripts/browser-operation-save-path.acceptance.compose.yml")');
  expect(source).toContain('JSON.stringify(exportedSource.replaceAll');
  expect(source).not.toContain('JSON.stringify(root.replaceAll');
  expect(source.indexOf("assertAcceptedTree(acceptedCommit")).toBeLessThan(source.indexOf("mkdirSync(directory"));
});
it("B2 extracts the Git archive with fixed relative tar operands from the controlled temporary root", () => {
  const source = read("scripts/cross-device-freshness.acceptance-rehearsal.ts");
  expect(source).toContain('await execute(controller.signal, "tar", ["-xf", "source.tar", "-C", "source"], directory, gitEnvironment)');
  expect(source).not.toContain('["-xf", archive, "-C", exportedSource]');
});
it("B7 attributes Chrome only to an exact profile argument and bounds signal cancellation", () => {
  const profile = "C:\\Temp\\cubby_freshness_0123456789abcdef-0123456789ab\\browser-1";
  for (const command of [`chrome.exe --user-data-dir=${profile} --headless`, `chrome.exe "--user-data-dir=${profile}" --headless`, `chrome.exe --user-data-dir="${profile}"`]) expect(rehearsal.matchesProfile(command, [profile])).toBe(true);
  for (const command of [`chrome.exe --user-data-dir=${profile}-other`, `chrome.exe --other=${profile}`, "chrome.exe --user-data-dir=C:\\NormalProfile"]) expect(rehearsal.matchesProfile(command, [profile])).toBe(false);
  expect(rehearsal.matchesProfile(`chrome.exe --type=crashpad-handler --database=${profile}\\Crashpad`, [profile])).toBe(true);
  expect(rehearsal.matchesProfile(`chrome.exe --database=${profile}\\Crashpad-other`, [profile])).toBe(false);
  const source = read("scripts/cross-device-freshness.acceptance-rehearsal.ts");
  expect(source).toContain('abortDeadline ??= setTimeout(() => finish(false), 5_000)');
  expect(source).toContain('fail("chrome_path_invalid")');
  const recovery = source.slice(source.indexOf("export async function recoverFreshnessLedger"), source.indexOf("export async function runCrossDeviceFreshnessRehearsal"));
  expect(recovery.indexOf("validateLedgerPath(ledgerPath)")).toBeGreaterThan(0);
  expect(recovery.indexOf("validateLedgerPath(ledgerPath)")).toBeLessThan(recovery.indexOf("readFileSync(ledgerPath"));
  expect(recovery).toContain('process.on("SIGINT", deferSignal)');
});
it("B1 encodes the exact generated fixture credential without disclosure", () => {
  expect(rehearsal).toHaveProperty("seedUrl");
  const credential = "generated:@/?#%+ space";
  const url = new URL(rehearsal.seedUrl(credential));
  expect(decodeURIComponent(url.password) === credential).toBe(true);
  expect(url.hostname).toBe("postgres");
  const source = read("scripts/cross-device-freshness.acceptance-rehearsal.ts");
  expect(source).toContain("seedUrl(infrastructure.CUBBY_SAVE_PATH_REHEARSAL_PASSWORD!)");
});
it("wires a separately approved Chrome lifecycle outside automatic gate groups", () => {
  const scripts = JSON.parse(read("package.json")).scripts;
  expect(scripts["verify:cross-device-freshness"]).toBe("node scripts/cross-device-freshness-launcher.mjs");
  expect(GATES_RUN_BY_HAND["verify:cross-device-freshness"]).toMatch(/Chrome/);
});
it("contains a bounded isolated production-image lifecycle and fail-closed teardown", () => {
  const source = read("scripts/cross-device-freshness.acceptance-rehearsal.ts");
  for (const required of ["COMPOSE_DISABLE_ENV_FILE", "randomBytes", "--project-name", "--build", "--wait-timeout", "removeDocker", "removeProfiles", "com.docker.compose.project=", "cleanup_incomplete", "setTimeout(stop, timeout)", "--user-data-dir", "windowsHide: true"]) expect(source).toContain(required);
  expect(source).not.toMatch(/dotenv|console\.(?:log|error)\([^)]*(?:stdout|stderr|body|password)/);
});
it("pins Docker to a local engine instead of inheriting an active remote context", () => {
  const source = read("scripts/cross-device-freshness.acceptance-rehearsal.ts");
  expect(source).toContain('DOCKER_CONTEXT: "default"');
  expect(source).toContain('"context", "inspect", "default"');
  expect(source).toContain('fail("docker_endpoint_not_local")');
});
it("asserts every acceptance domain with content-free observations", () => {
  const source = read("scripts/cross-device-freshness-browser-probe.mjs");
  for (const required of ["activity_create", "activity_update", "moments_create", "moments_update", "calendar_create", "timer_start", "timer_stop", "hidden_no_poll", "foreground_five_seconds", "offline_retention", "online_requires_confirmation", "draft_preservation", "tenant_isolation", "service_worker_cache", "request_cadence", "browser_diagnostics", "20_000", "5_000"]) expect(source).toContain(required);
  expect(source).not.toMatch(/console\.(?:log|error)/);
});
it("checks an application photo dialog, selected photo and focus without replacing the production worker", () => {
  const source = read("scripts/cross-device-freshness-browser-probe.mjs");
  expect(source).toContain("[role=dialog]");
  expect(source).toContain("Chosen photos");
  expect(source).toContain("s.dialog.isConnected");
  expect(source).toContain("navigator.serviceWorker.controller");
  expect(source).not.toContain("setBypassServiceWorker");
});
it("distinguishes current-route refreshes from prefetch and checks HTTP failures", () => {
  const source = read("scripts/cross-device-freshness-browser-probe.mjs");
  expect(source).toContain("next-router-prefetch");
  expect(source).toContain("params.response?.status >= 400");
  expect(source).toContain("requestPath === diagnostics.currentPath");
});
it("uses the required note text field in create, update and foreground probes", () => {
  const source = read("scripts/cross-device-freshness-browser-probe.mjs");
  expect(source).toContain('text: "FRESH_ACTIVITY_CREATED"');
  expect(source).toContain('textarea[name="text"]');
  expect(source).toContain('text: "FRESH_FOREGROUND"');
});

it("BD1 preserves a known browser predicate through phase formatting", () => {
  expect(rehearsal).toHaveProperty("parseFreshnessBrowserResult");
  let failure: unknown;
  try { rehearsal.parseFreshnessBrowserResult(1, "FRESHNESS_BROWSER_ACTIVITY_CREATE\n"); }
  catch (error) { failure = rehearsal.freshnessPhaseFailure("browser_observation", error); }
  expect(rehearsal.formatFreshnessFailure(failure)).toBe("FRESHNESS_ACCEPTANCE_FAILED\nFRESHNESS_PHASE_BROWSER_OBSERVATION\nFRESHNESS_BROWSER_ACTIVITY_CREATE\n");
});


it.each([false, true])("BD2 retains the browser primary with cleanup failure=%s", async (cleanupFails) => {
  const failure = await rehearsal.withFreshnessCleanup(
    async () => { rehearsal.parseFreshnessBrowserResult(1, "FRESHNESS_BROWSER_ACTIVITY_CREATE\n"); },
    async () => { if (cleanupFails) throw Error("synthetic detail"); },
    () => "browser_observation"
  ).catch((error: unknown) => error);
  expect(rehearsal.formatFreshnessFailure(rehearsal.freshnessPhaseFailure("terminal", failure))).toBe(
    "FRESHNESS_ACCEPTANCE_FAILED\nFRESHNESS_PHASE_BROWSER_OBSERVATION\nFRESHNESS_BROWSER_ACTIVITY_CREATE\n"
    + (cleanupFails ? "FRESHNESS_CLEANUP_FAILED\n" : ""));
});

it("BD3 rejects unknown Error and non-Error values without inspecting or retaining them", () => {
  const hostile = new Proxy({}, { get() { throw Error("must not inspect"); } });
  for (const value of [undefined, null, "activity_create", Error("activity_create"), Error("synthetic detail"),
    { code: "activity_create" }, hostile]) {
    expect(browserFailureCode(value)).toBe("unknown");
    expect(formatBrowserFailure(value)).toBe("FRESHNESS_BROWSER_UNKNOWN\n");
    const failure = rehearsal.freshnessPhaseFailure("browser_observation", value);
    expect(rehearsal.formatFreshnessFailure(failure)).toBe("FRESHNESS_ACCEPTANCE_FAILED\nFRESHNESS_PHASE_BROWSER_OBSERVATION\nFRESHNESS_BROWSER_UNKNOWN\n");
    expect(Object.values(failure).some(item => item === value)).toBe(false);
    for (const [status, output] of [[value, "FRESHNESS_BROWSER_ACTIVITY_CREATE"], [1, value]]) {
      try { rehearsal.parseFreshnessBrowserResult(status, output); expect.unreachable(); }
      catch (error) { expect(formatBrowserFailure(error)).toBe("FRESHNESS_BROWSER_UNKNOWN\n"); }
    }
  }
});

it.each(["FRESHNESS_BROWSER_PASS", "FRESHNESS_BROWSER_PASS\n"])("BD4 accepts exact success framing %j", (output) => {
  expect(() => rehearsal.parseFreshnessBrowserResult(0, output)).not.toThrow();
});

it.each([
  [1, ""], [1, "FRESHNESS_BROWSER_"], [1, "FRESHNESS_BROWSER_NOT_ALLOWLISTED"], [1, "arbitrary"],
  [1, "FRESHNESS_BROWSER_ACTIVITY_CREATE\nextra"], [1, "FRESHNESS_BROWSER_ACTIVITY_CREATE\n\n"],
  [1, "FRESHNESS_BROWSER_ACTIVITY_CREATE\nFRESHNESS_BROWSER_ACTIVITY_UPDATE\n"],
  [1, " FRESHNESS_BROWSER_ACTIVITY_CREATE"], [1, "FRESHNESS_BROWSER_ACTIVITY_CREATE "],
  [1, "FRESHNESS_BROWSER_ACTIVITY_CREATE\r\n"], [0, "FRESHNESS_BROWSER_PASS\nextra"],
  [0, "FRESHNESS_BROWSER_PASS\n\n"], [1, "FRESHNESS_BROWSER_PASS"], [0, "FRESHNESS_BROWSER_ACTIVITY_CREATE"],
  [null, "FRESHNESS_BROWSER_ACTIVITY_CREATE"], [undefined, "FRESHNESS_BROWSER_ACTIVITY_CREATE"],
  [NaN, "FRESHNESS_BROWSER_ACTIVITY_CREATE"], [1.5, "FRESHNESS_BROWSER_ACTIVITY_CREATE"]
])("BD5 fails closed for malformed or mismatched result %j %j", (status, output) => {
  let failure: unknown;
  try { rehearsal.parseFreshnessBrowserResult(status, output); } catch (error) { failure = error; }
  expect(formatBrowserFailure(failure)).toBe("FRESHNESS_BROWSER_UNKNOWN\n");
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toBe("FRESHNESS_BROWSER_UNKNOWN");
});

it("OC14 pins every function body the harness draws evidence from", () => {
  // THE SEVERING SURFACE IS NOT THE ONLY SURFACE. Rounds 7-14 bound what the probe may DO to the
  // browser - which CDP method on which session, which socket, which in-page expression. All of
  // that holds. But nothing bound the logic that INTERPRETS what the probe sees, and a reviewer
  // landed 15 of 20 mutations there at a fully green suite:
  //   evaluate() { return true; }            -> every in-page observation vacuous
  //   wait() returns before its predicate    -> every settle check vacuous
  //   the final census `&& false`            -> reports PASS having observed nothing
  //   exactCachedResponse forged true        -> service_worker_cache certifies on no evidence
  //   ownLog = `/app/../?babyId=...`      -> passes startsWith("/app"), resolves to origin root
  //   addBinding name mismatched             -> the isolation violation channel silently dies
  //   closeTarget closes the observed page   -> evidence destroyed, not severed
  // A harness that prints FRESHNESS_BROWSER_PASS having observed nothing is WORSE than one that
  // severs the document path: severing fails loudly and a forged proof does not. Enumerating the
  // ways to forge evidence is the arms race rounds 7-11 lost five times, so this is the same
  // inversion applied a third time - every top-level function body is pinned by digest, and any
  // new, removed or edited function fails closed with its name. Changing harness logic is now a
  // deliberate, reviewable act: update the digest and say why.
  const source = read("scripts/cross-device-freshness-browser-probe.mjs");
  const file = ts.createSourceFile("probe.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
  // Normalise line endings: JavaScript itself folds CRLF to LF inside template literals,
  // so a CRLF checkout and an LF checkout of the same file run the same program and must
  // produce the same digest. Without this the pin is an artifact of one platform.
  const digest = (node: ts.Node) => createHash("sha256")
    .update(printer.printNode(ts.EmitHint.Unspecified, node, file).split("\r\n").join("\n"))
    .digest("hex").slice(0, 16);
  const bodies: [string, string][] = [];
  for (const statement of file.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) {
      bodies.push([statement.name.text, digest(statement.body)]);
      continue;
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      // Fail closed: a name this census cannot read (destructuring, computed) is not skipped.
      // A destructured `const { forged } = { get forged() { ... } }` executes a getter, and the
      // previous version silently skipped it.
      const name = declaration.name;
      if (!ts.isIdentifier(name)) throw new Error(`unreadable declaration name: ${textOfNode(name)}`);
      if (!declaration.initializer) continue;
      if (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer)) {
        bodies.push([name.text, digest(declaration.initializer.body)]);
      }
    }
  }
  bodies.sort(([left], [right]) => left.localeCompare(right));
  expect(bodies).toEqual([
    ["assertDispatchAllowed", "82c3f3c7ef1625ac"],
    ["assertDisplayIsolation", "fc8d5ee9bdd45992"],
    ["assertTimerPathOut", "b1282eda929e92ba"],
    ["assertWorkerBlockEnforced", "85c64ec72bcc6caa"],
    ["assertWorkerOutage", "46b3b337d2f9f4a5"],
    ["calendarDayAdvanced", "83f3f5a4e55d2924"],
    ["calendarMobileDay", "37995e4f5d27bbb4"],
    ["calendarOutcomeCompleted", "6a1e27752dbd0a42"],
    ["calendarOutcomeState", "7743f8d8a8974204"],
    ["click", "20824589f505baa8"],
    ["clickText", "36dad3620412ddbd"],
    ["connect", "8b9ab57143d0dad0"],
    ["device", "d35dff4028b2a107"],
    ["evaluate", "361e6e83aed6917e"],
    ["fail", "2ee20448953a7bb8"],
    ["input", "f4279f30479b32e3"],
    ["mutate", "aeeba40ada826255"],
    ["navigate", "3047a3fbedb96b80"],
    ["observe", "bae8a679f51a5774"],
    ["onlineConfirmationState", "fc310c401a84b350"],
    ["operationId", "c989e2e6ae4e11f2"],
    ["probeTimerPath", "9b01a81228fd41ea"],
    ["renderedIsolationMarkup", "51bc2ec4d01b7c87"],
    ["signalBrowserFailure", "3d380f66dd574437"],
    ["sleep", "ea17e423aba602ac"],
    ["textPresent", "bcc4e632f7ae9c02"],
    ["wait", "c9b342d8bba9d59c"],
  ]);
});

it("OC15 pins the lifecycle sequence and every module-level constant", () => {
  // OC14 pinned function BODIES, and six mutations still survived - because the harness's most
  // important code is not in a function at all. The observation sequence lives in the top-level
  // lifecycle `try` block, and the route constants are plain module-level consts:
  //   closeTarget closing the OBSERVED page instead of the blank one   (in the try block)
  //   createTarget opening the app route instead of about:blank        (in the try block)
  //   exactCachedResponse forged true                                  (in the try block)
  //   request_cadence and the final observation census neutered        (in the try block)
  //   ownLog = `/app/../?babyId=...`                                 (a module const)
  // Every one of those forges or destroys evidence while the suite stays green. Pinning "every
  // function" was the wrong boundary: the right boundary is every statement the harness executes.
  // So the lifecycle block is pinned as one digest, and module-level constants are pinned as a
  // CENSUS rather than a hand-picked list - ownLog was missed exactly because it was neither a
  // function nor on anyone's list. Editing the observation sequence is now a deliberate act.
  const source = read("scripts/cross-device-freshness-browser-probe.mjs");
  const file = ts.createSourceFile("probe.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
  // Normalise line endings: JavaScript itself folds CRLF to LF inside template literals,
  // so a CRLF checkout and an LF checkout of the same file run the same program and must
  // produce the same digest. Without this the pin is an artifact of one platform.
  const digest = (node: ts.Node) => createHash("sha256")
    .update(printer.printNode(ts.EmitHint.Unspecified, node, file).split("\r\n").join("\n"))
    .digest("hex").slice(0, 16);
  // Exactly one top-level try: the lifecycle. A second one would give observations a home that
  // this pin does not cover, and would also defeat the dispatch-reachability contracts.
  const tryStatements = file.statements.filter(ts.isTryStatement);
  expect(tryStatements).toHaveLength(1);
  expect(digest(tryStatements[0].tryBlock)).toBe("e1fc046082b7c918");
  const constants: [string, string][] = [];
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      // Fail closed: a name this census cannot read (destructuring, computed) is not skipped.
      // A destructured `const { forged } = { get forged() { ... } }` executes a getter, and the
      // previous version silently skipped it.
      const name = declaration.name;
      if (!ts.isIdentifier(name)) throw new Error(`unreadable declaration name: ${textOfNode(name)}`);
      if (!declaration.initializer) continue;
      if (ts.isArrowFunction(declaration.initializer)
        || ts.isFunctionExpression(declaration.initializer)) continue;
      constants.push([name.text, digest(declaration.initializer)]);
    }
  }
  constants.sort(([left], [right]) => left.localeCompare(right));
  expect(constants).toEqual([
    ["action", "fae40a7c7ab441ad"],
    ["babyId", "6362efe1ac11498f"],
    ["base", "14012dae262daab1"],
    ["CDP_ALLOWED", "f0a78651c4f88e76"],
    ["CDP_PATH_SEVERING", "8b507e9d02026f40"],
    ["CDP_TIMER_PATH", "1d6adc16387d64e4"],
    ["connections", "4f53cda18c2baa0c"],
    ["devices", "4f53cda18c2baa0c"],
    ["displaySurfaces", "1ae36cea42d69792"],
    ["failureListeners", "1ae36cea42d69792"],
    ["observations", "1ae36cea42d69792"],
    ["outcome", "2f3b8e8d700f5702"],
    ["ownLog", "54bb98075216188c"],
    ["ownMoments", "3d1ade687bb560c6"],
    ["password", "ef5cc681612e5217"],
    ["required", "2ca92de3b6454b30"],
    ["TIMER_PATH_PROBE", "a2e048922c1fd78f"],
    ["WORKER_CONTROL_PROBE", "d0244cbdcd9dd03d"],
  ]);
});

it("OC16 pins every executable statement in the probe, in any form", () => {
  // THE BOUNDARY IS THE WHOLE FILE, NOT A LIST OF NODE KINDS. OC14 and OC15 pin function bodies,
  // the lifecycle block and module constants, which is useful for diagnostics but was NOT a
  // boundary: they enumerate which AST shapes to digest, and a reviewer put executable logic in
  // seventeen shapes they do not enumerate. The decisive one is that a function DECLARATION is a
  // mutable binding, so a single module-level assignment replaces a pinned function wholesale -
  // the pinned body stays in the file, byte-identical, and simply never runs:
  //   evaluate = async () => true;              every in-page observation vacuous
  //   wait = async () => {};                    every settle check vacuous
  //   assertDispatchAllowed = () => {};         the choke point of rounds 7-14, disabled
  //   probeTimerPath = async () => false;       both outage proofs forged
  // and the same assignment hidden in an IIFE, a class static block, a bare block, a label, a
  // top-level if/for, a top-level await, a destructured getter, or the lifecycle catch/finally.
  // Enumerating node kinds is the denylist polarity this design condemns elsewhere, and it has
  // now failed twice. So this digest covers EVERY top-level statement, printed with comments
  // removed. Nothing executes in a module outside its own statement list, so nothing can be
  // added, removed, reassigned or reordered without changing this one value.
  const source = read("scripts/cross-device-freshness-browser-probe.mjs");
  const file = ts.createSourceFile("probe.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
  const printed = file.statements
    .map(statement => printer.printNode(ts.EmitHint.Unspecified, statement, file))
    .join("\n");
  expect(file.statements).toHaveLength(50);
  // Line endings normalised for the same reason: the digest must identify the PROGRAM,
  // not the checkout. A CRLF tree and an LF tree of these bytes execute identically.
  expect(createHash("sha256").update(printed.split("\r\n").join("\n"))
    .digest("hex").slice(0, 16)).toBe("ec69ed71b7591191");
});

it("BD6 freezes the closed vocabulary and covers every explicit probe failure", () => {
  const expected = [
    "activity_create", "activity_update", "browser_diagnostics", "browser_expression_failed",
    "button_missing", "calendar_create", "calendar_outcome_incomplete", "calendar_submit_failed",
    "calendar_viewport_invalid", "cdp_closed",
    "cdp_command_failed", "cdp_command_timeout", "cdp_dispatch_forbidden",
    "cdp_message_failed", "cdp_failed", "cdp_scope", "cdp_timeout",
    "chosen_photo_missing", "control_missing", "dialog_missing", "draft_preservation",
    "draft_refresh_missing", "foreground_five_seconds", "freshness_scope_invalid",
    "hidden_no_poll", "hide_failed", "isolation_surfaces_missing", "known_timer_missing",
    "moments_create", "moments_update", "navigation_failed", "observations_missing",
    "offline_retention", "online_control_enabled", "online_instant_absent",
    "online_page_absent", "online_requires_confirmation", "online_status_absent",
    "online_timer_bar_absent", "online_timer_status_absent",
    "navigation_target_forbidden", "page_missing", "recovery_failed",
    "request_cadence", "service_worker_cache", "sign_in_failed", "tenant_isolation",
    "timer_path_probe_failed", "timer_path_reachable", "timer_start",
    "timer_stop", "worker_block_unenforced", "worker_control_probe_failed",
    "worker_control_unreachable", "worker_missing",
    "worker_outage_lapsed",
    "worker_target_missing", "unknown"
  ];
  expect(FRESHNESS_BROWSER_FAILURE_CODES).toEqual(expected);
  expect(Object.isFrozen(FRESHNESS_BROWSER_FAILURE_CODES)).toBe(true);
  const source = ts.createSourceFile("probe.mjs", read("scripts/cross-device-freshness-browser-probe.mjs"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const codes = new Set<string>();
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const name = node.expression.getText(source);
      const arg = node.arguments?.[name === "wait" ? 2 : 0];
      if (["fail", "wait", "observe", "browserFailure", "Error"].includes(name) && arg && ts.isStringLiteral(arg)) codes.add(arg.text);
      if (name === "Error") expect(arg).toBeUndefined();
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  // The five online_* sub-states are composed from a closed classifier result rather than written as
  // literals, so they are enumerated from the classifier itself and must reconcile exactly.
  // Bounded by the classifier's OWN closing brace, not by whatever happens to follow it: a probe
  // const inserted in between would otherwise leak its returns into this harvest.
  const classifierStart = source.text.indexOf("async function onlineConfirmationState(");
  const classifier = source.text.slice(
    classifierStart,
    source.text.indexOf("\n}", classifierStart)
  );
  const composed = [...classifier.matchAll(/return '([a-z_]+)'/g)]
    .map(match => match[1])
    .filter(state => state !== "confirmed")
    .map(state => `online_${state}`);
  expect(composed.sort()).toEqual([
    "online_control_enabled", "online_instant_absent", "online_page_absent",
    "online_status_absent", "online_timer_bar_absent", "online_timer_status_absent"
  ]);
  expect(source.text).toContain("`online_${onlineConfirmationDetail}`");
  for (const state of composed) codes.add(state);
  expect([...codes].sort()).toEqual(expected.filter(code => code !== "unknown").sort());
  for (const code of expected) {
    const marker = formatBrowserFailure(browserFailure(code));
    expect(marker).toBe("FRESHNESS_BROWSER_" + code.toUpperCase() + "\n");
    for (const output of [marker, marker.slice(0, -1)]) {
      let failure: unknown;
      try { rehearsal.parseFreshnessBrowserResult(1, output); } catch (error) { failure = error; }
      expect(browserFailureCode(failure)).toBe(code);
    }
  }
  for (const code of ["", "constructor", "toString", "ACTIVITY_CREATE", "activity_create\nextra"]) {
    expect(browserFailureCode(browserFailure(code))).toBe("unknown");
  }
  const shared = ts.createSourceFile("contract.mjs", read("scripts/cross-device-freshness-browser-contract.mjs"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  expect(shared.statements.some(ts.isImportDeclaration)).toBe(false);
  for (const name of ["cross-device-freshness-browser-probe.mjs", "cross-device-freshness.acceptance-rehearsal.ts"]) {
    expect(read("scripts/" + name)).toContain('from "./cross-device-freshness-browser-contract.mjs"');
  }
});

it("BD7 probe emits one fixed stdout marker and no stderr for caught failures", async () => {
  const source = ts.createSourceFile("probe.mjs", read("scripts/cross-device-freshness-browser-probe.mjs"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const boundary = source.statements.find(ts.isTryStatement)!;
  expect(boundary).toBeDefined();
  expect(source.text).not.toContain("process.stderr");
  const tail = source.text.slice(boundary.end);
  for (const error of [browserFailure("activity_create"), browserFailure("cdp_message_failed"), Error("synthetic detail"), undefined, "synthetic detail"]) {
    const stdout: string[] = [];
    const processStub = { stdout: { write: (marker: string) => stdout.push(marker) }, exitCode: 0 };
    await runInNewContext('(async () => { let outcome = "FRESHNESS_BROWSER_PASS\\n"; try { throw failure; } '
      + boundary.catchClause!.getText(source) + ' finally ' + boundary.finallyBlock!.getText(source) + tail + ' })()',
    { failure: error, connections: [], formatBrowserFailure, process: processStub });
    expect(stdout).toEqual([formatBrowserFailure(error)]);
    expect(processStub.exitCode).toBe(1);
  }
});

it.each([
  { code: 1, chunks: ["FRESHNESS_BROWSER_ACTIVITY_", "CREATE\n"], expected: "activity_create" },
  { code: 0, chunks: ["FRESHNESS_BROWSER_PASS\n"], expected: "pass" },
  { code: 1, chunks: ["FRESHNESS_BROWSER_ACTIVITY_CREATE\n", "extra"], expected: "unknown" },
  { code: 0, chunks: [" FRESHNESS_BROWSER_PASS\n"], expected: "unknown" },
  { code: 1, chunks: ["FRESHNESS_BROWSER_PASS\n"], expected: "unknown" },
  { code: 0, chunks: ["FRESHNESS_BROWSER_ACTIVITY_CREATE\n"], expected: "unknown" },
  { code: null, chunks: ["FRESHNESS_BROWSER_ACTIVITY_CREATE\n"], expected: "unknown" }
])("BD8 child transport classifies exact untrimmed output %#", async ({ code, chunks, expected }) => {
  const drain = vi.fn();
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const child = {
    stdout: { on: (_: string, receive: (chunk: string) => void) => chunks.forEach(receive) },
    stderr: { resume: drain },
    stdin: { on: () => {}, end: () => listeners.get("close")!(code) },
    once: (event: string, callback: (...args: unknown[]) => void) => listeners.set(event, callback)
  };
  const run = harnessFunction("run", {
    ...rehearsal, browserFailure, browserFailureCode, spawn: () => child,
    setTimeout: () => 1, clearTimeout: () => {}, fail: () => { throw Error(); }
  });
  const result = await run("synthetic", [], "synthetic", {}, undefined, 100, undefined, true).then(() => "pass", browserFailureCode);
  expect(result).toBe(expected);
  expect(drain).toHaveBeenCalledTimes(1);
});


it.each([false, true])("BD9 production control flow preserves a known predicate with cleanup failure=%s", async (cleanupFails) => {
  const acceptance = simulatedAcceptance("browser_observation", cleanupFails, "activity_create");
  const failure = await acceptance.run().catch((error: unknown) => error);
  expect(rehearsal.formatFreshnessFailure(failure)).toBe("FRESHNESS_ACCEPTANCE_FAILED\nFRESHNESS_PHASE_BROWSER_OBSERVATION\nFRESHNESS_BROWSER_ACTIVITY_CREATE\n"
    + (cleanupFails ? "FRESHNESS_CLEANUP_FAILED\n" : ""));
  expect(acceptance.stdout).toEqual([]);
  expect(acceptance.cleanup).toHaveBeenCalledTimes(1);
});

it.each([Error("synthetic detail"), undefined, { detail: "synthetic detail" }])("BD10 child launch throws reduce immediately to unknown %#", async (thrown) => {
  const run = harnessFunction("run", {
    ...rehearsal, browserFailure, browserFailureCode, spawn: () => { throw thrown; }
  });
  const failure = await run("synthetic", [], "synthetic", {}, undefined, 100, undefined, true).catch((error: unknown) => error);
  expect(failure instanceof Error).toBe(true);
  expect((failure as Error).message).toBe("FRESHNESS_BROWSER_UNKNOWN");
  expect(Object.values(failure as Error).some(value => value === thrown)).toBe(false);
});

it("BD11 probe preserves exact success and closes connections before emitting output", async () => {
  const source = ts.createSourceFile("probe.mjs", read("scripts/cross-device-freshness-browser-probe.mjs"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const boundary = source.statements.find(ts.isTryStatement)!;
  const tail = source.text.slice(boundary.end);
  for (const closeFails of [false, true]) {
    const events: string[] = [];
    const processStub = { stdout: { write: (marker: string) => events.push(marker) }, exitCode: 0 };
    await runInNewContext('(async () => { let outcome = "FRESHNESS_BROWSER_PASS\\n"; try {} '
      + boundary.catchClause!.getText(source) + ' finally ' + boundary.finallyBlock!.getText(source) + tail + ' })()', {
      connections: [{ close() { events.push("close"); if (closeFails) throw Error("synthetic detail"); } }],
      formatBrowserFailure, process: processStub
    });
    expect(events).toEqual(["close", closeFails ? "FRESHNESS_BROWSER_UNKNOWN\n" : "FRESHNESS_BROWSER_PASS\n"]);
    expect(processStub.exitCode).toBe(closeFails ? 1 : 0);
  }
});

it.each(["malformed message", "throwing listener"])("BD12 routes an asynchronous CDP %s into the closed failure contract", async (scenario) => {
  let socket: {
    onopen?: () => void;
    onmessage?: (event: { data: string }) => void;
    onerror?: () => void;
    closed: boolean;
  } | undefined;
  class SyntheticWebSocket {
    onopen?: () => void;
    onmessage?: (event: { data: string }) => void;
    onerror?: () => void;
    closed = false;
    constructor() { socket = this; queueMicrotask(() => this.onopen?.()); }
    send() {}
    close() { this.closed = true; }
  }
  const failures: string[] = [];
  const connect = probeFunction("connect", {
    WebSocket: SyntheticWebSocket, setTimeout, clearTimeout, browserFailure,
    asynchronousFailure: undefined, failureListeners: new Set(),
    signalBrowserFailure: () => failures.push("cdp_message_failed")
  });
  const client = await connect("ws://127.0.0.1:12345/devtools/browser/synthetic") as { on: (listener: () => void) => void; close: () => void };
  if (scenario === "throwing listener") client.on(() => { throw Error("synthetic private detail"); });
  expect(() => socket!.onmessage?.({ data: scenario === "malformed message" ? "{" : JSON.stringify({ method: "Synthetic.event" }) })).not.toThrow();
  expect(failures).toEqual(["cdp_message_failed"]);
  expect(formatBrowserFailure(browserFailure(failures[0]))).toBe("FRESHNESS_BROWSER_CDP_MESSAGE_FAILED\n");
  client.close();
  expect(socket!.closed).toBe(true);
});

/**
 * CAL contracts close `CALENDAR_CREATE_MOBILE_TITLE_OBSERVER_UNSATISFIABLE`. The probe fixes both
 * devices at 390 pixels, so an observation may only read a surface that is genuinely rendered at that
 * width, and an accepted calendar mutation must reach the same completed outcome the production
 * submission requires rather than any 2xx response.
 */
const CALENDAR_DAY_KEY = "2026-10-08";

type SyntheticNode = {
  style: { display: string; visibility: string };
  children: SyntheticNode[];
  getClientRects: () => readonly unknown[];
  getAttribute: (name: string) => string | null;
  querySelector: (selector: string) => SyntheticNode | null;
};

function syntheticNode(options: {
  display?: string;
  visibility?: string;
  attributes?: Record<string, string>;
  children?: SyntheticNode[];
  nested?: Record<string, SyntheticNode>;
}): SyntheticNode {
  const display = options.display ?? "flex";
  const visibility = options.visibility ?? "visible";
  return {
    style: { display, visibility },
    children: options.children ?? [],
    getClientRects: () => (display === "none" ? [] : [{ width: 6, height: 6 }]),
    getAttribute: (name) => options.attributes?.[name] ?? null,
    querySelector: (selector) => options.nested?.[selector] ?? null
  };
}

function syntheticDayCell(options: {
  label?: string | null;
  cellDisplay?: string;
  cellVisibility?: string;
  markers?: "absent" | "visible" | "hidden";
  dotDisplays?: string[];
}) {
  const dots = (options.dotDisplays ?? ["flex", "flex"]).map((display) => syntheticNode({ display }));
  const markerRow = options.markers === "absent"
    ? undefined
    : syntheticNode({ display: options.markers === "hidden" ? "none" : "flex", children: dots });
  return syntheticNode({
    display: options.cellDisplay ?? "flex",
    visibility: options.cellVisibility ?? "visible",
    attributes: options.label === null ? {} : { "aria-label": options.label ?? "October 8, 2026, 2 items" },
    nested: markerRow ? { '[aria-hidden="true"]': markerRow } : {}
  });
}

async function runCalendarMobileDay(cell: SyntheticNode | null) {
  let expression = "";
  const calendarMobileDay = probeFunction("calendarMobileDay", {
    evaluate: async (_client: unknown, source: string) => {
      expression = source;
      return runInNewContext(source, {
        document: { querySelector: (selector: string) => (selector === `[data-calendar-day="${CALENDAR_DAY_KEY}"]` ? cell : null) },
        getComputedStyle: (node: SyntheticNode) => node.style
      });
    },
    fail: (code: string) => { throw Error(code); }
  });
  const outcome = await calendarMobileDay({ client: {} }, CALENDAR_DAY_KEY).then(
    (value: unknown) => value,
    (error: Error) => error.message
  );
  return { outcome, expression };
}

it("CAL1 rejects a calendar day observation that is not rendered at the probe viewport", async () => {
  for (const cell of [
    null,
    syntheticDayCell({ cellDisplay: "none" }),
    syntheticDayCell({ cellVisibility: "hidden" }),
    syntheticDayCell({ label: null }),
    syntheticDayCell({ markers: "hidden" })
  ]) {
    const { outcome } = await runCalendarMobileDay(cell);
    expect(outcome).toBe("calendar_viewport_invalid");
  }
});

it("CAL2 reads the visible mobile day count and marker dots at the probe viewport", async () => {
  const { outcome, expression } = await runCalendarMobileDay(syntheticDayCell({ label: "October 8, 2026, 3 items" }));
  expect(outcome).toEqual({ items: 3, dots: 2 });
  // The predicate must read the mobile surface, never the desktop-only event-title region.
  expect(expression).not.toContain("md:block");
  expect(expression).not.toContain("innerText");
  expect(expression).not.toContain("data-calendar-event");

  const singular = await runCalendarMobileDay(syntheticDayCell({ label: "October 8, 2026, 1 item", dotDisplays: ["flex"] }));
  expect(singular.outcome).toEqual({ items: 1, dots: 1 });

  const empty = await runCalendarMobileDay(syntheticDayCell({ label: "October 8, 2026", markers: "absent" }));
  expect(empty.outcome).toEqual({ items: 0, dots: 0 });

  const partiallyHiddenDots = await runCalendarMobileDay(
    syntheticDayCell({ label: "October 8, 2026, 2 items", dotDisplays: ["flex", "none"] })
  );
  expect(partiallyHiddenDots.outcome).toEqual({ items: 2, dots: 1 });
});

async function runCalendarOutcomeState(response: { status?: number; body?: unknown }) {
  let expression = "";
  const calendarOutcomeState = probeFunction("calendarOutcomeState", {
    evaluate: async (_client: unknown, source: string) => {
      expression = source;
      return runInNewContext(source, {
        fetch: async (url: string) => {
          expect(url).toBe("/api/browser-operations/bmo_synthetic_operation");
          const status = response.status ?? 200;
          return { ok: status >= 200 && status < 300, status, json: async () => response.body };
        }
      });
    }
  });
  const state = await calendarOutcomeState({ client: {} }, "bmo_synthetic_operation");
  return { state, expression };
}

it("CAL3 classifies the operation status into completed, retryable pending, or terminal", async () => {
  const completed = await runCalendarOutcomeState({
    body: { ok: true, data: { status: "completed", operationId: "bmo_synthetic_operation", outcome: { eventId: "evt_synthetic" } } }
  });
  expect(completed.state).toBe("completed");
  expect(completed.expression).toContain("cache: 'no-store'");

  // The real route answers 202 for a not-yet-terminal operation, so these must stay retryable.
  for (const [status, data] of [
    [202, { status: "pending", operationId: "bmo_synthetic_operation" }],
    [202, { status: "prepared", operationId: "bmo_synthetic_operation", code: "operation_prepared" }],
    [200, { status: "open", operationId: "bmo_synthetic_operation" }]
  ] as const) {
    const { state } = await runCalendarOutcomeState({ status, body: { ok: true, data } });
    expect(state).toBe("pending");
  }

  // A terminal non-completed outcome must never be retried into a pass.
  for (const [status, data] of [
    [200, { status: "stale", operationId: "bmo_synthetic_operation", code: "stale_context" }],
    [200, { status: "rejected", operationId: "bmo_synthetic_operation", code: "rejected" }],
    [410, { status: "expired", operationId: "bmo_synthetic_operation", code: "operation_abandoned" }]
  ] as const) {
    const { state } = await runCalendarOutcomeState({ status, body: { ok: true, data } });
    expect(state).toBe("terminal");
  }

  // A completed operation without a usable event identifier is not a saved event.
  for (const outcome of [{}, { eventId: "" }, { eventId: 123 }, undefined]) {
    const { state } = await runCalendarOutcomeState({
      body: { ok: true, data: { status: "completed", operationId: "bmo_synthetic_operation", outcome } }
    });
    expect(state).toBe("unavailable");
  }
  for (const body of [{ ok: false, error: { code: "not_found" } }, null, { ok: true }]) {
    const { state } = await runCalendarOutcomeState({ status: 404, body });
    expect(state).toBe("unavailable");
  }
});

async function runCalendarOutcomeCompleted(states: string[], limit?: number) {
  const observed: string[] = [];
  let slept = 0;
  const calendarOutcomeCompleted = probeFunction("calendarOutcomeCompleted", {
    calendarOutcomeState: async () => {
      const next = states.length > 1 ? states.shift()! : states[0];
      observed.push(next);
      return next;
    },
    sleep: async () => { slept += 1; },
    Date: { now: () => slept * 1_000 },
    fail: (code: string) => { throw Error(code); }
  });
  const outcome = await calendarOutcomeCompleted({ client: {} }, "bmo_synthetic_operation", limit).then(
    () => "completed",
    (error: Error) => error.message
  );
  return { outcome, observed, slept };
}

it("CAL4 tolerates a transient pending operation but fails closed on a terminal or timed-out outcome", async () => {
  // A Serializable submit can still be prepared/pending when the POST returns, so one read is not proof.
  const eventual = await runCalendarOutcomeCompleted(["pending", "pending", "completed"]);
  expect(eventual.outcome).toBe("completed");
  expect(eventual.observed).toEqual(["pending", "pending", "completed"]);

  const immediate = await runCalendarOutcomeCompleted(["completed"]);
  expect(immediate.outcome).toBe("completed");
  expect(immediate.slept).toBe(0);

  // A terminal outcome must fail on the first read rather than being polled into a pass.
  for (const terminal of ["terminal", "unavailable"]) {
    const rejected = await runCalendarOutcomeCompleted(["pending", terminal, "completed"]);
    expect(rejected.outcome).toBe("calendar_outcome_incomplete");
    expect(rejected.observed).toEqual(["pending", terminal]);
  }

  const timedOut = await runCalendarOutcomeCompleted(["pending"], 3_000);
  expect(timedOut.outcome).toBe("calendar_outcome_incomplete");
  expect(timedOut.observed.every((state) => state === "pending")).toBe(true);
  expect(timedOut.observed.length).toBeGreaterThan(1);
});

it("CAL5 requires a real item increase without demanding a capped dot row to grow", () => {
  const calendarDayAdvanced = probeFunction("calendarDayAdvanced", {}) as unknown as
    (before: { items: number; dots: number }, after: { items: number; dots: number }) => boolean;

  // The real month cell renders markers.slice(0, 4), so a saturated day can never grow its dot row.
  expect(calendarDayAdvanced({ items: 6, dots: 4 }, { items: 7, dots: 4 })).toBe(true);
  expect(calendarDayAdvanced({ items: 1, dots: 1 }, { items: 2, dots: 2 })).toBe(true);
  expect(calendarDayAdvanced({ items: 0, dots: 0 }, { items: 1, dots: 1 })).toBe(true);

  // An unchanged or regressing surface is not a cross-device update.
  expect(calendarDayAdvanced({ items: 1, dots: 1 }, { items: 1, dots: 1 })).toBe(false);
  expect(calendarDayAdvanced({ items: 2, dots: 2 }, { items: 1, dots: 1 })).toBe(false);
  // A count that rises while every marker disappears is not the created event becoming visible.
  expect(calendarDayAdvanced({ items: 1, dots: 1 }, { items: 2, dots: 0 })).toBe(false);
  expect(calendarDayAdvanced({ items: 0, dots: 0 }, { items: 1, dots: 0 })).toBe(false);
});

it("CAL6 binds the submitted operation to the completed-outcome check and the mobile observation", () => {
  const source = read("scripts/cross-device-freshness-browser-probe.mjs");
  const probe = ts.createSourceFile("probe.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);

  // One retained operation identifier is both submitted and reconciled, so a 2xx alone cannot pass.
  const submitted = source.indexOf("const calendarOperation = operationId();");
  const form = source.indexOf("operationId: calendarOperation");
  const reconciled = source.indexOf("await calendarOutcomeCompleted(a, calendarOperation)");
  const submitFailure = source.indexOf('fail("calendar_submit_failed")');
  expect(submitted).toBeGreaterThan(0);
  expect(form).toBeGreaterThan(submitted);
  expect(submitFailure).toBeGreaterThan(form);
  expect(reconciled).toBeGreaterThan(submitFailure);
  expect(source.match(/operationId: calendarOperation/g)).toHaveLength(1);

  // The baseline is captured on the already-open device-B page, and the observation never renavigates.
  const baseline = source.indexOf("const calendarBefore = await calendarMobileDay(b, day)");
  const observation = source.indexOf('await observe("calendar_create"');
  expect(baseline).toBeGreaterThan(0);
  expect(baseline).toBeLessThan(observation);
  expect(reconciled).toBeLessThan(observation);
  expect(source.slice(baseline, observation)).not.toContain("navigate(b,");

  // No other own-baby mutation may land between the baseline and the observation, or an unrelated
  // activity could move the combined item count and make a pass non-attributable.
  expect(source.slice(baseline, observation)).not.toContain('mutate(a, "/api/activities"');
  expect(source.slice(baseline, observation)).not.toContain('mutate(a, "/api/feed');

  let predicate = "";
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(probe) === "observe"
      && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === "calendar_create") {
      predicate = node.arguments[1].getText(probe);
    }
    ts.forEachChild(node, visit);
  };
  visit(probe);
  expect(predicate).toContain("calendarMobileDay(b, day)");
  expect(predicate).toContain("calendarDayAdvanced(calendarBefore,");
  expect(predicate).not.toContain("textPresent");
  expect(predicate).not.toContain("FRESH_CALENDAR_CREATED");
  // The event is still created with a real title; only the unsatisfiable title observer is retired.
  expect(source).toContain('title: "FRESH_CALENDAR_CREATED"');
});

/**
 * OC contracts close `ONLINE_CONFIRMATION_DISABLED_CONTROL_CONJUNCT`. The online-confirmation
 * observation must not depend on service-worker network emulation surviving an idle window: the
 * browser may terminate and restart an idle worker, and a restarted worker does not inherit the
 * emulation, so the timer request would succeed over the real network and the product would
 * correctly re-enable its controls while the harness still asserted an outage. The outage is now
 * deterministic at the page layer, and a lapsed worker outage is reported as its own harness
 * condition instead of becoming a product verdict.
 */
it("OC1 makes the online-confirmation outage deterministic at the page layer", () => {
  const source = read("scripts/cross-device-freshness-browser-probe.mjs");

  const blocked = source.indexOf('await b.client.call("Network.setBlockedURLs", { urls: [`${base}/api/timers/active*`] })');
  const online = source.indexOf('await b.client.call("Network.emulateNetworkConditions", { offline: false');
  const observation = source.indexOf('await observe("online_requires_confirmation"');
  expect(blocked).toBeGreaterThan(0);
  // The deterministic block is installed before the page returns online and before the assertion.
  expect(blocked).toBeLessThan(online);
  expect(online).toBeLessThan(observation);

  // The timer endpoint block is lifted only after that assertion, so the later cache observation
  // can still reach the service worker and exercise its fallback.
  const restored = source.indexOf('await b.client.call("Network.setBlockedURLs", { urls: [] })', observation);
  const cacheObservation = source.indexOf('await observe("service_worker_cache"');
  expect(restored).toBeGreaterThan(observation);
  expect(restored).toBeLessThan(cacheObservation);

  // The assertion itself is unchanged in meaning: confirmed status plus a disabled timer control.
  const probe = ts.createSourceFile("probe.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let predicate = "";
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(probe) === "observe"
      && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === "online_requires_confirmation") {
      predicate = node.arguments[1].getText(probe);
    }
    ts.forEachChild(node, visit);
  };
  visit(probe);
  // The assertion's meaning is unchanged; it now runs through the sub-state classifier.
  expect(predicate).toContain("onlineConfirmationState(b)");
  expect(predicate).toContain('"confirmed"');
  const classifier = source.slice(source.indexOf("async function onlineConfirmationState("), source.indexOf("const TIMER_PATH_PROBE"));
  // The instant is read from the TIMER paragraph's own group, not anywhere in the region: a
  // page-level instant plus a button disabled only because a timer load was pending would
  // otherwise satisfy the conjunction while timer staleness had in fact cleared.
  expect(classifier).toContain("Timer data may be out of date");
  expect(classifier).toContain("timerCopy.nextElementSibling?.querySelector('time')");
  expect(classifier).toContain('[aria-label="Running timers"] button:disabled');
});

it("OC9 keeps the application route reachable during the online-confirmation window", () => {
  const source = read("scripts/cross-device-freshness-browser-probe.mjs");

  // A lifecycle from a071b17d reported FRESHNESS_BROWSER_ONLINE_PAGE_ABSENT: blocking the
  // application route destroyed the page this step means to observe, so the step demanded a state
  // that cannot exist under its own staging. The timer data path alone is blocked now, which keeps
  // the outage deterministic while the page survives to be observed.
  const blocked = source.indexOf('await b.client.call("Network.setBlockedURLs", { urls: [`${base}/api/timers/active*`] })');
  const online = source.indexOf('await b.client.call("Network.emulateNetworkConditions", { offline: false');
  const observation = source.indexOf('await observe("online_requires_confirmation"');
  expect(blocked).toBeGreaterThan(0);
  expect(blocked).toBeLessThan(online);
  expect(online).toBeLessThan(observation);

  // No page-layer block on the application route reaches the observation window. The negative is
  // structural rather than a list of known-bad spellings: setBlockedURLs replaces the list
  // wholesale, so the LAST call before the assertion is the one that governs it, whatever its
  // spelling. An extra or differently written app-route block inserted after the narrowed one would
  // otherwise re-block the route and reintroduce ONLINE_PAGE_ABSENT undetected. The pattern is
  // whitespace- and newline-tolerant so a reformatted or multi-line call cannot slip past it.
  const staging = source.slice(0, observation);
  const callPattern = /await\s+[A-Za-z_$][\w$]*\.client\.call\(\s*"Network\.setBlockedURLs"[\s\S]*?\);/g;
  const calls = [...staging.matchAll(callPattern)];
  expect(calls.length).toBeGreaterThan(0);
  expect(calls.at(-1)![0].replace(/\s+/g, " ")).toBe('await b.client.call("Network.setBlockedURLs", { urls: [`${base}/api/timers/active*`] });');
  expect(staging).not.toContain('urls: [`${base}/app*`, `${base}/api/timers/active*`]');
  expect(staging).not.toContain('urls: [`${base}/app*`]');

  // Scope-independent backstop: the application-route pattern must not appear in ANY blocked-URL
  // argument anywhere in the probe, so a block installed inside the observe callback or in a helper
  // it calls - textually after the slice above - cannot evade this contract either.
  for (const call of source.matchAll(callPattern)) expect(call[0]).not.toContain("/app*");

  // The endpoint block is lifted after the assertion so the later cache observation still reaches
  // the service worker, and nothing is left blocked at the page layer.
  const restored = source.indexOf('await b.client.call("Network.setBlockedURLs", { urls: [] })', observation);
  const cacheObservation = source.indexOf('await observe("service_worker_cache"');
  expect(restored).toBeGreaterThan(observation);
  expect(restored).toBeLessThan(cacheObservation);
});

function probeConst(name: string) {
  const source = read("scripts/cross-device-freshness-browser-probe.mjs");
  const file = ts.createSourceFile("probe.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let text: string | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === name && node.initializer) {
      text = node.initializer.getText(file).replace(/^`|`$/g, "");
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  expect(text).toBeDefined();
  return text!;
}

// Executes the probe's real in-page expression against a fake fetch. A review found that asserting
// this expression only textually let a mutation add `signal: AbortSignal.abort()` and survive: the
// guard then reported "proven out" unconditionally, including when the timer path was fully live.
// The expression now reports a DISCRIMINATED outcome, so a probe-internal fault is distinguishable
// from a network refusal instead of both reading as an outage.
async function runTimerPathProbe(fetchImpl: (...args: unknown[]) => Promise<unknown>, randomness?: () => never) {
  const calls: unknown[][] = [];
  const spy = async (...args: unknown[]) => { calls.push(args); return await fetchImpl(...args); };
  const result = await runInNewContext(probeConst("TIMER_PATH_PROBE"), {
    fetch: spy,
    Uint8Array,
    Array,
    TypeError,
    crypto: { getRandomValues: randomness ?? ((array: Uint8Array) => { array.fill(7); return array; }) }
  }) as string;
  return { result, calls };
}

it("OC11 proves the timer path is out before asserting, and fails closed when it is reachable", async () => {
  const source = read("scripts/cross-device-freshness-browser-probe.mjs");
  const probe = ts.createSourceFile("probe.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);

  // Holding the worker online means the page-layer block is the only thing keeping the timer data
  // path out, and whether a page-session block reaches a worker-mediated request is not something
  // this harness may assume. So the outage is PROVEN before the assertion runs: a reachable timer
  // path is reported as a harness condition, never as a product verdict.
  const reachable = await runAssertTimerPathOut(true);
  expect(reachable.outcome).toBe("timer_path_reachable");
  const out = await runAssertTimerPathOut(false);
  expect(out.outcome).toBe("path_proven_out");

  // The in-page expression is EXECUTED, not text-matched: a request that answers must report
  // answered, and only a genuine network rejection may report refused. A text-only check let a
  // pre-aborted-signal mutation certify "proven out" while the path was live.
  const answered = await runTimerPathProbe(async () => ({ ok: true, status: 200 }));
  expect(answered.result).toBe("answered");
  const rejected = await runTimerPathProbe(async () => { throw new TypeError("Failed to fetch"); });
  expect(rejected.result).toBe("refused");

  // A 5xx still means the path answered, so it must not read as proven out.
  const refused = await runTimerPathProbe(async () => ({ ok: false, status: 503 }));
  expect(refused.result).toBe("answered");

  // A non-network throw is a probe fault, NOT an outage: a bare catch previously let any error -
  // a restarted worker, a TypeError in the expression - certify that the path was out.
  const nonNetwork = await runTimerPathProbe(async () => { throw Error("boom"); });
  expect(nonNetwork.result).toBe("probe_error");
  const brokenRandomness = await runTimerPathProbe(async () => ({ ok: true }), () => { throw Error("no csprng"); });
  expect(brokenRandomness.result).toBe("probe_error");
  expect(brokenRandomness.calls).toHaveLength(0);

  // It really issues one request, to the real endpoint, with no abort signal that would make the
  // rejection arm unconditional, and it reads no page text.
  expect(answered.calls).toHaveLength(1);
  expect(String(answered.calls[0][0])).toContain("/api/timers/active?requestToken=");
  expect(JSON.stringify(answered.calls[0][1] ?? {})).not.toContain("signal");
  expect(probeConst("TIMER_PATH_PROBE")).not.toContain("signal");
  expect(probeConst("TIMER_PATH_PROBE")).not.toContain("innerText");
  expect(probeConst("TIMER_PATH_PROBE")).not.toContain("textContent");

  // It runs after the page returns online and before the observation it guards.
  const online = source.indexOf('await b.client.call("Network.emulateNetworkConditions", { offline: false');
  const proof = source.indexOf("await assertTimerPathOut(b);");
  const observation = source.indexOf('await observe("online_requires_confirmation"');
  expect(proof).toBeGreaterThan(online);
  expect(proof).toBeLessThan(observation);

  // Its throwaway token cannot collide with the cache proof's fixed token.
  const assertion = source.slice(source.indexOf("async function assertTimerPathOut("), source.indexOf("async function assertWorkerBlockEnforced("));
  expect(assertion).not.toContain("cacheToken");
  let callCount = 0;
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(probe) === "assertTimerPathOut") callCount += 1;
    ts.forEachChild(node, visit);
  };
  visit(probe);
  expect(callCount).toBe(1);
});

// Executes the worker control's real in-page expression against a fake fetch. Grepping its literals
// was not enough: a review made it unconditionally truthy in the browser while every literal
// assertion still passed, which is the same defect as the text-matched outage probe before it.
async function runWorkerControlProbe(fetchImpl: (...args: unknown[]) => Promise<unknown>, randomness?: () => never) {
  const calls: unknown[][] = [];
  const spy = async (...args: unknown[]) => { calls.push(args); return await fetchImpl(...args); };
  const outcome = await runInNewContext(probeConst("WORKER_CONTROL_PROBE"), {
    fetch: spy,
    Uint8Array,
    Array,
    TypeError,
    crypto: { getRandomValues: randomness ?? ((array: Uint8Array) => { array.fill(7); return array; }) }
  }) as string;
  return { outcome, calls };
}

it("OC12 proves the worker's scoped block is enforced before the cache proof depends on it", async () => {
  const source = read("scripts/cross-device-freshness-browser-probe.mjs");

  // Whether CDP enforces a blocked-URL list on a service_worker target, and delivers the refusal to
  // the worker's own fetch() promise rather than erroring the fetch event, is not establishable from
  // source. service_worker_cache has never executed, so an unenforced block would have surfaced as a
  // late product-looking failure. It is proven where it is first relied upon, and fails closed.
  const run = async (reachable: boolean, control: boolean | string) => {
    const evaluated: string[] = [];
    const assertWorkerBlockEnforced = probeFunction("assertWorkerBlockEnforced", {
      WORKER_CONTROL_PROBE: "(control probe)",
      probeTimerPath: async () => reachable,
      evaluate: async (_client: unknown, expression: string) => {
        evaluated.push(expression);
        return typeof control === "string" ? control : control ? "answered" : "refused";
      },
      fail: (code: string) => { throw Error(code); }
    });
    const outcome = await assertWorkerBlockEnforced({ client: {} }).then(() => "enforced", (error: Error) => error.message);
    return { outcome, evaluated };
  };

  // An answering timer path means the block is not enforced at all.
  expect((await run(true, true)).outcome).toBe("worker_block_unenforced");

  // A refused timer path alone is NOT proof: the worker falls back to caches.match, which must miss
  // for a never-cached URL, so respondWith(undefined) rejects for an unrelated reason that looks
  // identical. The positive control separates enforcement from a broken worker, and it must be
  // load-bearing - removing it previously left this guard unprotected while every test passed.
  expect((await run(false, false)).outcome).toBe("worker_control_unreachable");
  expect((await run(false, "probe_error")).outcome).toBe("worker_control_probe_failed");
  expect((await run(false, true)).outcome).toBe("enforced");

  // The control is a real request through the same worker, and reads no page text. Its SEMANTICS are
  // executed, not grepped: a review made the control unconditionally truthy in the browser
  // (`return response.ok || true`) while every literal assertion still passed.
  const { outcome: answered, calls: answeredCalls } = await runWorkerControlProbe(async () => ({ ok: true }));
  expect(answered).toBe("answered");
  expect(answeredCalls).toHaveLength(1);
  // The control URL must NOT be answerable from the shell cache. sw.js pre-caches
  // /manifest.webmanifest via SHELL_ASSETS and answers any controlled GET from cache when its
  // network fails, so the un-busted URL passed with the worker's network fully dead - proving only
  // that the worker was alive. caches.match defaults to ignoreSearch:false, so a unique query can
  // never match the cached entry: answering REQUIRES the passthrough fetch to reach the network.
  expect(String(answeredCalls[0][0])).toMatch(/\/manifest\.webmanifest\?cacheBust=[0-9a-f]{32}$/);
  expect(await runWorkerControlProbe(async () => ({ ok: false })).then(r => r.outcome)).toBe("refused");
  expect(await runWorkerControlProbe(async () => { throw new TypeError("blocked"); }).then(r => r.outcome)).toBe("refused");
  expect(await runWorkerControlProbe(async () => { throw Error("not a network failure"); }).then(r => r.outcome)).toBe("probe_error");
  const broken = await runWorkerControlProbe(async () => ({ ok: true }), () => { throw Error("no randomness"); });
  expect(broken.outcome).toBe("probe_error");
  expect(broken.calls).toHaveLength(0);
  expect(probeConst("WORKER_CONTROL_PROBE")).not.toContain("innerText");
  expect(probeConst("WORKER_CONTROL_PROBE")).not.toContain("textContent");

  // Both the outage proof and its control are consumed in conditions, never discarded.
  const file = ts.createSourceFile("probe.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const declaration = file.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "assertWorkerBlockEnforced");
  expect(declaration).toBeDefined();
  const body = declaration!.getText(file);
  expect(body).toMatch(/if\s*\(\s*await\s+probeTimerPath\(device\)\s*\)\s*fail\("worker_block_unenforced"\)/);
  expect(body).toMatch(/if\s*\(\s*control\s*===\s*"probe_error"\s*\)\s*fail\("worker_control_probe_failed"\)/);
  expect(body).toMatch(/if\s*\(\s*control\s*!==\s*"answered"\s*\)\s*fail\("worker_control_unreachable"\)/);

  // Placement is derived from RESOLVED AST call nodes, never from source.indexOf of call text: a
  // review deleted the guard with `// await assertWorkerBlockEnforced(b);` and every text-anchored
  // offset still matched inside the comment, so the whole CDP-enforcement discharge vanished from
  // the lifecycle with the suite green. A commented-out call is not a CallExpression.
  // A guard must be REACHED, not merely present. Counting CallExpressions proved only that the text
  // existed as a call: `if (false) await guard(b);`, `void guard(b);`, `try { await guard(b); }
  // catch {}` and a local no-op shadow `{ const guard = async () => {}; await guard(b); }` all left
  // exactly one correctly-named call node while the real guard never ran. So the call must be an
  // awaited expression statement on the lifecycle's unconditional path, and the name must not be
  // re-bound in any inner scope.
  // TOTAL and DECIDABLE. The previous reachability model inferred whether a guard was on the
  // unconditional path, and a review defeated it twice over: `switch (0) { case 1: await guard(b); }`
  // and `[].forEach(async () => await guard(b))` both read as unconditional, and catch-propagation was
  // decided by a TEXT regex over the handler, so `catch { /* throw */ }` laundered a fully swallowed
  // guard. Inference is abandoned. The guard call must be a DIRECT CHILD STATEMENT of the lifecycle's
  // own top-level try block - the one construct whose handler is known to report and exit non-zero.
  // Anything nested inside a switch, a callback, an if, or an inner try/catch is by construction not a
  // direct child and fails regardless of how it is spelled.
  const lifecycleTry = file.statements.find(ts.isTryStatement);
  expect(lifecycleTry).toBeDefined();
  const guardStatement = (name: string) => {
    const shadows: string[] = [];
    const walkShadow = (node: ts.Node) => {
      if ((ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node))
        && node.name && ts.isIdentifier(node.name) && node.name.text === name) {
        const atModuleScope = ts.isSourceFile(node.parent)
          || (ts.isVariableDeclarationList(node.parent) && ts.isVariableStatement(node.parent.parent)
            && ts.isSourceFile(node.parent.parent.parent));
        if (!atModuleScope) shadows.push(`${name} re-bound at ${node.getStart(file)}`);
      }
      ts.forEachChild(node, walkShadow);
    };
    walkShadow(file);
    expect(shadows).toEqual([]);
    // Every call to the guard anywhere in the file, so a second inert copy cannot hide.
    const all: number[] = [];
    const walkAll = (node: ts.Node) => {
      if (ts.isCallExpression(node) && node.expression.getText(file) === name) all.push(node.getStart(file));
      ts.forEachChild(node, walkAll);
    };
    walkAll(file);
    const direct = lifecycleTry!.tryBlock.statements
      .filter(statement => ts.isExpressionStatement(statement)
        && ts.isAwaitExpression(statement.expression)
        && ts.isCallExpression(statement.expression.expression)
        && statement.expression.expression.expression.getText(file) === name)
      .map(statement => statement.getStart(file));
    // A call that exists but is not a direct awaited child statement is inert: report it rather than
    // silently counting only the good ones.
    expect(all).toHaveLength(direct.length);
    return direct;
  };
  const enforcedSites = guardStatement("assertWorkerBlockEnforced");
  expect(enforcedSites).toHaveLength(1);
  const pageLifts = cdpCalls("Network.setBlockedURLs").calls
    .filter(call => call.receiver === "b.client" && call.argument === "{ urls: [] }");
  expect(pageLifts.length).toBeGreaterThan(0);
  const cacheObservation = source.indexOf('await observe("service_worker_cache"');
  expect(cacheObservation).toBeGreaterThan(0);
  expect(enforcedSites[0]).toBeGreaterThan(pageLifts[0].offset);
  expect(enforcedSites[0]).toBeLessThan(cacheObservation);
  // The outage re-assertion and the timer-path proof must be reached on the same unconditional path.
  expect(guardStatement("assertTimerPathOut")).toHaveLength(1);
  expect(guardStatement("assertWorkerOutage")).toHaveLength(1);
});

// TOTAL and DECIDABLE. Six review rounds defeated every inference-based version of this enumerator:
// an allowlist of callee shapes, then of receivers, then of carrier binding forms. Each closed the
// reported spellings and left an adjacent one open, because each tried to work out WHICH expression
// holds a CDP connection. The last hole was a connection passed as a FUNCTION PARAMETER with a
// runtime-built method name, which reinstated the document-severing emulation with a green suite.
//
// Inference is abandoned for three rules that need no notion of which variable holds a connection.
// In this probe `.call` is used EXCLUSIVELY for CDP dispatch, so:
//   1. the indirect-dispatch primitives are forbidden outright (the clean probe contains none);
//   2. a `call` reference may not be detached from its receiver without being invoked;
//   3. every invoked `.call(...)` must name its CDP method as a STRING LITERAL.
// Together these are total: the only route to a connection's `call` is rule 3, which forces a literal
// method name, so the dangerous-method check below is exhaustive by construction. A parameter, a
// destructured binding, a for-of binding and an alias chain of any depth are all irrelevant.
const CDP_DANGEROUS = new Set([
  "Network.setBlockedURLs",
  "Network.emulateNetworkConditions",
  // Stalls every request through the target when enabled with a wildcard pattern and no handler.
  "Fetch.enable",
  "Network.setRequestInterception"
]);

// Structural, name-free pin for loop-driven domain enables. The previous pin required the loop
// variable to be spelled `domain`, which rejected a semantically identical rename, and rejected
// `for (const m of ["Page.enable"]) await worker.call(m)` outright. Only benign enable/disable
// methods can satisfy it: `Network.setBlockedURLs` fails the tail pattern.
const BENIGN_DOMAIN = /^[A-Z][A-Za-z]*(?:\.(?:enable|disable))?$/;
function benignDomainLoop(call: ts.CallExpression, file: ts.SourceFile) {
  let scope: ts.Node | undefined = call;
  while (scope && !ts.isForOfStatement(scope)) scope = scope.parent;
  if (!scope) return false;
  const loop = scope as ts.ForOfStatement;
  if (!ts.isArrayLiteralExpression(loop.expression)) return false;
  if (!loop.expression.elements.every(element => ts.isStringLiteral(element) && BENIGN_DOMAIN.test(element.text))) return false;
  const declarations = ts.isVariableDeclarationList(loop.initializer) ? loop.initializer.declarations : [];
  const bound = declarations.length === 1 && ts.isIdentifier(declarations[0].name) ? declarations[0].name.text : undefined;
  if (!bound) return false;
  const first = call.arguments[0];
  if (!first) return false;
  // Either the bare loop variable, or a single-span template whose tail is a benign suffix.
  if (ts.isIdentifier(first) && first.text === bound) return true;
  if (ts.isTemplateExpression(first) && first.templateSpans.length === 1 && first.head.text === "") {
    const span = first.templateSpans[0];
    return ts.isIdentifier(span.expression) && span.expression.text === bound
      && /^\.(?:enable|disable)$/.test(span.literal.text);
  }
  return false;
}

function cdpCalls(method: string) {
  const text = read("scripts/cross-device-freshness-browser-probe.mjs");
  const file = ts.createSourceFile("probe.mjs", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const violations: string[] = [];
  const calls: { receiver: string; argument: string; offset: number }[] = [];

  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(file).replace(/\s+/g, "");
      // Rule 1: no primitive that can invoke a function while naming neither receiver nor method in a
      // resolvable position. Reflect.apply carried the emulation past an earlier version of this gate.
      if (/\bReflect\.(?:apply|get)\b/.test(callee) || /\.(?:apply|bind)$/.test(callee)) {
        violations.push(`indirect dispatch primitive ${callee.slice(0, 44)} at ${node.getStart(file)}`);
      }
      // Rule 3: an invoked `.call` must name its method as a string literal.
      const invokesCall = /\.call$/.test(callee) || /\[["']call["']\]$/.test(callee);
      if (invokesCall) {
        const first = node.arguments[0];
        if (!first || (!ts.isStringLiteral(first) && !benignDomainLoop(node, file))) {
          violations.push(`opaque CDP dispatch ${callee.slice(0, 32)}(${first ? first.getText(file).replace(/\s+/g, " ").slice(0, 32) : ""}) at ${node.getStart(file)}`);
        } else if (ts.isStringLiteral(first) && first.text === method) {
          const receiver = ts.isPropertyAccessExpression(node.expression)
            ? node.expression.expression.getText(file)
            : (node.expression as ts.ElementAccessExpression).expression.getText(file);
          calls.push({
            receiver,
            argument: node.arguments[1] ? node.arguments[1].getText(file).replace(/\s+/g, " ") : "",
            offset: node.getStart(file)
          });
        }
      }
    }
    // Rule 2: a `call` reference may not be detached from its receiver. Without this, `const f =
    // worker.call; await f(m, ...)` would reach a dispatch through a callee naming no connection.
    if ((ts.isPropertyAccessExpression(node) && node.name.text === "call")
      || (ts.isElementAccessExpression(node) && node.argumentExpression
        && ts.isStringLiteral(node.argumentExpression) && node.argumentExpression.text === "call")) {
      const invoked = ts.isCallExpression(node.parent) && node.parent.expression === node;
      if (!invoked) {
        violations.push(`detached call reference ${node.getText(file).replace(/\s+/g, "").slice(0, 44)} at ${node.getStart(file)}`);
      }
    }
    // Rule 2b: a computed member access with a non-literal key is forbidden when its result can be
    // dispatched. Both `worker["c"+"all"](m, p)` and `const k = "call"; const f = worker[k]; await
    // f(m, p)` evaded Rule 2 (the key is no literal) AND Rule 3 (the callee text matches neither
    // /\.call$/ nor /\["call"\]$/), making the dispatch wholly invisible rather than merely
    // misfiltered. Decided STRUCTURALLY, with no name heuristics: the access is a violation if it is
    // invoked, or if it is stored in a binding that is invoked anywhere in the file. Legitimate
    // indexing such as `alphabet[byte % alphabet.length]` is untouched because its result is only
    // read, never called - which is a property of the code, not of what the variable is named.
    if (ts.isElementAccessExpression(node) && node.argumentExpression
      && !ts.isStringLiteral(node.argumentExpression) && !ts.isNumericLiteral(node.argumentExpression)) {
      const invoked = ts.isCallExpression(node.parent) && node.parent.expression === node;
      let dispatchable = invoked;
      if (!dispatchable && ts.isVariableDeclaration(node.parent) && node.parent.initializer === node
        && ts.isIdentifier(node.parent.name)) {
        const bound = node.parent.name.text;
        const findInvocation = (scan: ts.Node): boolean => {
          if (ts.isCallExpression(scan) && ts.isIdentifier(scan.expression) && scan.expression.text === bound) return true;
          return ts.forEachChild(scan, findInvocation) ?? false;
        };
        dispatchable = findInvocation(file);
      }
      if (dispatchable) {
        violations.push(`computed dispatch ${node.getText(file).replace(/\s+/g, "").slice(0, 44)} at ${node.getStart(file)}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);

  // Cheap exhaustiveness backstop: a dangerous method name may appear ONLY as a dispatch argument,
  // or inside the runtime guard itself - its denylist set and its `method === "..."` comparisons ARE
  // the enforcement, and naming a method there is what forbids it. Without this exemption the
  // backstop flags the very mechanism that makes the method unreachable, which would pressure a
  // future author to weaken the guard to quiet the contract.
  const literals: string[] = [];
  const insideGuard = (node: ts.Node): boolean => {
    for (let scan: ts.Node | undefined = node; scan; scan = scan.parent) {
      if (ts.isVariableDeclaration(scan) && ts.isIdentifier(scan.name)
        && (scan.name.text === "CDP_PATH_SEVERING" || scan.name.text === "CDP_DANGEROUS"
          || scan.name.text === "CDP_ALLOWED")) return true;
      if (ts.isFunctionDeclaration(scan) && scan.name?.text === "assertDispatchAllowed") return true;
    }
    return false;
  };
  const sweep = (node: ts.Node) => {
    if (ts.isStringLiteral(node) && CDP_DANGEROUS.has(node.text)) {
      const parent = node.parent;
      const isArgumentZero = ts.isCallExpression(parent) && parent.arguments[0] === node;
      if (!isArgumentZero && !insideGuard(node)) literals.push(`${node.text} is not a dispatch argument at ${node.getStart(file)}`);
    }
    ts.forEachChild(node, sweep);
  };
  sweep(file);

  expect(violations).toEqual([]);
  expect(literals).toEqual([]);
  return { calls };
}
it("OC10 never severs the document path the online-confirmation step observes", () => {
  const source = read("scripts/cross-device-freshness-browser-probe.mjs");

  // Two lifecycles reported ONLINE_PAGE_ABSENT. The cause was not the page-layer block: the service
  // worker is registered at the origin root with no scope filter and its fetch handler answers every
  // controlled GET, so holding the WORKER offline made the observed page's own route unreachable
  // while the page believed it was online. The worker outage must therefore never be an offline
  // emulation that also severs documents and RSC payloads.
  //
  // ENFORCED AT RUNTIME, NOT INFERRED FROM SOURCE. Seven review rounds tried to decide from source
  // which expression holds a CDP connection, and each inference was defeated by a new spelling:
  // aliases, bound receivers, parameters, object properties, spreads, computed keys, runtime-built
  // method names. The invariant now lives in the probe's own `call`, the single function every
  // dispatch passes through, so those spellings are irrelevant by construction. The checks below
  // EXECUTE that guard rather than reading the source that contains it; see the executable suite
  // immediately following for the subversion attempts it refuses.
  const emulations = cdpCalls("Network.emulateNetworkConditions");
  expect(emulations.calls).toHaveLength(2);
  expect(emulations.calls[0].argument).toContain("offline: true");
  expect(emulations.calls[1].argument).toContain("offline: false");

  // Every blocked-URL list is EXACTLY the timer data path, or an explicit clear. A negative check
  // for "/app*" was vacuous: no spelling of this harness ever contained it.
  const scoped = "{ urls: [`${base}/api/timers/active*`] }";
  const allBlocks = cdpCalls("Network.setBlockedURLs").calls;
  expect(allBlocks.length).toBeGreaterThan(0);
  for (const block of allBlocks) expect([scoped, "{ urls: [] }"]).toContain(block.argument);

  // THE GUARD MUST GOVERN THE SOCKET. A correct guard proves nothing if a dispatch can reach
  // `socket.send` without passing it, and that reachability was NOT enforced: the previous check
  // matched any property assignment named `call` anywhere in the probe and set one global flag, so a
  // six-line decoy object satisfied it while the real `call` dispatched unguarded. Nothing
  // constrained the returned object's OTHER properties either, so a sibling
  // `raw: (method, params) => socket.send(...)` bypassed the choke point completely. Both survived at
  // full green. Reachability is now decided structurally, from the object literal `connect` returns.
  const probeFile = ts.createSourceFile("probe.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);

  // The probe must PARSE. Every contract reads it through ts.createSourceFile or String.indexOf,
  // both of which tolerate syntax errors, so a probe node refuses to run still returned 172/172.
  execFileSync(process.execPath, ["--check", "scripts/cross-device-freshness-browser-probe.mjs"], { stdio: "pipe" });

  const collect = (root: ts.Node, predicate: (node: ts.Node) => boolean): ts.Node[] => {
    const found: ts.Node[] = [];
    const walk = (node: ts.Node) => { if (predicate(node)) found.push(node); ts.forEachChild(node, walk); };
    walk(root);
    return found;
  };
  const textOf = (node: ts.Node) => node.getText(probeFile);

  // `connect` is the sole connection factory, and it takes the kind the guard decides on.
  const connectDecl = collect(probeFile, node => ts.isFunctionDeclaration(node)
    && node.name?.text === "connect")[0] as ts.FunctionDeclaration | undefined;
  expect(connectDecl).toBeDefined();
  expect(connectDecl!.parameters.map(parameter => textOf(parameter.name))).toEqual(["url", "kind"]);
  const returnedObjects = collect(connectDecl!, node => ts.isReturnStatement(node)
    && !!node.expression && ts.isObjectLiteralExpression(node.expression))
    .map(node => (node as ts.ReturnStatement).expression as ts.ObjectLiteralExpression);
  expect(returnedObjects).toHaveLength(1);
  const connection = returnedObjects[0];

  // EXACT dispatch surface. A new property on this object is a new dispatch path, so the allowlist
  // is exhaustive: widening it must be a deliberate edit to this contract, never a silent addition.
  const surface = connection.properties.map(property => property.name ? textOf(property.name) : "");
  expect([...surface].sort()).toEqual(["call", "close", "on"]);

  // `socket.send` must occur EXACTLY once in the entire probe, inside that object's `call` property.
  // This is the property the design claims - one function every dispatch passes through - and it was
  // previously only true of the current spelling rather than enforced.
  const sends = collect(probeFile, node => ts.isCallExpression(node)
    && ts.isPropertyAccessExpression(node.expression)
    && node.expression.name.text === "send"
    && textOf(node.expression.expression) === "socket");
  expect(sends).toHaveLength(1);
  const callProperty = connection.properties.find(property => ts.isPropertyAssignment(property)
    && textOf(property.name) === "call") as ts.PropertyAssignment | undefined;
  expect(callProperty).toBeDefined();
  expect(sends[0].getStart(probeFile)).toBeGreaterThan(callProperty!.getStart(probeFile));
  expect(sends[0].getEnd()).toBeLessThan(callProperty!.getEnd());

  // Exactly one `call` surface exists anywhere, so a decoy cannot satisfy the invocation check.
  const callProperties = collect(probeFile, node => ts.isPropertyAssignment(node)
    && textOf(node.name) === "call");
  expect(callProperties).toHaveLength(1);

  // The guard must be the FIRST statement of that one `call`, receiving the dispatch's own
  // parameters - not literals, not shadowed names.
  const dispatcher = callProperty!.initializer;
  expect(ts.isArrowFunction(dispatcher) || ts.isFunctionExpression(dispatcher)).toBe(true);
  const dispatcherParameters = (dispatcher as ts.ArrowFunction).parameters.map(parameter => textOf(parameter.name));
  const dispatcherBody = (dispatcher as ts.ArrowFunction).body;
  expect(ts.isBlock(dispatcherBody)).toBe(true);
  const firstStatement = (dispatcherBody as ts.Block).statements[0];
  expect(!!firstStatement && ts.isExpressionStatement(firstStatement)).toBe(true);
  const guardCall = (firstStatement as ts.ExpressionStatement).expression;
  expect(ts.isCallExpression(guardCall)).toBe(true);
  expect(textOf((guardCall as ts.CallExpression).expression)).toBe("assertDispatchAllowed");
  expect((guardCall as ts.CallExpression).arguments.map(textOf))
    .toEqual(["kind", dispatcherParameters[0], dispatcherParameters[1]]);

  // Connection creation enumerated from RESOLVED call nodes, not a regex. `/await connect\(/` did not
  // match a non-awaited `connect(...)`, so the exactly-three bound was not a bound on connections at
  // all: a rogue worker socket could be created and tagged "page", which the guard then lawfully
  // permits to emulate offline - the precise defect two lifecycles failed on.
  const connectCalls = collect(probeFile, node => ts.isCallExpression(node)
    && ts.isIdentifier(node.expression) && node.expression.text === "connect") as ts.CallExpression[];
  expect(connectCalls).toHaveLength(3);
  const tagged: Record<string, string> = {};
  for (const site of connectCalls) {
    expect(site.arguments).toHaveLength(2);
    expect(ts.isStringLiteral(site.arguments[1])).toBe(true);
    tagged[textOf(site.arguments[0])] = (site.arguments[1] as ts.StringLiteral).text;
  }
  expect(tagged).toEqual({
    url: "browser",
    "target.webSocketDebuggerUrl": "page",
    "workerTarget.webSocketDebuggerUrl": "worker"
  });

  // EVERY SOCKET MUST BE BORN INSIDE `connect`. Binding the returned object's property set closed
  // the "sibling raw: property" spelling but not the class: a raw `new WebSocket(workerTarget...)`
  // with its own `.send` never touches the connection object at all, took the worker offline, and
  // survived at full green. The only thing that caught it was the dangerous-method string-literal
  // sweep, which a concatenated method name defeats. So socket CONSTRUCTION is censused: exactly one
  // `new WebSocket` in the probe, lexically inside `connect`.
  const sockets = collect(probeFile, node => ts.isNewExpression(node)
    && textOf(node.expression) === "WebSocket") as ts.NewExpression[];
  expect(sockets).toHaveLength(1);
  expect(sockets[0].getStart(probeFile)).toBeGreaterThan(connectDecl!.getStart(probeFile));
  expect(sockets[0].getEnd()).toBeLessThan(connectDecl!.getEnd());

  // No `.send` may be reached through any receiver other than the one socket. The previous rule
  // matched only a receiver whose text is exactly "socket", so `const s = socket; s.send(...)`, a
  // destructured `{ send }`, `socket["se"+"nd"]`, or `Reflect.apply(socket.send, ...)` were invisible.
  const anySend = collect(probeFile, node => ts.isCallExpression(node)
    && ((ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "send")
      || (ts.isElementAccessExpression(node.expression)
        && (!ts.isStringLiteral(node.expression.argumentExpression)
          || node.expression.argumentExpression.text === "send")))) as ts.CallExpression[];
  for (const send of anySend) {
    expect(textOf((send.expression as ts.PropertyAccessExpression).expression)).toBe("socket");
  }
  expect(anySend).toHaveLength(1);
  // A detached or re-bound `send`, or the socket escaping by any alias, is refused outright.
  const sendEscapes = collect(probeFile, node => (ts.isPropertyAccessExpression(node)
    && node.name.text === "send" && !(ts.isCallExpression(node.parent) && node.parent.expression === node))
    || (ts.isBindingElement(node) && textOf(node.name) === "send")
    || (ts.isVariableDeclaration(node) && !!node.initializer && textOf(node.initializer) === "socket"));
  expect(sendEscapes.map(node => textOf(node))).toEqual([]);

  // THE KIND TAG MUST BE BOUND TO THE TARGET IT CONNECTS TO. The census mapped an argument's
  // expression TEXT to a required kind, and nothing tied that text to a verified CDP target type, so
  // re-pointing the "page" site's target at a service_worker entry kept the tag `"page"` and the
  // guard then lawfully permitted it to emulate offline - the eighth review's defect in a new
  // spelling. Each tagged site's target must derive from a filter on the matching target type.
  const targetTypeFor = (binding: string) => {
    const declaration = collect(probeFile, node => ts.isVariableDeclaration(node)
      && textOf(node.name) === binding)[0] as ts.VariableDeclaration | undefined;
    expect(declaration).toBeDefined();
    const initializer = textOf(declaration!.initializer!);
    const types = [...initializer.matchAll(/\.type\s*===\s*"([a-z_]+)"/g)].map(match => match[1]);
    expect(new Set(types).size).toBe(1);
    return types[0];
  };
  expect(targetTypeFor("target")).toBe("page");
  expect(targetTypeFor("workerTarget")).toBe("service_worker");

  // THE PAGE'S OFFLINE RESTORE MUST BE RUNTIME-REACHABLE. Source position pins the ORDER of the two
  // emulations but says nothing about execution: prefixing the `offline: false` restore with
  // `if (observations.size > 9999)` kept both call nodes in the required order while the page never
  // came back online, so the observation ran against a dead page. The reachability machinery already
  // used for the assert helpers is applied to the dispatches that actually sever the path.
  const dispatchStatement = (needle: string) => {
    const lifecycle = probeFile.statements.find(ts.isTryStatement);
    expect(lifecycle).toBeDefined();
    const occurrences = collect(probeFile, node => ts.isCallExpression(node)
      && textOf(node).includes(needle)) as ts.CallExpression[];
    const direct = lifecycle!.tryBlock.statements.filter(statement => ts.isExpressionStatement(statement)
      && ts.isAwaitExpression(statement.expression)
      && ts.isCallExpression(statement.expression.expression)
      && textOf(statement.expression.expression).includes(needle));
    // Every occurrence must be one of those unconditional awaited statements: a call wrapped in a
    // condition, a loop, a callback or a swallowing try is inert and is reported, not ignored.
    expect(occurrences).toHaveLength(direct.length);
    return direct.length;
  };
  expect(dispatchStatement('"Network.emulateNetworkConditions", { offline: true')).toBe(1);
  expect(dispatchStatement('"Network.emulateNetworkConditions", { offline: false')).toBe(1);

  // `fail` MUST THROW. Nothing constrained it, and `const fail = (code) => { browserFailure(code); }`
  // - dropping one keyword - turned every refusal in the probe into a no-op: all four guard refusals,
  // the timer-path and worker-control proofs, and the observation census became silent, and the probe
  // printed PASS with exit 0 at full green. The guard FUNCTION was protected; its helper was not.
  const failDeclaration = collect(probeFile, node => ts.isVariableDeclaration(node)
    && textOf(node.name) === "fail")[0] as ts.VariableDeclaration | undefined;
  expect(failDeclaration).toBeDefined();
  const failBody = (failDeclaration!.initializer as ts.ArrowFunction).body;
  expect(ts.isBlock(failBody)).toBe(true);
  const failStatements = (failBody as ts.Block).statements;
  expect(failStatements).toHaveLength(1);
  expect(ts.isThrowStatement(failStatements[0])).toBe(true);
  expect(textOf(failStatements[0])).toBe("throw browserFailure(code);");
  // No other binding may shadow or re-bind it, and it may never be reassigned.
  expect(collect(probeFile, node => ts.isVariableDeclaration(node) && textOf(node.name) === "fail")).toHaveLength(1);
  expect(collect(probeFile, node => ts.isBinaryExpression(node)
    && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    && textOf(node.left) === "fail")).toHaveLength(0);

  // THE TAG MUST BE BOUND TO THE SOCKET, NOT TO THE TEXT THAT CHOSE IT. Scanning the target
  // binding's initializer for `.type === "..."` only catches edits that disturb that text: assigning
  // `target.webSocketDebuggerUrl = <service worker's url>` afterwards left the initializer intact,
  // kept the tag "page", and let the pre-existing page emulation take the WORKER offline - the
  // two-lifecycle defect, reinstated at full green. A target's properties may never be written.
  for (const binding of ["target", "workerTarget"]) {
    const writes = collect(probeFile, node => ts.isBinaryExpression(node)
      && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && (ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left))
      && textOf(node.left.expression) === binding);
    expect(writes.map(node => textOf(node))).toEqual([]);
  }
  // The URL handed to `connect` must be read directly off the type-filtered binding, never through
  // an intermediate that could have been redirected.
  for (const site of connectCalls.slice(1)) {
    expect(textOf(site.arguments[0])).toMatch(/^(?:target|workerTarget)\.webSocketDebuggerUrl$/);
  }

  // IN-PAGE CODE IS AN ALLOWLIST, NOT A DENYLIST. The guard only sees CDP dispatches, so page-side
  // JavaScript is a second, independent route to severing the observed document path - and a regex
  // denylist over probe source could never close it: the expressions are template literals, so
  // page-side runtime string building (`self['cach'+'es']`, `reg['un'+'register']()`), a cache handle
  // aliased before deletion, `document.write`, `window.location =`, `history.pushState` and
  // `Object.defineProperty(window,'fetch',...)` all sever or destroy evidence without matching any
  // pattern. 13 of 15 such mutations survived a fully green suite. Enumerating forbidden spellings is
  // the arms race rounds 7-11 lost five times; this inverts the polarity. Every in-page expression is
  // pinned by hash, so ANY new or modified expression fails closed until it is deliberately reviewed
  // and registered here. Deny by default is the only form of this check that terminates.
  const inPageExpressions = (collect(probeFile, node => ts.isCallExpression(node)
    && ts.isIdentifier(node.expression) && node.expression.text === "evaluate") as ts.CallExpression[])
    .filter(node => node.arguments.length > 1)
    .map(node => ({
      line: probeFile.getLineAndCharacterOfPosition(node.getStart(probeFile)).line + 1,
      digest: createHash("sha256").update(textOf(node.arguments[1]).split("\r\n").join("\n")).digest("hex").slice(0, 16)
    }));
  const approvedInPage = [
    "b6314e78adb288ba", "3edb0c76cf5879f6", "fa13e2bca6b7473b", "3a2b8b8632ff5794",
    "62774b8d810c5708", "f3d2fa2984abcdbf", "1d653cd704aebd95", "f37b8f0b68f9e17a",
    "129668a0b4b539ae", "d2121bbba90c548e", "bced93e94d88108b", "ff6ab94dcba63c0c",
    "5bd370d435906199", "482d895bb0b5c985", "a8c2f0c5888caf31", "03718191aea7c946",
    "db165cc3493f249f", "a8c2f0c5888caf31", "f3ba4b67fd5acc5d", "3b6f9aaceecccc71",
    "c3eb418ad1ace980", "078a1a12b6390ded", "7cbeebac0d318f1a", "9b9127bd4ab9c54f",
    "0741665a967d0a2e", "865b8ee86596dac3", "4e77dbda0df164ed", "662d420e6b504459",
    "0fff10e7d8ecad36", "d6cf750806b1eb7e", "dcdd38d262f05dca", "13cbbe4b62aa5f0c",
    "cc02c00986be22a0"
  ];
  // Unregistered or altered expressions are reported with their line, so the failure names the edit.
  expect(inPageExpressions.filter(entry => !approvedInPage.includes(entry.digest))
    .map(entry => `unapproved in-page expression at probe:${entry.line} (${entry.digest})`)).toEqual([]);
  // The census must be exact in both directions: a REMOVED expression is also a contract change, and
  // the count pins it, so an attacker cannot delete a proof and leave the allowlist satisfied.
  expect(inPageExpressions).toHaveLength(approvedInPage.length);
  expect([...inPageExpressions].map(entry => entry.digest).sort()).toEqual([...approvedInPage].sort());
  // `evaluate` must remain the only page-side execution route: no direct Runtime.evaluate dispatch
  // may bypass this census, and no other helper may forward an expression to the page. The method
  // name now appears twice - once at the single dispatch site, once as a key in the CDP_ALLOWED
  // table - so require exactly that split rather than a bare count, which the table would inflate.
  const evaluateLiterals = collect(probeFile, node => ts.isStringLiteral(node)
    && node.text === "Runtime.evaluate") as ts.StringLiteral[];
  expect(evaluateLiterals).toHaveLength(2);
  const evaluateDispatches = evaluateLiterals.filter(node => ts.isCallExpression(node.parent)
    && node.parent.arguments[0] === node);
  expect(evaluateDispatches).toHaveLength(1);
  // The one dispatch must be inside `evaluate` itself, not in some other helper.
  const inEvaluate = (node: ts.Node): boolean => {
    for (let scan: ts.Node | undefined = node; scan; scan = scan.parent) {
      if (ts.isFunctionDeclaration(scan) && scan.name?.text === "evaluate") return true;
    }
    return false;
  };
  expect(inEvaluate(evaluateDispatches[0])).toBe(true);
  // The other occurrence is the allowlist key, which is what permits it at all.
  const inAllowedTable = (node: ts.Node): boolean => {
    for (let scan: ts.Node | undefined = node; scan; scan = scan.parent) {
      if (ts.isVariableDeclaration(scan) && ts.isIdentifier(scan.name)
        && scan.name.text === "CDP_ALLOWED") return true;
    }
    return false;
  };
  expect(evaluateLiterals.filter(node => !evaluateDispatches.includes(node))
    .every(node => inAllowedTable(node))).toBe(true);

  // THE CENSUS MUST HASH THE EXPRESSION, NOT A NAME THAT POINTS AT IT. Two sites pass a bare
  // identifier - TIMER_PATH_PROBE and WORKER_CONTROL_PROBE - so the digest covered the 16-character
  // string "TIMER_PATH_PROBE" while the const body it names was outside the allowlist entirely.
  // Rewriting that body to return "refused" unconditionally forged BOTH outage proofs at full
  // green. Any identifier argument must therefore have its DECLARATION pinned too.
  const indirectProbes = [
    { name: "TIMER_PATH_PROBE", digest: "a2e048922c1fd78f" },
    { name: "WORKER_CONTROL_PROBE", digest: "d0244cbdcd9dd03d" }
  ];
  // A pinned declaration may be a const initializer or a function declaration; hash the body either
  // way, so the thing that actually runs in the page is what the digest covers.
  const declarationDigest = (name: string) => {
    const variable = collect(probeFile, node => ts.isVariableDeclaration(node)
      && textOf(node.name) === name)[0] as ts.VariableDeclaration | undefined;
    const fn = collect(probeFile, node => ts.isFunctionDeclaration(node)
      && Boolean(node.name) && textOf(node.name!) === name)[0] as ts.FunctionDeclaration | undefined;
    const subject = variable?.initializer ?? fn;
    expect(subject, `${name} declaration missing`).toBeDefined();
    return createHash("sha256").update(textOf(subject!).split("\r\n").join("\n"))
      .digest("hex").slice(0, 16);
  };
  // Every identifier passed to evaluate must be one of the pinned indirect probes.
  const identifierArguments = (collect(probeFile, node => ts.isCallExpression(node)
    && ts.isIdentifier(node.expression) && node.expression.text === "evaluate") as ts.CallExpression[])
    .filter(node => node.arguments.length > 1 && ts.isIdentifier(node.arguments[1]))
    .map(node => textOf(node.arguments[1]));
  expect([...identifierArguments].sort()).toEqual(indirectProbes.map(entry => entry.name).sort());
  expect(indirectProbes.map(entry => `${entry.name}:${declarationDigest(entry.name)}`))
    .toEqual(indirectProbes.map(entry => `${entry.name}:${entry.digest}`));

  // INTERPOLATED VALUES ARE PART OF THE EXPRESSION. An approved template literal embeds
  // ${renderedIsolationMarkup.toString()}, so editing that function changed what runs in the page
  // while every digest stayed identical - adding one nodeName test made the tenant-isolation proof
  // unconditionally true. Any function serialised into an in-page expression is pinned as well.
  const interpolatedHelpers = [{ name: "renderedIsolationMarkup", digest: "f1c783683118c9bc" }];
  expect(interpolatedHelpers.map(entry => `${entry.name}:${declarationDigest(entry.name)}`))
    .toEqual(interpolatedHelpers.map(entry => `${entry.name}:${entry.digest}`));
  // No OTHER function may be serialised into page code, or it would be an unpinned channel.
  const serialisedFunctions = [...new Set([...source.matchAll(/\$\{([A-Za-z_$][\w$]*)\.toString\(\)\}/g)]
    .map(match => match[1]))].sort();
  expect(serialisedFunctions).toEqual(interpolatedHelpers.map(entry => entry.name).sort());

  // THE PERMITTED CDP SURFACE IS ITSELF A SEVERING ROUTE. Refusing four methods left the rest of
  // the protocol open: Page.navigate/reload sever the document, Storage.clearDataForOrigin and
  // Network.clearBrowserCache destroy the cache evidence, ServiceWorker.stopAllWorkers kills the
  // worker, Emulation.setScriptExecutionDisabled kills page script, and Runtime.callFunctionOn and
  // Page.addScriptToEvaluateOnNewDocument execute arbitrary page code without naming
  // Runtime.evaluate, bypassing the in-page census. The guard now denies every unlisted method, so
  // the contract pins the table: adding a method is a visible, reviewable edit here.
  const allowedEntries = [...source.matchAll(/\["([A-Za-z]+\.[A-Za-z]+)",\s*new Set\(\[([^\]]*)\]\)\]/g)]
    .map(match => `${match[1]}=${match[2].replace(/["\s]/g, "")}`);
  expect(allowedEntries).toEqual([
    "Target.createTarget=browser", "Target.activateTarget=browser", "Target.closeTarget=browser",
    "Page.enable=page", "Runtime.enable=page", "Log.enable=page",
    "Network.enable=page,worker", "Network.setCookies=page", "Network.setBlockedURLs=page,worker",
    "Network.emulateNetworkConditions=page", "Emulation.setDeviceMetricsOverride=page",
    "Runtime.evaluate=page", "Runtime.addBinding=page", "Page.navigate=page",
    "Page.addScriptToEvaluateOnNewDocument=page"
  ]);
  // Every method the probe actually dispatches must appear in the table, so the allowlist cannot
  // silently drift from the dispatch sites and fail the lifecycle at runtime instead of here.
  // Resolve dispatched methods STRUCTURALLY, not by matching double-quoted literals. A template
  // literal (`${domain}.enable`) driven by a `for ... of [...]` array is a real dispatch of one
  // method per element; the old regex census could not see it, which is exactly how three methods
  // the probe itself dispatches stayed out of CDP_ALLOWED and how Fetch.enable slipped in green.
  const dispatchCounts = new Map<string, number>();
  const tally = (method: string) => dispatchCounts.set(method, (dispatchCounts.get(method) ?? 0) + 1);
  const enclosingLoopDomains = (node: ts.Node): string[] | undefined => {
    for (let scan: ts.Node | undefined = node; scan; scan = scan.parent) {
      if (ts.isForOfStatement(scan) && ts.isArrayLiteralExpression(scan.expression)
        && scan.expression.elements.every(element => ts.isStringLiteral(element))) {
        return scan.expression.elements.map(element => (element as ts.StringLiteral).text);
      }
    }
    return undefined;
  };
  for (const node of collect(probeFile, candidate => ts.isCallExpression(candidate)
    && (ts.isPropertyAccessExpression(candidate.expression) || ts.isElementAccessExpression(candidate.expression))
    && /(?:^|\.)call$|\["call"\]$/.test(textOf(candidate.expression))) as ts.CallExpression[]) {
    const argument = node.arguments[0];
    if (!argument) continue;
    if (ts.isStringLiteral(argument)) { tally(argument.text); continue; }
    // A template literal must be a domain placeholder over a literal array, and nothing else.
    expect(ts.isTemplateExpression(argument), `unresolvable dispatch method at ${node.getStart(probeFile)}`).toBe(true);
    const template = argument as ts.TemplateExpression;
    expect(template.head.text).toBe("");
    expect(template.templateSpans).toHaveLength(1);
    const suffix = template.templateSpans[0].literal.text;
    const domains = enclosingLoopDomains(node);
    expect(domains, `template dispatch not driven by a literal array at ${node.getStart(probeFile)}`).toBeDefined();
    for (const domain of domains!) tally(`${domain}${suffix}`);
  }
  const allowedMethods = allowedEntries.map(entry => entry.split("=")[0]).sort();
  expect([...dispatchCounts.keys()].sort().filter(method => !allowedMethods.includes(method))).toEqual([]);
  // ALLOWING A METHOD IS NOT ALLOWING IT TWICE. The table binds method and session but says nothing
  // about how many times a method is dispatched, and two of the permitted methods are destructive on
  // a second use: another Page.navigate takes the observed page off /app, and another
  // Page.addScriptToEvaluateOnNewDocument installs a permanent page-side fetch override that the
  // in-page census never sees - which forges both outage proofs, since probeTimerPath reads a
  // TypeError as "refused". So the dispatch census is pinned exactly, per method.
  expect([...dispatchCounts.entries()].sort(([left], [right]) => left.localeCompare(right))).toEqual([
    ["Emulation.setDeviceMetricsOverride", 1],
    ["Log.enable", 1],
    ["Network.emulateNetworkConditions", 2],
    ["Network.enable", 2],
    ["Network.setBlockedURLs", 6],
    ["Network.setCookies", 1],
    ["Page.addScriptToEvaluateOnNewDocument", 1],
    ["Page.enable", 1],
    ["Page.navigate", 1],
    ["Runtime.addBinding", 1],
    ["Runtime.enable", 1],
    ["Runtime.evaluate", 1],
    ["Target.activateTarget", 2],
    ["Target.closeTarget", 1],
    ["Target.createTarget", 1]
  ]);

  // THE NAVIGATION TARGET IS PINNED STATICALLY, NOT ONLY GUARDED AT RUNTIME. Rewriting
  // `const destination = `${base}${path}`` to anything else - e.g. `${base}/` - sends every
  // navigation away from /app?babyId=..., which is the observed document path the whole harness
  // exists to watch. The runtime guard does fail closed on that (the destination no longer starts
  // with `${base}/app`, so it raises navigation_target_forbidden), but it fails closed only WHEN A
  // LIFECYCLE RUNS - the edit otherwise lands at a fully green suite and is discovered an hour
  // later in Chrome. Pin both the expression and its guard so it is refused at the point of
  // writing, which is the only place a contract can be cheap.
  const destinationDeclarations = collect(probeFile, node => ts.isVariableDeclaration(node)
    && ts.isIdentifier(node.name) && node.name.text === "destination") as ts.VariableDeclaration[];
  expect(destinationDeclarations).toHaveLength(1);
  expect(textOf(destinationDeclarations[0].initializer!)).toBe("`${base}${path}`");
  expect(source).toContain(
    'if (!destination.startsWith(`${base}/app`)) fail("navigation_target_forbidden");');
  // ...and the pinned dispatch must be the one that consumes it, not a literal URL.
  const navigateDispatch = collect(probeFile, node => ts.isCallExpression(node)
    && node.arguments.length === 2 && ts.isStringLiteral(node.arguments[0])
    && node.arguments[0].text === "Page.navigate") as ts.CallExpression[];
  expect(navigateDispatch).toHaveLength(1);
  expect(textOf(navigateDispatch[0].arguments[1])).toBe("{ url: destination }");

  // THE INJECTED DOCUMENT SCRIPT IS PAGE-SIDE CODE TOO, AND IT WAS PINNED BY NOTHING.
  // Page.addScriptToEvaluateOnNewDocument carries a source string in its PARAMS, not as an argument
  // to `evaluate`, so none of the 33 in-page digests covered it - only three `toContain` substring
  // checks, which additional code satisfies. One prepended statement installing a `fetch` override
  // via an alias (`const g = globalThis; g.fetch = ...`) ran on EVERY new document, before any probe
  // code, surviving every navigation - and since probeTimerPath reads a TypeError as "refused", it
  // forged BOTH outage proofs while the dispatch count stayed at exactly 1. Capping the count was
  // never enough: the first dispatch's own source is the payload. Pin it by digest.
  const injectionDispatch = collect(probeFile, node => ts.isCallExpression(node)
    && node.arguments.length === 2
    && ts.isStringLiteral(node.arguments[0])
    && node.arguments[0].text === "Page.addScriptToEvaluateOnNewDocument") as ts.CallExpression[];
  expect(injectionDispatch).toHaveLength(1);
  const injectionParams = injectionDispatch[0].arguments[1];
  expect(ts.isObjectLiteralExpression(injectionParams)).toBe(true);
  const injectionProperties = (injectionParams as ts.ObjectLiteralExpression).properties;
  expect(injectionProperties).toHaveLength(1);
  const injectionSource = injectionProperties[0];
  expect(ts.isPropertyAssignment(injectionSource)
    && ts.isIdentifier(injectionSource.name) && injectionSource.name.text === "source").toBe(true);
  expect(createHash("sha256")
    .update(textOf((injectionSource as ts.PropertyAssignment).initializer).split("\r\n").join("\n"))
    .digest("hex").slice(0, 16)).toBe("bb8f012d988d2903");

  // THE ALLOWLIST MUST BE THE GUARD'S FIRST ACT. Asserting only that the check EXISTS let it be moved
  // below the narrower shape rules, where an unlisted method reaches the socket whenever those rules
  // happen not to match it. Require it structurally: statements 0 and 1 of the guard body.
  const guardDeclaration = collect(probeFile, node => ts.isFunctionDeclaration(node)
    && node.name?.text === "assertDispatchAllowed")[0] as ts.FunctionDeclaration | undefined;
  expect(guardDeclaration).toBeDefined();
  const guardStatements = guardDeclaration!.body!.statements;
  expect(textOf(guardStatements[0])).toBe("const permittedKinds = CDP_ALLOWED.get(method);");
  expect(textOf(guardStatements[1]))
    .toBe('if (!permittedKinds || !permittedKinds.has(kind)) fail("cdp_dispatch_forbidden");');

  // The cheap spelling denylist is kept as a SECOND line only - it catches an obviously destructive
  // edit at the point of writing, before the hash census explains why. It is not the real gate.
  const forbiddenInPage = [
    /\.unregister\s*\(/, /caches\s*\.\s*delete\s*\(/, /caches\s*\.\s*keys\s*\(/,
    /globalThis\s*\.\s*fetch\s*=/, /document\s*\.\s*write\s*\(/,
    /location\s*\.\s*(?:replace|assign|reload)\s*\(/, /location\s*\.\s*href\s*=/,
    /window\s*\.\s*location\s*=/, /history\s*\.\s*(?:pushState|replaceState)\s*\(/,
    /localStorage\s*\.\s*clear\s*\(/, /sessionStorage\s*\.\s*clear\s*\(/,
    /defineProperty\s*\(\s*window\s*,\s*["']fetch["']/, /Reflect\s*\.\s*set\s*\(\s*window\s*,\s*["']fetch["']/
  ];
  for (const pattern of forbiddenInPage) {
    expect({ pattern: pattern.source, found: pattern.test(source) }).toEqual({ pattern: pattern.source, found: false });
  }

  // `window.fetch` IS overridden, legitimately: the cache-proof and timer-path observations install a
  // temporary wrapper to watch the production loader's own request. That is only safe if every
  // override captures the native function and restores it, so the page is never left with a
  // permanently replaced fetch. Requiring the literal `= async` spelling was itself an escape - an
  // arrow override, a computed key, defineProperty or Reflect.set was never COUNTED, so it needed no
  // capture and no restore and the one-for-one check still held. A permanent override that fakes a
  // TypeError on the timer endpoint forges BOTH outage proofs, because probeTimerPath classifies
  // `error instanceof TypeError` as refused. So count every assignment form, not one spelling.
  const fetchOverrides = [...source.matchAll(/(?:window|self)\s*(?:\.\s*fetch|\[\s*["'`]fetch["'`]\s*\])\s*=/g)];
  const fetchRestores = [...source.matchAll(/finally\s*\{[^}]*window\s*\.\s*fetch\s*=\s*nativeFetch/g)];
  const fetchCaptures = [...source.matchAll(/nativeFetch\s*=\s*window\s*\.\s*fetch/g)];
  expect(fetchRestores.length).toBeGreaterThan(0);
  // Each override is one install plus one restore, both matched by the assignment pattern.
  expect(fetchOverrides).toHaveLength(fetchRestores.length * 2);
  expect(fetchCaptures).toHaveLength(fetchRestores.length);

  // The request-stalling domains must also be statically absent OUTSIDE the guard's own denylist.
  // The runtime guard refuses them, so a lifecycle would fail closed - but a future author could add
  // `worker.call("Fetch.enable", ...)` and see a green suite, learning the wrong lesson. Both layers
  // now agree. Counted via the resolved enumeration, which already exempts the guard declaration.
  for (const method of ["Fetch.enable", "Network.setRequestInterception"]) {
    expect(cdpCalls(method).calls).toHaveLength(0);
  }

  // The worker's own sites still carry the staging/clear ordering. Resolved receivers are compared
  // here only to locate them, never to exclude a call from the correctness assertions above.
  const workerBlocks = allBlocks.filter(call => call.receiver === "worker");
  expect(workerBlocks.length).toBeGreaterThan(0);

  // The outage is re-asserted as the same scoped block, because a restarted worker keeps neither.
  const reassertion = source.slice(source.indexOf("async function assertWorkerOutage("), source.indexOf("async function observe("));
  expect(reassertion).toContain('await worker.call("Network.setBlockedURLs", { urls: [`${base}/api/timers/active*`] });');
  expect(reassertion).toContain('fail("worker_outage_lapsed")');

  // Ordering over RESOLVED call-sites, not text offsets. The staging block is installed inside the
  // window, and the worker's block is cleared exactly once, after the cache proof. Both properties
  // were previously defeatable: the install assertion was satisfied by the helper definition merely
  // existing above, and the clear check matched only canonical spacing.
  const helperEnd = source.indexOf("async function observe(");
  const retention = source.indexOf('await observe("offline_retention"');
  const observation = source.indexOf('await observe("online_requires_confirmation"');
  const cacheObservation = source.indexOf('await observe("service_worker_cache"');
  const staging = workerBlocks.filter(block => block.offset > helperEnd && block.argument === scoped);
  expect(staging).toHaveLength(1);
  expect(staging[0].offset).toBeGreaterThan(retention);
  expect(staging[0].offset).toBeLessThan(observation);
  const clears = workerBlocks.filter(block => block.argument === "{ urls: [] }");
  expect(clears).toHaveLength(1);
  expect(clears[0].offset).toBeGreaterThan(cacheObservation);
});

// Executes probeTimerPath's REAL body. It was previously reached only through stubs in both
// callers, so rewriting it to `{ await evaluate(...); return false; }` left the in-page expression
// dispatched, every assertion on the const intact, and BOTH guards unconditionally reporting
// success with the timer path live. The wiring between the const and the guards must be executed.
async function runProbeTimerPath(outcome: string) {
  const evaluated: string[] = [];
  const probeTimerPath = probeFunction("probeTimerPath", {
    TIMER_PATH_PROBE: "<expression>",
    evaluate: async (_client: unknown, expression: string) => { evaluated.push(expression); return outcome; },
    fail: (code: string) => { throw Error(code); }
  });
  const result = await probeTimerPath({ client: {} }).then(value => value, (error: Error) => error.message);
  return { result, evaluated };
}

it("OC13 wires the executed probe expression to both outage guards", async () => {
  // An answered request means the path is reachable; a network refusal means it is out.
  const answered = await runProbeTimerPath("answered");
  expect(answered.result).toBe(true);
  const refused = await runProbeTimerPath("refused");
  expect(refused.result).toBe(false);

  // A fault inside the probe is NEITHER, and must not be laundered into proof of an outage. A bare
  // catch previously made any throw - a restarted worker, a TypeError - read as "the path is out".
  const broken = await runProbeTimerPath("probe_error");
  expect(broken.result).toBe("timer_path_probe_failed");

  // It dispatches the shared expression rather than an inline copy, so OC11's executable assertions
  // about that expression actually govern what the guards send.
  expect(answered.evaluated).toEqual(["<expression>"]);

  // Both guards consult the probe's result; neither may discard it.
  const source = read("scripts/cross-device-freshness-browser-probe.mjs");
  const file = ts.createSourceFile("probe.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  for (const guard of ["assertTimerPathOut", "assertWorkerBlockEnforced"]) {
    const declaration = file.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === guard);
    expect(declaration).toBeDefined();
    const body = declaration!.getText(file);
    // The call must appear inside a condition, not as a bare discarded statement.
    expect(body).toMatch(/if\s*\(\s*(!)?\(?\s*await\s+probeTimerPath\(/);
  }
});

async function runAssertTimerPathOut(reachable: boolean) {
  const evaluated: string[] = [];
  const assertTimerPathOut = probeFunction("assertTimerPathOut", {
    probeTimerPath: async (_device: unknown) => { evaluated.push("probe"); return reachable; },
    fail: (code: string) => { throw Error(code); }
  });
  const outcome = await assertTimerPathOut({ client: {} }).then(
    () => "path_proven_out",
    (error: Error) => error.message
  );
  return { outcome, evaluated };
}


async function runAssertWorkerOutage(targets: unknown) {
  const emulated: unknown[] = [];
  const assertWorkerOutage = probeFunction("assertWorkerOutage", {
    base: "http://127.0.0.1:41234",
    fetch: async (url: string) => {
      expect(url).toBe("http://127.0.0.1:41235/json");
      if (targets === null) throw Error("synthetic transport detail");
      return { json: async () => targets };
    },
    AbortSignal: { timeout: () => undefined },
    fail: (code: string) => { throw Error(code); }
  });
  const worker = { call: async (method: string, params: unknown) => { emulated.push({ method, params }); } };
  const outcome = await assertWorkerOutage("127.0.0.1:41235", worker).then(
    () => "outage_held",
    (error: Error) => error.message
  );
  return { outcome, emulated };
}

it("OC3 reports a lapsed worker outage as a harness condition, never as a product verdict", async () => {
  const present = await runAssertWorkerOutage([
    { type: "page", url: "http://127.0.0.1:41234/app" },
    { type: "service_worker", url: "http://127.0.0.1:41234/sw.js" }
  ]);
  expect(present.outcome).toBe("outage_held");
  // Re-applying the scoped block is what makes the subsequent cache fallback deterministic, and it
  // must leave the document path through the same worker untouched.
  expect(present.emulated).toEqual([
    { method: "Network.setBlockedURLs", params: { urls: ["http://127.0.0.1:41234/api/timers/active*"] } }
  ]);

  // A terminated worker, a different worker, or an unreachable target list all fail closed, and
  // none of them may leave the lifecycle asserting an outage it can no longer enforce.
  for (const targets of [
    [],
    [{ type: "page", url: "http://127.0.0.1:41234/app" }],
    [{ type: "service_worker", url: "http://127.0.0.1:41234/other-worker.js" }],
    [{ type: "worker", url: "http://127.0.0.1:41234/sw.js" }],
    null
  ]) {
    const { outcome, emulated } = await runAssertWorkerOutage(targets);
    expect(outcome).not.toBe("outage_held");
    if (targets !== null) expect(outcome).toBe("worker_outage_lapsed");
    expect(emulated).toEqual([]);
  }
});

/**
 * OC4 closes a diagnostic gap this program paid for twice. The online-confirmation observation is a
 * two-part conjunction, and a single collapsed marker cannot say which half failed. One repair round
 * was already spent on a confidently-reasoned but unconfirmed attribution to the disabled-control
 * half. The step now reports its own earliest failing sub-state, so the next failure names the
 * mechanism instead of requiring another inferential diagnosis.
 */
async function runOnlineConfirmationState(dom: { live?: boolean; status?: boolean; time?: boolean; bar?: boolean; disabled?: boolean; foreignStatus?: boolean; timerCopy?: boolean; pageTime?: boolean }) {
  let expression = "";
  const onlineConfirmationState = probeFunction("onlineConfirmationState", {
    evaluate: async (_client: unknown, source: string) => {
      expression = source;
      return runInNewContext(source, {
        document: {
          querySelectorAll: (selector: string) => {
            if (selector !== "#app-freshness-status p") return [];
            // Each paragraph gets its OWN following instant, mirroring the real wrapper: dom.time is
            // the TIMER branch's instant and dom.pageTime the page branch's, so a page-level instant
            // can no longer satisfy the timer-branch assertion.
            const instant = (present: unknown) => ({ querySelector: (inner: string) => inner === "time" && present ? {} : null });
            type Paragraph = { textContent: string; nextElementSibling: { querySelector: (inner: string) => unknown } | null };
            const paragraphs: Paragraph[] = [
              { textContent: "Data may be out of date.", nextElementSibling: instant(dom.pageTime ?? dom.time) },
              { textContent: "Data current as of Jan 1.", nextElementSibling: null }
            ];
            if (dom.timerCopy !== false) {
              paragraphs.push({ textContent: "Timer data may be out of date. Timer actions are unavailable.", nextElementSibling: instant(dom.time) });
              paragraphs.push({ textContent: "Data current as of not yet confirmed.", nextElementSibling: null });
            }
            return paragraphs;
          },
          querySelector: (selector: string) => {
            // Liveness defaults to present so existing cases keep their meaning.
            if (selector === "main") return dom.live === false ? null : {};
            // A foreign role="status" node must never be mistaken for the freshness region.
            if (selector === '[role="status"]') return dom.foreignStatus || dom.status ? {} : null;
            if (selector === "#app-freshness-status") return dom.status ? {} : null;
            // A region-wide lookup returns the FIRST <time> in document order, which is the PAGE
            // branch's instant - the page paragraph precedes the timer paragraph in the shared
            // wrapper. Modelling it as the timer's own instant let a `|| document.querySelector(
            // '#app-freshness-status time')` fallback disjunct pass while restoring exactly the
            // page-instant-satisfies-timer-branch confusion this stub exists to detect.
            if (selector === "#app-freshness-status time") return (dom.pageTime ?? dom.time) ? {} : null;
            // Same reasoning for the bare selector: only a page-level instant answers a region scan.
            if (selector === "time") return (dom.pageTime ?? dom.time) ? {} : null;
            if (selector === '[aria-label="Running timers"]') return dom.bar ? {} : null;
            if (selector === '[aria-label="Running timers"] button:disabled') return dom.disabled ? {} : null;
            return null;
          }
        }
      });
    }
  });
  const state = await onlineConfirmationState({ client: {} });
  return { state, expression };
}

it("OC4 names the earliest failing sub-state of the online-confirmation conjunction", async () => {
  // Fully truthful online state: confirmed instant retained and consequential controls disabled.
  expect((await runOnlineConfirmationState({ status: true, time: true, bar: true, disabled: true })).state).toBe("confirmed");

  // Each failure mode is distinct, so a future lifecycle marker identifies the mechanism directly.
  expect((await runOnlineConfirmationState({ status: false, time: false, bar: true, disabled: true })).state).toBe("status_absent");
  expect((await runOnlineConfirmationState({ status: true, time: false, bar: true, disabled: true })).state).toBe("instant_absent");
  expect((await runOnlineConfirmationState({ status: true, time: true, bar: false, disabled: false })).state).toBe("timer_bar_absent");
  expect((await runOnlineConfirmationState({ status: true, time: true, bar: true, disabled: false })).state).toBe("control_enabled");

  // A page with no application tree is reported as such, and is checked FIRST. Without this, a page
  // destroyed by the route block is indistinguishable from a live page that is legitimately current,
  // which is exactly the ambiguity that made the previous lifecycle's marker unactionable.
  expect((await runOnlineConfirmationState({ live: false, status: false, time: false, bar: false, disabled: false })).state).toBe("page_absent");
  // Liveness must not mask a real live-page verdict.
  expect((await runOnlineConfirmationState({ live: true, status: false, time: false, bar: true, disabled: true })).state).toBe("status_absent");
  expect((await runOnlineConfirmationState({ live: true, status: true, time: true, bar: true, disabled: true })).state).toBe("confirmed");

  // Nine unrelated components render role="status". One of them being present while the freshness
  // region is absent must still report status_absent, or the attribution this step exists to provide
  // is wrong in exactly the case it is meant to explain.
  expect((await runOnlineConfirmationState({ foreignStatus: true, status: false, time: false, bar: true, disabled: true })).state).toBe("status_absent");

  // The classifier is content-free and bound to the freshness region by id, not by a shared role.
  // It reads textContent only to match the timer branch's fixed product copy - a comparison, never
  // an emission - so the binding property is that every return is a fixed closed literal.
  const { expression } = await runOnlineConfirmationState({ status: true, time: true, bar: true, disabled: true });
  expect(expression).not.toContain("innerText");
  const returns = [...expression.split("\n").join(" ").matchAll(/return ('[a-z_]+'|[^;]+?);/g)].map(match => match[1].trim());
  expect(returns.length).toBeGreaterThan(0);
  for (const returned of returns) expect(returned).toMatch(/^'[a-z_]+'$/);
  // The only textContent use is the fixed-copy predicate, and it never reaches a return.
  expect(expression).toContain("textContent.includes('Timer data may be out of date')");
  expect(expression.match(/textContent/g)).toHaveLength(1);

  // A region rendered ONLY by the page-level branch is not a timer confirmation.
  expect((await runOnlineConfirmationState({ status: true, time: true, bar: true, disabled: true, timerCopy: false })).state).toBe("timer_status_absent");

  // The page branch's instant must NEVER satisfy the timer branch's assertion. Both branches render
  // into one wrapper div (React fragments emit no node), so a parentElement lookup - or a region-wide
  // fallback disjunct - would find the PAGE instant and wrongly report the conjunction confirmed.
  expect((await runOnlineConfirmationState({ status: true, time: false, pageTime: true, bar: true, disabled: true })).state).toBe("instant_absent");
  expect((await runOnlineConfirmationState({ status: true, time: true, pageTime: false, bar: true, disabled: true })).state).toBe("confirmed");
  expect(expression).not.toContain('[role="status"]');
  expect(expression).toContain("#app-freshness-status");
  expect(expression).toContain("'main'");
});

it("OC5 statically mirrors the call site as defence in depth only, never as the reporting guard", () => {
  // Deliberately weak by design: textual proximity is exactly what let a deleted reporting line pass
  // the whole suite once. OC6 is the executed guard; this only catches a call site drifting away
  // from the classifier.
  const source = read("scripts/cross-device-freshness-browser-probe.mjs");
  const probe = ts.createSourceFile("probe.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let predicate = "";
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(probe) === "observe"
      && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === "online_requires_confirmation") {
      predicate = node.arguments[1].getText(probe);
    }
    ts.forEachChild(node, visit);
  };
  visit(probe);
  expect(predicate).toContain("onlineConfirmationState(b)");
  expect(predicate).toContain('"confirmed"');

  // The distinct sub-state must reach the retained marker rather than collapsing into one code.
  const reported = source.slice(source.indexOf('await observe("online_requires_confirmation"'));
  expect(reported.slice(0, 600)).toContain("onlineConfirmationDetail");
  const detail = source.slice(source.indexOf("async function onlineConfirmationState("), source.indexOf("async function assertWorkerOutage("));
  for (const state of ["page_absent", "status_absent", "instant_absent", "timer_bar_absent", "control_enabled"]) {
    expect(detail).toContain(state);
  }
  // The probe must resolve browserFailureCode from the shared contract rather than an injected
  // binding. OC6 supplies its own, so without this a removed import would leave the suite green
  // while the real probe threw at the catch site and degraded every sub-state to UNKNOWN.
  const header = source.slice(0, source.indexOf("const base ="));
  expect(header).toContain("browserFailureCode");
  expect(header).toContain("./cross-device-freshness-browser-contract.mjs");
  // Every reported sub-state code is in the frozen closed allowlist.
  for (const code of ["online_page_absent", "online_status_absent", "online_instant_absent", "online_timer_bar_absent", "online_control_enabled"]) {
    expect(FRESHNESS_BROWSER_FAILURE_CODES).toContain(code);
  }
});

it("OC6 actually emits the sub-state code from observe, not just a literal in source", async () => {
  // A static assertion on the detail identifier passed while the reporting line was deleted, so this
  // executes the real observe boundary. Deleting `fail(reported)` must fail here.
  const observe = probeFunction("observe", {
    wait: async (_predicate: unknown, _limit: unknown, code: string) => { throw browserFailure(code); },
    browserFailureCode,
    fail: (code: string) => { throw browserFailure(code); },
    devices: [],
    observations: new Set<string>(),
    assertDisplayIsolation: async () => {}
  });

  // A supplied sub-state replaces the collapsed code at the closed marker boundary.
  const reported = await observe(
    "online_requires_confirmation", async () => false, 10, () => "online_control_enabled"
  ).then(() => "passed", browserFailureCode);
  expect(reported).toBe("online_control_enabled");

  // No detail, or a detail that is not yet resolved, preserves the original closed code.
  for (const detail of [undefined, () => undefined, () => ""]) {
    const fallback = await observe(
      "online_requires_confirmation", async () => false, 10, detail
    ).then(() => "passed", browserFailureCode);
    expect(fallback).toBe("online_requires_confirmation");
  }

  // A different failure escaping the predicate is never relabelled as a sub-state.
  const unrelated = probeFunction("observe", {
    wait: async () => { throw browserFailure("cdp_command_timeout"); },
    browserFailureCode,
    fail: (code: string) => { throw browserFailure(code); },
    devices: [],
    observations: new Set<string>(),
    assertDisplayIsolation: async () => {}
  });
  const preserved = await unrelated(
    "online_requires_confirmation", async () => false, 10, () => "online_control_enabled"
  ).then(() => "passed", browserFailureCode);
  expect(preserved).toBe("cdp_command_timeout");

  // A passing observation records the canonical code and never reports a sub-state.
  const recorded = new Set<string>();
  const passing = probeFunction("observe", {
    wait: async () => {},
    browserFailureCode,
    fail: (code: string) => { throw browserFailure(code); },
    devices: [],
    observations: recorded,
    assertDisplayIsolation: async () => {}
  });
  await passing("online_requires_confirmation", async () => true, 10, () => "online_control_enabled");
  expect([...recorded]).toEqual(["online_requires_confirmation"]);
});

it("OC7 composes the real classifier, call-site closure and observe end to end", async () => {
  // Closes the last static-only link: BD6 and OC5 only prove the `online_` template appears in the
  // file. This drives the real classifier result through the real composition into the real observe.
  for (const [state, expected] of [
    ["page_absent", "online_page_absent"],
    ["status_absent", "online_status_absent"],
    ["instant_absent", "online_instant_absent"],
    ["timer_bar_absent", "online_timer_bar_absent"],
    ["control_enabled", "online_control_enabled"]
  ] as const) {
    const observe = probeFunction("observe", {
      wait: async (predicate: () => Promise<boolean>, _limit: unknown, code: string) => {
        if (!await predicate()) throw browserFailure(code);
      },
      browserFailureCode,
      fail: (code: string) => { throw browserFailure(code); },
      devices: [],
      observations: new Set<string>(),
      assertDisplayIsolation: async () => {}
    });
    const onlineConfirmationState = probeFunction("onlineConfirmationState", {
      evaluate: async () => state
    });

    // Exactly the production call-site shape, including the template composition.
    let onlineConfirmationDetail: string | undefined;
    const emitted = await observe("online_requires_confirmation", async () => {
      onlineConfirmationDetail = await onlineConfirmationState({ client: {} }) as string;
      return onlineConfirmationDetail === "confirmed";
    }, 1_000, () => onlineConfirmationDetail && `online_${onlineConfirmationDetail}`)
      .then(() => "passed", browserFailureCode);

    expect(emitted).toBe(expected);
    // The emitted code must survive the real outer parser without degrading to unknown.
    expect(FRESHNESS_BROWSER_FAILURE_CODES).toContain(emitted);
    let parsed: unknown;
    try { rehearsal.parseFreshnessBrowserResult(1, `FRESHNESS_BROWSER_${emitted.toUpperCase()}\n`); }
    catch (error) { parsed = error; }
    expect(browserFailureCode(parsed)).toBe(expected);
  }

  // The confirmed path passes and emits no sub-state at all.
  const observe = probeFunction("observe", {
    wait: async (predicate: () => Promise<boolean>, _limit: unknown, code: string) => {
      if (!await predicate()) throw browserFailure(code);
    },
    browserFailureCode,
    fail: (code: string) => { throw browserFailure(code); },
    devices: [],
    observations: new Set<string>(),
    assertDisplayIsolation: async () => {}
  });
  const confirmed = probeFunction("onlineConfirmationState", { evaluate: async () => "confirmed" });
  let detail: string | undefined;
  await observe("online_requires_confirmation", async () => {
    detail = await confirmed({ client: {} }) as string;
    return detail === "confirmed";
  }, 1_000, () => detail && `online_${detail}`);
  expect(detail).toBe("confirmed");
});

it("OC8 keeps a throwing detail supplier from destroying attribution", async () => {
  // Defensive: the current closure cannot throw, but a future supplier must not be able to convert a
  // precisely attributed failure into an unknown marker by throwing inside the catch path.
  const observe = probeFunction("observe", {
    wait: async (_predicate: unknown, _limit: unknown, code: string) => { throw browserFailure(code); },
    browserFailureCode,
    fail: (code: string) => { throw browserFailure(code); },
    devices: [],
    observations: new Set<string>(),
    assertDisplayIsolation: async () => {}
  });
  const emitted = await observe("online_requires_confirmation", async () => false, 10, () => {
    throw Error("synthetic detail failure");
  }).then(() => "passed", browserFailureCode);
  // The original closed code is preserved rather than collapsing to unknown.
  expect(emitted).toBe("online_requires_confirmation");
});

// OC10b: EXECUTE the probe's dispatch guard against subversions that defeated static analysis.
// Every attempt below is the SAME code path at runtime - `assertDispatchAllowed` sees a method name
// and params, never the expression that produced them - so alias depth, computed keys, bound
// receivers and runtime-built names cannot evade it. This is the property seven rounds of source
// inference could not establish. The guard is loaded from the real probe, not restated here.
it("refuses path-severing CDP dispatches at the probe's one choke point", () => {
  const probeSource = read("scripts/cross-device-freshness-browser-probe.mjs");
  // Lift the guard and its two constants out of the probe and execute them. Extracting by source
  // slice keeps this test honest: if the guard is deleted or renamed, the slice fails to compile and
  // this test fails, rather than passing against a stale copy maintained inside the contract.
  const severingSet = probeSource.match(/^const CDP_PATH_SEVERING = .*$/m)?.[0] ?? "";
  // The allowlist Map spans several lines; splice it whole so the VM runs the real table.
  const allowedTable = probeSource.match(/^const CDP_ALLOWED = new Map\(\[[\s\S]*?^\]\);$/m)?.[0] ?? "";
  expect(allowedTable).not.toBe("");
  const timerPattern = probeSource.match(/^const CDP_TIMER_PATH = .*$/m)?.[0] ?? "";
  const guardStart = probeSource.indexOf("function assertDispatchAllowed(");
  const guardEnd = probeSource.indexOf("\nasync function connect(");
  expect(severingSet).not.toBe("");
  expect(timerPattern).not.toBe("");
  expect(guardStart).toBeGreaterThan(-1);
  expect(guardEnd).toBeGreaterThan(guardStart);
  const guardSource = probeSource.slice(guardStart, guardEnd);
  // Execute the probe's REAL `fail` and `browserFailure`, not a substitute. Modelling `fail` as a
  // local throw meant this suite tested a function the probe did not have: dropping `throw` from the
  // probe's own `fail` made every refusal a silent no-op while these assertions still passed.
  const failSource = probeSource.match(/^const fail = .*$/m)?.[0] ?? "";
  const failureImport = probeSource.match(/^import \{[^}]*browserFailure[^}]*\} from .*$/m)?.[0] ?? "";
  expect(failSource).not.toBe("");
  expect(failureImport).not.toBe("");
  const { browserFailure: realBrowserFailure } = { browserFailure };
  const harness = `${severingSet}\n${timerPattern}\n${allowedTable}\n${failSource}\n${guardSource}\n`
    + `(kind, method, params) => { try { assertDispatchAllowed(kind, method, params); return "allowed"; } `
    + `catch (error) { return browserFailureCode(error) ?? "not_a_browser_failure"; } }`;
  const dispatch = runInNewContext(harness, {
    Array, Set, Map, String, RegExp, Error, browserFailure: realBrowserFailure, browserFailureCode
  }) as (kind: string, method: string, params?: unknown) => string;

  const base = "http://127.0.0.1:41234";
  const timerPath = { urls: [`${base}/api/timers/active*`] };
  const offline = { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 };
  const REFUSED = "cdp_dispatch_forbidden";

  // The legitimate harness dispatches must all be allowed, or the guard has broken the probe.
  expect(dispatch("page", "Network.emulateNetworkConditions", offline)).toBe("allowed");
  expect(dispatch("page", "Network.emulateNetworkConditions", { ...offline, offline: false })).toBe("allowed");
  expect(dispatch("worker", "Network.setBlockedURLs", timerPath)).toBe("allowed");
  expect(dispatch("page", "Network.setBlockedURLs", timerPath)).toBe("allowed");
  expect(dispatch("worker", "Network.setBlockedURLs", { urls: [] })).toBe("allowed");
  expect(dispatch("page", "Network.setBlockedURLs", { urls: [] })).toBe("allowed");
  // These two were previously "allowed" because the guard only refused four methods. The allowlist
  // denies every unlisted method, so they are now refused - and that is the point: the permitted CDP
  // surface was itself a severing route. Runtime.enable is harmless but unused; if a future author
  // needs it, adding it to CDP_ALLOWED is a visible, reviewable edit.
  expect(dispatch("worker", "Runtime.enable")).toBe("cdp_dispatch_forbidden");
  expect(dispatch("worker", "Network.setCacheDisabled", { cacheDisabled: true })).toBe("cdp_dispatch_forbidden");
  // Methods the probe legitimately dispatches remain allowed on exactly the sessions that need them.
  expect(dispatch("browser", "Target.createTarget", { url: "about:blank" })).toBe("allowed");
  expect(dispatch("page", "Runtime.evaluate", { expression: "1" })).toBe("allowed");
  expect(dispatch("worker", "Network.enable")).toBe("allowed");
  // The severing routes the twelfth review landed are all refused now, on every session.
  for (const kind of ["browser", "page", "worker"]) {
    expect(dispatch(kind, "Page.reload", {})).toBe("cdp_dispatch_forbidden");
    expect(dispatch(kind, "Storage.clearDataForOrigin", { origin: "x", storageTypes: "cache_storage" })).toBe("cdp_dispatch_forbidden");
    expect(dispatch(kind, "Network.clearBrowserCache", {})).toBe("cdp_dispatch_forbidden");
    expect(dispatch(kind, "ServiceWorker.stopAllWorkers", {})).toBe("cdp_dispatch_forbidden");
    expect(dispatch(kind, "ServiceWorker.unregister", { scopeURL: "/" })).toBe("cdp_dispatch_forbidden");
    expect(dispatch(kind, "Emulation.setScriptExecutionDisabled", { value: true })).toBe("cdp_dispatch_forbidden");
    expect(dispatch(kind, "Runtime.callFunctionOn", { functionDeclaration: "function(){}" })).toBe("cdp_dispatch_forbidden");
    expect(dispatch(kind, "DOM.removeNode", { nodeId: 1 })).toBe("cdp_dispatch_forbidden");
    expect(dispatch(kind, "Browser.close", {})).toBe("cdp_dispatch_forbidden");
  }
  // Page-side execution and navigation are page-only: the worker session may not reach them.
  expect(dispatch("worker", "Runtime.evaluate", { expression: "1" })).toBe("cdp_dispatch_forbidden");
  expect(dispatch("worker", "Page.navigate", { url: "about:blank" })).toBe("cdp_dispatch_forbidden");
  expect(dispatch("worker", "Page.addScriptToEvaluateOnNewDocument", { source: "1" })).toBe("cdp_dispatch_forbidden");
  expect(dispatch("browser", "Runtime.evaluate", { expression: "1" })).toBe("cdp_dispatch_forbidden");

  // Taking the WORKER offline is what severed the observed document path in two lifecycles. Refused
  // regardless of how the worker connection was spelled at the call site, because the guard never
  // sees the spelling.
  expect(dispatch("worker", "Network.emulateNetworkConditions", offline)).toBe(REFUSED);
  expect(dispatch("worker", "Network.emulateNetworkConditions", { ...offline, offline: false })).toBe(REFUSED);
  expect(dispatch("browser", "Network.emulateNetworkConditions", offline)).toBe(REFUSED);
  // An untagged or unknown connection kind must not be treated as the page.
  expect(dispatch(undefined as unknown as string, "Network.emulateNetworkConditions", offline)).toBe(REFUSED);
  expect(dispatch("", "Network.emulateNetworkConditions", offline)).toBe(REFUSED);
  expect(dispatch("Page", "Network.emulateNetworkConditions", offline)).toBe(REFUSED);

  // Wholesale and document-pattern blocks are refused on EVERY connection kind, including the page.
  for (const kind of ["worker", "page", "browser"]) {
    expect(dispatch(kind, "Network.setBlockedURLs", { urls: ["*"] })).toBe(REFUSED);
    expect(dispatch(kind, "Network.setBlockedURLs", { urls: [`${base}/*`] })).toBe(REFUSED);
    expect(dispatch(kind, "Network.setBlockedURLs", { urls: [`${base}/app*`] })).toBe(REFUSED);
    expect(dispatch(kind, "Network.setBlockedURLs", { urls: [`${base}/_next/*`] })).toBe(REFUSED);
    // Smuggling the document pattern alongside the legitimate timer path.
    expect(dispatch(kind, "Network.setBlockedURLs", { urls: [`${base}/api/timers/active*`, "*"] })).toBe(REFUSED);
    // A malformed or absent list must fail closed rather than read as an empty clear.
    expect(dispatch(kind, "Network.setBlockedURLs", {})).toBe(REFUSED);
    expect(dispatch(kind, "Network.setBlockedURLs", { urls: "*" })).toBe(REFUSED);
    expect(dispatch(kind, "Network.setBlockedURLs")).toBe(REFUSED);
    // A near-miss timer path must not pass: the pattern is anchored, not a substring test.
    expect(dispatch(kind, "Network.setBlockedURLs", { urls: [`${base}/api/timers/active*extra`] })).toBe(REFUSED);
    expect(dispatch(kind, "Network.setBlockedURLs", { urls: ["http://evil/api/timers/active*"] })).toBe(REFUSED);
    // Request stalling severs documents just as effectively as an offline worker.
    expect(dispatch(kind, "Fetch.enable", { patterns: [{ urlPattern: "*" }] })).toBe(REFUSED);
    expect(dispatch(kind, "Network.setRequestInterception", { patterns: [{ urlPattern: "*" }] })).toBe(REFUSED);
  }
});
