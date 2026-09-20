import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";

// Measures DEC-PROD-225's remaining budget: 100 ms p95 for "visible accessible input acknowledgement".
// The server-outcome budgets are covered by performance-budgets-probe.mjs over HTTP; this one needs a
// real browser, because the thing being measured is the delay between the browser delivering an input
// event and the screen actually changing.
//
// Each sample dispatches a real mouse press/release through the DevTools input pipeline (not
// element.click(), which skips it), and the page itself records two timestamps: when it receives
// pointerdown, and the animation frame after the DOM change that acknowledges it. The difference is
// what a caregiver perceives as "it responded".

const baseUrl = process.env.REHEARSAL_APP_BASE_URL;
const handoffFile = process.env.REHEARSAL_HANDOFF_FILE;
const password = process.env.REHEARSAL_APP_PASSWORD;
const chromePath = process.env.CUBBY_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
if (!baseUrl || !handoffFile || !password) throw new Error("performance_input_probe_environment_not_set");
if (!existsSync(chromePath)) throw new Error("performance_input_probe_chrome_missing");

const handoff = JSON.parse(await readFile(handoffFile, "utf8"));
const [firstBaby] = handoff.babyIds ?? [];
if (!firstBaby) throw new Error("performance_input_probe_handoff_invalid");

const warmups = 3;
const samples = 15;
const budgetMs = 100;

function fail(code) { throw new Error(code); }

