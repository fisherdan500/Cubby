import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const baseUrl = process.env.REHEARSAL_APP_BASE_URL;
const handoffFile = process.env.REHEARSAL_HANDOFF_FILE;
const password = process.env.REHEARSAL_APP_PASSWORD;
const prismaClientPath = process.env.REHEARSAL_PRISMA_CLIENT_PATH;
const migrationDatabaseUrl = process.env.REHEARSAL_MIGRATION_DATABASE_URL;
if (!baseUrl || !handoffFile || !password || !prismaClientPath || !migrationDatabaseUrl) {
  throw new Error("browser_operation_save_path_probe_environment_not_set");
}

const handoff = JSON.parse(await readFile(handoffFile, "utf8"));
for (const field of ["email", "householdId", "memberId", "babyId"]) {
  if (typeof handoff[field] !== "string" || !handoff[field]) throw new Error(`browser_operation_save_path_probe_handoff_invalid:${field}`);
}

const { PrismaClient } = await import(pathToFileURL(resolve(prismaClientPath, "index.js")).href);
const prisma = new PrismaClient({ datasourceUrl: migrationDatabaseUrl });

function operationId() {
  const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
  return `bmo_${Array.from(randomBytes(26), (byte) => alphabet[byte % alphabet.length]).join("")}`;
}

const health = await fetch(`${baseUrl}/api/health`, { cache: "no-store" });
if (!health.ok) throw new Error(`browser_operation_save_path_probe_health_invalid:${health.status}`);

const signIn = await fetch(`${baseUrl}/api/auth/sign-in/email`, {
  method: "POST",
  headers: { "content-type": "application/json", origin: baseUrl },
  body: JSON.stringify({ email: handoff.email, password, rememberMe: false })
});
if (!signIn.ok) throw new Error(`browser_operation_save_path_probe_sign_in_failed:${signIn.status}`);
const setCookie = signIn.headers.get("set-cookie") ?? "";
const sessionTokenCookie = setCookie.match(/(?:^|,\s*)((?:__Secure-)?better-auth\.session_token=[^;,]+)/)?.[1];
if (!sessionTokenCookie) throw new Error("browser_operation_save_path_probe_session_cookie_missing");
const cookie = `${sessionTokenCookie}; cubby_household_member=${encodeURIComponent(handoff.memberId)}`;

// The exact class of runtime break this rehearsal pins: an ordinary browser-operation mutation
// (activity.create) must succeed against the REAL restricted `cubby_runtime` role, which has no
// UPDATE grant on "Session" (20260824140000_global_security_foundation onward) - only the
// SECURITY DEFINER lock functions PR #76 introduced may take the row lock the mutation path needs.
// It must also succeed on a session well past SESSION_FRESH_AGE_SECONDS (600s), because
// requireFreshSession() must stay scoped to the sensitive call sites PR #74 fixed, never a blanket
// gate on every mutation.
async function saveActivity(label) {
  const response = await fetch(`${baseUrl}/api/activities`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseUrl, cookie },
    body: JSON.stringify({
      operationId: operationId(),
      babyId: handoff.babyId,
      type: "sleep",
      occurredAt: new Date().toISOString(),
      startedAt: new Date().toISOString()
    })
  });
  const body = await response.json().catch(() => null);
  const result = body?.data;
  if (!response.ok || !body?.ok || result?.status !== "completed" || result?.outcome?.code !== "ok") {
    throw new Error(`browser_operation_save_path_probe_save_failed:${label}:${response.status}:${JSON.stringify(body)}`);
  }
  const activityId = result.outcome.activityId;
  if (typeof activityId !== "string" || !activityId) {
    throw new Error(`browser_operation_save_path_probe_save_no_activity_id:${label}`);
  }
  const row = await prisma.activityLog.count({ where: { id: activityId, householdId: handoff.householdId, babyId: handoff.babyId } });
  if (row !== 1) throw new Error(`browser_operation_save_path_probe_save_not_persisted:${label}`);
}

await saveActivity("fresh_session");

// The synthetic fixture user has never signed in before this probe, so the sign-in above created
// exactly one Session row; find it by recency rather than re-deriving better-auth's cookie/token
// encoding here.
const sessionRow = await prisma.session.findFirst({
  where: { userId: handoff.userId },
  orderBy: { createdAt: "desc" },
  select: { id: true, createdAt: true }
});
if (!sessionRow) throw new Error("browser_operation_save_path_probe_session_row_missing");

const runtimeHasSessionUpdate = await prisma.$queryRaw`SELECT has_table_privilege('cubby_runtime', '"Session"', 'UPDATE') AS granted`;
if (runtimeHasSessionUpdate[0]?.granted !== false) {
  throw new Error("browser_operation_save_path_probe_privilege_boundary_not_restrictive");
}

await prisma.session.update({
  where: { id: sessionRow.id },
  data: { createdAt: new Date(Date.now() - 20 * 60 * 1000) }
});

await saveActivity("aged_session");

