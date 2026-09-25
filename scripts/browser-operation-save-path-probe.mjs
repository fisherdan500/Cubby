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
for (const field of ["email", "householdId", "memberId", "babyId", "feedingWarningFingerprint", "targetMemberId", "apiKeyId"]) {
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
let cookie = `${sessionTokenCookie}; cubby_household_member=${encodeURIComponent(handoff.memberId)}`;

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

// The remaining families the dashboard and settings screens actually drive. Each one runs the same
// issue/submit path through the same restricted role, and each writes an audit row whose payload the
// audit contract validates - the two places the last round's defects hid. None of them had ever been
// exercised end to end against a real database.
async function createDisposableActivity(label) {
  const response = await fetch(`${baseUrl}/api/activities`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseUrl, cookie },
    body: JSON.stringify({
      operationId: operationId(),
      babyId: handoff.babyId,
      type: "diaper",
      kind: "wet",
      occurredAt: new Date().toISOString()
    })
  });
  const body = await response.json().catch(() => null);
  const activityId = body?.data?.outcome?.activityId;
  if (!response.ok || body?.data?.status !== "completed" || typeof activityId !== "string") {
    throw new Error(`browser_operation_save_path_probe_seed_activity_failed:${label}:${response.status}:${JSON.stringify(body)}`);
  }
  return activityId;
}

// Baby-scoped: dismissing a dashboard warning (the only family issued through the baby-scoped path
// besides activity.create, so it is the one that must still record its babyId on the binding).
await submitOperation("warning_dismiss_aged_session", {
  submitPath: "/api/dashboard/warnings/dismiss",
  method: "POST",
  payload: { babyId: handoff.babyId, type: "feeding", fingerprint: handoff.feedingWarningFingerprint }
});
const dismissals = await prisma.dashboardWarningDismissal.count({
  where: { babyId: handoff.babyId, fingerprint: handoff.feedingWarningFingerprint }
});
if (dismissals !== 1) {
  throw new Error(`browser_operation_save_path_probe_warning_dismissal_not_persisted:${dismissals}`);
}

// Household-scoped activity family: delete, and undo-last. Both were dead alongside timer stop until
// the binding shape was corrected, and neither is covered by the create/update pair above.
const deletableId = await createDisposableActivity("delete");
await submitOperation("activity_delete_aged_session", {
  submitPath: `/api/activities/${deletableId}`,
  method: "DELETE",
  payload: {}
});
const deleted = await prisma.activityLog.findUnique({ where: { id: deletableId }, select: { deletedAt: true } });
if (!deleted?.deletedAt) {
  throw new Error("browser_operation_save_path_probe_activity_delete_not_persisted");
}

const undoableId = await createDisposableActivity("undo");
await submitOperation("activity_undo_last_aged_session", {
  submitPath: "/api/activities/undo-last",
  method: "POST",
  payload: {}
});
const undone = await prisma.activityLog.findUnique({ where: { id: undoableId }, select: { deletedAt: true } });
if (!undone?.deletedAt) {
  throw new Error("browser_operation_save_path_probe_activity_undo_not_persisted");
}

// Baby lifecycle, the settings-screen pair. Deactivate then reactivate so the fixture baby is left
// exactly as it started and later runs are unaffected.
await submitOperation("baby_deactivate_aged_session", {
  submitPath: `/api/babies/${handoff.babyId}/deactivate`,
  method: "POST",
  payload: {}
});
const deactivated = await prisma.baby.findUnique({ where: { id: handoff.babyId }, select: { inactiveAt: true } });
if (!deactivated?.inactiveAt) {
  throw new Error("browser_operation_save_path_probe_baby_deactivate_not_persisted");
}

await submitOperation("baby_reactivate_aged_session", {
  submitPath: `/api/babies/${handoff.babyId}/reactivate`,
  method: "POST",
  payload: {}
});
const reactivated = await prisma.baby.findUnique({ where: { id: handoff.babyId }, select: { inactiveAt: true } });
if (reactivated?.inactiveAt) {
  throw new Error("browser_operation_save_path_probe_baby_reactivate_not_persisted");
}

