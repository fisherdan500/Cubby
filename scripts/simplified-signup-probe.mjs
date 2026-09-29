import { readFile } from "node:fs/promises";
import { randomBytes, createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

// Real-HTTP acceptance for simplified invitation signup (DEC-PROD-426/427/428) against the actual
// app image and the production restricted-role topology. Synthetic accounts only; no real mailbox,
// household or credential is reachable, and no email is ever sent. Failures report fixed codes,
// never response bodies, headers, cookies or passwords.
//
// What this proves that no unit test can: the full client-driven sequence
//   claim -> credential-submit -> sign-in -> post-signin-bind -> review -> accept-reserve -> accept-submit
// completes over real HTTP, as the real restricted database roles, WITHOUT the invitee ever
// generating or rehearsing an offline recovery code, typing the household name, or typing an admin
// acknowledgement. Before this slice the acceptance procedure rejected exactly that.

const baseUrl = process.env.REHEARSAL_APP_BASE_URL;
const handoffFile = process.env.REHEARSAL_HANDOFF_FILE;
const prismaClientPath = process.env.REHEARSAL_PRISMA_CLIENT_PATH;
const migrationDatabaseUrl = process.env.REHEARSAL_MIGRATION_DATABASE_URL;
if (!baseUrl || !handoffFile || !prismaClientPath || !migrationDatabaseUrl) {
  throw new Error("simplified_signup_probe_environment_not_set");
}

const handoff = JSON.parse(await readFile(handoffFile, "utf8"));
const { PrismaClient } = await import(pathToFileURL(resolve(prismaClientPath, "index.js")).href);
const prisma = new PrismaClient({ datasourceUrl: migrationDatabaseUrl });

const inviteePassword = `${randomBytes(18).toString("base64url")}Aa1`;

function uuid() {
  const b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// Mirrors src/components/invitations/invitation-browser.ts: unkeyed SHA-256 over a stable
// JSON projection, lowercase hex. The server only requires continuity with the reserve step.
function fingerprint(purpose, payload) {
  return createHash("sha256").update(`${purpose}:${JSON.stringify(payload)}`).digest("hex");
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function post(path, cookie, payload) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseUrl, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(payload)
  });
  const body = await response.json().catch(() => null);
  const setCookie = response.headers.get("set-cookie") ?? "";
  return { status: response.status, ok: body?.ok === true, data: body?.data, code: body?.error?.code, setCookie };
}

