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

console.log("BROWSER OPERATION SAVE PATH PASSED");
await prisma.$disconnect();
