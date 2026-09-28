import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

// Real-HTTP acceptance for admin-assisted account creation and password reset against the actual
// app image and the production restricted-role topology. Synthetic accounts only; no real mailbox,
// household or credential is reachable. Failures report fixed codes, never response bodies,
// headers, cookies or passwords.

const baseUrl = process.env.REHEARSAL_APP_BASE_URL;
const handoffFile = process.env.REHEARSAL_HANDOFF_FILE;
const password = process.env.REHEARSAL_APP_PASSWORD;
const prismaClientPath = process.env.REHEARSAL_PRISMA_CLIENT_PATH;
const migrationDatabaseUrl = process.env.REHEARSAL_MIGRATION_DATABASE_URL;
if (!baseUrl || !handoffFile || !password || !prismaClientPath || !migrationDatabaseUrl) {
  throw new Error("admin_assisted_accounts_probe_environment_not_set");
}

const handoff = JSON.parse(await readFile(handoffFile, "utf8"));
const { PrismaClient } = await import(pathToFileURL(resolve(prismaClientPath, "index.js")).href);
const prisma = new PrismaClient({ datasourceUrl: migrationDatabaseUrl });

const assistedPassword = `${randomBytes(18).toString("base64url")}Aa1`;
const replacementPassword = `${randomBytes(18).toString("base64url")}Bb2`;

function operationId() {
  const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
  return `bmo_${Array.from(randomBytes(26), (byte) => alphabet[byte % alphabet.length]).join("")}`;
}

function securityOperationId() {
  const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
  return `gso_${Array.from(randomBytes(26), (byte) => alphabet[byte % alphabet.length]).join("")}`;
}

function fingerprint() {
  return randomBytes(32).toString("hex");
}

