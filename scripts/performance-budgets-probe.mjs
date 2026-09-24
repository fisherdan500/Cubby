import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { populatedDashboardPath, populatedDateKey, requirePopulatedPage } from "./performance-probe-pages.mjs";

// Measures the DEC-PROD-225 workflows against a real signed-in app holding the deterministic
// DEC-PROD-226 dataset, and fails when a p95 exceeds its budget.
//
// Scope, stated plainly so the evidence is not read as more than it is: these are server outcomes
// measured from the host over loopback - the time for the app to return a complete authenticated HTML
// response, or an authoritative mutation result. That covers the "useful interactive content" and
// "authoritative server outcome" budgets. The 100 ms "visible accessible input acknowledgement" budget
// is a client-side paint measurement and is NOT measured here; it needs a browser harness.

const baseUrl = process.env.REHEARSAL_APP_BASE_URL;
const handoffFile = process.env.REHEARSAL_HANDOFF_FILE;
const password = process.env.REHEARSAL_APP_PASSWORD;
if (!baseUrl || !handoffFile || !password) throw new Error("performance_budgets_probe_environment_not_set");

const handoff = JSON.parse(await readFile(handoffFile, "utf8"));
const [firstBaby, secondBaby] = handoff.babyIds ?? [];
if (!firstBaby || !secondBaby) throw new Error("performance_budgets_probe_handoff_invalid");
const datasetDay = populatedDateKey(handoff);
// A dataset day holds eighteen activities per baby and a history page twenty-five rows, so fewer than
// this means the page did not render the seeded history it is supposed to be timing.
const populatedMinimum = 10;

const warmups = 3;
const samples = 15;

function operationId() {
  const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
  return `bmo_${Array.from(randomBytes(26), (byte) => alphabet[byte % alphabet.length]).join("")}`;
}

const health = await fetch(`${baseUrl}/api/health`, { cache: "no-store" });
if (!health.ok) throw new Error(`performance_budgets_probe_health_invalid:${health.status}`);

const signIn = await fetch(`${baseUrl}/api/auth/sign-in/email`, {
  method: "POST",
  headers: { "content-type": "application/json", origin: baseUrl },
  body: JSON.stringify({ email: handoff.email, password, rememberMe: false })
});
if (!signIn.ok) throw new Error(`performance_budgets_probe_sign_in_failed:${signIn.status}`);
const sessionCookie = (signIn.headers.get("set-cookie") ?? "").match(/(?:^|,\s*)((?:__Secure-)?better-auth\.session_token=[^;,]+)/)?.[1];
if (!sessionCookie) throw new Error("performance_budgets_probe_session_cookie_missing");
const cookie = `${sessionCookie}; cubby_household_member=${encodeURIComponent(handoff.memberId)}`;

/**
 * A page is only "useful content" once the whole authenticated HTML has arrived, so the body is read,
 * and only a measurement of the seeded history once that history is actually on it.
 */
async function page(path) {
  const response = await fetch(`${baseUrl}${path}`, { headers: { cookie }, cache: "no-store" });
  const body = await response.text();
  if (!response.ok) throw new Error(`performance_budgets_probe_page_failed:${path}:${response.status}`);
  if (!body.includes("</html>")) throw new Error(`performance_budgets_probe_page_incomplete:${path}`);
  requirePopulatedPage(path, body, populatedMinimum);
  return body;
}

async function saveMinimumEntry() {
  const response = await fetch(`${baseUrl}/api/activities`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseUrl, cookie },
    body: JSON.stringify({
      operationId: operationId(),
      babyId: firstBaby,
      type: "diaper",
      kind: "wet",
      occurredAt: new Date().toISOString()
    })
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.data?.status !== "completed" || body?.data?.outcome?.code !== "ok") {
    throw new Error(`performance_budgets_probe_save_failed:${response.status}:${JSON.stringify(body)}`);
  }
  return body.data.outcome.activityId;
}

async function startTimer() {
  const response = await fetch(`${baseUrl}/api/activities`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseUrl, cookie },
    body: JSON.stringify({
      operationId: operationId(),
      babyId: secondBaby,
      type: "sleep",
      activeTimer: "true",
      occurredAt: new Date().toISOString(),
      startedAt: new Date().toISOString()
    })
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.data?.outcome?.code !== "ok") {
    throw new Error(`performance_budgets_probe_timer_start_failed:${response.status}:${JSON.stringify(body)}`);
  }
  return body.data.outcome.activityId;
}

async function stopTimer(activityId) {
  const id = operationId();
  const issued = await fetch(`${baseUrl}/api/timers/${activityId}/stop?issue=1`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseUrl, cookie },
    body: JSON.stringify({ operationId: id })
  });
  if (!issued.ok) throw new Error(`performance_budgets_probe_timer_issue_failed:${issued.status}`);
  const response = await fetch(`${baseUrl}/api/timers/${activityId}/stop`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseUrl, cookie },
    body: JSON.stringify({ operationId: id })
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.data?.outcome?.code !== "ok") {
    throw new Error(`performance_budgets_probe_timer_stop_failed:${response.status}:${JSON.stringify(body)}`);
  }
}

function percentile(sorted, fraction) {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return Math.round(sorted[index]);
}

async function measure(id, budgetMs, run) {
  for (let index = 0; index < warmups; index += 1) await run();
  const durations = [];
  for (let index = 0; index < samples; index += 1) {
    const started = performance.now();
    await run();
    durations.push(performance.now() - started);
  }
  const sorted = [...durations].sort((left, right) => left - right);
  const result = {
    workflow: id,
    budgetMs,
    samples: durations.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: Math.round(sorted[sorted.length - 1])
  };
  result.pass = result.p95 <= budgetMs;
  console.log(`${result.pass ? "PASS" : "FAIL"} ${id}: p50=${result.p50}ms p95=${result.p95}ms p99=${result.p99}ms max=${result.max}ms budget=${budgetMs}ms`);
  return result;
}

const timerIds = [];
const results = [
  await measure("dashboard_useful_content", 2_000, () => page(populatedDashboardPath(firstBaby, datasetDay))),
  await measure("recent_history_useful_content", 2_000, () => page("/app/history")),
  await measure("baby_switch_navigation", 1_000, () => page(populatedDashboardPath(secondBaby, datasetDay))),
  await measure("minimum_entry_authoritative_outcome", 2_000, () => saveMinimumEntry()),
  await measure("timer_start_authoritative_outcome", 2_000, async () => timerIds.push(await startTimer()))
];
// Each stop needs its own running timer, so the timers started above are consumed here.
let stopIndex = 0;
results.push(await measure("timer_stop_authoritative_outcome", 2_000, async () => {
  const activityId = timerIds[stopIndex++] ?? (await startTimer());
  await stopTimer(activityId);
}));

const evidence = {
  schemaVersion: 1,
  datasetYears: handoff.years,
  datasetCounts: handoff.counts,
  datasetDay,
  measurement: "server_outcome_over_loopback",
  mode: "warm",
  notMeasured: ["visible_accessible_input_acknowledgement_100ms_client_paint"],
  node: process.version,
  results
};
console.log(`PERFORMANCE_BUDGET_EVIDENCE ${JSON.stringify(evidence)}`);

const failed = results.filter((result) => !result.pass).map((result) => result.workflow);
if (failed.length) throw new Error(`performance_budgets_probe_budget_exceeded:${failed.join(",")}`);