// The families above are the ordinary ones: they must work on a session far past
// SESSION_FRESH_AGE_SECONDS. The boundary has another side that matters just as much - member
// management and API keys deliberately require a recent sign-in, and PR #74's fix only scoped
// requireFreshSession() back to those call sites rather than removing it. Both sides are asserted
// here, so a future "fix" that widens or drops freshness fails loudly instead of silently.
async function expectRefusal(label, { submitPath, method, payload, code }) {
  const response = await fetch(`${baseUrl}${submitPath}`, {
    method,
    headers: { "content-type": "application/json", origin: baseUrl, cookie },
    body: JSON.stringify({ operationId: operationId(), ...payload })
  });
  const body = await response.json().catch(() => null);
  if (response.status !== 403 || body?.error?.code !== code) {
    throw new Error(`browser_operation_save_path_probe_expected_refusal:${label}:${response.status}:${JSON.stringify(body)}`);
  }
}

await expectRefusal("member_role_update_aged_session", {
  submitPath: `/api/members/${handoff.targetMemberId}`,
  method: "PATCH",
  payload: { role: "parent" },
  code: "fresh_authentication_required"
});

await expectRefusal("api_key_revoke_aged_session", {
  submitPath: `/api/settings/api-keys/${handoff.apiKeyId}/revoke`,
  method: "POST",
  payload: {},
  code: "fresh_authentication_required"
});

// Ordinary household family with no freshness requirement, two-step like unit preferences.
await submitOperation("notification_preference_aged_session", {
  issuePath: "/api/notifications/preferences/issue",
  submitPath: "/api/notifications/preferences",
  method: "POST",
  payload: {
    externalDeliveryEnabled: false,
    babyScope: { mode: "all" },
    categories: [],
    channels: [],
    interruptionLevel: "time_sensitive",
    destinationIds: []
  }
});
const preference = await prisma.notificationPreference.findFirst({
  where: { householdId: handoff.householdId, memberId: handoff.memberId },
  select: { interruptionLevel: true }
});
// The API takes the wire value "time_sensitive"; Prisma reads the enum back as "timeSensitive".
if (preference?.interruptionLevel !== "timeSensitive") {
  throw new Error(`browser_operation_save_path_probe_notification_preference_not_persisted:${preference?.interruptionLevel}`);
}

// A direct (non-operation) household write that still goes through the audit contract, which is
// where the unit-preferences defect lived.
const webhookResponse = await fetch(`${baseUrl}/api/settings/webhooks`, {
  method: "POST",
  headers: { "content-type": "application/json", origin: baseUrl, cookie },
  body: JSON.stringify({ name: "Save path rehearsal", url: "https://rehearsal.invalid/hook", events: ["activity_created"] })
});
const webhookBody = await webhookResponse.json().catch(() => null);
const webhookId = webhookBody?.data?.id;
if (webhookResponse.status !== 201 || typeof webhookId !== "string") {
  throw new Error(`browser_operation_save_path_probe_webhook_create_failed:${webhookResponse.status}:${JSON.stringify(webhookBody)}`);
}

// Every mutation above is a write. Nothing checked that the app's own pages still render, and a
// server component that throws takes the screen down for a signed-in household - which is exactly
// how the 2026-09-15 outage presented. These are read-only GETs on the ALREADY-AGED session, since
// that is the normal state of a household that signed in weeks ago.
const renderedPages = [
  "/app",
  "/app/feed",
  "/app/history",
  "/app/calendar",
  "/app/reports",
  "/app/babies",
  "/app/settings",
  "/app/settings/appearance",
  "/app/settings/units",
  "/app/settings/members",
  "/app/settings/integrations",
  "/app/settings/backups",
  "/app/settings/export",
  "/app/settings/notifications",
  "/app/settings/sessions",
  "/app/settings/security-history",
  "/app/settings/leave",
  "/app/log/feeding",
  "/app/log/diaper",
  `/app/activities/${timerActivityId}`,
  `/app/activities/${timerActivityId}/edit`
];
for (const path of renderedPages) {
  const page = await fetch(`${baseUrl}${path}`, { headers: { cookie }, redirect: "manual" });
  if (page.status >= 400) {
    throw new Error(`browser_operation_save_path_probe_page_failed:${path}:${page.status}`);
  }
  // A thrown server component can still answer 200 with an error boundary, so assert the shell
  // actually rendered rather than trusting the status alone.
  if (page.status === 200) {
    const html = await page.text();
    if (!html.includes("Log Entry")) {
      throw new Error(`browser_operation_save_path_probe_page_shell_missing:${path}`);
    }
  }
}