async function signIn(email, secret) {
  const response = await fetch(`${baseUrl}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseUrl },
    body: JSON.stringify({ email, password: secret, rememberMe: false })
  });
  if (!response.ok) return null;
  const setCookie = response.headers.get("set-cookie") ?? "";
  const token = setCookie.match(/(?:^|,\s*)((?:__Secure-)?better-auth\.session_token=[^;,]+)/)?.[1];
  return token ?? null;
}

async function post(path, cookie, payload) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseUrl, cookie },
    body: JSON.stringify(payload)
  });
  const body = await response.json().catch(() => null);
  return { status: response.status, ok: body?.ok === true, data: body?.data, code: body?.error?.code };
}

const health = await fetch(`${baseUrl}/api/health`, { cache: "no-store" });
if (!health.ok) throw new Error(`admin_assisted_accounts_probe_health_invalid:${health.status}`);

const ownerToken = await signIn(handoff.ownerEmail, password);
if (!ownerToken) throw new Error("admin_assisted_accounts_probe_owner_sign_in_failed");
const ownerCookie = `${ownerToken}; cubby_household_member=${encodeURIComponent(handoff.ownerMemberId)}`;

// --- Case 1: owner creates a regular account with the checkbox OFF ---------------------------
async function createAccount(cookie, email, requireFirstLoginPasswordChange, role = "parent") {
  const id = operationId();
  const opened = await post("/api/members/assisted-account?issue=1", cookie, { operationId: id });
  if (!opened.ok || opened.data?.status !== "open" || typeof opened.data?.openingFingerprint !== "string") {
    throw new Error(`admin_assisted_accounts_probe_create_issue_failed:${opened.status}:${opened.code ?? ""}`);
  }
  return post("/api/members/assisted-account", cookie, {
    operationId: id,
    openingFingerprint: opened.data.openingFingerprint,
    name: "Assisted Created Person",
    email,
    role,
    password: assistedPassword,
    passwordConfirmation: assistedPassword,
    requireFirstLoginPasswordChange
  });
}

const unchecked = await createAccount(ownerCookie, handoff.createdEmail, false);
if (!unchecked.ok || unchecked.data?.status !== "completed" || unchecked.data?.outcome?.code !== "created") {
  throw new Error(`admin_assisted_accounts_probe_create_unchecked_failed:${unchecked.status}:${unchecked.code ?? ""}`);
}
const createdMemberId = unchecked.data.outcome.memberId;
const createdMember = await prisma.householdMember.findFirst({
  where: { id: createdMemberId, householdId: handoff.householdId, deletedAt: null },
  select: { userId: true, role: true }
});
if (!createdMember || createdMember.role !== "parent") throw new Error("admin_assisted_accounts_probe_create_not_persisted");

// An administrator entering an address does not prove mailbox control.
const createdUser = await prisma.user.findUnique({ where: { id: createdMember.userId }, select: { emailVerified: true } });
if (createdUser?.emailVerified !== false) throw new Error("admin_assisted_accounts_probe_created_email_wrongly_verified");

const uncheckedState = await prisma.assistedAccountState.findUnique({
  where: { userId: createdMember.userId },
  select: { requiredChangeCredentialVersion: true, assistedCreationMemberId: true }
});
if (uncheckedState?.requiredChangeCredentialVersion !== null) throw new Error("admin_assisted_accounts_probe_unchecked_requirement_set");
if (uncheckedState?.assistedCreationMemberId !== createdMemberId) throw new Error("admin_assisted_accounts_probe_origin_member_missing");

// The unchecked account signs in and reaches ordinary access immediately.
const createdToken = await signIn(handoff.createdEmail, assistedPassword);
if (!createdToken) throw new Error("admin_assisted_accounts_probe_created_sign_in_failed");
const createdCookie = `${createdToken}; cubby_household_member=${encodeURIComponent(createdMemberId)}`;
const ordinaryRead = await fetch(`${baseUrl}/api/browser-operations/partition`, { headers: { cookie: createdCookie }, cache: "no-store" });
if (!ordinaryRead.ok) throw new Error(`admin_assisted_accounts_probe_unchecked_ordinary_denied:${ordinaryRead.status}`);

// --- Case 2: checkbox ON produces a server-enforced restriction --------------------------------
const checked = await createAccount(ownerCookie, handoff.createdCheckedEmail, true);
if (!checked.ok || checked.data?.status !== "completed") {
  throw new Error(`admin_assisted_accounts_probe_create_checked_failed:${checked.status}:${checked.code ?? ""}`);
}
const checkedMemberId = checked.data.outcome.memberId;
const checkedMember = await prisma.householdMember.findFirst({ where: { id: checkedMemberId }, select: { userId: true } });
const checkedState = await prisma.assistedAccountState.findUnique({
  where: { userId: checkedMember.userId },
  select: { requiredChangeCredentialVersion: true }
});
if (checkedState?.requiredChangeCredentialVersion !== 1) throw new Error("admin_assisted_accounts_probe_checked_requirement_missing");

const checkedToken = await signIn(handoff.createdCheckedEmail, assistedPassword);
if (!checkedToken) throw new Error("admin_assisted_accounts_probe_checked_sign_in_failed");
const checkedCookie = `${checkedToken}; cubby_household_member=${encodeURIComponent(checkedMemberId)}`;

// Ordinary access must be denied server-side while the obligation stands.
const restrictedRead = await fetch(`${baseUrl}/api/browser-operations/partition`, { headers: { cookie: checkedCookie }, cache: "no-store" });
if (restrictedRead.ok) throw new Error("admin_assisted_accounts_probe_restricted_ordinary_allowed");

// Reusing the administrator-known password must be refused.
const reuse = await post("/api/account/security/required-password-change", checkedCookie, {
  operationId: securityOperationId(),
  openingFingerprint: fingerprint(),
  intentFingerprint: fingerprint(),
  currentPassword: assistedPassword,
  newPassword: assistedPassword,
  newPasswordConfirmation: assistedPassword
});
if (reuse.ok || reuse.code !== "required_password_change_reuse") {
  throw new Error(`admin_assisted_accounts_probe_reuse_not_rejected:${reuse.status}:${reuse.code ?? ""}`);
}
const afterReuse = await prisma.assistedAccountState.findUnique({
  where: { userId: checkedMember.userId }, select: { requiredChangeCredentialVersion: true }
});
if (afterReuse?.requiredChangeCredentialVersion !== 1) throw new Error("admin_assisted_accounts_probe_reuse_cleared_requirement");

// A genuine change clears the obligation atomically through the canonical transition.
const completed = await post("/api/account/security/required-password-change", checkedCookie, {
  operationId: securityOperationId(),
  openingFingerprint: fingerprint(),
  intentFingerprint: fingerprint(),
  currentPassword: assistedPassword,
  newPassword: replacementPassword,
  newPasswordConfirmation: replacementPassword
});
if (!completed.ok) throw new Error(`admin_assisted_accounts_probe_required_change_failed:${completed.status}:${completed.code ?? ""}`);
const afterChange = await prisma.assistedAccountState.findUnique({
  where: { userId: checkedMember.userId }, select: { requiredChangeCredentialVersion: true }
});
if (afterChange?.requiredChangeCredentialVersion !== null) throw new Error("admin_assisted_accounts_probe_requirement_not_cleared");

if (await signIn(handoff.createdCheckedEmail, assistedPassword)) {
  throw new Error("admin_assisted_accounts_probe_old_password_still_valid");
}
const rechecked = await signIn(handoff.createdCheckedEmail, replacementPassword);
if (!rechecked) throw new Error("admin_assisted_accounts_probe_new_password_rejected");
const recheckedOrdinary = await fetch(`${baseUrl}/api/browser-operations/partition`, {
  headers: { cookie: `${rechecked}; cubby_household_member=${encodeURIComponent(checkedMemberId)}` },
  cache: "no-store"
});
if (!recheckedOrdinary.ok) throw new Error(`admin_assisted_accounts_probe_post_change_ordinary_denied:${recheckedOrdinary.status}`);

// --- Case 3: eligible single-household reset succeeds ------------------------------------------
async function resetPassword(cookie, memberId, secret) {
  const id = operationId();
  const opened = await post(`/api/members/${encodeURIComponent(memberId)}/assisted-password?issue=1`, cookie, { operationId: id });
  if (!opened.ok || opened.data?.status !== "open") {
    return { issue: opened, submit: null };
  }
  const snapshot = opened.data.snapshot ?? {};
  const submit = await post(`/api/members/${encodeURIComponent(memberId)}/assisted-password`, cookie, {
    operationId: id,
    openingFingerprint: opened.data.openingFingerprint,
    targetUserId: snapshot.targetUserId,
    credentialVersion: snapshot.credentialVersion,
    sessionSecurityVersion: snapshot.sessionSecurityVersion,
    password: secret,
    passwordConfirmation: secret,
    requireFirstLoginPasswordChange: false
  });
  return { issue: opened, submit };
}

const memberSessionsBefore = await prisma.session.count({ where: { userId: handoff.memberUserId } });
const eligible = await resetPassword(ownerCookie, handoff.memberMemberId, replacementPassword);
if (!eligible.submit?.ok || eligible.submit.data?.status !== "completed" || eligible.submit.data?.outcome?.code !== "reset") {
  throw new Error(`admin_assisted_accounts_probe_reset_failed:${eligible.submit?.status ?? eligible.issue.status}:${eligible.submit?.code ?? eligible.issue.code ?? ""}`);
}
if (!(await signIn(handoff.memberEmail, replacementPassword))) {
  throw new Error("admin_assisted_accounts_probe_reset_password_not_effective");
}
if (await signIn(handoff.memberEmail, password)) {
  throw new Error("admin_assisted_accounts_probe_reset_old_password_still_valid");
}
void memberSessionsBefore;

// --- Case 4: cross-household reset is refused server-side --------------------------------------
const shared = await resetPassword(ownerCookie, handoff.sharedMemberId, replacementPassword);
const sharedResult = shared.submit ?? shared.issue;
const refused = sharedResult.data?.status === "rejected"
  && sharedResult.data?.code === "personal_recovery_unavailable";
if (!refused) {
  throw new Error(`admin_assisted_accounts_probe_cross_household_not_refused:${sharedResult.status}:${sharedResult.data?.status ?? ""}:${sharedResult.data?.code ?? sharedResult.code ?? ""}`);
}
// Their password must be untouched.
if (!(await signIn(handoff.sharedEmail, password))) {
  throw new Error("admin_assisted_accounts_probe_cross_household_password_changed");
}

// --- Case 5: authority matrix ------------------------------------------------------------------
const adminToken = await signIn(handoff.adminEmail, password);
if (!adminToken) throw new Error("admin_assisted_accounts_probe_admin_sign_in_failed");
const adminCookie = `${adminToken}; cubby_household_member=${encodeURIComponent(handoff.adminMemberId)}`;

// An admin may not reset another admin.
const adminOnAdmin = await resetPassword(adminCookie, handoff.adminMemberId, replacementPassword);
const adminOnAdminResult = adminOnAdmin.submit ?? adminOnAdmin.issue;
if (adminOnAdminResult.ok && adminOnAdminResult.data?.status === "completed") {
  throw new Error("admin_assisted_accounts_probe_admin_reset_admin_allowed");
}

// Nobody may reset the household owner through this screen.
const ownerTarget = await resetPassword(adminCookie, handoff.ownerMemberId, replacementPassword);
const ownerTargetResult = ownerTarget.submit ?? ownerTarget.issue;
if (ownerTargetResult.ok && ownerTargetResult.data?.status === "completed") {
  throw new Error("admin_assisted_accounts_probe_owner_reset_allowed");
}

// An admin may not create an admin.
const adminCreatesAdmin = await createAccount(adminCookie, "assisted-admin-escalation@rehearsal.invalid", false, "admin");
if (adminCreatesAdmin.ok && adminCreatesAdmin.data?.status === "completed") {
  throw new Error("admin_assisted_accounts_probe_admin_created_admin");
}

// --- Case 6: duplicate email is refused, not upserted ------------------------------------------
const duplicate = await createAccount(ownerCookie, handoff.memberEmail, false);
if (duplicate.data?.status !== "rejected" || duplicate.data?.code !== "existing_account_invitation_required") {
  throw new Error(`admin_assisted_accounts_probe_duplicate_not_refused:${duplicate.status}:${duplicate.data?.status ?? ""}`);
}

await prisma.$disconnect();
console.log("ADMIN_ASSISTED_ACCOUNTS_ACCEPTANCE_PASS");