async function signIn(email, secret) {
  const response = await fetch(`${baseUrl}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseUrl },
    body: JSON.stringify({ email, password: secret, rememberMe: false })
  });
  if (!response.ok) return null;
  const setCookie = response.headers.get("set-cookie") ?? "";
  return setCookie.match(/(?:^|,\s*)((?:__Secure-)?better-auth\.session_token=[^;,]+)/)?.[1] ?? null;
}

const health = await fetch(`${baseUrl}/api/health`, { cache: "no-store" });
if (!health.ok) throw new Error(`simplified_signup_probe_health_invalid:${health.status}`);

// ---------------------------------------------------------------------------------------------
// Case 1: a brand-new invitee completes signup with NO recovery codes at any point.
// ---------------------------------------------------------------------------------------------
const probePartitionDigest = digest(`probe-partition:${handoff.inviteeEmail}`);
const claim = await post("/api/invitations/claim", "", { token: handoff.invitationToken, browserPartitionDigest: probePartitionDigest });
if (!claim.ok) throw new Error(`simplified_signup_probe_claim_failed:${claim.status}:${claim.code ?? ""}`);
const claimCookie = claim.setCookie.match(/(?:^|,\s*)(cubby_invitation_claim=[^;,]+)/)?.[1];
if (!claimCookie) throw new Error("simplified_signup_probe_claim_cookie_missing");

const credentialOperationId = uuid();
const credentialOpening = fingerprint("credential", { operationId: credentialOperationId, email: handoff.inviteeEmail });
const credentialIntent = fingerprint("credential-submit", { operationId: credentialOperationId, displayName: "Probe Invitee", email: handoff.inviteeEmail });
const credentialBase = {
  operationId: credentialOperationId,
  browserPartitionDigest: probePartitionDigest,
  recipientEmailDigest: digest(handoff.inviteeEmail),
  openingFingerprint: credentialOpening
};

const credentialReserve = await post("/api/invitations/credentials/reserve", claimCookie, credentialBase);
if (credentialReserve.data?.status !== "prepared") {
  throw new Error(`simplified_signup_probe_credential_reserve_failed:${credentialReserve.status}:${credentialReserve.code ?? ""}`);
}
const credentialSubmit = await post("/api/invitations/credentials/submit", claimCookie, {
  ...credentialBase, intentFingerprint: credentialIntent, displayName: "Probe Invitee", password: inviteePassword
});
if (credentialSubmit.data?.status !== "continue_with_sign_in") {
  throw new Error(`simplified_signup_probe_credential_submit_failed:${credentialSubmit.status}:${credentialSubmit.code ?? ""}`);
}

// The invitee has credentials but NO recovery codes. Assert that before continuing, so a later
// success cannot be explained by codes having been silently enrolled somewhere.
const invitee = await prisma.user.findFirst({ where: { email: handoff.inviteeEmail }, select: { id: true } });
if (!invitee) throw new Error("simplified_signup_probe_invitee_missing");
const codeCount = await prisma.recoveryCode.count({ where: { userId: invitee.id } });
const setCount = await prisma.recoveryCodeSet.count({ where: { userId: invitee.id } });
if (codeCount !== 0 || setCount !== 0) {
  throw new Error(`simplified_signup_probe_unexpected_recovery_material:${codeCount}:${setCount}`);
}

const sessionCookie = await signIn(handoff.inviteeEmail, inviteePassword);
if (!sessionCookie) throw new Error("simplified_signup_probe_sign_in_failed");
const boundCookie = `${sessionCookie}; ${claimCookie}`;

const bind = await post("/api/invitations/post-signin-bind", boundCookie, {});
if (bind.data?.status !== "review") {
  throw new Error(`simplified_signup_probe_post_signin_bind_failed:${bind.status}:${bind.code ?? ""}:${String(bind.data?.status ?? "")}`);
}

const reviewResponse = await fetch(`${baseUrl}/api/invitations/review`, {
  method: "GET", headers: { origin: baseUrl, cookie: boundCookie }, cache: "no-store"
});
const reviewBody = await reviewResponse.json().catch(() => null);
const review = reviewBody?.data;
if (!review?.reviewVersion || !review?.reviewSnapshotDigest) {
  throw new Error(`simplified_signup_probe_review_failed:${reviewResponse.status}`);
}

const acceptOperationId = uuid();
const acceptOpening = fingerprint("accept", {
  operationId: acceptOperationId, reviewVersion: review.reviewVersion, reviewSnapshotDigest: review.reviewSnapshotDigest
});
// Simplified signup: the intent fingerprint covers the operation id alone.
const acceptIntent = fingerprint("accept-submit", { operationId: acceptOperationId });
const acceptBase = {
  operationId: acceptOperationId,
  reviewVersion: review.reviewVersion,
  reviewSnapshotDigest: review.reviewSnapshotDigest,
  openingFingerprint: acceptOpening
};

const acceptReserve = await post("/api/invitations/accept/reserve", boundCookie, acceptBase);
if (acceptReserve.data?.status !== "prepared") {
  throw new Error(`simplified_signup_probe_accept_reserve_failed:${acceptReserve.status}:${acceptReserve.code ?? ""}`);
}

// The decisive call. Note the absence of typedHouseholdName and adminAcknowledgement: the old
// protocol rejected this payload outright, and rejected any invitee without nine active codes.
const acceptSubmit = await post("/api/invitations/accept/submit", boundCookie, { ...acceptBase, intentFingerprint: acceptIntent });
if (acceptSubmit.data?.status !== "accepted" && acceptSubmit.data?.status !== "completed") {
  throw new Error(`simplified_signup_probe_accept_submit_failed:${acceptSubmit.status}:${acceptSubmit.code ?? ""}:${String(acceptSubmit.data?.status ?? "")}`);
}

// Durable effects: membership granted, setup terminal, still no recovery material.
const membership = await prisma.householdMember.findFirst({
  where: { userId: invitee.id, householdId: handoff.householdId }, select: { role: true, deletedAt: true }
});
if (!membership || membership.deletedAt) throw new Error("simplified_signup_probe_membership_missing");
if (membership.role !== handoff.offeredRole) throw new Error(`simplified_signup_probe_role_mismatch:${membership.role}`);

const setup = await prisma.$queryRawUnsafe(
  `SELECT "setupState" FROM invitation_protocol."InvitationAccountSetup" WHERE "userId"=$1`, invitee.id
);
if (setup?.[0]?.setupState !== "accepted") {
  throw new Error(`simplified_signup_probe_setup_state_not_accepted:${String(setup?.[0]?.setupState ?? "")}`);
}

const codesAfter = await prisma.recoveryCode.count({ where: { userId: invitee.id } });
if (codesAfter !== 0) throw new Error(`simplified_signup_probe_codes_created:${codesAfter}`);

// ---------------------------------------------------------------------------------------------
// Case 2: DEC-PROD-428 -- no database object may REQUIRE recovery codes for any user.
// ---------------------------------------------------------------------------------------------
const requiring = await prisma.$queryRawUnsafe(
  `SELECT count(*)::int AS n FROM pg_constraint WHERE contype='c' AND pg_get_constraintdef(oid) ILIKE '%RecoveryCodeSet%'`
);
if ((requiring?.[0]?.n ?? 0) !== 0) {
  throw new Error(`simplified_signup_probe_recovery_required_by_constraint:${requiring[0].n}`);
}

// ---------------------------------------------------------------------------------------------
// Case 3: replay of the same acceptance is idempotent, not a second membership.
// ---------------------------------------------------------------------------------------------
const replay = await post("/api/invitations/accept/submit", boundCookie, { ...acceptBase, intentFingerprint: acceptIntent });
if (replay.data?.status !== "accepted" && replay.data?.status !== "completed") {
  throw new Error(`simplified_signup_probe_replay_not_idempotent:${replay.status}:${replay.code ?? ""}`);
}
const membershipCount = await prisma.householdMember.count({ where: { userId: invitee.id, householdId: handoff.householdId } });
if (membershipCount !== 1) throw new Error(`simplified_signup_probe_duplicate_membership:${membershipCount}`);

await prisma.$disconnect();
console.log("SIMPLIFIED_SIGNUP_PROBE_PASS");