// Kept so the freshness boundary can still be exercised from the aged side after the fresh sign-in
// below replaces the working cookie.
const agedCookie = cookie;

// Signing in again produces a fresh session, which is the other half of the boundary: the same two
// operations that just refused must now succeed.
const freshSignIn = await fetch(`${baseUrl}/api/auth/sign-in/email`, {
  method: "POST",
  headers: { "content-type": "application/json", origin: baseUrl },
  body: JSON.stringify({ email: handoff.email, password, rememberMe: false })
});
if (!freshSignIn.ok) throw new Error(`browser_operation_save_path_probe_fresh_sign_in_failed:${freshSignIn.status}`);
const freshCookieValue = (freshSignIn.headers.get("set-cookie") ?? "")
  .match(/(?:^|,\s*)((?:__Secure-)?better-auth\.session_token=[^;,]+)/)?.[1];
if (!freshCookieValue) throw new Error("browser_operation_save_path_probe_fresh_session_cookie_missing");
cookie = `${freshCookieValue}; cubby_household_member=${encodeURIComponent(handoff.memberId)}`;

await submitOperation("member_role_update_fresh_session", {
  submitPath: `/api/members/${handoff.targetMemberId}`,
  method: "PATCH",
  payload: { role: "parent" }
});
const targetMember = await prisma.householdMember.findUnique({
  where: { id: handoff.targetMemberId },
  select: { role: true }
});
if (targetMember?.role !== "parent") {
  throw new Error(`browser_operation_save_path_probe_member_role_not_persisted:${targetMember?.role}`);
}

await submitOperation("api_key_revoke_fresh_session", {
  submitPath: `/api/settings/api-keys/${handoff.apiKeyId}/revoke`,
  method: "POST",
  payload: {}
});
const revokedKey = await prisma.apiKey.findUnique({ where: { id: handoff.apiKeyId }, select: { revokedAt: true } });
if (!revokedKey?.revokedAt) throw new Error("browser_operation_save_path_probe_api_key_not_revoked");

// Suspension is the one member operation that also revokes the target's sessions, so it exercises
// lock_user_sessions_for_operation - the second SECURITY DEFINER lock added in PR #76, which until
// now had no end-to-end coverage at all. Restore puts the fixture back the way it started.
await submitOperation("member_suspend_fresh_session", {
  submitPath: `/api/members/${handoff.targetMemberId}/suspend`,
  method: "POST",
  payload: {}
});
const suspended = await prisma.householdMember.findUnique({
  where: { id: handoff.targetMemberId },
  select: { disabledAt: true }
});
if (!suspended?.disabledAt) throw new Error("browser_operation_save_path_probe_member_not_suspended");

await submitOperation("member_restore_fresh_session", {
  submitPath: `/api/members/${handoff.targetMemberId}/restore`,
  method: "POST",
  payload: {}
});
const restored = await prisma.householdMember.findUnique({
  where: { id: handoff.targetMemberId },
  select: { disabledAt: true }
});
if (restored?.disabledAt) throw new Error("browser_operation_save_path_probe_member_not_restored");

// Creating a calendar event is the only mutation with no HTTP route: the client component calls a
// Server Action directly. The browser posts the page route with a Next-Action header, so that is
// exactly what happens here - same session, same cookies, same aged-session question as the rest.
// Until now this path was only exercised at the persistence layer (browser-operation-pilot inserts
// bindings in SQL), which cannot catch an app-layer break like the ones the HTTP families had.
const calendarActionId = process.env.REHEARSAL_CALENDAR_ACTION_ID;
if (!calendarActionId) throw new Error("browser_operation_save_path_probe_calendar_action_id_missing");

