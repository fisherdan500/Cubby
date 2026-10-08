import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";

// Source-only until a separately approved lifecycle. Never uses the normal Compose project or .env.
type ChildEnvironment = Record<string, string | undefined>;
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
function fail(code: string): never { throw new Error(`freshness_${code}`); }
export function seedUrl(password: string) {
  if (!password) fail("fixture_credential_missing");
  return `postgresql://${encodeURIComponent("cubby_save_path_rehearsal")}:${encodeURIComponent(password)}@postgres:5432/cubby_browser_operation_save_path?schema=public`;
}
export function assertAcceptedTree(accepted: string | undefined, head: string, status: string) {
  if (!accepted || !/^[0-9a-f]{40}$/.test(accepted) || accepted !== head || status !== "") fail("accepted_tree_required");
}
export function assertExportEntry(mode: string, path: string) {
  if (!["100644", "100755"].includes(mode) || !path || /[\\:\x00-\x1f]/.test(path) || path.startsWith("/") || /^(?:backups|credentials|runtime-data)(?:\/|$)/i.test(path) || path.split("/").some(part =>
    part === ".." || /^(?:\.git|\.env(?:\..+)?|smtp-password|worker-runtime|node_modules|docker-data|credentials\..+)$/i.test(part) && part !== ".env.example")) fail("unsafe_export_entry");
}
export function childEnvironments(ambient: ChildEnvironment, infrastructure: ChildEnvironment, password: string) {
  const pick = (keys: string[]) => Object.fromEntries(keys.filter(key => ambient[key] !== undefined).map(key => [key, ambient[key]]));
  const node = pick(["PATH", "Path", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP"]);
  const chrome = pick(["PATH", "Path", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "HOME", "USERPROFILE", "ProgramFiles", "ProgramW6432", "ProgramData", "LOCALAPPDATA", "APPDATA", "ComSpec", "PATHEXT"]);
  const generated: ChildEnvironment = Object.fromEntries(Object.entries(infrastructure).filter(([key]) => /^CUBBY_SAVE_PATH_REHEARSAL_[A-Z_]+$/.test(key)));
  return {
    node, chrome,
    compose: { ...chrome, ...generated, DOCKER_CONTEXT: "default", COMPOSE_DISABLE_ENV_FILE: "true" } as ChildEnvironment,
    fixture: { REHEARSAL_SEED_URL: seedUrl(infrastructure.CUBBY_SAVE_PATH_REHEARSAL_PASSWORD!), REHEARSAL_APP_PASSWORD: password }
  };
}
async function run(command: string, commandArgs: string[], directory: string, childEnvironment: ChildEnvironment, input?: string, timeout = 120_000, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) fail("interrupted");
  return new Promise((done, reject) => {
    const child = spawn(command, commandArgs, { cwd: directory, env: childEnvironment as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let output = "", failed = false;
    let abortDeadline: ReturnType<typeof setTimeout> | undefined;
    const stop = () => { failed = true; child.kill("SIGKILL"); abortDeadline ??= setTimeout(() => finish(false), 5_000); };
    const timer = setTimeout(stop, timeout);
    const hardDeadline = setTimeout(() => finish(false), timeout + 5_000);
    function finish(ok: boolean) {
      clearTimeout(timer); clearTimeout(hardDeadline); clearTimeout(abortDeadline); signal?.removeEventListener("abort", stop);
      if (ok && !failed) done(output.trim()); else reject(new Error("freshness_command_failed"));
    }
    signal?.addEventListener("abort", stop, { once: true });
    child.stdout.on("data", chunk => { output += String(chunk); if (output.length > 4 * 1024 * 1024) stop(); });
    child.stderr.resume();
    child.stdin.on("error", () => { failed = true; });
    child.once("error", () => finish(false)); child.once("close", code => finish(code === 0));
    child.stdin.end(input);
  });
}
function execute(signal: AbortSignal, command: string, args: string[], cwd: string, env: ChildEnvironment, input?: string, timeout = 120_000) {
  return run(command, args, cwd, env, input, timeout, signal);
}
type Ledger = { version: 1; project: string; image: string; directory: string; exportedCommit: string; pid: number };
const ledgerDirectory = () => resolve(tmpdir(), "cubby-freshness-ledgers");
const profilePaths = (ledger: Ledger) => [1, 2].map(index => resolve(ledger.directory, `browser-${index}`));
export function validateLedgerPath(path: string) {
  if (dirname(path) !== ledgerDirectory() || !/^cubby_freshness_[0-9a-f]{16}\.json$/.test(basename(path))) fail("ledger_path_invalid");
}
export function validateLedger(value: unknown, path: string): Ledger {
  validateLedgerPath(path);
  const ledger = value as Ledger;
  if (!ledger || Object.keys(ledger).sort().join() !== "directory,exportedCommit,image,pid,project,version" || ledger.version !== 1 ||
    !/^cubby_freshness_[0-9a-f]{16}$/.test(ledger.project) || ledger.image !== `${ledger.project}:acceptance` ||
    !/^[0-9a-f]{40}$/.test(ledger.exportedCommit) || !Number.isSafeInteger(ledger.pid) || ledger.pid <= 0 ||
    typeof ledger.directory !== "string" || dirname(ledger.directory) !== resolve(tmpdir()) ||
    !new RegExp(`^${ledger.project}-[0-9a-f]{12}$`).test(basename(ledger.directory)) ||
    resolve(ledger.directory) !== ledger.directory || path !== resolve(ledgerDirectory(), `${ledger.project}.json`)) fail("ledger_invalid");
  return ledger;
}
function assertOwnedPath(path: string) {
  // Refuse reparse/symlink roots; do not traverse a redirected disposable or ledger directory.
  if (existsSync(path) && (lstatSync(path).isSymbolicLink() || realpathSync(path).toLowerCase() !== resolve(path).toLowerCase())) fail("path_redirected");
}
async function persistLedger(ledger: Ledger) {
  const path = resolve(ledgerDirectory(), `${ledger.project}.json`);
  validateLedger(ledger, path);
  assertOwnedPath(tmpdir());
  mkdirSync(ledgerDirectory(), { recursive: true, mode: 0o700 });
  assertOwnedPath(ledgerDirectory());
  if (process.platform === "win32") {
    await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `
      $ErrorActionPreference = 'Stop'
      $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
      $acl = New-Object System.Security.AccessControl.DirectorySecurity
      $acl.SetAccessRuleProtection($true, $false); $acl.SetOwner($sid)
      $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
      $acl.AddAccessRule($rule); Set-Acl -LiteralPath $env:FRESHNESS_LEDGER_DIRECTORY -AclObject $acl
    `], tmpdir(), { ...osEnvironment(), FRESHNESS_LEDGER_DIRECTORY: ledgerDirectory() });
  } else if ((lstatSync(ledgerDirectory()).mode & 0o077) !== 0 || lstatSync(ledgerDirectory()).uid !== process.getuid?.()) fail("ledger_permissions");
  writeFileSync(path, JSON.stringify(ledger), { mode: 0o600, flag: "wx" });
  const descriptor = openSync(path, "r"); try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
  return path;
}
function osEnvironment() {
  // No generated/ambient application credentials are needed by cleanup or OS inspection.
  const keys = ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "HOME", "USERPROFILE", "ProgramFiles", "ProgramW6432", "ProgramData", "LOCALAPPDATA", "APPDATA", "ComSpec", "PATHEXT"];
  return Object.fromEntries(keys.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
}
async function dockerPreflight(environment: ChildEnvironment) {
  await run("docker", ["compose", "version"], tmpdir(), environment, undefined, 20_000);
  const endpoint = await run("docker", ["context", "inspect", "default", "--format", "{{.Endpoints.docker.Host}}"], tmpdir(), environment, undefined, 20_000);
  if (!endpoint.startsWith("unix:///") && !endpoint.startsWith("npipe:////./pipe/")) fail("docker_endpoint_not_local");
}
type ChromeProcess = { ProcessId: number; CreationDate: string; CommandLine: string };
export function matchesProfile(commandLine: string, profiles: string[]) {
  const match = /(?:^|\s)(?:"--user-data-dir=([^"]+)"|--user-data-dir="([^"]+)"|--user-data-dir=([^\s"]+))(?:\s|$)/.exec(commandLine);
  const profile = match?.[1] ?? match?.[2] ?? match?.[3];
  if (profile !== undefined && profiles.includes(profile)) return true;
  const database = /(?:^|\s)(?:"--database=([^"]+)"|--database="([^"]+)"|--database=([^\s"]+))(?:\s|$)/.exec(commandLine);
  const crashpad = database?.[1] ?? database?.[2] ?? database?.[3];
  return crashpad !== undefined && profiles.some(path => crashpad === win32.join(path, "Crashpad"));
}
async function chromeProcesses(ledger: Ledger): Promise<ChromeProcess[]> {
  // This Windows Chrome harness fails closed on other hosts before it creates resources.
  const output = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe' OR Name = 'chromium.exe' OR Name = 'chrome_crashpad_handler.exe' OR Name = 'crashpad_handler.exe'" | Select-Object ProcessId,CreationDate,CommandLine) | ConvertTo-Json -Compress`], tmpdir(), osEnvironment(), undefined, 15_000);
  const parsed = output ? JSON.parse(output) : [];
  const processes: ChromeProcess[] = Array.isArray(parsed) ? parsed : [parsed];
  return processes.filter(entry => Number.isSafeInteger(entry.ProcessId) && entry.ProcessId > 0 && typeof entry.CreationDate === "string" && typeof entry.CommandLine === "string" && matchesProfile(entry.CommandLine, profilePaths(ledger)));
}
export async function cleanupScope(operations: {
  stopChrome: () => Promise<void>; removeDocker: () => Promise<void>; removeProfiles: () => Promise<void>;
  removeRoot: () => Promise<void>; verify: () => Promise<void>;
}) {
  const failures: string[] = [];
  for (const [code, operation] of [["chrome", operations.stopChrome], ["docker", operations.removeDocker], ["profiles", operations.removeProfiles], ["root", operations.removeRoot], ["verification", operations.verify]] as const) {
    try { await operation(); } catch { failures.push(code); }
  }
  return failures;
}
async function cleanLedger(ledger: Ledger, ledgerPath: string, attempted: boolean, browsers: ChildProcess[] = [], uncertain = false) {
  validateLedger(ledger, ledgerPath);
  const dockerEnvironment = { ...osEnvironment(), DOCKER_CONTEXT: "default", COMPOSE_DISABLE_ENV_FILE: "true" };
  const docker = (args: string[]) => run("docker", args, tmpdir(), dockerEnvironment, undefined, 15_000);
  const list = async (kind: string) => {
    const query = kind === "container" ? ["ps", "--all", "--quiet", "--no-trunc"] : [kind, "ls", "--quiet"];
    const entries = (await docker([...query, "--filter", `label=com.docker.compose.project=${ledger.project}`])).split(/\r?\n/).filter(Boolean);
    if (entries.length > 12 || entries.some(entry => !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,199}$/.test(entry))) fail("resource_identity_invalid");
    return entries;
  };
  const imageExists = async (image: string) => (await docker(["image", "ls", "--format", "{{.Repository}}:{{.Tag}}", "--filter", `reference=${image}`])).split(/\r?\n/).includes(image);
  const failures = await cleanupScope({
    stopChrome: async () => {
      for (const entry of await chromeProcesses(ledger)) {
        const current = (await chromeProcesses(ledger)).find(candidate => candidate.ProcessId === entry.ProcessId && candidate.CreationDate === entry.CreationDate);
        if (current) await run("taskkill.exe", ["/PID", String(current.ProcessId), "/T", "/F"], tmpdir(), osEnvironment(), undefined, 15_000);
      }
      for (let attempt = 0; attempt < 30 && browsers.some(child => child.exitCode === null && child.signalCode === null); attempt++) await pause(100);
      if ((await chromeProcesses(ledger)).length || browsers.some(child => child.exitCode === null && child.signalCode === null)) fail("chrome_exit_failed");
    },
    removeDocker: async () => {
      if (!attempted) return;
      await dockerPreflight(dockerEnvironment);
      const failures: string[] = [];
      for (const kind of ["container", "volume", "network"]) {
        try {
          for (const id of await list(kind)) {
            try {
              const format = kind === "container" ? '{{index .Config.Labels "com.docker.compose.project"}}' : '{{index .Labels "com.docker.compose.project"}}';
              const actualLabel = await docker([kind, "inspect", "--format", format, id]);
              if (actualLabel !== ledger.project) fail("resource_label_invalid");
              await docker([kind, "rm", ...(kind === "container" ? ["--force"] : []), id]);
            } catch { failures.push(kind); }
          }
        } catch { failures.push(kind); }
      }
      try { if (await imageExists(ledger.image)) await docker(["image", "rm", ledger.image]); } catch { failures.push("image"); }
      if (failures.length) fail("docker_cleanup_failed");
    },
    removeProfiles: async () => {
      assertOwnedPath(ledger.directory);
      let failed = false;
      for (const profile of profilePaths(ledger)) {
        try { assertOwnedPath(profile); rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { failed = true; }
      }
      if (failed || profilePaths(ledger).some(existsSync)) fail("profiles_remain");
    },
    removeRoot: async () => {
      assertOwnedPath(ledger.directory);
      rmSync(ledger.directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
    verify: async () => {
      const failures: string[] = [];
      if (attempted) {
        for (const kind of ["container", "volume", "network"]) {
          try { if ((await list(kind)).length) failures.push(kind); } catch { failures.push(kind); }
        }
        try { if (await imageExists(ledger.image)) failures.push("image"); } catch { failures.push("image"); }
      }
      try { if ((await chromeProcesses(ledger)).length) failures.push("chrome"); } catch { failures.push("chrome"); }
      if (profilePaths(ledger).some(existsSync) || existsSync(ledger.directory)) failures.push("filesystem");
      if (uncertain || failures.length) fail("cleanup_verification_failed");
    }
  });
  if (failures.length) fail("cleanup_incomplete");
  rmSync(ledgerPath);
}
export async function recoverFreshnessLedger(path: string) {
  if (process.platform !== "win32") fail("windows_required");
  const ledgerPath = resolve(path);
  validateLedgerPath(ledgerPath);
  assertOwnedPath(tmpdir()); assertOwnedPath(ledgerDirectory()); assertOwnedPath(ledgerPath);
  const ledger = validateLedger(JSON.parse(readFileSync(ledgerPath, "utf8")), ledgerPath);
  let alive = true;
  try { process.kill(ledger.pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false; }
  if (alive) fail("recovery_owner_alive");
  const deferSignal = () => { process.exitCode = 1; };
  process.on("SIGINT", deferSignal); process.on("SIGTERM", deferSignal);
  try { await cleanLedger(ledger, ledgerPath, true); }
  finally { process.off("SIGINT", deferSignal); process.off("SIGTERM", deferSignal); }
  process.stdout.write("FRESHNESS_CLEANUP_PASS\n");
}

export async function runCrossDeviceFreshnessRehearsal() {
  if (process.platform !== "win32") fail("windows_required");
  const gitEnvironment = { PATH: process.env.PATH, Path: process.env.Path, SystemRoot: process.env.SystemRoot, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null" };
  const acceptedCommit = process.env.CUBBY_FRESHNESS_ACCEPTED_COMMIT;
  assertAcceptedTree(acceptedCommit, await run("git", ["rev-parse", "HEAD"], root, gitEnvironment),
    await run("git", ["status", "--porcelain=v1", "--untracked-files=all"], root, gitEnvironment));
  for (const entry of (await run("git", ["ls-tree", "-rz", "--full-tree", acceptedCommit!], root, gitEnvironment)).split("\0").filter(Boolean)) {
    const match = /^(\d+) blob [0-9a-f]+\t(.+)$/s.exec(entry);
    if (!match) fail("unsafe_export_entry");
    assertExportEntry(match[1], match[2]);
  }
  const chromePath = process.env.CUBBY_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
  if (!/^[a-z]:[\\/]/i.test(chromePath) || !/^(?:chrome|chromium)\.exe$/i.test(basename(chromePath))) fail("chrome_path_invalid");
  if (!existsSync(chromePath)) fail("chrome_missing");
  const project = `cubby_freshness_${randomBytes(8).toString("hex")}`;
  const directory = resolve(tmpdir(), `${project}-${randomBytes(6).toString("hex")}`);
  const ledger: Ledger = { version: 1, project, image: `${project}:acceptance`, directory, exportedCommit: acceptedCommit!, pid: process.pid };
  const ledgerPath = await persistLedger(ledger);
  const controller = new AbortController();
  const browsers: ChildProcess[] = [];
  let attempted = false, passed = false;
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = () => cleanupPromise ??= cleanLedger(ledger, ledgerPath, attempted, browsers, attempted && controller.signal.aborted);
  const onSignal = () => controller.abort();
  process.on("SIGINT", onSignal); process.on("SIGTERM", onSignal);
  try {
    if (controller.signal.aborted) fail("interrupted");
    mkdirSync(directory, { mode: 0o700 });
    const exportedSource = resolve(directory, "source");
    const archive = resolve(directory, "source.tar");
    mkdirSync(exportedSource, { mode: 0o700 });
    await execute(controller.signal, "git", ["archive", "--format=tar", "--output", archive, acceptedCommit!], root, gitEnvironment);
    await execute(controller.signal, "tar", ["-xf", archive, "-C", exportedSource], directory, gitEnvironment);
    rmSync(archive);
    const composeFile = resolve(directory, "compose.yml");
    const image = `${project}:acceptance`;
    const infrastructure: ChildEnvironment = {};
    const template = readFileSync(resolve(exportedSource, "scripts/browser-operation-save-path.acceptance.compose.yml"), "utf8");
    for (const match of template.matchAll(/\$\{(CUBBY_SAVE_PATH_REHEARSAL_[A-Z_]+):/g)) {
      const key = match[1];
      infrastructure[key] = key.endsWith("KEYRING") ? `1:${randomBytes(32).toString("base64url")}` : randomBytes(32).toString("base64url");
    }
    const environments = childEnvironments(process.env, infrastructure, randomBytes(24).toString("base64url"));
    const environment = environments.compose;
    if (template.match(/context: \.\./g)?.length !== 1) fail("compose_context_invalid");
    const compose = template.replace("context: ..", `context: ${JSON.stringify(exportedSource.replaceAll("\\", "/"))}`)
      .replace("  app:\n", `  app:\n    image: ${image}\n`)
      .replace("  app:\r\n", `  app:\r\n    image: ${image}\r\n`)
      .replace("pg_isready -U", "pg_isready -h 127.0.0.1 -U");
    writeFileSync(composeFile, compose, { mode: 0o600, flag: "wx" });
    const args = ["compose", "--project-name", project, "--file", composeFile];
    async function launch(index: number) {
      if (controller.signal.aborted) fail("interrupted");
      const child = spawn(chromePath, ["--headless=new", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0",
        `--user-data-dir=${resolve(directory, `browser-${index}`)}`, "--no-first-run", "--no-default-browser-check", "--window-size=390,844", "about:blank"],
      { stdio: ["ignore", "ignore", "pipe"], windowsHide: true, env: environments.chrome as NodeJS.ProcessEnv });
      browsers.push(child);
      return new Promise<string>((done, reject) => {
        const timer = setTimeout(() => reject(new Error("freshness_chrome_timeout")), 20_000);
        controller.signal.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("freshness_interrupted")); }, { once: true });
        let buffer = "";
        child.stderr?.on("data", (chunk) => {
          buffer = (buffer + String(chunk)).slice(-4096);
          const socket = buffer.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[^\s]+)/)?.[1];
          if (socket) { clearTimeout(timer); done(socket); }
        });
        for (const event of ["error", "exit"] as const) child.once(event, () => { clearTimeout(timer); reject(new Error("freshness_chrome_failed")); });
      });
    }
    await execute(controller.signal, "docker", ["compose", "version"], directory, environment);
    const endpoint = await execute(controller.signal, "docker", ["context", "inspect", "default", "--format", "{{.Endpoints.docker.Host}}"], directory, environment);
    if (!endpoint.startsWith("unix:///") && !endpoint.startsWith("npipe:////./pipe/")) fail("docker_endpoint_not_local");
    assertAcceptedTree(acceptedCommit, await execute(controller.signal, "git", ["rev-parse", "HEAD"], root, gitEnvironment),
      await execute(controller.signal, "git", ["status", "--porcelain=v1", "--untracked-files=all"], root, gitEnvironment));
    attempted = true;
    await execute(controller.signal, "docker", [...args, "up", "--detach", "--build", "--wait", "--wait-timeout", "240"], directory, environment, undefined, 1_200_000);
    const address = await execute(controller.signal, "docker", [...args, "port", "app", "3000"], directory, environment);
    if (!/^127\.0\.0\.1:\d{2,5}$/.test(address) || address.endsWith(":3000")) fail("loopback_invalid");
    const baseUrl = `http://${address}`;
    const appContainer = await execute(controller.signal, "docker", [...args, "ps", "--quiet", "app"], directory, environment);
    if (!/^[0-9a-f]{12,64}$/.test(appContainer)) fail("container_invalid");
    await execute(controller.signal, "docker", ["--context", "default", "exec", "-i", "-e", "REHEARSAL_APP_PASSWORD", "-e", "REHEARSAL_SEED_URL", appContainer, "/bin/sh", "-c",
      'exec env -i REHEARSAL_SEED_URL="$REHEARSAL_SEED_URL" REHEARSAL_APP_PASSWORD="$REHEARSAL_APP_PASSWORD" /usr/local/bin/node --input-type=module'], directory,
      { ...environments.chrome, ...environments.fixture }, readFileSync(resolve(exportedSource, "scripts/cross-device-freshness-fixture.mjs"), "utf8"));
    const bundle = resolve(directory, "calendar.js");
    await execute(controller.signal, "docker", [...args, "cp", "app:/app/.next/server/app/app/calendar/page.js", bundle], directory, environment);
    const action = readFileSync(bundle, "utf8").match(/"([0-9a-f]{40})"\s*:[^"]{0,200}?\.createCalendarEventAction\b/)?.[1];
    if (!action) fail("calendar_action_missing");
    const probeEnvironment = {
      ...environments.node, REHEARSAL_APP_BASE_URL: baseUrl, REHEARSAL_CALENDAR_ACTION_ID: action,
      REHEARSAL_APP_PASSWORD: environments.fixture.REHEARSAL_APP_PASSWORD,
      REHEARSAL_BROWSER_A: await launch(1), REHEARSAL_BROWSER_B: await launch(2)
    };
    const observation = await execute(controller.signal, process.execPath, [resolve(exportedSource, "scripts/cross-device-freshness-browser-probe.mjs")], directory, probeEnvironment, undefined, 600_000);
    if (observation !== "FRESHNESS_BROWSER_PASS") fail("observation_invalid");
    passed = true;
  } finally {
    try { await cleanup(); } finally { process.off("SIGINT", onSignal); process.off("SIGTERM", onSignal); }
  }
  process.stdout.write(freshnessTerminalOutcome(passed, controller.signal.aborted));
}

export function freshnessTerminalOutcome(passed: boolean, aborted: boolean): string {
  if (aborted) fail("interrupted");
  if (!passed) fail("observation_invalid");
  return "FRESHNESS_ACCEPTANCE_PASS\nFRESHNESS_CLEANUP_PASS\n";
}

export function parseFreshnessArguments(args: readonly string[]): { recoveryPath: string | null } {
  if (args.length === 0) return { recoveryPath: null };
  const [operation, ...rest] = args;
  if (operation === "--recover" && rest.length === 1 && rest[0]) return { recoveryPath: rest[0] };
  fail("arguments_invalid");
}
async function main(args: readonly string[]) {
  const { recoveryPath } = parseFreshnessArguments(args);
  if (recoveryPath) await recoverFreshnessLedger(recoveryPath);
  else await runCrossDeviceFreshnessRehearsal();
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(() => { process.stderr.write("FRESHNESS_ACCEPTANCE_FAILED\n"); process.exitCode = 1; });
}