// activity.create is only one of the mutation families that broke. Every ordinary browser operation
// runs the same issue/submit flow through the same restricted role, and the three context helpers
// that take the session row lock are exercised by different families: baby-scoped
// (getBrowserOperationContextForBaby - activities, timers), household-scoped
// (getBrowserOperationContextForHousehold - unit preferences and the rest of household settings)
// and account-scoped (lockCurrentAccountActor - account appearance). A privilege or freshness
// regression in any one of them is invisible to the activity path alone, so each family is
// exercised here on the ALREADY-AGED session, which is the shape that actually broke live.
async function submitOperation(label, { issuePath, submitPath, method, payload }) {
  const id = operationId();
  if (issuePath) {
    const issued = await fetch(`${baseUrl}${issuePath}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseUrl, cookie },
      body: JSON.stringify({ operationId: id })
    });
    const issuedBody = await issued.json().catch(() => null);
    if (!issued.ok || !issuedBody?.ok) {
      throw new Error(`browser_operation_save_path_probe_issue_failed:${label}:${issued.status}:${JSON.stringify(issuedBody)}`);
    }
    const issuedStatus = issuedBody.data?.status;
    if (issuedStatus !== "open" && issuedStatus !== "prepared") {
      throw new Error(`browser_operation_save_path_probe_issue_unexpected_status:${label}:${issuedStatus}`);
    }
  }
  const response = await fetch(`${baseUrl}${submitPath}`, {
    method,
    headers: { "content-type": "application/json", origin: baseUrl, cookie },
    body: JSON.stringify({ operationId: id, ...payload })
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.ok || body.data?.status !== "completed") {
    throw new Error(`browser_operation_save_path_probe_operation_failed:${label}:${response.status}:${JSON.stringify(body)}`);
  }
  return body.data;
}

// Baby-scoped, second family: a running timer must still stop. Same context helper as activity
// create, but a different operation key and a target that already exists.
const startedTimer = await fetch(`${baseUrl}/api/activities`, {
  method: "POST",
  headers: { "content-type": "application/json", origin: baseUrl, cookie },
  body: JSON.stringify({
    operationId: operationId(),
    babyId: handoff.babyId,
    type: "sleep",
    activeTimer: true,
    occurredAt: new Date().toISOString(),
    startedAt: new Date().toISOString()
  })
});
const startedTimerBody = await startedTimer.json().catch(() => null);
const timerActivityId = startedTimerBody?.data?.outcome?.activityId;
if (!startedTimer.ok || startedTimerBody?.data?.status !== "completed" || typeof timerActivityId !== "string") {
  throw new Error(`browser_operation_save_path_probe_timer_start_failed:${startedTimer.status}:${JSON.stringify(startedTimerBody)}`);
}
const runningTimer = await prisma.activityLog.findUnique({ where: { id: timerActivityId }, select: { timerState: true } });
if (runningTimer?.timerState !== "running") {
  throw new Error(`browser_operation_save_path_probe_timer_not_running:${runningTimer?.timerState}`);
}

await submitOperation("timer_stop_aged_session", {
  submitPath: `/api/timers/${timerActivityId}/stop`,
  method: "POST",
  payload: {}
});
const stoppedTimer = await prisma.activityLog.findUnique({
  where: { id: timerActivityId },
  select: { timerState: true, endedAt: true }
});
if (stoppedTimer?.timerState !== "stopped" || !stoppedTimer.endedAt) {
  throw new Error(`browser_operation_save_path_probe_timer_not_stopped:${JSON.stringify(stoppedTimer)}`);
}

// Same household-scoped activity family as the timer, but a different operation key and a payload
// that carries the caller's expected revision: editing an existing activity.
const editTarget = await prisma.activityLog.findUnique({
  where: { id: timerActivityId },
  select: { updatedAt: true, babyId: true }
});
if (!editTarget) throw new Error("browser_operation_save_path_probe_edit_target_missing");
await submitOperation("activity_update_aged_session", {
  submitPath: `/api/activities/${timerActivityId}`,
  method: "PATCH",
  payload: {
    babyId: editTarget.babyId,
    type: "sleep",
    expectedUpdatedAt: editTarget.updatedAt.toISOString(),
    notes: "edited by the save-path rehearsal",
    occurredAt: new Date().toISOString()
  }
});
const editedActivity = await prisma.activityLog.findUnique({
  where: { id: timerActivityId },
  select: { notes: true }
});
if (editedActivity?.notes !== "edited by the save-path rehearsal") {
  throw new Error(`browser_operation_save_path_probe_activity_update_not_persisted:${editedActivity?.notes}`);
}

// Household-scoped family: unit preferences. Two-step (issue, then submit) rather than the
// activity route's single-call form, so it also covers the separately issued opening.
await submitOperation("units_update_aged_session", {
  issuePath: "/api/settings/units/issue",
  submitPath: "/api/settings/units",
  method: "PATCH",
  payload: { volume: "mL", weight: "kg", length: "cm", temperature: "C", medicineUnits: {}, supplementUnits: {} }
});
const settings = await prisma.householdSettings.findUnique({
  where: { householdId: handoff.householdId },
  select: { unitPreferences: true }
});
if (settings?.unitPreferences?.volume !== "mL" || settings?.unitPreferences?.temperature !== "C") {
  throw new Error(`browser_operation_save_path_probe_units_not_persisted:${JSON.stringify(settings?.unitPreferences)}`);
}

// Account-scoped family: appearance runs through lockCurrentAccountActor, a different lock helper
// on a different table set ("Session" plus "User"), so the household families above cannot cover it.
await submitOperation("account_appearance_aged_session", {
  issuePath: "/api/account/appearance/issue",
  submitPath: "/api/account/appearance",
  method: "PATCH",
  payload: { appearanceMode: "dark" }
});
const appearance = await prisma.user.findUnique({
  where: { id: handoff.userId },
  select: { appearanceMode: true }
});
if (appearance?.appearanceMode !== "dark") {
  throw new Error(`browser_operation_save_path_probe_appearance_not_persisted:${appearance?.appearanceMode}`);
}

console.log("BROWSER OPERATION SAVE PATH PASSED");
await prisma.$disconnect();