const calendarTitle = `Save path rehearsal ${randomBytes(6).toString("hex")}`;
const calendarForm = new FormData();
// The no-JavaScript submission shape: a plain multipart body carrying $ACTION_ID_<id>, which Next
// hands to the action as its FormData argument. Posting the arguments with a Next-Action header
// instead would mean reproducing React's own reply encoding, which is version-specific and would be
// testing the reimplementation rather than the app.
calendarForm.set(`$ACTION_ID_${calendarActionId}`, "");
calendarForm.set("operationId", operationId());
calendarForm.set("babyId", handoff.babyId);
calendarForm.set("title", calendarTitle);
calendarForm.set("eventType", "Appointment");
calendarForm.set("startDate", "2026-09-20");
calendarForm.set("startTime", "09:00");
calendarForm.set("endDate", "2026-09-20");
calendarForm.set("endTime", "10:00");
calendarForm.set("location", "Rehearsal");
calendarForm.set("description", "Created through the Server Action");

const calendarResponse = await fetch(`${baseUrl}/app/calendar`, {
  method: "POST",
  headers: { origin: baseUrl, cookie },
  body: calendarForm,
  redirect: "manual"
});
// A no-JS action submission answers 200 or a 303 back to the page; either is success at this layer.
if (calendarResponse.status >= 400) {
  throw new Error(`browser_operation_save_path_probe_calendar_action_failed:${calendarResponse.status}:${(await calendarResponse.text()).slice(0, 400)}`);
}
// The action's own result travels in an RSC stream; the database is the assertion that matters.
const calendarEvent = await prisma.calendarEvent.findFirst({
  where: { householdId: handoff.householdId, title: calendarTitle },
  select: { id: true, eventType: true }
});
if (!calendarEvent) {
  throw new Error(`browser_operation_save_path_probe_calendar_event_not_persisted:${(await calendarResponse.text().catch(() => "")).slice(0, 200)}`);
}

// Changing a password is the highest-consequence flow the app has - fresh-auth grant, throttle
// preauthorization, the global security operation ledger, credential rotation and session
// revocation - and it is the flow whose machinery took sign-in down for the household on
// 2026-09-15. Until now it was only exercised at the service and SQL layers, never once over HTTP
// against the real restricted role. It runs last because it rotates the credential and clears the
// session cookies, exactly as it does for a real person.
function securityOperationMetadata() {
  const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
  const hex = () => Array.from(randomBytes(32), (value) => value.toString(16).padStart(2, "0")).join("");
  return {
    operationId: `gso_${Array.from(randomBytes(26), (value) => alphabet[value & 31]).join("")}`,
    openingFingerprint: hex(),
    intentFingerprint: hex()
  };
}

const newPassword = `${password}-rotated`;
const passwordChangeBody = (cookieHeader) => ({
  method: "POST",
  headers: { "content-type": "application/json", origin: baseUrl, cookie: cookieHeader },
  body: JSON.stringify({ ...securityOperationMetadata(), currentPassword: password, newPassword })
});

// Recovery enrollment is the offline fallback for losing the password, so it matters that it works
// against the real restricted role rather than only in service tests. It re-authenticates with the
// current password, like the password change below, so the aged session drives it.
async function securityPost(path, body, label) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseUrl, cookie: agedCookie },
    body: JSON.stringify(body)
  });
  const parsed = await response.json().catch(() => null);
  if (!response.ok || parsed?.ok !== true) {
    throw new Error(`browser_operation_save_path_probe_${label}_failed:${response.status}:${JSON.stringify(parsed)}`);
  }
  return parsed.data;
}

// Every follow-up action reuses this exact metadata: the set is looked up by its issuance
// operationId, and the binding check compares the fingerprints too, so a fresh operation id here
// reads as "no such enrollment" rather than as a new request.
const recoveryMetadata = securityOperationMetadata();
const enrolled = await securityPost(
  "/api/account/security/recovery",
  { action: "enroll", ...recoveryMetadata, currentPassword: password },
  "recovery_enroll"
);
if (!Array.isArray(enrolled?.codes) || enrolled.codes.length === 0 || enrolled.displayOnce !== true) {
  throw new Error(`browser_operation_save_path_probe_recovery_codes_missing:${JSON.stringify(enrolled)}`);
}

await securityPost(
  "/api/account/security/recovery",
  { action: "acknowledge", operationId: enrolled.operationId, setVersion: enrolled.setVersion },
  "recovery_acknowledge"
);

