import { existsSync, readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { GATES_RUN_BY_HAND } from "./verify-gates";
import * as rehearsal from "./cross-device-freshness.acceptance-rehearsal";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import ts from "typescript";
import { runInNewContext } from "node:vm";
import { createRequire } from "node:module";
import { discoverPackageCommands } from "../src/server/operation-registry/checker";

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

function simulatedAcceptance(failedPhase?: string, cleanupFails = false) {
  const stdout: string[] = [];
  const cleanup = vi.fn(async () => { if (cleanupFails) throw Error("synthetic cleanup detail"); });
  const lifecycle = vi.fn(rehearsal.withFreshnessCleanup);
  const child = { stderr: { on: (_: string, receive: (chunk: string) => void) => receive("DevTools listening on ws://127.0.0.1:12345/devtools/browser/synthetic") }, once: () => {} };
  const rejectAt = (phase: string) => { if (failedPhase === phase) throw Error("synthetic private failure"); };
  const processStub = { platform: "win32", pid: 123, env: { CUBBY_FRESHNESS_ACCEPTED_COMMIT: "a".repeat(40) }, on: () => {}, off: () => {}, stdout: { write: (value: string) => stdout.push(value) } };
  const run = harnessFunction("runCrossDeviceFreshnessRehearsal", {
    ...rehearsal, process: processStub, root: "synthetic-root", AbortController,
    resolve, basename: () => "chrome.exe", tmpdir: () => "synthetic-temp", existsSync: () => true,
    randomBytes: () => ({ toString: () => "synthetic" }), pause: async () => {},
    run: async (_: string, args: string[]) => { rejectAt("preflight_export"); return args[0] === "rev-parse" ? "a".repeat(40) : ""; },
    persistLedger: async () => "synthetic-ledger", cleanLedger: cleanup,
    withFreshnessCleanup: lifecycle,
    mkdirSync: () => {}, rmSync: () => {}, writeFileSync: () => {},
    readFileSync: (path: string) => path.endsWith(".yml") ? "context: ..\n  app:\n" : `"${"a".repeat(40)}":x.createCalendarEventAction`,
    childEnvironments: () => ({ compose: {}, chrome: {}, fixture: {}, node: {} }),
    execute: async (_: unknown, command: string, args: string[]) => {
      if (args.includes("up")) rejectAt("docker_image_start");
      if (args.includes("exec")) rejectAt("fixture");
      if (args.includes("cp")) rejectAt("action_discovery");
      if (args.includes("port")) return "127.0.0.1:12345";
      if (args.includes("ps")) return "a".repeat(12);
      if (args.includes("inspect")) return "npipe:////./pipe/synthetic";
      if (args.includes("rev-parse")) return "a".repeat(40);
      if (command === undefined) { rejectAt("browser_observation"); return "FRESHNESS_BROWSER_PASS"; }
      return "";
    },
    spawn: () => { rejectAt("browser_launch"); return child; },
    setTimeout: () => 1, clearTimeout: () => {},
    freshnessTerminalOutcome: (passed: boolean, aborted: boolean) => { rejectAt("terminal"); return rehearsal.freshnessTerminalOutcome(passed, aborted); },
    fail: () => { throw Error("synthetic validation failure"); }
  });
  return { run, stdout, cleanup, lifecycle };
}

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

it("D7 outermost CLI formats retained failure state without printing content", async () => {
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
    const stderr: string[] = [];
    const processStub = { argv: ["node", "synthetic-cli"], stderr: { write: (value: string) => stderr.push(value) }, exitCode: 0 };
    await runInNewContext(expression, { process: processStub, main: async () => { throw failure; }, formatFreshnessFailure: rehearsal.formatFreshnessFailure });
    expect(stderr.join("")).toBe(rehearsal.formatFreshnessFailure(failure));
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
    expect(rehearsal.formatFreshnessFailure(failure)).toBe(`FRESHNESS_ACCEPTANCE_FAILED\nFRESHNESS_PHASE_${phase.toUpperCase()}\n`);
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
  expect(source).toContain('process.stderr.write(formatFreshnessFailure(error))');
});
it("B7 keeps explicit recovery argument parsing compatible with unchanged governance", () => {
  expect(rehearsal).toHaveProperty("parseFreshnessArguments");
  expect(rehearsal.parseFreshnessArguments([])).toEqual({ recoveryPath: null });
  expect(rehearsal.parseFreshnessArguments(["--recover", "ledger.json"])).toEqual({ recoveryPath: "ledger.json" });
  for (const args of [["--recover"], ["--recover", "a", "b"], ["unknown"]]) expect(() => rehearsal.parseFreshnessArguments(args)).toThrow();
  const program = ts.createProgram([resolve("scripts/cross-device-freshness.acceptance-rehearsal.ts")], { noResolve: true, target: ts.ScriptTarget.ESNext });
  const result = discoverPackageCommands(program, resolve("."), JSON.stringify({ scripts: { "verify:cross-device-freshness": "tsx scripts/cross-device-freshness.acceptance-rehearsal.ts" } }));
  expect(result.diagnostics).toEqual([]);
});
it("B8 documents only unexecuted source guarantees and separate lifecycle gates", () => {
  const docs = read("docs/DEVELOPMENT.md");
  for (const text of ["CUBBY_FRESHNESS_ACCEPTED_COMMIT", "clean tracked and nonignored-untracked", "Git-object export", "cubby-freshness-ledgers", "--recover", "Windows", "display/read isolation", "runtime acceptance remains **pending**", "FileList"]) expect(docs).toContain(text);
  expect(docs).toContain("not a hostile mutation or side-effect audit");
  expect(docs).toContain("No archive, Docker, Chrome or recovery lifecycle was run");
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
  const main = source.slice(source.indexOf("export async function runCrossDeviceFreshnessRehearsal()"));
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
  expect(scripts["verify:cross-device-freshness"]).toBe("tsx scripts/cross-device-freshness.acceptance-rehearsal.ts");
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