async function cdpConnect(url) {
  const socket = new WebSocket(url);
  await new Promise((resolveOpen, rejectOpen) => {
    socket.onopen = () => resolveOpen();
    socket.onerror = () => rejectOpen(new Error("performance_input_probe_cdp_connect_failed"));
  });
  let nextId = 1;
  const pending = new Map();
  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data));
    if (!message.id) return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(`performance_input_probe_cdp_${message.error.message ?? "error"}`));
    else request.resolve(message);
  };
  return {
    call(method, params = {}) {
      const id = nextId++;
      return new Promise((resolveCall, rejectCall) => {
        pending.set(id, { resolve: resolveCall, reject: rejectCall });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() { socket.close(); }
  };
}

async function evaluate(client, expression) {
  const response = await client.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (response.result?.exceptionDetails) fail("performance_input_probe_evaluate_failed");
  return response.result?.result?.value;
}

const profile = mkdtempSync(resolve(tmpdir(), "cubby-input-probe-"));
const chrome = spawn(chromePath, [
  "--headless=new",
  "--remote-debugging-port=0",
  `--user-data-dir=${profile}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--window-size=390,844",
  "about:blank"
], { stdio: ["ignore", "ignore", "pipe"] });

let client;
let passed = false;
try {
  const browserSocket = await new Promise((resolveSocket, rejectSocket) => {
    const timeout = setTimeout(() => rejectSocket(new Error("performance_input_probe_chrome_debug_timeout")), 20_000);
    chrome.stderr?.on("data", (chunk) => {
      const match = String(chunk).match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match?.[1]) { clearTimeout(timeout); resolveSocket(match[1]); }
    });
    chrome.once("exit", () => { clearTimeout(timeout); rejectSocket(new Error("performance_input_probe_chrome_exited")); });
  });

  const endpoint = new URL(browserSocket).host;
  const targets = await fetch(`http://${endpoint}/json`).then((response) => response.json());
  const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
  if (!page) fail("performance_input_probe_target_missing");
  client = await cdpConnect(page.webSocketDebuggerUrl);
  await client.call("Page.enable");
  await client.call("Runtime.enable");
  // A phone-sized viewport, because these budgets are about one-thumb use.
  await client.call("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });

  const signIn = await fetch(`${baseUrl}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseUrl },
    body: JSON.stringify({ email: handoff.email, password, rememberMe: false })
  });
  if (!signIn.ok) fail(`performance_input_probe_sign_in_failed:${signIn.status}`);
  const cookieHeader = signIn.headers.get("set-cookie") ?? "";
  const sessionCookie = cookieHeader.match(/(?:^|,\s*)((?:__Secure-)?better-auth\.session_token)=([^;,]+)/);
  if (!sessionCookie) fail("performance_input_probe_session_cookie_missing");
  const { hostname } = new URL(baseUrl);
  await client.call("Network.enable");
  await client.call("Network.setCookies", { cookies: [
    { name: sessionCookie[1], value: sessionCookie[2], domain: hostname, path: "/" },
    { name: "cubby_household_member", value: handoff.memberId, domain: hostname, path: "/" }
  ] });

  async function navigate(path) {
    const loaded = new Promise((resolveLoad) => {
      const timer = setTimeout(resolveLoad, 15_000);
      const check = setInterval(async () => {
        const ready = await evaluate(client, "document.readyState === 'complete'");
        if (ready) { clearInterval(check); clearTimeout(timer); resolveLoad(); }
      }, 50);
    });
    await client.call("Page.navigate", { url: `${baseUrl}${path}` });
    await loaded;
    // React has to hydrate before a tap does anything; wait for the app's own interactive marker.
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (await evaluate(client, "Boolean(document.querySelector('main'))")) break;
      await new Promise((wait) => setTimeout(wait, 50));
    }
  }

  /**
   * Arms the page: record the pointerdown timestamp, then the animation frame after the acknowledging
   * DOM change. `readyExpression` must evaluate to the element to press.
   */
  async function arm(selector, changeDescription) {
    const armed = await evaluate(client, `(() => {
      const target = document.querySelector(${JSON.stringify(selector)});
      if (!target) return null;
      window.__ack = null;
      let pressedAt = null;
      target.addEventListener("pointerdown", () => { pressedAt = performance.now(); }, { once: true, capture: true });
      const observer = new MutationObserver(() => {
        if (pressedAt === null) return;
        observer.disconnect();
        requestAnimationFrame(() => { window.__ack = performance.now() - pressedAt; });
      });
      observer.observe(document.body, { attributes: true, childList: true, subtree: true, characterData: true });
      const box = target.getBoundingClientRect();
      return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
    })()`);
    if (!armed) fail(`performance_input_probe_target_absent:${changeDescription}`);
    return armed;
  }

  async function press({ x, y }) {
    const shared = { x, y, button: "left", clickCount: 1, pointerType: "mouse" };
    await client.call("Input.dispatchMouseEvent", { type: "mousePressed", ...shared });
    await client.call("Input.dispatchMouseEvent", { type: "mouseReleased", ...shared });
  }

  async function acknowledgement(selector, description) {
    const point = await arm(selector, description);
    await press(point);
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const value = await evaluate(client, "window.__ack");
      if (typeof value === "number") return value;
      await new Promise((wait) => setTimeout(wait, 10));
    }
    fail(`performance_input_probe_no_acknowledgement:${description}`);
  }

  function percentile(sorted, fraction) {
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
    return Math.round(sorted[index] * 10) / 10;
  }

  async function measure(id, path, selector) {
    const durations = [];
    for (let index = 0; index < warmups + samples; index += 1) {
      // Each sample starts from a fresh load so every press meets the same state.
      await navigate(path);
      const value = await acknowledgement(selector, id);
      if (index >= warmups) durations.push(value);
    }
    const sorted = [...durations].sort((left, right) => left - right);
    const result = {
      interaction: id,
      budgetMs,
      samples: durations.length,
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      p99: percentile(sorted, 0.99),
      max: percentile(sorted, 1)
    };
    result.pass = result.p95 <= budgetMs;
    console.log(`${result.pass ? "PASS" : "FAIL"} ${id}: p50=${result.p50}ms p95=${result.p95}ms p99=${result.p99}ms max=${result.max}ms budget=${budgetMs}ms`);
    return result;
  }

  const results = [
    // The segmented choice at the top of a feeding entry: aria-checked moves to the pressed option.
    await measure("activity_form_choice_chip", `/app/log/feeding?babyId=${firstBaby}`, '[role="radio"][aria-checked="false"]'),
    // The amount stepper: the number in the field changes.
    await measure("activity_form_amount_step", `/app/log/feeding?babyId=${firstBaby}`, 'button[aria-label^="Increase amount"]'),
    // The dashboard's "More activities" disclosure opens.
    await measure("dashboard_more_activities", `/app?babyId=${firstBaby}`, "details > summary")
  ];

  const evidence = {
    schemaVersion: 1,
    datasetYears: handoff.years,
    datasetCounts: handoff.counts,
    measurement: "input_pointerdown_to_next_frame_after_acknowledging_change",
    viewport: "390x844 mobile, deviceScaleFactor 2",
    headless: true,
    results
  };
  console.log(`PERFORMANCE_INPUT_EVIDENCE ${JSON.stringify(evidence)}`);

  const failed = results.filter((result) => !result.pass).map((result) => result.interaction);
  if (failed.length) fail(`performance_input_probe_budget_exceeded:${failed.join(",")}`);
  passed = true;
} finally {
  client?.close();
  if (chrome.pid) {
    const killed = spawnSync("taskkill.exe", ["/PID", String(chrome.pid), "/T", "/F"], { stdio: "ignore" });
    if (killed.error || killed.status !== 0) chrome.kill();
  }
  rmSync(profile, { recursive: true, force: true });
  if (!passed) console.error("performance_input_probe_incomplete");
}
