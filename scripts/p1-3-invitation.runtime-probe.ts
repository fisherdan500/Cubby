import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { hashPassword } from "better-auth/crypto";

import { crossLineageReinvitationPostconditionCodes, manualDiagnosticCodes, manualDiagnosticSqlCode, manualDiagnosticSteps, manualManagementPostconditionCodes, type ManualDiagnosticStep, type P13CrossLineageReinvitationAcceptance, validateCrossLineageReinvitationAcceptance, validateManualManagementAcceptance } from "./p1-3-invitation.runtime-probe-contract";
import { invitationFingerprint, prepareRecoveryVerifierBatch } from "../src/server/services/invitation-attestation";
import { classifyInvitationSetupCorridor } from "../src/server/services/invitation-setup-corridor";
import { getInvitationServices } from "../src/server/services/invitation-service";
import { handleInvitationRoute } from "../src/server/services/invitation-route-layer";

type Services = Awaited<ReturnType<typeof getInvitationServices>>;
type Fixture = { userId: string; sessionId: string; memberId: string; householdId: string };
type Request = { ordinarySessionId: string; subjectUserId: string; issuerMembershipEpisodeId: string; subjectMembershipEpisodeId: null; openingFingerprint: Buffer; intentFingerprint: Buffer | null };
type OperationState = { identityId: string; state: string; bindingCount: number; payloadCount: number; resultCount: number; auditCount: number } | null;

const digest = (value: number) => Buffer.alloc(32, value);
const randomDigest = () => randomBytes(32);
const operationId = () => randomUUID();
const fail = (code: string): never => { throw new Error(code); };

const runtimeProbeCodes = new Set([
  ...manualDiagnosticCodes,
  ...manualManagementPostconditionCodes,
  ...crossLineageReinvitationPostconditionCodes,
  "p1_3_invitation_acceptance_runtime_cross_lineage_bind_invalid",
  "p1_3_invitation_acceptance_runtime_probe_failed",
  "p1_3_invitation_acceptance_runtime_persistence_invalid",
  "p1_3_invitation_acceptance_runtime_manual_management_failed",
  "p1_3_invitation_acceptance_runtime_service_bootstrap_failed",
  "p1_3_invitation_acceptance_runtime_fixture_seed_failed",
  "p1_3_invitation_acceptance_runtime_manual_create_reserve_failed",
  "p1_3_invitation_acceptance_runtime_manual_create_submit_failed",
  "p1_3_invitation_acceptance_runtime_receipt_missing",
  "p1_3_invitation_acceptance_runtime_receipt_invalid",
  "p1_3_invitation_acceptance_runtime_receipt_not_safe",
  "p1_3_invitation_acceptance_fixture_database_unavailable",
  "p1_3_invitation_acceptance_created_invite_missing",
  "p1_3_invitation_acceptance_pending_invite_missing",
  "p1_3_invitation_acceptance_claim_invalid",
  "p1_3_invitation_acceptance_setup_corridor_not_neutral",
  "p1_3_invitation_acceptance_route_layer_invalid"
]);

export function runtimeProbeFailureCode(error: unknown) {
  return error instanceof Error && runtimeProbeCodes.has(error.message)
    ? error.message
    : "p1_3_invitation_acceptance_runtime_probe_failed";
}

export async function runManualManagementDiagnostic(runCheck: (checkpoint: (step: ManualDiagnosticStep) => void) => Promise<void>) {
  let step: ManualDiagnosticStep = "fixture";
  try {
    await runCheck((next) => {
      if (!manualDiagnosticSteps.includes(next)) throw new Error("invalid diagnostic checkpoint");
      step = next;
    });
  } catch (error) {
    if (error instanceof Error && runtimeProbeCodes.has(error.message)) throw error;
    const diagnostic = manualDiagnosticSqlCode(step, error);
    if (diagnostic) throw new Error(diagnostic);
    throw new Error(`p1_3_invitation_acceptance_check_${step}_failed`);
  }
}

const request = (fixture: Fixture, openingFingerprint: Buffer, intentFingerprint: Buffer | null = null): Request => ({
  ordinarySessionId: fixture.sessionId, subjectUserId: fixture.userId, issuerMembershipEpisodeId: fixture.memberId,
  subjectMembershipEpisodeId: null, openingFingerprint, intentFingerprint,
});

function record(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("p1_3_invitation_acceptance_runtime_receipt_missing");
  return value as Record<string, unknown>;
}

function tokenFromInitialReceipt(value: unknown): string {
  const token = record(value).inviteToken;
  if (typeof token !== "string" || token.length < 32) fail("p1_3_invitation_acceptance_runtime_receipt_invalid");
  return token as string;
}

function receiptIsSafe(value: unknown) {
  const status = record(value).status;
  if (status !== "unavailable" && status !== "unknown" && status !== "abandoned") fail("p1_3_invitation_acceptance_runtime_receipt_not_safe");
}

async function invoke(value: Promise<unknown>) {
  try { receiptIsSafe(await value); } catch (error) {
    if (!error || typeof error !== "object" || (error as { code?: unknown }).code !== "P2010") throw error;
  }
}

