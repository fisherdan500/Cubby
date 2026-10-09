import { existsSync, readFileSync } from "node:fs";
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

it("BD6 freezes the closed vocabulary and covers every explicit probe failure", () => {
  const expected = [
    "activity_create", "activity_update", "browser_diagnostics", "browser_expression_failed",
    "button_missing", "calendar_create", "calendar_outcome_incomplete", "calendar_submit_failed",
    "calendar_viewport_invalid", "cdp_closed",
    "cdp_command_failed", "cdp_command_timeout", "cdp_message_failed", "cdp_failed", "cdp_scope", "cdp_timeout",
    "chosen_photo_missing", "control_missing", "dialog_missing", "draft_preservation",
    "draft_refresh_missing", "foreground_five_seconds", "freshness_scope_invalid",
    "hidden_no_poll", "hide_failed", "isolation_surfaces_missing", "known_timer_missing",
    "moments_create", "moments_update", "navigation_failed", "observations_missing",
    "offline_retention", "online_requires_confirmation", "page_missing", "recovery_failed",
    "request_cadence", "service_worker_cache", "sign_in_failed", "tenant_isolation",
    "timer_start", "timer_stop", "worker_missing", "worker_outage_lapsed", "worker_target_missing", "unknown"
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

  const blocked = source.indexOf('await b.client.call("Network.setBlockedURLs", { urls: [`${base}/app*`, `${base}/api/timers/active*`] })');
  const online = source.indexOf('await b.client.call("Network.emulateNetworkConditions", { offline: false');
  const observation = source.indexOf('await observe("online_requires_confirmation"');
  expect(blocked).toBeGreaterThan(0);
  // The deterministic block is installed before the page returns online and before the assertion.
  expect(blocked).toBeLessThan(online);
  expect(online).toBeLessThan(observation);

  // The timer endpoint block is lifted only after that assertion, so the later cache observation
  // can still reach the service worker and exercise its fallback.
  const restored = source.indexOf('await b.client.call("Network.setBlockedURLs", { urls: [`${base}/app*`] })');
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
  expect(predicate).toContain('[role="status"] time');
  expect(predicate).toContain('[aria-label="Running timers"] button:disabled');
});

it("OC2 re-asserts the worker outage before relying on it and fails closed when it lapsed", () => {
  const source = read("scripts/cross-device-freshness-browser-probe.mjs");
  const reassertion = source.indexOf("await assertWorkerOutage(workerHost, worker)");
  const cacheDispatch = source.indexOf("window.__freshCacheProof");
  const cacheObservation = source.indexOf('await observe("service_worker_cache"');
  expect(reassertion).toBeGreaterThan(0);
  // The outage is reconfirmed before the cache proof depends on the worker failing its own fetch.
  expect(reassertion).toBeLessThan(cacheDispatch);
  expect(cacheDispatch).toBeLessThan(cacheObservation);

  const helper = source.slice(source.indexOf("async function assertWorkerOutage("), source.indexOf("async function observe("));
  expect(helper).toContain('fail("worker_outage_lapsed")');
  // It must identify the exact worker target rather than any service worker, and re-apply the outage.
  expect(helper).toContain('target.type === "service_worker"');
  expect(helper).toContain("${base}/sw.js");
  expect(helper).toContain("offline: true");
});

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
  // Re-applying the outage is what makes the subsequent cache fallback deterministic.
  expect(present.emulated).toEqual([
    { method: "Network.emulateNetworkConditions", params: { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 } }
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
