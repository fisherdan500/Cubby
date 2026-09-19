import { randomBytes } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(import.meta.dirname, "..");
const chromePath = "C:/Program Files/Google/Chrome/Application/chrome.exe";

type CdpMessage = { id?: number; method?: string; params?: Record<string, unknown>; result?: { result?: { value?: unknown } }; error?: { message?: string } };
type CdpClient = { call: (method: string, params?: Record<string, unknown>) => Promise<CdpMessage>; diagnostics: string[]; close: () => void };

function fail(code: string): never { throw new Error(code); }

function run(command: string, args: string[], env?: NodeJS.ProcessEnv, capture = false, code = "dec407_browser_command_failed") {
  const result = spawnSync(command, args, { cwd: root, env, encoding: "utf8", stdio: capture ? ["ignore", "pipe", "pipe"] : "ignore" });
  if (result.error || result.status !== 0) fail(code);
  return String(result.stdout ?? "").trim();
}

function docker(args: string[], capture = false, code?: string) {
  return run("docker", args, undefined, capture, code ?? "dec407_browser_docker_failed");
}

async function waitFor(predicate: () => Promise<boolean>, code: string, attempts = 120) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  fail(code);
}

async function loopbackPort() {
  return new Promise<number>((resolvePort, rejectPort) => {
    const server = createServer();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") { server.close(); rejectPort(new Error("dec407_browser_port_reservation_failed")); return; }
      server.close((error) => error ? rejectPort(error) : resolvePort(address.port));
    });
  });
}