async function expectClosed(value: Promise<unknown>) {
  try { await value; } catch (error) {
    if (error && typeof error === "object" && (error as { code?: unknown }).code === "P2010") return true;
  }
  return false;
}

function fixtureDatabaseUrl() {
  const value = process.env.FIXTURE_DATABASE_URL;
  if (!value) fail("p1_3_invitation_acceptance_fixture_database_unavailable");
  return value;
}

async function seedFixture(database: PrismaClient): Promise<{ issuer: Fixture; credentialless: { userId: string; sessionId: string } }> {
  const suffix = randomBytes(18).toString("base64url");
  const now = new Date();
  const issuer = { userId: `p13_owner_${suffix}`, sessionId: `p13_session_${suffix}`, memberId: `p13_member_${suffix}`, householdId: `p13_household_${suffix}` };
  const credentialless = { userId: `p13_credentialless_${suffix}`, sessionId: `p13_credentialless_session_${suffix}` };
  let credential = randomBytes(32).toString("base64url");
  const password = await hashPassword(credential);
  credential = "";
  await database.$transaction(async (tx) => {
    await tx.user.create({ data: { id: issuer.userId, name: `Fixture owner ${suffix}`, email: `p13-owner-${suffix}@acceptance.invalid`, emailVerified: true, createdAt: now, updatedAt: now } });
    await tx.account.create({ data: { id: `p13_account_${suffix}`, accountId: `p13_credential_${suffix}`, providerId: "credential", userId: issuer.userId, password, createdAt: now, updatedAt: now } });
    await tx.accountSecurityState.create({ data: { userId: issuer.userId, credentialVersion: 1, sessionSecurityVersion: 1, securityUpdatedAt: now } });
    await tx.session.create({ data: { id: issuer.sessionId, token: randomBytes(32).toString("base64url"), userId: issuer.userId, expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000), createdAt: now, updatedAt: now } });
    await tx.household.create({ data: { id: issuer.householdId, name: `Fixture household ${suffix}`, createdByUserId: issuer.userId, createdAt: now, updatedAt: now } });
    await tx.householdMember.create({ data: { id: issuer.memberId, householdId: issuer.householdId, userId: issuer.userId, role: "owner", joinedAt: now, createdAt: now, updatedAt: now } });
    await tx.user.create({ data: { id: credentialless.userId, name: `Credentialless fixture ${suffix}`, email: `p13-credentialless-${suffix}@acceptance.invalid`, emailVerified: true, createdAt: now, updatedAt: now } });
    await tx.accountSecurityState.create({ data: { userId: credentialless.userId, credentialVersion: 1, sessionSecurityVersion: 1, securityUpdatedAt: now } });
    await tx.session.create({ data: { id: credentialless.sessionId, token: randomBytes(32).toString("base64url"), userId: credentialless.userId, expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000), createdAt: now, updatedAt: now } });
  });
  return { issuer, credentialless };
}

type RecipientFixture = { userId: string; sessionId: string; email: string };

const recipientRequest = (recipient: RecipientFixture, openingFingerprint: Buffer, intentFingerprint: Buffer | null = null) => ({
  ordinarySessionId: recipient.sessionId, subjectUserId: recipient.userId, issuerMembershipEpisodeId: null,
  subjectMembershipEpisodeId: null, openingFingerprint, intentFingerprint,
});

async function seedRecipientFixture(database: PrismaClient): Promise<RecipientFixture> {
  const suffix = randomBytes(18).toString("base64url");
  const now = new Date();
  const userId = `p13_recipient_${suffix}`;
  const sessionId = `p13_recipient_session_${suffix}`;
  const email = `p13-recipient-${suffix}@acceptance.invalid`;
  let credential = randomBytes(32).toString("base64url");
  const password = await hashPassword(credential);
  credential = "";
  await database.$transaction(async (tx) => {
    await tx.user.create({ data: { id: userId, name: `Fixture recipient ${suffix}`, email, emailVerified: true, createdAt: now, updatedAt: now } });
    await tx.account.create({ data: { id: `p13_recipient_account_${suffix}`, accountId: `p13_recipient_credential_${suffix}`, providerId: "credential", userId, password, createdAt: now, updatedAt: now } });
    await tx.accountSecurityState.create({ data: { userId, credentialVersion: 1, sessionSecurityVersion: 1, securityUpdatedAt: now } });
    await tx.session.create({ data: { id: sessionId, token: randomBytes(32).toString("base64url"), userId, expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000), createdAt: now, updatedAt: now } });
  });
  return { userId, sessionId, email };
}

async function claimWithOperationId(services: Services, token: string): Promise<{ identityId: string; claimOperationId: string }> {
  const receipt = record(await services.claim({ token, browserPartitionDigest: randomDigest() }));
  const identityId = receipt.claimIdentityId;
  const claimOperationId = receipt.operationId;
  if (typeof identityId !== "string" || typeof claimOperationId !== "string") fail("p1_3_invitation_acceptance_claim_invalid");
  return { identityId: identityId as string, claimOperationId: claimOperationId as string };
}

