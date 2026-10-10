// Only the disposable lifecycle invokes this file. Values stay in memory; output is one fixed code.
import { randomBytes, randomUUID } from "node:crypto";
import { browserFailure, browserFailureCode, formatBrowserFailure } from "./cross-device-freshness-browser-contract.mjs";
const base = process.env.REHEARSAL_APP_BASE_URL;
const password = process.env.REHEARSAL_APP_PASSWORD;
const action = process.env.REHEARSAL_CALENDAR_ACTION_ID;
let asynchronousFailure;
const failureListeners = new Set();
function signalBrowserFailure() {
  if (asynchronousFailure) return;
  asynchronousFailure = browserFailure("cdp_message_failed");
  for (const listener of [...failureListeners]) listener(asynchronousFailure);
}
const sleep = (ms) => new Promise((done, reject) => {
  if (asynchronousFailure) { reject(asynchronousFailure); return; }
  let timer;
  const failSleep = (error) => { clearTimeout(timer); failureListeners.delete(failSleep); reject(error); };
  timer = setTimeout(() => { failureListeners.delete(failSleep); done(); }, ms);
  failureListeners.add(failSleep);
});
const fail = (code) => { throw browserFailure(code); };
const observations = new Set();
const required = ["activity_create", "activity_update", "moments_create", "moments_update", "calendar_create", "timer_start", "timer_stop", "hidden_no_poll", "foreground_five_seconds", "offline_retention", "online_requires_confirmation", "draft_preservation", "tenant_isolation", "service_worker_cache", "request_cadence", "browser_diagnostics"];
async function wait(predicate, limit, code) {
  const until = Date.now() + limit;
  do { if (await predicate()) return; await sleep(100); } while (Date.now() < until);
  fail(code);
}
// Request interception with no handler stalls every request through the target, documents included.
const CDP_PATH_SEVERING = new Set(["Fetch.enable", "Network.setRequestInterception"]);
// EVERY CDP METHOD IS DENIED UNLESS LISTED HERE. Refusing four known-dangerous methods left the
// entire rest of the protocol permitted, and that surface is itself a page-side execution route:
// Page.navigate and Page.reload sever the observed document, Storage.clearDataForOrigin and
// Network.clearBrowserCache destroy the cache the proof depends on, ServiceWorker.stopAllWorkers
// kills the worker, Emulation.setScriptExecutionDisabled kills all page script, and
// Runtime.callFunctionOn plus Page.addScriptToEvaluateOnNewDocument run arbitrary page code
// without ever naming Runtime.evaluate. Enumerating what to refuse cannot terminate; this can.
const CDP_ALLOWED = new Map([
  ["Target.createTarget", new Set(["browser"])],
  ["Target.activateTarget", new Set(["browser"])],
  ["Target.closeTarget", new Set(["browser"])],
  ["Page.enable", new Set(["page"])],
  ["Runtime.enable", new Set(["page"])],
  ["Log.enable", new Set(["page"])],
  ["Network.enable", new Set(["page", "worker"])],
  ["Network.setCookies", new Set(["page"])],
  ["Network.setBlockedURLs", new Set(["page", "worker"])],
  ["Network.emulateNetworkConditions", new Set(["page"])],
  ["Emulation.setDeviceMetricsOverride", new Set(["page"])],
  ["Runtime.evaluate", new Set(["page"])],
  ["Runtime.addBinding", new Set(["page"])],
  ["Page.navigate", new Set(["page"])],
  ["Page.addScriptToEvaluateOnNewDocument", new Set(["page"])]
]);
const CDP_TIMER_PATH = /^http:\/\/127\.0\.0\.1:\d+\/api\/timers\/active\*$/;
function assertDispatchAllowed(kind, method, params) {
  // THE ONE CHOKE POINT. Whatever expression reaches this function - an alias, a parameter, a
  // computed key, a name built at runtime - these shapes are refused. Static contracts over the
  // probe source cannot be made total against re-spelling; this can, because every dispatch is here.
  //
  // The service worker controls the origin root with no scope filter and its fetch handler answers
  // every controlled GET, so taking the WORKER offline severs the observed page's own document and
  // RSC payloads. Two lifecycles failed exactly that way. The page session may emulate freely.
  // Deny by default: an unlisted method, or a listed method on the wrong session, is refused.
  const permittedKinds = CDP_ALLOWED.get(method);
  if (!permittedKinds || !permittedKinds.has(kind)) fail("cdp_dispatch_forbidden");
  if (method === "Network.emulateNetworkConditions" && kind !== "page") fail("cdp_dispatch_forbidden");
  // A blocked-URL list may only be the timer data path, or an explicit clear. A wildcard or an /app
  // pattern severs the document path the online-confirmation step observes.
  if (method === "Network.setBlockedURLs") {
    const urls = params?.urls;
    if (!Array.isArray(urls) || urls.length > 1) fail("cdp_dispatch_forbidden");
    if (urls.length === 1 && !CDP_TIMER_PATH.test(String(urls[0]))) fail("cdp_dispatch_forbidden");
  }
  if (CDP_PATH_SEVERING.has(method)) fail("cdp_dispatch_forbidden");
}
async function connect(url, kind) {
  if (asynchronousFailure) throw asynchronousFailure;
  if (!/^ws:\/\/127\.0\.0\.1:\d+\/devtools\//.test(url ?? "")) fail("cdp_scope");
  const socket = new WebSocket(url);
  await new Promise((done, reject) => {
    const timer = setTimeout(() => reject(browserFailure("cdp_timeout")), 10_000);
    socket.onopen = () => { clearTimeout(timer); done(); };
    socket.onerror = () => { clearTimeout(timer); reject(browserFailure("cdp_failed")); };
  });
  if (asynchronousFailure) { socket.close(); throw asynchronousFailure; }
  const pending = new Map();
  const listeners = [];
  let id = 0;
  const rejectPending = (error) => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
    pending.clear();
  };
  failureListeners.add(rejectPending);
  socket.onmessage = ({ data }) => {
    try {
      const message = JSON.parse(String(data));
      if (!message.id) { for (const listener of listeners) listener(message); return; }
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id); clearTimeout(request.timer);
      if (message.error) request.reject(browserFailure("cdp_command_failed"));
      else request.done(message.result);
    } catch { signalBrowserFailure(); }
  };
  return {
    on: (listener) => listeners.push(listener),
    call: (method, params = {}) => {
      assertDispatchAllowed(kind, method, params);
      return new Promise((done, reject) => {
      if (asynchronousFailure) { reject(asynchronousFailure); return; }
      const sequence = ++id;
      const timer = setTimeout(() => { pending.delete(sequence); reject(browserFailure("cdp_command_timeout")); }, 15_000);
      pending.set(sequence, { done, reject, timer }); socket.send(JSON.stringify({ id: sequence, method, params }));
      });
    },
    close: () => { failureListeners.delete(rejectPending); rejectPending(browserFailure("cdp_closed")); socket.close(); }
  };
}
async function evaluate(client, expression) {
  const response = await client.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (response.exceptionDetails) fail("browser_expression_failed");
  return response.result?.value;
}
const connections = [];
const devices = [];
const displaySurfaces = new Set();
function renderedIsolationMarkup(node) {
  // Framework scripts can echo the hostile query; inspect the rendered surface and its attributes.
  if (!node || node.nodeName === "SCRIPT" || node.parentElement?.closest("script")) return "";
  const copy = node.cloneNode(true);
  copy.querySelectorAll?.("script").forEach(script => script.remove());
  return copy.outerHTML ?? copy.textContent ?? "";
}
async function device(url) {
  const browser = await connect(url, "browser"); connections.push(browser);
  const endpoint = new URL(url).host;
  const targets = await fetch(`http://${endpoint}/json`, { signal: AbortSignal.timeout(5_000) }).then((response) => response.json());
  const target = targets.find((entry) => entry.type === "page");
  if (!target) fail("page_missing");
  const client = await connect(target.webSocketDebuggerUrl, "page"); connections.push(client);
  const diagnostics = { errors: 0, exceptions: 0, failures: 0, overlap: false, rsc: [], active: new Set(), expectedOutage: false, currentPath: "", isolationViolation: false };
  client.on((message) => {
    const params = message.params ?? {};
    if (message.method === "Runtime.bindingCalled" && params.name === "freshIsolationViolation") diagnostics.isolationViolation = true;
    if (!diagnostics.expectedOutage && (message.method === "Log.entryAdded" && params.entry?.level === "error" || message.method === "Runtime.consoleAPICalled" && params.type === "error")) diagnostics.errors++;
    if (message.method === "Runtime.exceptionThrown") diagnostics.exceptions++;
    if (message.method === "Network.loadingFailed" && !diagnostics.expectedOutage && !params.canceled) diagnostics.failures++;
    if (message.method === "Network.responseReceived" && !diagnostics.expectedOutage && params.response?.status >= 400) diagnostics.failures++;
    const headers = Object.fromEntries(Object.entries(params.request?.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
    const requestPath = params.request?.url?.startsWith(base) ? new URL(params.request.url).pathname : "";
    if (message.method === "Network.requestWillBeSent" && requestPath === diagnostics.currentPath && !headers["next-router-prefetch"] && /[?&]_rsc=/.test(params.request?.url ?? "")) {
      if (diagnostics.active.size) diagnostics.overlap = true;
      diagnostics.active.add(params.requestId); diagnostics.rsc.push(Date.now());
    }
    if (["Network.loadingFinished", "Network.loadingFailed"].includes(message.method)) diagnostics.active.delete(params.requestId);
  });
  for (const domain of ["Page", "Runtime", "Network", "Log"]) await client.call(`${domain}.enable`);
  await client.call("Runtime.addBinding", { name: "freshIsolationViolation" });
  await client.call("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
    const forbidden = ['FOREIGN_FRESHNESS_SENTINEL', 'fresh-baby-foreign', 'fresh-household-foreign', 'fresh-user-foreign', 'fresh-member-foreign'];
    const markup = ${renderedIsolationMarkup.toString()};
    const checkIsolation = (records = []) => {
      const fragments = [markup(document.documentElement), ...records.flatMap(record => [...record.addedNodes, ...record.removedNodes].map(markup))];
      if (fragments.some(fragment => forbidden.some(value => fragment.includes(value)))) {
        window.__freshIsolationViolation = true; window.freshIsolationViolation('1');
      }
    };
    new MutationObserver(checkIsolation).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    checkIsolation();
  })()` });
  await client.call("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  const response = await fetch(`${base}/api/auth/sign-in/email`, { method: "POST", signal: AbortSignal.timeout(10_000), headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ email: "own@freshness.invalid", password, rememberMe: false }) });
  const cookie = response.headers.get("set-cookie")?.match(/(?:^|,\s*)((?:__Secure-)?better-auth\.session_token)=([^;,]+)/);
  if (!response.ok || !cookie) fail("sign_in_failed");
  await client.call("Network.setCookies", { cookies: [{ name: cookie[1], value: cookie[2], url: base }, { name: "cubby_household_member", value: "fresh-member-own", url: base }] });
  const result = { client, browser, targetId: target.id, diagnostics }; devices.push(result); return result;
}
async function assertDisplayIsolation(device, surface) {
  if (device.diagnostics.isolationViolation || !await evaluate(device.client, `!window.__freshIsolationViolation && !['FOREIGN_FRESHNESS_SENTINEL', 'fresh-baby-foreign', 'fresh-household-foreign', 'fresh-member-foreign', 'fresh-user-foreign'].some(value => (${renderedIsolationMarkup.toString()})(document.documentElement).includes(value))`)) fail("tenant_isolation");
  if (surface) displaySurfaces.add(surface);
}
async function navigate(device, path) {
  await assertDisplayIsolation(device);

  device.diagnostics.currentPath = path.split("?")[0];
  // The observed document path is the whole point of the harness; refuse to navigate anywhere
  // else. Without this the single permitted navigate could be retargeted at the origin root.
  const destination = `${base}${path}`;
  if (!destination.startsWith(`${base}/app`)) fail("navigation_target_forbidden");
  await device.client.call("Page.navigate", { url: destination });
  await wait(() => evaluate(device.client, `location.pathname === ${JSON.stringify(path.split("?")[0])} && location.search === ${JSON.stringify(new URL(path, base).search)} && document.readyState === 'complete' && Boolean(document.querySelector('main'))`), 15_000, "navigation_failed");
  await sleep(750);
  await assertDisplayIsolation(device);
}
async function textPresent(device, text) { return evaluate(device.client, `document.body.innerText.includes(${JSON.stringify(text)})`); }
async function calendarMobileDay(device, dayKey) {
  // Phone month cell only: the count it speaks and the marker dots actually painted at this viewport.
  // Event titles live in a desktop-only region, so they are never observable here.
  const observed = await evaluate(device.client, `(() => {
    const cell = document.querySelector(${JSON.stringify(`[data-calendar-day="${dayKey}"]`)});
    const painted = (node) => {
      const style = getComputedStyle(node);
      return style.display !== 'none' && style.visibility !== 'hidden' && node.getClientRects().length > 0;
    };
    if (!cell || !painted(cell)) return null;
    const label = cell.getAttribute('aria-label');
    if (typeof label !== 'string') return null;
    const markers = cell.querySelector('[aria-hidden="true"]');
    if (markers && !painted(markers)) return null;
    const counted = label.match(/, (\\d+) items?$/);
    return { items: counted ? Number(counted[1]) : 0, dots: markers ? [...markers.children].filter(painted).length : 0 };
  })()`);
  if (!observed) fail("calendar_viewport_invalid");
  return observed;
}
function calendarDayAdvanced(before, after) {
  // The month cell caps its marker row at four dots, so a saturated day can never grow it. Require the
  // uncapped spoken count to rise and the marker row to still carry at least as many dots as before.
  return after.items > before.items && after.dots >= before.dots && after.dots > 0;
}
async function calendarOutcomeState(device, operation) {
  // Fixed classification only: completed, still-reconciling, terminal non-completed, or unavailable.
  return evaluate(device.client, `(async () => {
    const response = await fetch(${JSON.stringify(`/api/browser-operations/${operation}`)}, { cache: 'no-store' });
    const body = await response.json().catch(() => null);
    const status = body && body.ok && body.data ? body.data.status : undefined;
    if (status === 'completed') {
      const eventId = body.data.outcome?.eventId;
      return typeof eventId === 'string' && eventId.length > 0 ? 'completed' : 'unavailable';
    }
    if (status === 'pending' || status === 'prepared' || status === 'open') return 'pending';
    if (status === 'stale' || status === 'rejected' || status === 'expired') return 'terminal';
    return 'unavailable';
  })()`);
}
async function calendarOutcomeCompleted(device, operation, limit = 20_000) {
  // A Serializable submit can still be reconciling when the POST returns, so poll the retained
  // operation instead of trusting one read; a terminal outcome fails immediately rather than retrying.
  const until = Date.now() + limit;
  for (;;) {
    const state = await calendarOutcomeState(device, operation);
    if (state === "completed") return;
    if (state !== "pending" || Date.now() >= until) fail("calendar_outcome_incomplete");
    await sleep(250);
  }
}
async function onlineConfirmationState(device) {
  // Truthful online state is a conjunction, so report which part is unmet rather than one collapsed
  // boolean. A single combined marker already cost this program a repair round spent on an inferred
  // attribution; the earliest failing sub-state is reported instead.
  return evaluate(device.client, `(() => {
    if (!document.querySelector('main')) return 'page_absent';
    if (!document.querySelector('#app-freshness-status')) return 'status_absent';
    // The timer paragraph specifically, not the page-level branch: both render inside this region,
    // and a page-level instant plus a button disabled only because a timer load was pending would
    // otherwise satisfy the conjunction while timer staleness had in fact cleared.
    const timerCopy = [...document.querySelectorAll('#app-freshness-status p')]
      .find(p => p.textContent.includes('Timer data may be out of date'));
    if (!timerCopy) return 'timer_status_absent';
    if (!timerCopy.nextElementSibling?.querySelector('time')) return 'instant_absent';
    if (!document.querySelector('[aria-label="Running timers"]')) return 'timer_bar_absent';
    if (!document.querySelector('[aria-label="Running timers"] button:disabled')) return 'control_enabled';
    return 'confirmed';
  })()`);
}
// One throwaway request shape, shared by both outage guards so a single executable contract covers
// both. It reports a DISCRIMINATED outcome, because a network refusal, an answer and a fault inside
// the probe itself are three different facts: a bare catch let any throw - a restarted worker, a
// TypeError in the expression - read as "the path is out" and certify an outage that never existed.
// The token is built the way the product builds it, so the probe exercises the real request shape.
const WORKER_CONTROL_PROBE = `(async () => {
  try {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    const token = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    // caches.match defaults to ignoreSearch:false, so this query can never match the pre-cached
    // shell entry: answering REQUIRES the worker's passthrough fetch to reach the network.
    var url = '/manifest.webmanifest?cacheBust=' + token;
  } catch {
    return 'probe_error';
  }
  try {
    const response = await fetch(url, { cache: 'no-store' });
    return response.ok ? 'answered' : 'refused';
  } catch (error) {
    return error instanceof TypeError ? 'refused' : 'probe_error';
  }
})()`;
const TIMER_PATH_PROBE = `(async () => {
  let url;
  try {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    url = '/api/timers/active?requestToken=' + [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return 'probe_error';
  }
  try {
    await fetch(url, { cache: 'no-store' });
    return 'answered';
  } catch (error) {
    return error instanceof TypeError ? 'refused' : 'probe_error';
  }
})()`;
async function probeTimerPath(device) {
  // Only an explicit network refusal counts as "out". Anything else - answered, or a fault inside
  // the probe - is reported to the caller as not-out, so no guard can treat a broken probe as proof.
  const outcome = await evaluate(device.client, TIMER_PATH_PROBE);
  if (outcome === "probe_error") fail("timer_path_probe_failed");
  return outcome === "answered";
}
async function assertTimerPathOut(device) {
  // The worker now stays online, so the page-layer block is the only thing holding the timer data
  // path out - and whether a page-session block reaches a request mediated by the worker is not
  // something this harness may assume. Prove the outage instead: issue one throwaway request from
  // the page and require it to FAIL. A reachable timer path is a harness condition, never a product
  // verdict, because the product would then be correct to re-enable its controls.
  if (await probeTimerPath(device)) fail("timer_path_reachable");
}
async function assertWorkerBlockEnforced(device) {
  // The page layer is clear by now, so this request is governed only by the worker's scoped block.
  // Whether CDP enforces a blocked-URL list on a service_worker target - and delivers the refusal to
  // the worker's own fetch() promise rather than erroring the fetch event - is an ASSUMPTION this
  // harness cannot establish from source. Prove it where the cache proof first depends on it.
  //
  // A refusal alone is NOT proof: the worker falls back to caches.match, which must miss for a
  // never-cached URL, so respondWith(undefined) rejects for an unrelated reason that looks
  // identical. A positive control separates the two. An unblocked path must still answer through
  // the same worker; if the control is also refused, the worker is broken rather than enforcing,
  // and that is a harness condition instead of a silent product-looking cache failure later.
  if (await probeTimerPath(device)) fail("worker_block_unenforced");
  const control = await evaluate(device.client, WORKER_CONTROL_PROBE);
  if (control === "probe_error") fail("worker_control_probe_failed");
  if (control !== "answered") fail("worker_control_unreachable");
}
async function assertWorkerOutage(workerHost, worker) {
  // An idle service worker can be terminated and restarted, and a restarted worker inherits neither
  // its blocked-URL list nor any emulation. Confirm the exact worker target still exists and
  // re-apply the scoped block, so a lapsed outage is reported as a harness condition instead of
  // becoming a product verdict. The block is scoped to the timer data path: the worker controls the
  // origin root with no scope filter, so an offline emulation here would also sever the document and
  // RSC payloads of the very page under observation.
  const targets = await fetch(`http://${workerHost}/json`, { signal: AbortSignal.timeout(5_000) }).then(response => response.json());
  if (!targets.some(target => target.type === "service_worker" && target.url === `${base}/sw.js`)) fail("worker_outage_lapsed");
  await worker.call("Network.setBlockedURLs", { urls: [`${base}/api/timers/active*`] });
}
async function observe(code, predicate, limit = 20_000, detail) {
  // A conjunction-backed observation may supply a closed sub-state code, so a failure names the
  // earliest unmet part instead of collapsing into one ambiguous marker.
  try {
    await wait(predicate, limit, code);
  } catch (error) {
    // A throwing supplier must not convert a precisely attributed failure into an unknown marker.
    let reported;
    try { reported = detail?.(); } catch { reported = undefined; }
    if (browserFailureCode(error) === code && reported) fail(reported);
    throw error;
  }
  for (const device of devices) await assertDisplayIsolation(device);
  observations.add(code);
}
async function click(device, selector) {
  await wait(() => evaluate(device.client, `Boolean(document.querySelector(${JSON.stringify(selector)}))`), 5_000, "control_missing");
  await evaluate(device.client, `document.querySelector(${JSON.stringify(selector)}).click()`);
}
async function clickText(device, text) {
  const result = await evaluate(device.client, `(() => { const button = [...document.querySelectorAll('button')].find(node => node.textContent.trim() === ${JSON.stringify(text)}); if (!button || button.disabled) return false; button.click(); return true; })()`);
  if (!result) fail("button_missing");
}
async function input(device, selector, value) {
  await evaluate(device.client, `(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node) throw Error(); Object.getOwnPropertyDescriptor(Object.getPrototypeOf(node), 'value').set.call(node, ${JSON.stringify(value)}); node.dispatchEvent(new Event('input', { bubbles: true })); node.dispatchEvent(new Event('change', { bubbles: true })); })()`);
}
function operationId() { const alphabet = "0123456789abcdefghjkmnpqrstvwxyz"; return `bmo_${[...randomBytes(26)].map(byte => alphabet[byte % alphabet.length]).join("")}`; }
async function mutate(device, path, payload, method = "POST") {
  return evaluate(device.client, `(async () => { const response = await fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'content-type': 'application/json' }, body: JSON.stringify(${JSON.stringify({ operationId: operationId(), ...payload })}) }); const body = await response.json(); if (!response.ok || !body.ok || body.data.status !== 'completed') throw Error(); return body.data.outcome; })()`);
}
const babyId = "fresh-baby-own";
const ownLog = `/app?babyId=${babyId}`;
const ownMoments = `/app/moments?babyId=${babyId}`;
let outcome = "FRESHNESS_BROWSER_PASS\n";
try {
if (!base || !/^http:\/\/127\.0\.0\.1:\d+$/.test(base) || !password || !action) fail("freshness_scope_invalid");
  const a = await device(process.env.REHEARSAL_BROWSER_A);
  const b = await device(process.env.REHEARSAL_BROWSER_B);
  await navigate(a, ownLog); await navigate(b, ownLog);
  const created = await mutate(a, "/api/activities", { babyId, type: "note", occurredAt: new Date().toISOString(), text: "FRESH_ACTIVITY_CREATED" });
  await observe("activity_create", () => textPresent(b, "FRESH_ACTIVITY_CREATED"));
  await navigate(a, `/app/activities/${created.activityId}/edit`);
  await input(a, 'textarea[name="text"]', "FRESH_ACTIVITY_UPDATED");
  await clickText(a, "Save changes");
  await observe("activity_update", () => textPresent(b, "FRESH_ACTIVITY_UPDATED"));

  await assertDisplayIsolation(b, "log");
  await navigate(a, ownMoments); await navigate(b, ownMoments);
  await mutate(a, "/api/feed/posts", { babyId, body: "FRESH_MOMENT_CREATED" });
  await observe("moments_create", () => textPresent(b, "FRESH_MOMENT_CREATED"));
  await navigate(a, ownMoments);
  await click(a, 'button[aria-label="Edit post"]');
  await input(a, 'article textarea', "FRESH_MOMENT_UPDATED"); await clickText(a, "Save");
  await observe("moments_update", () => textPresent(b, "FRESH_MOMENT_UPDATED"));

  await assertDisplayIsolation(b, "moments");
  await navigate(b, `/app/calendar?babyId=${babyId}`);
  const day = new Date().toISOString().slice(0, 10);
  const calendarBefore = await calendarMobileDay(b, day);
  const calendarOperation = operationId();
  const saved = await evaluate(a.client, `(async () => { const form = new FormData(); const fields = ${JSON.stringify({ [`$ACTION_ID_${action}`]: "", operationId: calendarOperation, babyId, title: "FRESH_CALENDAR_CREATED", eventType: "Appointment", startDate: day, startTime: "09:00", endDate: day, endTime: "10:00" })}; for (const [key, value] of Object.entries(fields)) form.set(key, value); const result = await fetch('/app/calendar', { method: 'POST', body: form }); return result.ok; })()`);
  if (!saved) fail("calendar_submit_failed");
  await calendarOutcomeCompleted(a, calendarOperation);
  await observe("calendar_create", async () => calendarDayAdvanced(calendarBefore, await calendarMobileDay(b, day)));

  await assertDisplayIsolation(b, "calendar");
  await navigate(b, ownLog);
  const timer = await mutate(a, "/api/activities", { babyId, type: "sleep", occurredAt: new Date().toISOString(), startedAt: new Date().toISOString(), activeTimer: true });
  await observe("timer_start", () => evaluate(b.client, `Boolean(document.querySelector('[aria-label="Running timers"]'))`));
  await mutate(a, `/api/timers/${timer.activityId}/stop`, {});
  await observe("timer_stop", () => evaluate(b.client, `!document.querySelector('[aria-label="Running timers"]')`));

  // Real tab visibility, not a mocked visibilityState property or a suspended interval.
  const blank = await b.browser.call("Target.createTarget", { url: "about:blank" });
  await b.browser.call("Target.activateTarget", { targetId: blank.targetId });
  await wait(() => evaluate(b.client, "document.visibilityState === 'hidden'"), 5_000, "hide_failed");
  await sleep(1_000);
  const hiddenCount = b.diagnostics.rsc.length;
  await mutate(a, "/api/activities", { babyId, type: "note", occurredAt: new Date().toISOString(), text: "FRESH_FOREGROUND" });
  await sleep(31_000);
  if (hiddenCount !== b.diagnostics.rsc.length) fail("hidden_no_poll"); observations.add("hidden_no_poll");
  await b.browser.call("Target.activateTarget", { targetId: b.targetId });
  await observe("foreground_five_seconds", () => textPresent(b, "FRESH_FOREGROUND"), 5_000);
  await b.browser.call("Target.closeTarget", { targetId: blank.targetId });

  await mutate(a, "/api/activities", { babyId, type: "sleep", occurredAt: new Date().toISOString(), startedAt: new Date().toISOString(), activeTimer: true });
  await wait(() => evaluate(b.client, `Boolean(document.querySelector('[aria-label="Running timers"]'))`), 20_000, "known_timer_missing");
  // One old authorized response, under the exact URL the production loader will request later.
  await wait(() => evaluate(b.client, "Boolean(navigator.serviceWorker.controller)"), 10_000, "worker_missing");
  const cacheToken = randomUUID();
  const cacheUrl = `${base}/api/timers/active?${new URLSearchParams({ requestToken: cacheToken, babyId })}`;
  await evaluate(b.client, `(async () => {
    const cacheUrl = ${JSON.stringify(cacheUrl)};
    const response = await fetch(cacheUrl, { cache: 'no-store' });
    const body = await response.json();
    if (!response.ok || !body.ok || body.data.requestToken !== ${JSON.stringify(cacheToken)} || !body.data.timers.length) throw Error();
    window.__freshOldBody = JSON.stringify(body);
    const headers = new Headers(response.headers); headers.set('x-cubby-freshness-cache-proof', '1');
    await (await caches.open('cubby-shell-v2')).put(cacheUrl, new Response(window.__freshOldBody, { status: 200, headers }));
    // Separate server millisecond instants before asking the production loader for its newer snapshot.
    await new Promise(done => setTimeout(done, 25));
    const nativeFetch = window.fetch;
    try {
      await new Promise((done, reject) => {
        const deadline = setTimeout(() => reject(Error()), 5_000);
        window.fetch = async (...args) => {
          const result = await nativeFetch(...args);
          if (String(args[0]).startsWith('/api/timers/active?')) {
            const newer = await result.clone().json();
            if (newer.ok && Date.parse(newer.data.confirmedAt) > Date.parse(body.data.confirmedAt)) {
              window.__freshNewerInstant = newer.data.confirmedAt; clearTimeout(deadline); done();
            }
          }
          return result;
        };
        window.dispatchEvent(new Event('cubby:active-timers-changed'));
      });
    } finally { window.fetch = nativeFetch; }
    await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
  })()`);
  const targets = await fetch(`http://${new URL(process.env.REHEARSAL_BROWSER_B).host}/json`, { signal: AbortSignal.timeout(5_000) }).then(r => r.json());
  const workerHost = new URL(process.env.REHEARSAL_BROWSER_B).host;
  const workerTarget = targets.find(target => target.type === "service_worker" && target.url === `${base}/sw.js`);
  if (!workerTarget) fail("worker_target_missing");
  const worker = await connect(workerTarget.webSocketDebuggerUrl, "worker"); connections.push(worker);
  await worker.call("Network.enable");
  let exactCachedResponse = false;
  b.client.on(({ method, params }) => {
    if (method !== "Network.responseReceived") return;
    const response = params.response;
    const headers = Object.fromEntries(Object.entries(response.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
    if (response.url === cacheUrl && response.fromServiceWorker && headers["x-cubby-freshness-cache-proof"] === "1") exactCachedResponse = true;
  });
  b.diagnostics.expectedOutage = true;
  await b.client.call("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await observe("offline_retention", () => evaluate(b.client, `Boolean(document.querySelector('[aria-label="Running timers"]')) && Boolean(document.querySelector('[aria-label="Running timers"] button:disabled')) && Boolean(document.querySelector('[role="status"] time[datetime]'))`), 12_000);
  // Sever ONLY the timer data path, at both layers, and never the document path. The worker controls
  // the origin root with no scope filter and its fetch handler answers every controlled GET, so an
  // offline emulation on the worker also kills the observed page's own route and leaves no page to
  // observe - which two lifecycles reported as ONLINE_PAGE_ABSENT. A scoped blocked-URL list keeps
  // the document path alive. That it ALSO still forces the cache fallback service_worker_cache
  // proves is an assumption about where CDP enforces a blocked-URL list relative to the worker's
  // fetch event; it is not established from source, so assertWorkerBlockEnforced proves it below
  // before that observation relies on it.
  await worker.call("Network.setBlockedURLs", { urls: [`${base}/api/timers/active*`] });
  await b.client.call("Network.setBlockedURLs", { urls: [`${base}/api/timers/active*`] });
  await b.client.call("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await sleep(11_000);
  // The timer bar's requestToken check rejects any response that does not answer its own live
  // request, so a cached reply cannot clear timer staleness; proving the path is out makes that the
  // only remaining explanation for a retained stale state.
  await assertTimerPathOut(b);
  let onlineConfirmationDetail;
  await observe("online_requires_confirmation", async () => {
    onlineConfirmationDetail = await onlineConfirmationState(b);
    return onlineConfirmationDetail === "confirmed";
  }, 1_000, () => onlineConfirmationDetail && `online_${onlineConfirmationDetail}`);
  // The cache observation needs the request to reach the worker and fall back, so lift the PAGE
  // block and reconfirm the worker's scoped block it depends on. Nothing stays blocked at the page
  // layer; the worker keeps only the timer data path blocked.
  await b.client.call("Network.setBlockedURLs", { urls: [] });
  await assertWorkerOutage(workerHost, worker);
  await assertWorkerBlockEnforced(b);
  // The override exists only during this synchronous loader dispatch, never during authentication/mutation.
  await evaluate(b.client, `(async () => {
    const cacheUrl = ${JSON.stringify(cacheUrl)}, token = ${JSON.stringify(cacheToken)};
    const nativeRandom = crypto.getRandomValues, nativeFetch = window.fetch;
    const bytes = Uint8Array.from(token.replaceAll('-', '').match(/../g), hex => parseInt(hex, 16));
    window.__freshCacheProof = { consumed: 0, exactBody: false };
    const before = document.querySelector('#app-freshness-status time')?.dateTime;
    let finish;
    const received = new Promise((done, reject) => {
      const deadline = setTimeout(() => reject(Error()), 5_000);
      finish = () => { clearTimeout(deadline); done(); };
    });
    try {
      window.fetch = async (...args) => {
        const response = await nativeFetch(...args);
        if (new URL(String(args[0]), location.origin).href === cacheUrl) {
          const body = await response.clone().json();
          window.__freshCacheProof.exactBody = JSON.stringify(body) === window.__freshOldBody && body.data.requestToken === token && Date.parse(body.data.confirmedAt) < Date.parse(window.__freshNewerInstant);
          finish();
        }
        return response;
      };
      try {
        crypto.getRandomValues = function(array) {
          if (!(array instanceof Uint8Array) || array.length !== 16 || window.__freshCacheProof.consumed !== 0) throw Error();
          window.__freshCacheProof.consumed++; array.set(bytes); return array;
        };
        window.dispatchEvent(new Event('cubby:active-timers-changed'));
      } finally { crypto.getRandomValues = nativeRandom; }
      await received;
      await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
      window.__freshCacheProof.sameInstant = Boolean(before) && document.querySelector('#app-freshness-status time')?.dateTime === before;
    } finally { crypto.getRandomValues = nativeRandom; window.fetch = nativeFetch; }
  })()`);
  await observe("service_worker_cache", async () => exactCachedResponse && await evaluate(b.client, `navigator.onLine && window.__freshCacheProof.consumed === 1 && window.__freshCacheProof.exactBody && window.__freshCacheProof.sameInstant && Boolean(document.querySelector('#app-freshness-status time')) && Boolean(document.querySelector('[aria-label="Running timers"] button:disabled')) && !document.querySelector('[aria-label="Running timers"] button:not(:disabled)')`), 1_000);
  await assertDisplayIsolation(b, "timer_status");
  await worker.call("Network.setBlockedURLs", { urls: [] });
  await b.client.call("Network.setBlockedURLs", { urls: [] });
  await clickText(b, "Retry refresh");
  await wait(() => evaluate(b.client, `!document.querySelector('#app-freshness-status')`), 20_000, "recovery_failed");
  b.diagnostics.expectedOutage = false;

  const photo = await evaluate(a.client, `(async () => { const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aC1cAAAAASUVORK5CYII='), c => c.charCodeAt(0)); const response = await fetch('/api/attachments/feed-photos', { method: 'POST', headers: { 'content-type': 'image/png' }, body: bytes }); const body = await response.json(); if (!response.ok || !body.ok) throw Error(); return body.data.attachmentId; })()`);
  await mutate(a, "/api/feed/posts", { babyId, body: "FRESH_PHOTO", attachmentIds: [photo] });
  // Real composer and gallery state: unsaved text, a chosen photo, focus and an open dialog.
  await navigate(b, ownMoments);
  await clickText(b, "Share a moment");
  await input(b, 'form textarea', "UNSAVED_FRESHNESS_DRAFT");
  await evaluate(b.client, `(() => { const input = document.querySelector('input[type=file]'); if (!input) throw Error(); const transfer = new DataTransfer(); transfer.items.add(new File([Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aC1cAAAAASUVORK5CYII='), c => c.charCodeAt(0))], 'fixture.png', { type: 'image/png' })); window.__freshSelectedFiles = transfer.files; input.files = transfer.files; input.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await wait(() => evaluate(b.client, `Boolean(document.querySelector('[aria-label="Chosen photos"] img'))`), 10_000, "chosen_photo_missing");
  // The composer consumes/clears the picker on change; retain a real pending FileList separately from its uploaded preview.
  await evaluate(b.client, `(() => { const input = document.querySelector('input[type=file]'); input.files = window.__freshSelectedFiles; })()`);
  await click(b, 'button[aria-label="Open photo 1 of 1"]');
  await wait(() => evaluate(b.client, "Boolean(document.querySelector('[role=dialog]'))"), 5_000, "dialog_missing");
  await evaluate(b.client, `(async () => {
    const spacer = document.createElement('div'); spacer.style.height = '2000px'; spacer.setAttribute('aria-hidden', 'true'); document.body.append(spacer);
    scrollTo(0, 200); await new Promise(done => requestAnimationFrame(done));
    if (scrollY <= 0) throw Error();
    const file = document.querySelector('input[type=file]');
    if (!file || file.files.length !== 1 || !file.files[0].size) throw Error();
    window.__freshDraft = { draft: document.querySelector('form textarea'), file,
      files: [...file.files].map(({ name, type, size }) => ({ name, type, size })),
      photo: document.querySelector('[aria-label="Chosen photos"] img'), photoSrc: document.querySelector('[aria-label="Chosen photos"] img').src, focus: document.activeElement,
      scroll: scrollY, dialog: document.querySelector('[role=dialog]'), spacer };
  })()`);
  const before = b.diagnostics.rsc.length;
  await wait(() => Promise.resolve(b.diagnostics.rsc.length > before && b.diagnostics.active.size === 0), 20_000, "draft_refresh_missing");
  await observe("draft_preservation", () => evaluate(b.client, `(() => { const s = window.__freshDraft; return s.draft.isConnected && s.draft.value === 'UNSAVED_FRESHNESS_DRAFT' && s.file.isConnected && document.querySelector('input[type=file]') === s.file && s.files.length === 1 && s.file.files.length === s.files.length && [...s.file.files].every((file, index) => file.name === s.files[index].name && file.type === s.files[index].type && file.size === s.files[index].size) && s.photo.isConnected && s.photo.src === s.photoSrc && document.querySelector('[aria-label=\"Chosen photos\"] img') === s.photo && s.dialog.isConnected && document.querySelector('[role=dialog]') === s.dialog && document.activeElement === s.focus && s.scroll > 0 && scrollY === s.scroll; })()`), 1_000);
  await evaluate(b.client, "window.__freshDraft.spacer.remove()");
  const denied = await evaluate(b.client, `(async () => { const r = await fetch('/api/timers/active?babyId=fresh-baby-foreign&requestToken=${randomUUID()}', { cache: 'no-store' }); const body = await r.json(); return body.ok && body.data.timers.length === 0 && !JSON.stringify(body).includes('fresh-baby-foreign'); })()`);
  if (!denied) fail("tenant_isolation");
  await navigate(b, "/app?babyId=fresh-baby-foreign");
  await assertDisplayIsolation(b, "foreign_log");
  await navigate(b, ownLog);
  await navigate(b, "/app/moments?babyId=fresh-baby-foreign");
  await assertDisplayIsolation(b, "foreign_moments");
  await navigate(b, ownMoments);
  await navigate(b, "/app/calendar?babyId=fresh-baby-foreign");
  await assertDisplayIsolation(b, "foreign_calendar");
  await navigate(b, `/app/calendar?babyId=${babyId}`);
  if (!["log", "moments", "calendar", "timer_status", "foreign_log", "foreign_moments", "foreign_calendar"].every(surface => displaySurfaces.has(surface))) fail("isolation_surfaces_missing");
  for (const device of devices) await assertDisplayIsolation(device);
  observations.add("tenant_isolation");

  // Observe two undisturbed periodic requests, excluding explicit foreground/retry/navigation.
  await navigate(b, ownLog); await sleep(1_000);
  b.diagnostics.rsc = []; b.diagnostics.overlap = false;
  await sleep(32_000);
  const cadence = b.diagnostics.rsc;
  if (cadence.length !== 2 || cadence[1] - cadence[0] < 14_000 || cadence[1] - cadence[0] > 16_000 || b.diagnostics.overlap) fail("request_cadence");
  observations.add("request_cadence");
  if ([a, b].some(d => d.diagnostics.errors || d.diagnostics.exceptions || d.diagnostics.failures)) fail("browser_diagnostics");
  observations.add("browser_diagnostics");
  if (required.some(code => !observations.has(code))) fail("observations_missing");
} catch (error) {
  outcome = formatBrowserFailure(error); process.exitCode = 1;
} finally {
  for (const connection of connections) {
    try { connection.close(); }
    catch (error) {
      if (process.exitCode !== 1) { outcome = formatBrowserFailure(error); process.exitCode = 1; }
    }
  }
}
process.stdout.write(outcome);