async function cdpConnect(url: string): Promise<CdpClient> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolveOpen, rejectOpen) => {
    socket.onopen = () => resolveOpen();
    socket.onerror = () => rejectOpen(new Error("dec407_browser_cdp_connect_failed"));
  });
  let nextId = 1;
  const diagnostics: string[] = [];
  const selectionRequestIds = new Set<string>();
  const requestUrls = new Map<string, string>();
  const pending = new Map<number, { resolve: (value: CdpMessage) => void; reject: (reason: Error) => void }>();
  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data)) as CdpMessage;
    if (!message.id) {
      const params = message.params as {
        requestId?: string;
        request?: { url?: string };
        headers?: Record<string, string>;
        errorText?: string;
        blockedReason?: string;
        entry?: { level?: string; text?: string; url?: string };
        exceptionDetails?: { text?: string; exception?: { description?: string } };
      } | undefined;
      if (message.method === "Network.requestWillBeSent" && params?.requestId && params.request?.url) {
        requestUrls.set(params.requestId, params.request.url);
        if (params.request.url.includes("/api/household-selection")) selectionRequestIds.add(params.requestId);
      }
      if (message.method === "Network.requestWillBeSentExtraInfo" && params?.requestId && selectionRequestIds.has(params.requestId)) {
        const origin = params.headers?.origin ?? params.headers?.Origin ?? "absent";
        const site = params.headers?.["sec-fetch-site"] ?? "absent";
        diagnostics.push(`selection_request_origin=${origin};site=${site}`);
      }
      if (message.method === "Log.entryAdded" && params?.entry?.level === "error") {
        diagnostics.push(`console_error:${params.entry.url ?? "unknown"}:${params.entry.text ?? "unknown"}`);
      }
      if (message.method === "Runtime.exceptionThrown") {
        diagnostics.push(`runtime_exception:${params?.exceptionDetails?.exception?.description ?? params?.exceptionDetails?.text ?? "unknown"}`);
      }
      if (message.method === "Network.loadingFailed" && params?.requestId) {
        diagnostics.push(`network_failure:${requestUrls.get(params.requestId) ?? "unknown"}:${params.errorText ?? params.blockedReason ?? "unknown"}`);
      }
      return;
    }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(`dec407_browser_cdp_${message.error.message ?? "error"}`));
    else request.resolve(message);
  };
  return {
    call(method, params = {}) {
      const id = nextId++;
      return new Promise<CdpMessage>((resolveCall, rejectCall) => {
        pending.set(id, { resolve: resolveCall, reject: rejectCall });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    diagnostics,
    close() { socket.close(); }
  };
}

async function launchChrome(profile: string): Promise<{ process: ChildProcess; websocket: string }> {
  if (!existsSync(chromePath)) fail("dec407_browser_chrome_missing");
  const process = spawn(chromePath, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  const websocket = await new Promise<string>((resolveSocket, rejectSocket) => {
    const timeout = setTimeout(() => rejectSocket(new Error("dec407_browser_chrome_debug_timeout")), 20_000);
    process.stderr?.on("data", (chunk) => {
      const match = String(chunk).match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match?.[1]) { clearTimeout(timeout); resolveSocket(match[1]); }
    });
    process.once("error", () => { clearTimeout(timeout); rejectSocket(new Error("dec407_browser_chrome_start_failed")); });
    process.once("exit", () => { clearTimeout(timeout); rejectSocket(new Error("dec407_browser_chrome_exited")); });
  });
  return { process, websocket };
}

async function terminateChromeProcessTree(process: ChildProcess) {
  const exited = () => process.exitCode !== null || process.signalCode !== null;
  if (exited()) return true;
  if (!process.pid) return false;
  const terminated = spawnSync("taskkill.exe", ["/PID", String(process.pid), "/T", "/F"], { stdio: "ignore" });
  if (terminated.error || terminated.status !== 0) process.kill();
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (exited()) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  return exited();
}

async function value(client: CdpClient, expression: string) {
  const response = await client.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  return response.result?.result?.value;
}

async function diagnosticState(client: CdpClient) {
  const state = await value(client, `(() => ({
    url: location.href,
    readyState: document.readyState,
    title: document.title,
    radios: Array.from(document.querySelectorAll('[role=radio]')).map((node) => ({ label: node.getAttribute('aria-label') ?? node.textContent?.trim()?.slice(0, 48) ?? '', mode: node.getAttribute('data-appearance-mode'), accent: node.getAttribute('data-accent-theme') })),
    headings: Array.from(document.querySelectorAll('h1,h2')).map((node) => node.textContent?.trim()?.slice(0, 80) ?? ''),
    bodyText: document.body?.innerText?.replace(/\s+/g, ' ').slice(0, 240) ?? ''
  }))()`);
  return { state, diagnostics: client.diagnostics.slice(-12) };
}

async function assert(client: CdpClient, expression: string, code: string) {
  await waitFor(async () => await value(client, `Boolean(${expression})`) === true, code);
}

async function navigate(client: CdpClient, url: string) {
  await client.call("Page.navigate", { url });
  await waitFor(async () => await value(client, "location.href") === url, "dec407_browser_navigation_url_timeout");
  await assert(client, "document.readyState === 'complete'", "dec407_browser_navigation_timeout");
}

async function setInput(client: CdpClient, selector: string, text: string) {
  const literal = JSON.stringify(text);
  await assert(client, `document.querySelector(${JSON.stringify(selector)})`, "dec407_browser_input_missing");
  await value(client, `(() => { const node = document.querySelector(${JSON.stringify(selector)}); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set; if (!node || !set) return false; set.call(node, ${literal}); node.dispatchEvent(new Event('input', { bubbles: true })); node.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
}

async function click(client: CdpClient, selector: string) {
  try {
    await assert(client, `document.querySelector(${JSON.stringify(selector)})`, "dec407_browser_control_missing");
  } catch {
    const state = await diagnosticState(client);
    fail(`dec407_browser_control_missing:${JSON.stringify(state)}`);
  }
  await value(client, `(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node) return false; (node).click(); return true; })()`);
}

async function clickText(client: CdpClient, text: string) {
  const literal = JSON.stringify(text);
  await assert(client, `Array.from(document.querySelectorAll('button')).some((node) => node.textContent?.trim() === ${literal})`, "dec407_browser_button_missing");
  await value(client, `(() => { const node = Array.from(document.querySelectorAll('button')).find((candidate) => candidate.textContent?.trim() === ${literal}); if (!node) return false; node.click(); return true; })()`);
}

async function setViewport(client: CdpClient, width: number, height: number) {
  await client.call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false, screenWidth: width, screenHeight: height });
  await assert(client, `window.innerWidth === ${width} && window.innerHeight === ${height}`, "dec407_browser_effective_viewport_mismatch");
}

function unexpectedBrowserDiagnostics(entries: string[], allowExpectedPartitionFailure: boolean) {
  return entries.filter((entry) =>
    entry.startsWith("console_error:") ||
    entry.startsWith("runtime_exception:") ||
    (entry.startsWith("network_failure:") &&
      !(allowExpectedPartitionFailure && entry.includes("/api/browser-operations/partition")) &&
      !entry.endsWith(":net::ERR_ABORTED"))
  );
}

async function assertInteractiveGeometry(client: CdpClient, route: string) {
  await assert(client, "document.documentElement.scrollWidth <= window.innerWidth && document.body.scrollWidth <= window.innerWidth", `dec407_browser_page_overflow_detected:${route}`);
  const offenders = await value(client, `(() => Array.from(document.querySelectorAll('[role=radio], [role=button], button, input, select, textarea')).map((node, index) => {
    const measured = node instanceof HTMLInputElement && (node.type === 'checkbox' || node.type === 'radio') ? (node.closest('label') ?? node) : node;
    const rect = measured.getBoundingClientRect();
    return {
      tag: node.tagName.toLowerCase(),
      name: node.getAttribute('aria-label') ?? node.getAttribute('name') ?? node.textContent?.replace(/\\s+/g, ' ').trim().slice(0, 80) ?? '',
      identity: node.id ? '#' + node.id : '[interactive]:nth(' + index + ')',
      width: Math.round(rect.width * 100) / 100,
      height: Math.round(rect.height * 100) / 100
    };
  }).filter((item) => item.width > 0 && item.height > 0 && (item.width < 44 || item.height < 44)))()`);
  if (Array.isArray(offenders) && offenders.length) fail(`dec407_browser_touch_target_too_small:${JSON.stringify({ route, offenders })}`);
}

export async function runDecProd407BrowserAcceptance() {
  const suffix = randomBytes(8).toString("hex");
  const prefix = `cubby-dec407-browser-${suffix}`;
  const network = `${prefix}-network`;
  const database = `${prefix}-db`;
  const app = `${prefix}-app`;
  const image = `${prefix}:latest`;
  const user = `dec407_${suffix}`;
  const password = randomBytes(24).toString("base64url");
  const email = `dec407-${suffix}@acceptance.invalid`;
  const browserRoot = resolve(root, "..", "..", "worker-runtime", `${prefix}-profile`);
  let chrome: ChildProcess | undefined;
  let client: CdpClient | undefined;
  let copiedTabClient: CdpClient | undefined;
  const created = { network: false, database: false, app: false, image: false };

  const appEnv = (hostPort: string) => ({
    DATABASE_URL: `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${database}:5432/${database}?schema=public`,
    BETTER_AUTH_SECRET: randomBytes(32).toString("base64url"),
    BETTER_AUTH_URL: `http://127.0.0.1:${hostPort}`,
    TRUSTED_ORIGINS: `http://127.0.0.1:${hostPort}`,
    ENABLE_REGISTRATION: "true",
    APP_TIMEZONE: "UTC",
    AUTOMATED_BACKUPS_ENABLED: "false",
    INTEGRITY_CHECKS_ENABLED: "false",
    NEXT_TELEMETRY_DISABLED: "1"
  });
  const psql = (statement: string, capture = false) => docker([
    "exec", "-e", `PGPASSWORD=${password}`, database, "psql", "-X", "-v", "ON_ERROR_STOP=1", "-At", "-U", user, "-d", database, "-c", statement
  ], capture, "dec407_browser_sql_failed");

  try {
    run(process.execPath, ["-e", "const fs=require('fs'); const text=fs.readFileSync('.dockerignore','utf8'); process.exit(text.includes('.env*') ? 0 : 1)"], undefined, false, "dec407_browser_dockerignore_missing_env_filter");
    mkdirSync(browserRoot, { recursive: true });
    docker(["build", "--label", "cubby.dec407.browser=true", "--tag", image, "."], false, "dec407_browser_build_failed");
    created.image = true;
    docker(["network", "create", "--label", "cubby.dec407.browser=true", network], false, "dec407_browser_network_start_failed");
    created.network = true;
    docker(["run", "--detach", "--name", database, "--network", network, "--label", "cubby.dec407.browser=true", "-e", `POSTGRES_DB=${database}`, "-e", `POSTGRES_USER=${user}`, "-e", `POSTGRES_PASSWORD=${password}`, "postgres:16-alpine"], false, "dec407_browser_postgres_start_failed");
    created.database = true;
    await waitFor(async () => {
      try { docker(["exec", database, "pg_isready", "-U", user, "-d", database], false, "dec407_browser_postgres_ready_probe_failed"); return true; } catch { return false; }
    }, "dec407_browser_postgres_ready_timeout");
    const port = await loopbackPort();
    const actualEnv = appEnv(String(port));
    docker(["run", "--detach", "--name", app, "--network", network, "--label", "cubby.dec407.browser=true", "-p", `127.0.0.1:${port}:3000`, ...Object.entries(actualEnv).flatMap(([key, entry]) => ["-e", `${key}=${entry}`]), image], false, "dec407_browser_app_start_failed");
    created.app = true;
    const published = docker(["port", app, "3000"], true, "dec407_browser_app_port_probe_failed");
    if (published !== `127.0.0.1:${port}`) fail("dec407_browser_loopback_port_invalid");
    await waitFor(async () => {
      try { return (await fetch(`http://127.0.0.1:${port}/api/health`)).status === 200; } catch { return false; }
    }, "dec407_browser_app_health_timeout", 180);

    const launched = await launchChrome(browserRoot);
    chrome = launched.process;
    const browserEndpoint = new URL(launched.websocket);
    const target = await fetch(`http://${browserEndpoint.host}/json/new?about:blank`, { method: "PUT" }).then(async (response) => {
      if (!response.ok) fail("dec407_browser_target_create_failed");
      return response.json() as Promise<{ webSocketDebuggerUrl?: string }>;
    });
    if (!target.webSocketDebuggerUrl) fail("dec407_browser_target_websocket_missing");
    client = await cdpConnect(target.webSocketDebuggerUrl);
    if (!client) fail("dec407_browser_cdp_connect_failed");
    await client.call("Page.enable");
    await client.call("Runtime.enable");
    await client.call("Log.enable");
    await client.call("Network.enable");

    const origin = `http://127.0.0.1:${port}`;
    await navigate(client, `${origin}/register`);
    await setInput(client, 'input[name="name"]', "DEC407 Browser User");
    await setInput(client, 'input[name="email"]', email);
    await setInput(client, 'input[name="password"]', "SyntheticPassphrase-407!");
    await clickText(client, "Create account");
    await assert(client, "location.pathname === '/onboarding'", "dec407_browser_registration_navigation_failed");

    // The verified flag is guarded against direct writes (guard_user_email_change), so the rehearsal
    // verifies the bootstrap account through the same supported host command an operator uses.
    const userId = psql(`SELECT "id" FROM "User" WHERE "email"='${email}'`, true).split(/\r?\n/).filter(Boolean).at(-1);
    if (!userId) fail("dec407_browser_registered_user_missing");
    docker(["exec", app, "node", "/app/platform-owner.mjs", "verify-bootstrap", "--user-id", userId, "--confirm-email", email, "--acknowledgement", "I_ACCEPT_LOCAL_BOOTSTRAP_EMAIL_VERIFICATION"], false, "dec407_browser_platform_verify_failed");
    docker(["exec", app, "node", "/app/platform-owner.mjs", "bind", "--user-id", userId, "--confirm-email", email], false, "dec407_browser_platform_bind_failed");

    await navigate(client, `${origin}/platform/settings`);
    await click(client, 'input[name="householdCreationMode"][value="open"]');
    await clickText(client, "Save registration policy");
    await waitFor(async () => {
      try { return psql('SELECT "householdCreationMode" FROM "PlatformSettings"', true) === "open"; } catch { return false; }
    }, "dec407_browser_policy_save_timeout");

    await navigate(client, `${origin}/onboarding`);
    await setInput(client, 'input[name="householdName"]', "DEC407 Browser Household");
    await setInput(client, 'input[name="babyName"]', "DEC407 Browser Baby");
    await clickText(client, "Start tracking");
    await assert(client, "location.pathname === '/app'", "dec407_browser_onboarding_navigation_failed");
    await assert(client, "document.querySelector('select[name=memberId]')", "dec407_browser_household_selection_missing");
    await value(client, "(() => { const select = document.querySelector('select[name=memberId]'); if (!(select instanceof HTMLSelectElement) || !select.options[1]) return false; select.value = select.options[1].value; select.dispatchEvent(new Event('change', { bubbles: true })); return true; })()");
    await value(client, `(() => {
      const original = window.fetch.bind(window);
      window.fetch = async (...args) => {
        const response = await original(...args);
        const target = typeof args[0] === 'string' ? args[0] : args[0] instanceof Request ? args[0].url : String(args[0]);
        if (target.includes('/api/household-selection')) {
          const body = (await response.clone().text()).slice(0, 240);
          sessionStorage.setItem('dec407-selection-response', JSON.stringify({ status: response.status, redirected: response.redirected, url: response.url, body }));
        }
        return response;
      };
    })()`);
    await clickText(client, "Continue");
    await waitFor(async () => typeof await value(client!, "sessionStorage.getItem('dec407-selection-response')") === "string", "dec407_browser_household_selection_response_missing");
    const selectionRaw = await value(client!, "sessionStorage.getItem('dec407-selection-response')");
    const selectionResult = typeof selectionRaw === "string" ? JSON.parse(selectionRaw) as { redirected?: boolean; url?: string } : undefined;
    if (!selectionResult?.redirected || !selectionResult.url) {
      const originProbes: Record<string, number> = {};
      const containerHostname = docker(["inspect", "--format", "{{.Config.Hostname}}", app], true, "dec407_browser_app_hostname_probe_failed");
      for (const candidate of [origin, `http://localhost:${port}`, "http://localhost:3000", "http://127.0.0.1:3000", "http://localhost", `http://${app}:3000`, `http://${containerHostname}:3000`]) {
        const probe = await fetch(`${origin}/api/household-selection`, {
          method: "POST",
          redirect: "manual",
          headers: { Origin: candidate, "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ memberId: "synthetic-probe" })
        });
        originProbes[candidate] = probe.status;
      }
      fail(`dec407_browser_household_selection_post_failed:${JSON.stringify({ response: selectionResult ?? selectionRaw, headers: client.diagnostics.filter((entry) => entry.startsWith("selection_request_origin=")), originProbes })}`);
    }
    await waitFor(async () => await value(client!, "location.pathname") === "/app", "dec407_browser_household_selection_redirect_timeout");
    await assert(client, "location.pathname === '/app' && document.querySelector('[aria-label=\"Household selection\"]')?.textContent?.includes('Current household')", "dec407_browser_household_selection_navigation_failed");
    const babyId = psql("SELECT \"id\" FROM \"Baby\" ORDER BY \"createdAt\" ASC LIMIT 1", true).trim();
    if (!babyId) fail("dec407_browser_onboarding_fixture_missing");

    for (const [width, height] of [[320, 568], [375, 667], [390, 844], [430, 932], [1440, 900]] as const) {
      await setViewport(client, width, height);
      await navigate(client, `${origin}/app/settings/appearance`);
      await assert(client, "document.documentElement.scrollWidth <= window.innerWidth && document.body.scrollWidth <= window.innerWidth", "dec407_browser_page_overflow_detected");
      const touchInventory = await value(client, `(() => Array.from(document.querySelectorAll('[role=radio], button')).map((node, index) => {
        const rect = node.getBoundingClientRect();
        return {
          tag: node.tagName.toLowerCase(),
          name: node.getAttribute('aria-label') ?? node.textContent?.replace(/\\s+/g, ' ').trim().slice(0, 80) ?? '',
          identity: node.id ? '#' + node.id : node.getAttribute('data-appearance-mode') ? '[data-appearance-mode="' + node.getAttribute('data-appearance-mode') + '"]' : node.getAttribute('data-accent-theme') ? '[data-accent-theme="' + node.getAttribute('data-accent-theme') + '"]' : '[role="' + (node.getAttribute('role') ?? 'button') + '"]:nth(' + index + ')',
          width: Math.round(rect.width * 100) / 100,
          height: Math.round(rect.height * 100) / 100
        };
      }).filter((item) => item.width > 0 && item.height > 0 && (item.width < 44 || item.height < 44)))()`);
      if (Array.isArray(touchInventory) && touchInventory.length) fail(`dec407_browser_touch_target_too_small:${JSON.stringify({ viewport: { width, height }, offenders: touchInventory })}`);
    }

    const carrierRoutes = [
      "/app",
      "/app/babies",
      "/app/settings/members",
      "/app/settings/notifications",
      "/app/settings/units",
      `/app/calendar?babyId=${encodeURIComponent(babyId)}`
    ];
    for (const [width, height] of [[320, 568], [1440, 900]] as const) {
      await setViewport(client, width, height);
      for (const route of carrierRoutes) {
        await navigate(client, `${origin}${route}`);
        await assertInteractiveGeometry(client, `${width}x${height}:${route}`);
      }
    }

    await setViewport(client, 390, 844);
    await navigate(client, `${origin}/app/settings/appearance`);
    await click(client, '[data-appearance-mode="system"]');
    await value(client, "document.querySelector('[data-appearance-mode=system]')?.focus()");
    await client.call("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowRight", code: "ArrowRight" });
    await client.call("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowRight", code: "ArrowRight" });
    await assert(client, "document.activeElement?.getAttribute('data-appearance-mode') === 'light' && document.querySelector('[data-appearance-mode=light]')?.getAttribute('aria-checked') === 'true'", "dec407_browser_personal_radio_keyboard_failed");
    await clickText(client, "Save personal appearance");
    await click(client, '[data-accent-theme="sage"]');
    await value(client, "document.querySelector('[data-accent-theme=sage]')?.focus()");
    await client.call("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowRight", code: "ArrowRight" });
    await client.call("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowRight", code: "ArrowRight" });
    await assert(client, "document.activeElement?.getAttribute('data-accent-theme') === 'rose' && document.querySelector('[data-accent-theme=rose]')?.getAttribute('aria-checked') === 'true'", "dec407_browser_accent_radio_keyboard_failed");

    const targetsBeforeCopy = await fetch(`http://${browserEndpoint.host}/json`).then((response) => response.json() as Promise<Array<{ id: string }>>);
    await waitFor(async () => await value(client!, "Object.keys(sessionStorage).some((key) => key.startsWith('cubby:browser-operation-tab-namespace:'))") === true, "dec407_browser_tab_scope_parent_timeout");
    const copiedPointer = "bmo_0123456789abcdefghjkmnpqrs";
    const parentScope = await value(client, `(() => {
      const metadataKey = Object.keys(sessionStorage).find((key) => key.startsWith('cubby:browser-operation-tab-namespace:'));
      if (!metadataKey) return null;
      const namespace = sessionStorage.getItem(metadataKey);
      const partition = metadataKey.slice('cubby:browser-operation-tab-namespace:'.length);
      if (!namespace || !partition) return null;
      const pointerKey = 'cubby:account-appearance-operation:' + partition + ':tab:' + namespace;
      sessionStorage.setItem(pointerKey, ${JSON.stringify("bmo_0123456789abcdefghjkmnpqrs")});
      return { metadataKey, namespace, pointerKey };
    })()` ) as { metadataKey?: string; namespace?: string; pointerKey?: string } | null;
    if (!parentScope?.metadataKey || !parentScope.namespace || !parentScope.pointerKey) fail("dec407_browser_tab_scope_parent_missing");
    await value(client, `(() => {
      const anchor = document.createElement('a');
      anchor.id = 'dec407-copy-tab';
      anchor.href = location.href;
      anchor.target = '_blank';
      anchor.rel = 'opener';
      anchor.textContent = 'Open copied tab';
      document.body.appendChild(anchor);
      anchor.click();
      return true;
    })()`);
    let copiedTarget: { id: string; webSocketDebuggerUrl?: string; url?: string } | undefined;
    await waitFor(async () => {
      const targets = await fetch(`http://${browserEndpoint.host}/json`).then((response) => response.json() as Promise<Array<{ id: string; webSocketDebuggerUrl?: string; url?: string }>>);
      copiedTarget = targets.find((candidate) => !targetsBeforeCopy.some((before) => before.id === candidate.id) && candidate.url?.includes("/app/settings/appearance"));
      return Boolean(copiedTarget?.webSocketDebuggerUrl);
    }, "dec407_browser_copied_tab_open_failed");
    copiedTabClient = await cdpConnect(copiedTarget!.webSocketDebuggerUrl!);
    await copiedTabClient.call("Page.enable");
    await copiedTabClient.call("Runtime.enable");
    await copiedTabClient.call("Network.enable");
    await copiedTabClient.call("Log.enable");
    await assert(copiedTabClient, `sessionStorage.getItem(${JSON.stringify(parentScope.metadataKey)}) !== null && sessionStorage.getItem(${JSON.stringify(parentScope.pointerKey)}) === ${JSON.stringify(copiedPointer)}`, "dec407_browser_copied_tab_fixture_missing");
    await click(copiedTabClient, '[data-appearance-mode="dark"]');
    await clickText(copiedTabClient, "Save personal appearance");
    await waitFor(async () => await value(copiedTabClient!, `sessionStorage.getItem(${JSON.stringify(parentScope.metadataKey)}) !== ${JSON.stringify(parentScope.namespace)}`) === true, "dec407_browser_copied_tab_namespace_not_rotated");
    await assert(copiedTabClient, `!performance.getEntriesByType('resource').some((entry) => entry.name.includes(${JSON.stringify(copiedPointer)}))`, "dec407_browser_copied_tab_pointer_probed");

    const crossPartitionA = "dec407-cross-partition-a";
    const crossPartitionB = "dec407-cross-partition-b";
    const crossNamespaceA = "dec407-cross-namespace-a";
    const crossNamespaceB = "dec407-cross-namespace-b";
    const crossPointerKey = `cubby:baby-create-operation:${crossPartitionA}:tab:${crossNamespaceB}`;
    const crossControlOperation = "bmo_1123456789abcdefghjkmnpqrs";
    const crossControlKey = `cubby:baby-create-operation:${crossPartitionA}:tab:${crossNamespaceA}`;
    await value(copiedTabClient, `(() => {
      sessionStorage.setItem('cubby:browser-operation-tab-namespace:' + ${JSON.stringify(crossPartitionA)}, ${JSON.stringify(crossNamespaceA)});
      sessionStorage.setItem('cubby:browser-operation-tab-namespace:' + ${JSON.stringify(crossPartitionB)}, ${JSON.stringify(crossNamespaceB)});
      sessionStorage.setItem(${JSON.stringify(crossPointerKey)}, ${JSON.stringify(copiedPointer)});
      sessionStorage.setItem(${JSON.stringify(crossControlKey)}, ${JSON.stringify(crossControlOperation)});
      window.dispatchEvent(new Event('focus'));
      return true;
    })()`);
    await assert(copiedTabClient, `sessionStorage.getItem('cubby:browser-operation-tab-namespace:' + ${JSON.stringify(crossPartitionA)}) === ${JSON.stringify(crossNamespaceA)} && sessionStorage.getItem('cubby:browser-operation-tab-namespace:' + ${JSON.stringify(crossPartitionB)}) === ${JSON.stringify(crossNamespaceB)} && sessionStorage.getItem(${JSON.stringify(crossPointerKey)}) === ${JSON.stringify(copiedPointer)} && sessionStorage.getItem(${JSON.stringify(crossControlKey)}) === ${JSON.stringify(crossControlOperation)}`, "dec407_browser_cross_partition_fixture_missing");
    await waitFor(async () => await value(copiedTabClient!, `Array.from(document.querySelectorAll('button')).some((node) => node.textContent === 'Discard 1 saved request')`) === true, "dec407_browser_cross_partition_recovery_refresh_missing");
    const copiedUnexpectedDiagnostics = unexpectedBrowserDiagnostics(copiedTabClient.diagnostics, false);
    if (copiedUnexpectedDiagnostics.length) fail(`dec407_browser_copied_tab_unexpected_diagnostics:${JSON.stringify(copiedUnexpectedDiagnostics)}`);
    await value(copiedTabClient, `sessionStorage.removeItem(${JSON.stringify(crossPointerKey)}); sessionStorage.removeItem(${JSON.stringify(crossControlKey)}); sessionStorage.removeItem('cubby:browser-operation-tab-namespace:' + ${JSON.stringify(crossPartitionA)}); sessionStorage.removeItem('cubby:browser-operation-tab-namespace:' + ${JSON.stringify(crossPartitionB)})`);

    await value(copiedTabClient, `sessionStorage.removeItem(${JSON.stringify(parentScope.pointerKey)})`);
    await value(client, `sessionStorage.removeItem(${JSON.stringify(parentScope.pointerKey)})`);
    await copiedTabClient.call("Page.close");
    copiedTabClient.close();
    copiedTabClient = undefined;

    await navigate(client, `${origin}/app/calendar?babyId=${encodeURIComponent(babyId)}`);
    await click(client, "[data-calendar-add-event]");
    await assert(client, "document.querySelector('input[name=title]')", "dec407_browser_calendar_form_missing");
    await setInput(client, 'input[name="title"]', "DEC407 calendar diagnostic");
    await client.call("Network.setBlockedURLs", { urls: [`${origin}/api/browser-operations/partition*`] });
    await clickText(client, "Save Event");
    await assert(client, "document.querySelector('[role=alert][aria-live=assertive]')", "dec407_browser_calendar_live_error_missing");
    await client.call("Network.setBlockedURLs", { urls: [] });
    await waitFor(async () => client!.diagnostics.some((entry) => entry.startsWith("network_failure:") && entry.includes("/api/browser-operations/partition")), "dec407_browser_expected_calendar_failure_missing");
    const unexpectedDiagnostics = unexpectedBrowserDiagnostics(client.diagnostics, true);
    if (unexpectedDiagnostics.length) fail(`dec407_browser_unexpected_diagnostics:${JSON.stringify(unexpectedDiagnostics)}`);

    console.log("DEC407_BROWSER_ACCEPTANCE_PASS");
  } finally {
    copiedTabClient?.close();
    client?.close();
    const chromeStopped = chrome ? await terminateChromeProcessTree(chrome) : true;
    if (created.app) spawnSync("docker", ["rm", "--force", app], { cwd: root, stdio: "ignore" });
    if (created.database) spawnSync("docker", ["rm", "--force", database], { cwd: root, stdio: "ignore" });
    if (created.network) spawnSync("docker", ["network", "rm", network], { cwd: root, stdio: "ignore" });
    if (created.image) spawnSync("docker", ["image", "rm", image], { cwd: root, stdio: "ignore" });
    rmSync(browserRoot, { recursive: true, force: true });
    const residual = [
      docker(["ps", "--all", "--quiet", "--filter", `name=^/${prefix}`], true, "dec407_browser_cleanup_probe_failed"),
      docker(["network", "ls", "--quiet", "--filter", `name=${network}`], true, "dec407_browser_cleanup_probe_failed"),
      docker(["image", "ls", "--quiet", image], true, "dec407_browser_cleanup_probe_failed")
    ].some(Boolean);
    if (!chromeStopped || residual || existsSync(browserRoot)) fail("dec407_browser_cleanup_incomplete");
    console.log("DEC407_BROWSER_ACCEPTANCE_CLEANUP_PASS");
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) void runDecProd407BrowserAcceptance();