async function accountSetupOrigin(database: PrismaClient, userId: string) {
  const rows = await database.$queryRaw<Array<{ originLineageId: string | null; originLineageDigestHex: string | null }>>(Prisma.sql`
    SELECT "originLineageId", encode("originLineageDigest",'hex') AS "originLineageDigestHex" FROM invitation_protocol."InvitationAccountSetup" WHERE "userId"=${userId}
  `);
  return rows[0] ?? { originLineageId: null, originLineageDigestHex: null };
}

async function lineageForClaimIdentity(database: PrismaClient, identityId: string) {
  const rows = await database.$queryRaw<Array<{ lineageId: string }>>(Prisma.sql`
    SELECT "lineageId" FROM invitation_protocol."InvitationOperationIdentity" WHERE "id"=${identityId}::uuid
  `);
  return rows[0]?.lineageId ?? null;
}

/**
 * DEC-PROD-413: an account whose InvitationAccountSetup already belongs to a different invitation
 * lineage may bind to a new invitation only when the prior invitation is no longer active. This proves
 * both branches on real disposable PostgreSQL: takeover when the prior invite is revoked, and unchanged
 * fail-closed denial when a (different) prior invite is still pending and unexpired.
 */
async function runCrossLineageReinvitationAcceptance(services: Services, database: PrismaClient, checkpoint: (step: ManualDiagnosticStep) => void): Promise<P13CrossLineageReinvitationAcceptance> {
  checkpoint("cross_lineage_recipient_fixture");
  const recipient = await seedRecipientFixture(database);
  const { issuer } = await seedFixture(database);
  const role = "parent";

  async function inviteRecipient(label: string): Promise<{ inviteId: string; token: string }> {
    const id = operationId(); const opening = randomDigest();
    const intent = invitationFingerprint("manual_invite_create", { operationId: id, householdId: issuer.householdId, role, label });
    await services.manualCreate.reserve({ operationId: id, householdId: issuer.householdId, role, expiresInHours: 24, recipientEmail: recipient.email, request: request(issuer, opening) });
    const receipt = await services.manualCreate.submit({ operationId: id, householdId: issuer.householdId, request: request(issuer, opening, intent) });
    const token = tokenFromInitialReceipt(receipt);
    const invite = await inviteByTokenHash(database, createHash("sha256").update(token, "utf8").digest("hex"));
    if (!invite) fail("p1_3_invitation_acceptance_pending_invite_missing");
    return { inviteId: invite.id, token };
  }

  async function bindRecipient(claimIdentityId: string, claimOperationId: string) {
    const opening = randomDigest();
    return record(await services.bind({ sessionId: recipient.sessionId, claimIdentityId, request: { ...recipientRequest(recipient, opening), operationId: claimOperationId } }));
  }

  checkpoint("cross_lineage_first_invite_create");
  const first = await inviteRecipient("cross-lineage-first");
  checkpoint("cross_lineage_first_invite_claim");
  const firstClaim = await claimWithOperationId(services, first.token);
  checkpoint("cross_lineage_first_bind");
  const firstBindReceipt = await bindRecipient(firstClaim.identityId, firstClaim.claimOperationId);
  const firstBindSucceeded = firstBindReceipt.status === "review";
  checkpoint("cross_lineage_first_origin_read");
  const firstLineageId = await lineageForClaimIdentity(database, firstClaim.identityId);
  const firstOrigin = await accountSetupOrigin(database, recipient.userId);
  const firstOriginMatches = firstLineageId !== null && firstOrigin.originLineageId === firstLineageId;

  checkpoint("cross_lineage_first_revoke");
  const revokeId = operationId(); const revokeOpening = randomDigest();
  const revokeIntent = invitationFingerprint("invite_revoke", { operationId: revokeId, inviteId: first.inviteId });
  await services.revoke({ inviteId: first.inviteId, operationId: revokeId, request: request(issuer, revokeOpening, revokeIntent) });

  checkpoint("cross_lineage_second_invite_create");
  const second = await inviteRecipient("cross-lineage-second");
  checkpoint("cross_lineage_second_invite_claim");
  const secondClaim = await claimWithOperationId(services, second.token);
  checkpoint("cross_lineage_takeover_bind");
  const takeoverReceipt = await bindRecipient(secondClaim.identityId, secondClaim.claimOperationId);
  const takeoverSucceeded = takeoverReceipt.status === "review";
  checkpoint("cross_lineage_takeover_read");
  const secondLineageId = await lineageForClaimIdentity(database, secondClaim.identityId);
  const takeoverOrigin = await accountSetupOrigin(database, recipient.userId);
  const takeoverOriginMatches = secondLineageId !== null && takeoverOrigin.originLineageId === secondLineageId;
  const expectedDigest = secondLineageId ? createHash("sha256").update(secondLineageId, "utf8").digest("hex") : null;
  const takeoverDigestMatches = expectedDigest !== null && takeoverOrigin.originLineageDigestHex === expectedDigest;
  const priorInvite = await database.$queryRaw<Array<{ status: string }>>(Prisma.sql`SELECT "status"::text FROM public."Invite" WHERE "id"=${first.inviteId}`);
  const priorInviteRevoked = priorInvite[0]?.status === "revoked";

  // The second invite (now the recipient's current, still-pending lineage) is the "prior invitation" for
  // this third bind attempt: it must still deny, exactly as before this charter, because it is active.
  checkpoint("cross_lineage_active_invite_create");
  const third = await inviteRecipient("cross-lineage-active");
  checkpoint("cross_lineage_active_invite_claim");
  const thirdClaim = await claimWithOperationId(services, third.token);
  checkpoint("cross_lineage_active_bind_denied");
  const deniedReceipt = await bindRecipient(thirdClaim.identityId, thirdClaim.claimOperationId);
  const failedClosed = deniedReceipt.status === "unavailable";
  checkpoint("cross_lineage_active_origin_read");
  const afterDenialOrigin = await accountSetupOrigin(database, recipient.userId);
  const originLineageUnchanged = afterDenialOrigin.originLineageId === takeoverOrigin.originLineageId && afterDenialOrigin.originLineageDigestHex === takeoverOrigin.originLineageDigestHex;

  checkpoint("cross_lineage_postconditions");
  const result: P13CrossLineageReinvitationAcceptance = {
    firstBind: { succeeded: firstBindSucceeded, originLineageMatchesFirst: firstOriginMatches },
    takeover: { succeeded: takeoverSucceeded, originLineageMatchesSecond: takeoverOriginMatches, originLineageDigestMatchesSecond: takeoverDigestMatches, priorInviteRevoked },
    stillActiveDenial: { failedClosed, originLineageUnchanged },
  };
  validateCrossLineageReinvitationAcceptance(result);
  return result;
}