// Rehearsing spends one real code, which is the only way to prove the set is usable rather than
// merely stored.
await securityPost(
  "/api/account/security/recovery",
  { action: "rehearse", ...recoveryMetadata, setVersion: enrolled.setVersion, code: enrolled.codes[0] },
  "recovery_rehearse"
);
const recoveryStatus = await securityPost(
  "/api/account/security/recovery",
  { action: "status", ...recoveryMetadata },
  "recovery_status"
);
if (typeof recoveryStatus?.remainingCodes !== "number" || recoveryStatus.remainingCodes >= enrolled.codes.length) {
  throw new Error(`browser_operation_save_path_probe_recovery_code_not_spent:${JSON.stringify(recoveryStatus)}`);
}

// Email change is covered as far as this harness honestly can: initiate, status and cancel all run
// server-side, while verify and cutover need the token that only reaches a real mailbox. Driving
// those would mean reaching into delivery internals and asserting against the harness's own
// plumbing rather than the app.
const emailChangeMetadata = securityOperationMetadata();
const initiated = await securityPost(
  "/api/account/security/email-change",
  { action: "initiate", ...emailChangeMetadata, currentPassword: password, newEmail: "save-path-rotated@rehearsal.invalid" },
  "email_change_initiate"
);
const emailChangeStatus = await securityPost(
  "/api/account/security/email-change",
  { action: "status", operationId: initiated.operationId },
  "email_change_status"
);
if (emailChangeStatus?.status !== "pending") {
  throw new Error(`browser_operation_save_path_probe_email_change_not_pending:${JSON.stringify(emailChangeStatus)}`);
}
await securityPost(
  "/api/account/security/email-change",
  { action: "cancel", operationId: initiated.operationId },
  "email_change_cancel"
);
const cancelledUser = await prisma.user.findUnique({ where: { id: handoff.userId }, select: { email: true } });
if (cancelledUser?.email !== handoff.email) {
  throw new Error(`browser_operation_save_path_probe_email_changed_without_verification:${cancelledUser?.email}`);
}

// Session age is deliberately NOT the gate here: a password change re-authenticates with the
// current password itself (issueFreshAuthGrantForCurrentPassword), not with a recent sign-in, so it
// is driven from the aged session on purpose. "signed_out" is the success status - the credential
// rotates and every session is revoked. The 409 password_change_sign_in_required exists for a
// different condition: the grant machinery refusing a stale security version.
const passwordChange = await fetch(`${baseUrl}/api/account/security/password`, passwordChangeBody(agedCookie));
const passwordChangeResult = await passwordChange.json().catch(() => null);
if (!passwordChange.ok || passwordChangeResult?.data?.status !== "signed_out" || passwordChangeResult?.data?.signInRequired !== true) {
  throw new Error(`browser_operation_save_path_probe_password_change_failed:${passwordChange.status}:${JSON.stringify(passwordChangeResult)}`);
}

const securityState = await prisma.accountSecurityState.findUnique({
  where: { userId: handoff.userId },
  select: { credentialVersion: true }
});
if ((securityState?.credentialVersion ?? 0) < 2) {
  throw new Error(`browser_operation_save_path_probe_credential_version_not_rotated:${securityState?.credentialVersion}`);
}

// The rotation is only real if the old secret stops working and the new one starts.
const staleSignIn = await fetch(`${baseUrl}/api/auth/sign-in/email`, {
  method: "POST",
  headers: { "content-type": "application/json", origin: baseUrl },
  body: JSON.stringify({ email: handoff.email, password, rememberMe: false })
});
if (staleSignIn.ok) throw new Error("browser_operation_save_path_probe_old_password_still_accepted");

const rotatedSignIn = await fetch(`${baseUrl}/api/auth/sign-in/email`, {
  method: "POST",
  headers: { "content-type": "application/json", origin: baseUrl },
  body: JSON.stringify({ email: handoff.email, password: newPassword, rememberMe: false })
});
if (!rotatedSignIn.ok) {
  throw new Error(`browser_operation_save_path_probe_rotated_password_rejected:${rotatedSignIn.status}`);
}

console.log("BROWSER OPERATION SAVE PATH PASSED");
await prisma.$disconnect();