async function operationState(database: PrismaClient, operationIdValue: string): Promise<OperationState> {
  const rows = await database.$queryRaw<Array<{ identityId: string; state: string; bindingCount: bigint; payloadCount: bigint; resultCount: bigint; auditCount: bigint }>>(Prisma.sql`
    SELECT i."id" AS "identityId", i."state"::text AS "state",
      (SELECT count(*) FROM invitation_protocol."InvitationOperationBinding" b WHERE b."identityId"=i."id") AS "bindingCount",
      (SELECT count(*) FROM invitation_protocol."InvitationPreparedPayload" p WHERE p."identityId"=i."id") AS "payloadCount",
      (SELECT count(*) FROM invitation_protocol."InvitationOperationResult" r WHERE r."identityId"=i."id") AS "resultCount",
      (SELECT count(*) FROM public."AuditEvent" a WHERE a."entityId"=i."id"::text) AS "auditCount"
    FROM invitation_protocol."InvitationOperationIdentity" i WHERE i."operationId"=${operationIdValue}::uuid
  `);
  const row = rows[0];
  return row ? { identityId: row.identityId, state: row.state, bindingCount: Number(row.bindingCount), payloadCount: Number(row.payloadCount), resultCount: Number(row.resultCount), auditCount: Number(row.auditCount) } : null;
}

async function inviteByTokenHash(database: PrismaClient, tokenHash: string) {
  const rows = await database.$queryRaw<Array<{ id: string; status: string; tokenVersion: number }>>(Prisma.sql`SELECT "id", "status"::text, "tokenVersion" FROM public."Invite" WHERE "tokenHash"=${tokenHash}`);
  return rows[0] ?? null;
}

async function persistedText(database: PrismaClient, householdId: string) {
  const rows = await database.$queryRaw<Array<{ value: string | null }>>(Prisma.sql`
    SELECT string_agg(value::text, '') AS value FROM (
      SELECT to_jsonb(i) AS value FROM invitation_protocol."InvitationOperationIdentity" i WHERE i."householdId"=${householdId}
      UNION ALL SELECT to_jsonb(b) FROM invitation_protocol."InvitationOperationBinding" b WHERE b."householdId"=${householdId}
      UNION ALL SELECT to_jsonb(p) FROM invitation_protocol."InvitationPreparedPayload" p WHERE p."householdId"=${householdId}
      UNION ALL SELECT to_jsonb(r) FROM invitation_protocol."InvitationOperationResult" r WHERE r."householdId"=${householdId}
      UNION ALL SELECT to_jsonb(a) FROM invitation_protocol."InvitationRequestAttestation" a JOIN invitation_protocol."InvitationOperationIdentity" i ON i."id"=a."identityId" WHERE i."householdId"=${householdId}
      UNION ALL SELECT to_jsonb(v) FROM public."Invite" v WHERE v."householdId"=${householdId}
      UNION ALL SELECT to_jsonb(a) FROM public."AuditEvent" a WHERE a."householdId"=${householdId}
    ) rows
  `);
  return rows[0]?.value ?? "";
}

async function claim(services: Services, token: string): Promise<string> {
  const receipt = record(await services.claim({ token, browserPartitionDigest: randomDigest() }));
  const identityId = receipt.claimIdentityId;
  if (typeof identityId !== "string") fail("p1_3_invitation_acceptance_claim_invalid");
  return identityId as string;
}

async function claimWasClosed(database: PrismaClient, identityId: string) {
  const rows = await database.$queryRaw<Array<{ state: string; tombstones: bigint }>>(Prisma.sql`
    SELECT i."state"::text AS state, (SELECT count(*) FROM invitation_protocol."InvitationOperationTombstone" t WHERE t."identityId"=i."id") AS tombstones
    FROM invitation_protocol."InvitationOperationIdentity" i WHERE i."id"=${identityId}::uuid
  `);
  return rows[0]?.state === "PRESENTATION_CLOSED" && Number(rows[0]?.tombstones ?? 0) === 1;
}

async function householdDeletionIsAbsent(database: PrismaClient) {
  const rows = await database.$queryRaw<Array<{ absent: boolean }>>(Prisma.sql`
    SELECT NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='invitation_protocol' AND p.proname IN ('delete_household_with_invitation_containment_v2','issue_invitation_household_delete_authorization_v2'))
      AND NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='cubby_household_delete_runtime') AS absent
  `);
  return rows[0]?.absent === true;
}

async function runManualManagementAcceptance(services: Services, database: PrismaClient, checkpoint: (step: ManualDiagnosticStep) => void) {
  checkpoint("fixture");
  const fixture = await seedFixture(database);
  const { issuer, credentialless } = fixture;
  const role = "parent";
  const createId = operationId(); const createOpening = randomDigest();
  const createIntent = invitationFingerprint("manual_invite_create", { operationId: createId, householdId: issuer.householdId, role });
  checkpoint("create_reserve");
  await services.manualCreate.reserve({ operationId: createId, householdId: issuer.householdId, role, expiresInHours: 24, recipientEmail: `create-${randomBytes(12).toString("hex")}@acceptance.invalid`, request: request(issuer, createOpening) });
  checkpoint("create_prepared_read");
  const prepared = await operationState(database, createId);
  const preparedInviteCount = await database.invite.count({ where: { householdId: issuer.householdId } });
  checkpoint("create_submit");
  const createReceipt = await services.manualCreate.submit({ operationId: createId, householdId: issuer.householdId, request: request(issuer, createOpening, createIntent) });
  checkpoint("create_token");
  let createToken = tokenFromInitialReceipt(createReceipt);
  const createTokenHash = createHash("sha256").update(createToken, "utf8").digest("hex");
  checkpoint("create_invite_read");
  const createdInvite = await inviteByTokenHash(database, createTokenHash);
  const createSubmitted = await operationState(database, createId);
  const beforeReplayInvites = await database.invite.count({ where: { householdId: issuer.householdId } });
  const beforeReplayAudits = await database.auditEvent.count({ where: { householdId: issuer.householdId } });
  checkpoint("create_persistence");
  const persistedWithoutToken = !(await persistedText(database, issuer.householdId)).includes(createToken);
  createToken = "";
  checkpoint("create_status");
  const createStatus = record(await services.manualCreate.status({ operationId: createId, householdId: issuer.householdId, request: request(issuer, createOpening) }));
  checkpoint("create_replay");
  const replay = record(await services.manualCreate.submit({ operationId: createId, householdId: issuer.householdId, request: request(issuer, createOpening, createIntent) }));
  const exactReplay = await database.invite.count({ where: { householdId: issuer.householdId } });
  const exactReplayAudits = await database.auditEvent.count({ where: { householdId: issuer.householdId } });
  checkpoint("create_conflict");
  const changedIntentConflictedWithoutMutation = await expectClosed(services.manualCreate.submit({ operationId: createId, householdId: issuer.householdId, request: request(issuer, createOpening, randomDigest()) }))
    && exactReplay === await database.invite.count({ where: { householdId: issuer.householdId } })
    && exactReplayAudits === await database.auditEvent.count({ where: { householdId: issuer.householdId } });

  if (!createdInvite) fail("p1_3_invitation_acceptance_created_invite_missing");
  const replaceId = operationId(); const replaceOpening = randomDigest();
  const replaceIntent = invitationFingerprint("manual_invite_replace", { operationId: replaceId, inviteId: createdInvite.id });
  checkpoint("replace_reserve");
  await services.manualReplace.reserve({ operationId: replaceId, inviteId: createdInvite.id, expiresInHours: 24, request: request(issuer, replaceOpening) });
  checkpoint("replace_submit");
  const replaceReceipt = await services.manualReplace.submit({ operationId: replaceId, inviteId: createdInvite.id, request: request(issuer, replaceOpening, replaceIntent) });
  checkpoint("replace_token");
  let replaceToken = tokenFromInitialReceipt(replaceReceipt);
  checkpoint("replace_read");
  const replacement = await inviteByTokenHash(database, createHash("sha256").update(replaceToken, "utf8").digest("hex"));
  replaceToken = "";
  const predecessor = await database.$queryRaw<Array<{ status: string; tokenVersion: number }>>(Prisma.sql`SELECT "status"::text, "tokenVersion" FROM public."Invite" WHERE "id"=${createdInvite.id}`);
  const replaceSubmitted = await operationState(database, replaceId);
  checkpoint("replace_status");
  const replaceStatus = record(await services.manualReplace.status({ operationId: replaceId, inviteId: createdInvite.id, request: request(issuer, replaceOpening) }));
  const replaceInviteCount = await database.invite.count({ where: { householdId: issuer.householdId } });

  async function createPending(label: string, withClaim: boolean): Promise<{ id: string; invite: { id: string; status: string; tokenVersion: number }; claimId: string | null }> {
    checkpoint("pending_create");
    const id = operationId(); const opening = randomDigest(); const intent = invitationFingerprint("manual_invite_create", { operationId: id, label });
    await services.manualCreate.reserve({ operationId: id, householdId: issuer.householdId, role, expiresInHours: 24, recipientEmail: `${label}-${randomBytes(12).toString("hex")}@acceptance.invalid`, request: request(issuer, opening) });
    const receipt = await services.manualCreate.submit({ operationId: id, householdId: issuer.householdId, request: request(issuer, opening, intent) });
    let token = tokenFromInitialReceipt(receipt);
    const invite = await inviteByTokenHash(database, createHash("sha256").update(token, "utf8").digest("hex"));
    checkpoint("pending_claim");
    const claimId = withClaim ? await claim(services, token) : null;
    token = "";
    if (!invite) fail("p1_3_invitation_acceptance_pending_invite_missing");
    return { id, invite, claimId };
  }

  const single = await createPending("single", true);
  const revokeId = operationId(); const revokeOpening = randomDigest(); const revokeIntent = invitationFingerprint("invite_revoke", { operationId: revokeId, inviteId: single.invite.id });
  checkpoint("single_revoke");
  await services.revoke({ inviteId: single.invite.id, operationId: revokeId, request: request(issuer, revokeOpening, revokeIntent) });
  checkpoint("single_read");
  const singleInvite = await database.$queryRaw<Array<{ status: string }>>(Prisma.sql`SELECT "status"::text FROM public."Invite" WHERE "id"=${single.invite.id}`);
  const revokeState = await operationState(database, revokeId);

  checkpoint("bulk_create");
  const bulkOne = await createPending("bulk-one", true); const bulkTwo = await createPending("bulk-two", true);
  const pendingBeforeBulk = await database.invite.findMany({ where: { householdId: issuer.householdId, status: "pending" }, select: { id: true } });
  const bulkId = operationId(); const bulkOpening = randomDigest(); const bulkIntent = invitationFingerprint("invite_revoke_all", { operationId: bulkId, householdId: issuer.householdId });
  checkpoint("bulk_revoke");
  await services.revokeAll({ householdId: issuer.householdId, operationId: bulkId, acknowledgement: "I_REVOKE_ALL_PENDING_INVITATIONS", request: request(issuer, bulkOpening, bulkIntent) });
  checkpoint("bulk_read");
  const pendingAfterBulk = await database.invite.count({ where: { householdId: issuer.householdId, status: "pending" } });
  const bulkState = await operationState(database, bulkId);

  const authorityId = operationId(); const authorityOpening = randomDigest(); const authorityIntent = invitationFingerprint("manual_invite_create", { operationId: authorityId, authorityLoss: true });
  checkpoint("authority_reserve");
  await services.manualCreate.reserve({ operationId: authorityId, householdId: issuer.householdId, role, expiresInHours: 24, recipientEmail: `authority-${randomBytes(12).toString("hex")}@acceptance.invalid`, request: request(issuer, authorityOpening) });
  const beforeAuthorityInvites = await database.invite.count({ where: { householdId: issuer.householdId } });
  const beforeAuthorityAudits = await database.auditEvent.count({ where: { householdId: issuer.householdId } });
  checkpoint("authority_disable");
  await database.householdMember.update({ where: { id: issuer.memberId }, data: { disabledAt: new Date() } });
  checkpoint("authority_submit");
  const authorityFailedClosed = await expectClosed(services.manualCreate.submit({ operationId: authorityId, householdId: issuer.householdId, request: request(issuer, authorityOpening, authorityIntent) }));
  const authorityState = await operationState(database, authorityId);
  checkpoint("credentialless_classify");
  const credentiallessNeutral = await classifyInvitationSetupCorridor({ sessionId: credentialless.sessionId, userId: credentialless.userId, purpose: "ordinary_global" }) === "neutral";

  checkpoint("postconditions");
  validateManualManagementAcceptance({
    create: { preparedIdentity: prepared?.state === "PREPARED", preparedBinding: prepared?.bindingCount === 1, preparedPayload: prepared?.payloadCount === 1, inviteCount: preparedInviteCount, terminalResultCount: prepared?.resultCount ?? -1, auditCount: prepared?.auditCount ?? -1 },
    createSubmit: { pendingInviteCount: createdInvite.status === "pending" ? 1 : 0, terminalResultCount: createSubmitted?.resultCount ?? -1, auditCount: createSubmitted?.auditCount ?? -1, rawTokenOnlyInInitialResponse: !("inviteToken" in createStatus) && !("inviteToken" in replay), tokenHashLocatesInvite: true, statusDoesNotRediscloseToken: !("inviteToken" in createStatus) },
    createReplay: { duplicateInviteCount: exactReplay - beforeReplayInvites, unchangedAuditCount: beforeReplayAudits === exactReplayAudits, changedIntentConflictedWithoutMutation },
    replace: { predecessorRevoked: predecessor[0]?.status === "revoked", successorVersionIncremented: replacement?.tokenVersion === createdInvite.tokenVersion + 1 && replaceInviteCount === 2, successorTokenOnlyInInitialResponse: !("inviteToken" in replaceStatus), terminalResultCount: replaceSubmitted?.resultCount ?? -1, auditCount: replaceSubmitted?.auditCount ?? -1 },
    revoke: { exactTargetTerminalized: singleInvite[0]?.status === "revoked" && revokeState?.resultCount === 1, claimClosed: Boolean(single.claimId) && await claimWasClosed(database, single.claimId!), auditCount: revokeState?.auditCount ?? -1 },
    revokeAll: { exactPendingTargetsTerminalized: pendingBeforeBulk.length > 0 && pendingAfterBulk === 0 && (await database.invite.count({ where: { householdId: issuer.householdId, id: { in: pendingBeforeBulk.map((row) => row.id) }, status: "revoked" } })) === pendingBeforeBulk.length, claimsClosed: Boolean(bulkOne.claimId && bulkTwo.claimId) && await claimWasClosed(database, bulkOne.claimId!) && await claimWasClosed(database, bulkTwo.claimId!), auditCount: bulkState?.auditCount ?? -1 },
    authorityLoss: { failedClosed: authorityFailedClosed, noSuccessEffects: authorityState?.state === "PREPARED" && authorityState.resultCount === 0 && beforeAuthorityInvites === await database.invite.count({ where: { householdId: issuer.householdId } }) && beforeAuthorityAudits === await database.auditEvent.count({ where: { householdId: issuer.householdId } }) },
    privacy: { rawTokenAbsentFromPersistence: persistedWithoutToken, rawTokenAbsentFromAuditAndStatus: !("inviteToken" in createStatus) && !("inviteToken" in replay) && !("inviteToken" in replaceStatus), credentiallessExistingUserDenied: credentiallessNeutral },
    householdDeletion: { absentAndFailClosed: await householdDeletionIsAbsent(database) },
  });
}

async function run() {
  const fixture = new PrismaClient({ datasourceUrl: fixtureDatabaseUrl() });
  try {
    const services = await getInvitationServices().catch(() => fail("p1_3_invitation_acceptance_runtime_service_bootstrap_failed"));
    await runManualManagementDiagnostic((checkpoint) => runManualManagementAcceptance(services, fixture, checkpoint));
    await runManualManagementDiagnostic((checkpoint) => runCrossLineageReinvitationAcceptance(services, fixture, checkpoint).then(() => undefined));

    // Recipient and browser phases remain deliberately neutral-only and incomplete.
    const missingClaimIdentityId = operationId(); const missingInviteId = "p13-nonexistent-invite"; const missingHouseholdId = "p13-nonexistent-household";
    const neutralRequest = { ordinarySessionId: "p13-nonexistent-session", subjectUserId: "p13-nonexistent-user", issuerMembershipEpisodeId: "p13-nonexistent-member", subjectMembershipEpisodeId: null, openingFingerprint: digest(1), intentFingerprint: null };
    await invoke(services.claim({ token: randomBytes(32).toString("base64url"), browserPartitionDigest: digest(3) }));
    await invoke(services.close({ claimIdentityId: missingClaimIdentityId, reason: "explicit_close", request: { ...neutralRequest, operationId: missingClaimIdentityId } }));
    const manualCreateId = operationId();
    await invoke(services.manualCreate.reserve({ operationId: manualCreateId, householdId: missingHouseholdId, role: "parent", expiresInHours: 24, recipientEmail: "recipient@acceptance.invalid", request: neutralRequest }));
    await invoke(services.manualCreate.submit({ operationId: manualCreateId, householdId: missingHouseholdId, request: { ...neutralRequest, intentFingerprint: digest(2) } }));
    await invoke(services.manualCreate.status({ operationId: manualCreateId, householdId: missingHouseholdId, request: neutralRequest }));
    await invoke(services.manualCreate.abandon({ operationId: manualCreateId, householdId: missingHouseholdId, request: neutralRequest }));
    const manualReplaceId = operationId();
    await invoke(services.manualReplace.reserve({ operationId: manualReplaceId, inviteId: missingInviteId, expiresInHours: 24, request: neutralRequest }));
    await invoke(services.manualReplace.submit({ operationId: manualReplaceId, inviteId: missingInviteId, request: { ...neutralRequest, intentFingerprint: digest(2) } }));
    await invoke(services.manualReplace.status({ operationId: manualReplaceId, inviteId: missingInviteId, request: neutralRequest }));
    await invoke(services.manualReplace.abandon({ operationId: manualReplaceId, inviteId: missingInviteId, request: neutralRequest }));
    await invoke(services.bind({ sessionId: "p13-nonexistent-session", claimIdentityId: missingClaimIdentityId, request: { ...neutralRequest, operationId: missingClaimIdentityId } }));
    await invoke(services.review({ sessionId: "p13-nonexistent-session", claimIdentityId: missingClaimIdentityId, request: { ...neutralRequest, operationId: missingClaimIdentityId } }));
    const credentialId = operationId(); const credential = { operationId: credentialId, claimIdentityId: missingClaimIdentityId, browserPartitionDigest: digest(4), recipientEmailDigest: digest(5) };
    await invoke(services.credential.reserve({ ...credential, request: neutralRequest }));
    await invoke(services.credential.submit({ ...credential, displayName: "Acceptance recipient", password: randomBytes(24).toString("base64url"), hashPassword, request: { ...neutralRequest, intentFingerprint: digest(2) } }));
    await invoke(services.credential.status(credential)); await invoke(services.credential.abandon(credential));
    const enrollmentId = operationId(); let recoveryRandomByte = 0;
    const batch = await prepareRecoveryVerifierBatch({ random: () => Buffer.alloc(15, ++recoveryRandomByte), codeId: (ordinal) => `p13-code-${ordinal}` });
    await invoke(services.recoveryEnrollment.reserve({ operationId: enrollmentId, request: neutralRequest }));
    await invoke(services.recoveryEnrollment.submit({ operationId: enrollmentId, request: { ...neutralRequest, intentFingerprint: digest(2) }, prepareBatch: async () => batch }));
    await invoke(services.recoveryEnrollment.status({ operationId: enrollmentId, request: neutralRequest })); await invoke(services.recoveryEnrollment.abandon({ operationId: enrollmentId, request: neutralRequest }));
    const rehearsalId = operationId(); const rehearsalRequest = { ...neutralRequest, intentFingerprint: invitationFingerprint("recovery_rehearsal", { operationId: rehearsalId, selectedRecoveryCodeId: "p13-code-1" }) };
    await invoke(services.rehearsal.reserve({ operationId: rehearsalId, selectedRecoveryCodeId: "p13-code-1", acknowledgement: "I SAVED MY RECOVERY CODES", request: rehearsalRequest }));
    await invoke(services.rehearsal.submit({ operationId: rehearsalId, selectedRecoveryCodeId: "p13-code-1", nonce: digest(6), attestation: { keyVersion: 2, mac: digest(7) }, request: rehearsalRequest }));
    await invoke(services.rehearsal.status({ operationId: rehearsalId, request: rehearsalRequest })); await invoke(services.rehearsal.abandon({ operationId: rehearsalId, request: rehearsalRequest }));
    const acceptanceId = operationId();
    await invoke(services.acceptance.reserve({ operationId: acceptanceId, claimIdentityId: missingClaimIdentityId, reviewVersion: 1, reviewSnapshotDigest: "a".repeat(64), request: neutralRequest }));
    await invoke(services.acceptance.submit({ operationId: acceptanceId, reviewVersion: 1, reviewSnapshotDigest: "a".repeat(64), typedHouseholdName: "Acceptance household", adminAcknowledgement: null, request: { ...neutralRequest, intentFingerprint: digest(2) } }));
    await invoke(services.acceptance.status({ operationId: acceptanceId, request: neutralRequest })); await invoke(services.acceptance.abandon({ operationId: acceptanceId, request: neutralRequest }));
    await invoke(services.revoke({ inviteId: missingInviteId, operationId: operationId(), request: { ...neutralRequest, intentFingerprint: digest(2) } }));
    await invoke(services.revokeAll({ householdId: missingHouseholdId, operationId: operationId(), acknowledgement: "I_REVOKE_ALL_PENDING_INVITATIONS", request: { ...neutralRequest, intentFingerprint: digest(2) } }));
    await invoke(services.expire({ inviteId: missingInviteId })); await invoke(services.compact({ identityId: missingClaimIdentityId }));
    if (await classifyInvitationSetupCorridor({ sessionId: "p13-nonexistent-session", userId: "p13-nonexistent-user", purpose: "ordinary_global" }) !== "neutral") fail("p1_3_invitation_acceptance_setup_corridor_not_neutral");
    const response = await handleInvitationRoute(new Request("https://acceptance.invalid/api/invitations/claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: randomBytes(32).toString("base64url"), browserPartitionDigest: digest(8).toString("hex") }) }), "claim");
    const body = await response.json() as { ok?: unknown; data?: { status?: unknown } };
    if (response.headers.get("Cache-Control") !== "no-store" || body.ok !== true || body.data?.status !== "unavailable") fail("p1_3_invitation_acceptance_route_layer_invalid");
  } finally { await fixture.$disconnect(); }
}

if (process.env.VITEST !== "true") {
  run().then(async () => {
    const [{ invitationPrisma }, { invitationExpiryPrisma }, { invitationMaintenancePrisma }, { prisma }, { authPrisma }] = await Promise.all([
      import("../src/lib/db/invitation-prisma"), import("../src/lib/db/invitation-expiry-prisma"), import("../src/lib/db/invitation-maintenance-prisma"),
      import("../src/lib/db/prisma"), import("../src/lib/db/auth-prisma"),
    ]);
    await Promise.all([invitationPrisma.$disconnect(), invitationExpiryPrisma.$disconnect(), invitationMaintenancePrisma.$disconnect(), prisma.$disconnect(), authPrisma.$disconnect()]);
  }).catch((error) => {
    const code = runtimeProbeFailureCode(error);
    if (process.send) process.send(code);
    else process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
