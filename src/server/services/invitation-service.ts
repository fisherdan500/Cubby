import { createHash, randomBytes } from "node:crypto";
import { Prisma } from "@prisma/client";
import {
  createInvitationAttestationSigner,
  type InvitationOperationKind,
  type InvitationRecoveryVerifierRecord
} from "@/server/services/invitation-attestation";
import { verifyRecoveryCode } from "@/server/services/recovery-codes";

type QueryClient = { $queryRaw: (query: Prisma.Sql) => Promise<unknown> };
type Request = { ordinarySessionId: string | null; subjectUserId: string | null; issuerMembershipEpisodeId: string | null; subjectMembershipEpisodeId: string | null; openingFingerprint: Buffer; intentFingerprint: Buffer | null };
type Signer = ReturnType<typeof createInvitationAttestationSigner>;

const asRows = <T>(value: unknown) => Array.isArray(value) ? value as T[] : [];
const first = <T>(value: unknown) => {
  const row = asRows<T & { receipt?: T }>(value)[0] ?? null;
  return row && "receipt" in row ? row.receipt ?? null : row;
};

function requestCarrier(signer: Signer, input: Request & { operationId: string; operationKind: InvitationOperationKind; target?: string | null; purpose: string }, signed = signer.signRequest({ ...input, target: input.target ?? null })) {
  return Prisma.sql`ROW(${input.ordinarySessionId}, ${input.subjectUserId}, ${input.issuerMembershipEpisodeId}, ${input.subjectMembershipEpisodeId}, ${input.operationKind}::invitation_protocol."InvitationOperationKind", ${input.operationId}::uuid, ${input.target ?? null}, ${input.openingFingerprint}, ${input.intentFingerprint}, ${input.purpose}, ${signed.keyVersion}::integer, ${signed.nonce}, ${signed.issuedAt}, ${signed.mac})::invitation_protocol.invitation_request_attestation`;
}

function preaccountCarrier(signer: Signer, input: { operationId: string; claimIdentityId: string; browserPartitionDigest: Buffer; recipientEmailDigest: Buffer; openingFingerprint: Buffer; intentFingerprint: Buffer | null; passwordHashDigest: Buffer | null }) {
  const signed = signer.signPreaccountCredential(input);
  return Prisma.sql`ROW(${input.claimIdentityId}::uuid, ${input.browserPartitionDigest}, ${input.recipientEmailDigest}, 'CREDENTIAL_SETUP'::invitation_protocol."InvitationOperationKind", ${input.operationId}::uuid, ${input.openingFingerprint}, ${input.intentFingerprint}, ${input.passwordHashDigest}, ${signed.keyVersion}::integer, ${signed.nonce}, ${signed.issuedAt}, ${signed.mac})::invitation_protocol.invitation_preaccount_credential_attestation`;
}

function credentialStatusCarrier(signer: Signer, input: { operationId: string; claimIdentityId: string; browserPartitionDigest: Buffer; recipientEmailDigest: Buffer }) {
  const signed = signer.signCredentialStatus(input);
  return Prisma.sql`ROW(${input.claimIdentityId}::uuid, ${input.browserPartitionDigest}, ${input.recipientEmailDigest}, 'CREDENTIAL_SETUP'::invitation_protocol."InvitationOperationKind", ${input.operationId}::uuid, ${signed.keyVersion}::integer, ${signed.nonce}, ${signed.issuedAt}, ${signed.mac})::invitation_protocol.invitation_credential_status_attestation`;
}

/**
 * Rehearsal byte fields cross the JSONB receipt boundary as hex. The route needs exact Buffers to
 * verify the typed recovery code and to sign the rehearsal attestation; they never reach the browser.
 */
function decodeRehearsalReservation(receipt: Record<string, unknown>) {
  const decode = (value: unknown) => typeof value === "string" && value.length % 2 === 0 && /^[0-9a-f]*$/.test(value) ? Buffer.from(value, "hex") : value;
  return { ...receipt, nonce: decode(receipt.nonce), salt: decode(receipt.salt), derivedKey: decode(receipt.derivedKey) };
}

function recoveryBatch(records: InvitationRecoveryVerifierRecord[], digest: Buffer) {
  if (records.length !== 10 || digest.length !== 32 || new Set(records.map((record) => record.codeId)).size !== 10 || new Set(records.map((record) => record.ordinal)).size !== 10) throw new Error("invitation_recovery_verifier_batch_invalid");
  const rows = records.map((record) => Prisma.sql`ROW(${record.codeId}, ${record.ordinal}::integer, ${record.salt}, ${record.derivedKey}, ${record.kdfVersion}::integer)::invitation_protocol.recovery_verifier_record`);
  return Prisma.sql`ROW(ARRAY[${Prisma.join(rows)}]::invitation_protocol.recovery_verifier_record[], ${digest})::invitation_protocol.recovery_verifier_batch`;
}

export function createInvitationServices(dependencies: {
  runtime: QueryClient;
  expiry: QueryClient;
  maintenance: QueryClient;
  signer?: Signer;
  random?: () => Buffer;
  now?: () => Date;
  verifyRecoveryCode?: (code: string, record: { salt: Buffer; derivedKey: Buffer; kdfVersion: 1 }) => Promise<boolean>;
}) {
  const runtime = dependencies.runtime;
  const expiry = dependencies.expiry;
  const maintenance = dependencies.maintenance;
  const signer = dependencies.signer ?? createInvitationAttestationSigner();
  const random = dependencies.random ?? (() => randomBytes(32));
  const now = dependencies.now ?? (() => new Date());
  const verifyCode = dependencies.verifyRecoveryCode ?? verifyRecoveryCode;

  return {
    async claim(input: { token: string; browserPartitionDigest: Buffer }) {
      const tokenHashDigest = createHash("sha256").update(input.token, "utf8").digest();
      const carrier = signer.signPublicClaim({ tokenHashDigest });
      return first(await runtime.$queryRaw(Prisma.sql`SELECT invitation_protocol.claim_invitation_presentation_v2(${input.token}, ${input.browserPartitionDigest}, ROW(${tokenHashDigest}, ${carrier.keyVersion}::integer, ${carrier.issuedAt}, ${carrier.nonce}, ${carrier.mac})::invitation_protocol.invitation_public_token_claim) AS receipt`));
    },
    async close(input: { claimIdentityId: string; reason: "explicit_close" | "expiry" | "revoke" | "consume"; request: Request & { operationId: string } }) {
      return first(await runtime.$queryRaw(Prisma.sql`SELECT invitation_protocol.close_invitation_presentation_v2(${input.claimIdentityId}::uuid, ${input.reason}::invitation_protocol.presentation_close_reason, ${requestCarrier(signer, { ...input.request, operationKind: "PRESENTATION_CLAIM", purpose: "presentation_close" })}) AS receipt`));
    },
    manualCreate: {
      async reserve(input: { operationId: string; householdId: string; role: string; expiresInHours: number; recipientEmail: string; request: Request }) {
        return first(await runtime.$queryRaw(Prisma.sql`SELECT invitation_protocol.reserve_manual_invite_create_v2(${input.operationId}::uuid, ${input.householdId}::text, ${input.role}::public."HouseholdRole", ${input.expiresInHours}::integer, ${input.recipientEmail}::text, ${input.request.openingFingerprint}::bytea, ${requestCarrier(signer, { ...input.request, operationId: input.operationId, operationKind: "MANUAL_INVITE_CREATE", target: input.householdId, purpose: "manual_invite_create" })}) AS receipt`));
      },
      async submit(input: { operationId: string; householdId: string; request: Request }) { return first(await runtime.$queryRaw(Prisma.sql`SELECT invitation_protocol.submit_manual_invite_create_v2(${input.operationId}::uuid, ${input.request.intentFingerprint}, ${requestCarrier(signer, { ...input.request, operationId: input.operationId, operationKind: "MANUAL_INVITE_CREATE", target: input.householdId, purpose: "manual_invite_create" })}) AS receipt`)); },
      async status(input: { operationId: string; householdId: string; request: Request }) { return first(await runtime.$queryRaw(Prisma.sql`SELECT invitation_protocol.status_manual_invite_create_v2(${input.operationId}::uuid, ${requestCarrier(signer, { ...input.request, operationId: input.operationId, operationKind: "MANUAL_INVITE_CREATE", target: input.householdId, purpose: "manual_invite_status" })}) AS receipt`)); },
      async abandon(input: { operationId: string; householdId: string; request: Request }) { return first(await runtime.$queryRaw(Prisma.sql`SELECT invitation_protocol.abandon_manual_invite_create_v2(${input.operationId}::uuid, ${requestCarrier(signer, { ...input.request, operationId: input.operationId, operationKind: "MANUAL_INVITE_CREATE", target: input.householdId, purpose: "manual_invite_create_abandon" })}) AS receipt`)); }
    },
    manualReplace: {
      async reserve(input: { operationId: string; inviteId?: string; expiresInHours: number; request: Request }) { return first(await runtime.$queryRaw(Prisma.sql`SELECT invitation_protocol.reserve_manual_invite_replace_v2(${input.operationId}::uuid, ${input.expiresInHours}::integer, ${input.request.openingFingerprint}, ${requestCarrier(signer, { ...input.request, operationId: input.operationId, operationKind: "MANUAL_INVITE_REPLACE", target: input.inviteId ?? null, purpose: "manual_invite_replace" })}) AS receipt`)); },
      async submit(input: { operationId: string; inviteId: string; request: Request }) { return first(await runtime.$queryRaw(Prisma.sql`SELECT invitation_protocol.submit_manual_invite_replace_v2(${input.operationId}::uuid, ${input.request.intentFingerprint}, ${requestCarrier(signer, { ...input.request, operationId: input.operationId, operationKind: "MANUAL_INVITE_REPLACE", target: input.inviteId, purpose: "manual_invite_replace" })}) AS receipt`)); },
      async status(input: { operationId: string; inviteId: string; request: Request }) { return first(await runtime.$queryRaw(Prisma.sql`SELECT invitation_protocol.status_manual_invite_replace_v2(${input.operationId}::uuid, ${requestCarrier(signer, { ...input.request, operationId: input.operationId, operationKind: "MANUAL_INVITE_REPLACE", target: input.inviteId, purpose: "manual_invite_replace_status" })}) AS receipt`)); },
      async abandon(input: { operationId: string; inviteId: string; request: Request }) { return first(await runtime.$queryRaw(Prisma.sql`SELECT invitation_protocol.abandon_manual_invite_replace_v2(${input.operationId}::uuid, ${requestCarrier(signer, { ...input.request, operationId: input.operationId, operationKind: "MANUAL_INVITE_REPLACE", target: input.inviteId, purpose: "manual_invite_replace_abandon" })}) AS receipt`)); }
    },
    async bind(input: { sessionId: string; claimIdentityId: string; request: Request & { operationId: string } }) { return first(await runtime.$queryRaw(Prisma.sql`SELECT invitation_protocol.bind_post_signin_invitation_claim_v2(${input.sessionId}, ${input.claimIdentityId}::uuid, ${requestCarrier(signer, { ...input.request, operationKind: "PRESENTATION_CLAIM", purpose: "presentation_bind" })}) AS receipt`)); },
    async review(input: { sessionId: string; claimIdentityId: string; request: Request & { operationId: string } }) { return first(await runtime.$queryRaw(Prisma.sql`SELECT invitation_protocol.issue_invitation_review_v2(${input.claimIdentityId}::uuid, ${input.sessionId}, ${requestCarrier(signer, { ...input.request, operationKind: "PRESENTATION_CLAIM", purpose: "invitation_review" })}) AS receipt`)); },
    credential: {
      async reserve(input: { operationId: string; claimIdentityId: string; browserPartitionDigest: Buffer; recipientEmailDigest: Buffer; request: Request }) { return first(await runtime.$queryRaw(Prisma.sql`SELECT invitation_protocol.reserve_invitation_credential_setup_v2(${input.operationId}::uuid, ${input.claimIdentityId}::uuid, ${input.request.openingFingerprint}, ${preaccountCarrier(signer, { ...input, openingFingerprint: input.request.openingFingerprint, intentFingerprint: null, passwordHashDigest: null })}) AS receipt`)); },
      async submit(input: { operationId: string; claimIdentityId: string; browserPartitionDigest: Buffer; recipientEmailDigest: Buffer; request: Request; displayName: string; password: string; hashPassword: (password: string) => Promise<string> }) {
        const passwordHash = await input.hashPassword(input.password);
        const passwordHashDigest = createHash("sha256").update(passwordHash, "utf8").digest();
        return first(await runtime.$queryRaw(Prisma.sql`SELECT invitation_protocol.submit_invitation_credential_setup_v2(${input.operationId}::uuid, ${input.request.intentFingerprint}, ${input.displayName}, ${passwordHash}, ${passwordHashDigest}, ${preaccountCarrier(signer, { ...input, openingFingerprint: input.request.openingFingerprint, intentFingerprint: input.request.intentFingerprint, passwordHashDigest })}) AS receipt`));
      },
      async status(input: { operationId: string; claimIdentityId: string; browserPartitionDigest: Buffer; recipientEmailDigest: Buffer }) { return first(await runtime.$queryRaw(Prisma.sql`SELECT invitation_protocol.status_invitation_credential_setup_v2(${input.operationId}::uuid, ${credentialStatusCarrier(signer, input)}) AS receipt`)); },
      async abandon(input: { operationId: string; claimIdentityId: string; browserPartitionDigest: Buffer; recipientEmailDigest: Buffer }) { return first(await runtime.$queryRaw(Prisma.sql`SELECT invitation_protocol.abandon_invitation_credential_setup_v2(${input.operationId}::uuid, ${credentialStatusCarrier(signer, input)}) AS receipt`)); }
    },
    recoveryEnrollment: {
      async reserve(input: { operationId: string; request: Request }) { return first(await runtime.$queryRaw(Prisma.sql`SELECT invitation_protocol.reserve_invitation_recovery_enrollment_v2(${input.operationId}::uuid, ${input.request.openingFingerprint}, ${requestCarrier(signer, { ...input.request, operationId: input.operationId, operationKind: "RECOVERY_ENROLLMENT", purpose: "recovery_enrollment_reserve" })}) AS receipt`)); },
      /** Resolves the server-held canonical mapping; no canonical state may be created before it. */
      async authorizeFreshAuth(input: { operationId: string; request: Request }) { return first(await runtime.$queryRaw(Prisma.sql`SELECT invitation_protocol.authorize_invitation_recovery_enrollment_fresh_auth_v2(${input.operationId}::uuid, ${requestCarrier(signer, { ...input.request, operationId: input.operationId, operationKind: "RECOVERY_ENROLLMENT", purpose: "recovery_enrollment_authorize" })}) AS receipt`)); },
      async bindFreshAuth(input: { operationId: string; request: Request }) { return first(await runtime.$queryRaw(Prisma.sql`SELECT invitation_protocol.bind_invitation_recovery_enrollment_fresh_auth_v2(${input.operationId}::uuid, ${input.request.intentFingerprint}, ${requestCarrier(signer, { ...input.request, operationId: input.operationId, operationKind: "RECOVERY_ENROLLMENT", purpose: "recovery_enrollment_fresh_auth" })}) AS receipt`)); },
      /**
       * A lost response is reconciled through authenticated status only: a terminal issuance never
       * mints a second verifier batch for the same operation and never rediscloses the first one.
       */
      async submit(input: { operationId: string; request: Request; prepareBatch: () => Promise<{ records: InvitationRecoveryVerifierRecord[]; digest: Buffer }> }) {
        const context = first<Record<string, unknown>>(await runtime.$queryRaw(Prisma.sql`SELECT invitation_protocol.status_invitation_recovery_enrollment_v2(${input.operationId}::uuid, ${requestCarrier(signer, { ...input.request, operationId: input.operationId, operationKind: "RECOVERY_ENROLLMENT", purpose: "recovery_enrollment_status" })}) AS receipt`));
        // The protocol denies neutrally: an unusable authenticated status yields the safe unavailable
        // receipt rather than an exception, so no batch is minted and nothing is disclosed.
        if (!context || !["prepared", "generated"].includes(String(context.status)) || [context.credentialVersion, context.sessionSecurityVersion, context.recoverySetVersion].some((value) => typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 0x7fffffff)) return { operationId: input.operationId, status: "unavailable" };
        if (context.status === "generated") return { operationId: input.operationId, status: "generated", outcomeCode: context.outcomeCode ?? null, recoverySetVersion: context.recoverySetVersion };
        const batch = await input.prepareBatch();
        const carrierInput = { ...input.request, issuerMembershipEpisodeId: null, subjectMembershipEpisodeId: null, operationId: input.operationId, operationKind: "RECOVERY_ENROLLMENT" as const, target: null, purpose: "recovery_enrollment_submit" };
        const signed = signer.signRecoveryIssuance({ ...carrierInput, credentialVersion: context.credentialVersion as number, sessionSecurityVersion: context.sessionSecurityVersion as number, recoverySetVersion: context.recoverySetVersion as number, verifierBatchDigest: batch.digest });
        return first(await runtime.$queryRaw(Prisma.sql`SELECT invitation_protocol.submit_invitation_recovery_enrollment_v2(${input.operationId}::uuid, ${input.request.intentFingerprint}, ${recoveryBatch(batch.records, batch.digest)}, ${batch.digest}, ${requestCarrier(signer, { ...carrierInput, target: signed.target }, signed)}) AS receipt`));
      },
      async status(input: { operationId: string; request: Request }) { return first(await runtime.$queryRaw(Prisma.sql`SELECT invitation_protocol.status_invitation_recovery_enrollment_v2(${input.operationId}::uuid, ${requestCarrier(signer, { ...input.request, operationId: input.operationId, operationKind: "RECOVERY_ENROLLMENT", purpose: "recovery_enrollment_status" })}) AS receipt`)); },
      async abandon(input: { operationId: string; request: Request }) { return first(await runtime.$queryRaw(Prisma.sql`SELECT invitation_protocol.abandon_invitation_recovery_enrollment_v2(${input.operationId}::uuid, ${requestCarrier(signer, { ...input.request, operationId: input.operationId, operationKind: "RECOVERY_ENROLLMENT", purpose: "recovery_enrollment_abandon" })}) AS receipt`)); }
    },
    rehearsal: {
      async reserve(input: { operationId: string; selectedRecoveryCodeId: string; acknowledgement: string; request: Request }) {
        const receipt = first<Record<string, unknown>>(await runtime.$queryRaw(Prisma.sql`SELECT invitation_protocol.reserve_invitation_recovery_rehearsal_v2(${input.operationId}::uuid, ${input.selectedRecoveryCodeId}, ${input.acknowledgement}, ${input.request.openingFingerprint}, ${requestCarrier(signer, { ...input.request, operationId: input.operationId, operationKind: "RECOVERY_REHEARSAL", purpose: "recovery_rehearsal_reserve" })}) AS receipt`));
        return receipt && typeof receipt === "object" ? decodeRehearsalReservation(receipt) : receipt;
      },
      async attestReservation(input: { operationId: string; selectedRecoveryCodeId: string; recoveryCode: string; request: Request; reservation: { operationIdentityId: string; credentialVersion: number; sessionSecurityVersion: number; recoverySetVersion: number; nonce: Buffer; salt: Buffer; derivedKey: Buffer; kdfVersion: 1 } }) {
        if (!input.request.subjectUserId || !input.request.ordinarySessionId || !input.request.intentFingerprint || input.reservation.nonce.length !== 32) throw new Error("invitation_recovery_unavailable");
        const valid = await verifyCode(input.recoveryCode, { salt: input.reservation.salt, derivedKey: input.reservation.derivedKey, kdfVersion: input.reservation.kdfVersion }).catch(() => false);
        if (!valid) throw new Error("recovery_code_invalid");
        return signer.signRecoveryRehearsal({ subjectUserId: input.request.subjectUserId, ordinarySessionId: input.request.ordinarySessionId, operationIdentityId: input.reservation.operationIdentityId, operationId: input.operationId, credentialVersion: input.reservation.credentialVersion, sessionSecurityVersion: input.reservation.sessionSecurityVersion, recoverySetVersion: input.reservation.recoverySetVersion, selectedRecoveryCodeId: input.selectedRecoveryCodeId, nonce: input.reservation.nonce, openingFingerprint: input.request.openingFingerprint, intentFingerprint: input.request.intentFingerprint });
      },
      async submit(input: { operationId: string; selectedRecoveryCodeId: string; nonce: Buffer; attestation: { keyVersion: number; mac: Buffer }; request: Request }) {
        return first(await runtime.$queryRaw(Prisma.sql`SELECT invitation_protocol.submit_invitation_recovery_rehearsal_v2(${input.operationId}::uuid, ${input.request.intentFingerprint}, ${input.selectedRecoveryCodeId}, ${input.nonce}, ${input.attestation.keyVersion}::integer, ${input.attestation.mac}, ${requestCarrier(signer, { ...input.request, operationId: input.operationId, operationKind: "RECOVERY_REHEARSAL", purpose: "recovery_rehearsal_submit" })}) AS receipt`));
      },
      async status(input: { operationId: string; request: Request }) { return first(await runtime.$queryRaw(Prisma.sql`SELECT invitation_protocol.status_invitation_recovery_rehearsal_v2(${input.operationId}::uuid, ${requestCarrier(signer, { ...input.request, operationId: input.operationId, operationKind: "RECOVERY_REHEARSAL", purpose: "recovery_rehearsal_status" })}) AS receipt`)); },
      async abandon(input: { operationId: string; request: Request }) { return first(await runtime.$queryRaw(Prisma.sql`SELECT invitation_protocol.abandon_invitation_recovery_rehearsal_v2(${input.operationId}::uuid, ${requestCarrier(signer, { ...input.request, operationId: input.operationId, operationKind: "RECOVERY_REHEARSAL", purpose: "recovery_rehearsal_abandon" })}) AS receipt`)); }
    },
    acceptance: {
      async reserve(input: { operationId: string; claimIdentityId: string; reviewVersion: number; reviewSnapshotDigest: string; request: Request }) { return first(await runtime.$queryRaw(Prisma.sql`SELECT invitation_protocol.reserve_invitation_acceptance_v2(${input.operationId}::uuid, ${input.claimIdentityId}::uuid, ${input.reviewVersion}::integer, ${input.reviewSnapshotDigest}, ${input.request.openingFingerprint}, ${requestCarrier(signer, { ...input.request, operationId: input.operationId, operationKind: "MEMBERSHIP_ACCEPTANCE", purpose: "membership_acceptance_reserve" })}) AS receipt`)); },
      async submit(input: { operationId: string; reviewVersion: number; reviewSnapshotDigest: string; typedHouseholdName: string; adminAcknowledgement: string | null; request: Request }) { return first(await runtime.$queryRaw(Prisma.sql`SELECT invitation_protocol.submit_invitation_acceptance_v2(${input.operationId}::uuid, ${input.reviewVersion}::integer, ${input.reviewSnapshotDigest}, ${input.request.intentFingerprint}, ${input.typedHouseholdName}, ${input.adminAcknowledgement}, ${requestCarrier(signer, { ...input.request, operationId: input.operationId, operationKind: "MEMBERSHIP_ACCEPTANCE", purpose: "membership_acceptance_submit" })}) AS receipt`)); },
      async status(input: { operationId: string; request: Request }) { return first(await runtime.$queryRaw(Prisma.sql`SELECT invitation_protocol.status_invitation_acceptance_v2(${input.operationId}::uuid, ${requestCarrier(signer, { ...input.request, operationId: input.operationId, operationKind: "MEMBERSHIP_ACCEPTANCE", purpose: "membership_acceptance_status" })}) AS receipt`)); },
      async abandon(input: { operationId: string; request: Request }) { return first(await runtime.$queryRaw(Prisma.sql`SELECT invitation_protocol.abandon_invitation_acceptance_v2(${input.operationId}::uuid, ${requestCarrier(signer, { ...input.request, operationId: input.operationId, operationKind: "MEMBERSHIP_ACCEPTANCE", purpose: "membership_acceptance_abandon" })}) AS receipt`)); }
    },
    async revoke(input: { inviteId: string; operationId: string; request: Request }) { return first(await runtime.$queryRaw(Prisma.sql`SELECT invitation_protocol.revoke_invitation_v2(${input.inviteId}, ${input.operationId}::uuid, ${input.request.intentFingerprint}, ${requestCarrier(signer, { ...input.request, operationId: input.operationId, operationKind: "INVITE_REVOKE", target: input.inviteId, purpose: "invite_revoke" })}) AS receipt`)); },
    async revokeAll(input: { householdId: string; operationId: string; acknowledgement: string; request: Request }) { return first(await runtime.$queryRaw(Prisma.sql`SELECT invitation_protocol.revoke_all_invitations_v2(${input.householdId}, ${input.operationId}::uuid, ${input.acknowledgement}, ${input.request.intentFingerprint}, ${requestCarrier(signer, { ...input.request, operationId: input.operationId, operationKind: "INVITE_REVOKE_ALL", target: input.householdId, purpose: "invite_revoke_all" })}) AS receipt`)); },
    async expire(input: { inviteId: string }) { const workerNonce = Buffer.from(random()); return expiry.$queryRaw(Prisma.sql`SELECT invitation_protocol.expire_invitation_v2(${input.inviteId}, ${now()}, ROW(${workerNonce}, ${now()}, ${input.inviteId})::invitation_protocol.invitation_expiry_worker_carrier)`); },
    async compact(input: { identityId: string }) { const workerNonce = Buffer.from(random()); return maintenance.$queryRaw(Prisma.sql`SELECT invitation_protocol.compact_invitation_operation_v2(${input.identityId}::uuid, ROW(${workerNonce}, ${now()}, ${input.identityId}::uuid)::invitation_protocol.invitation_maintenance_worker_carrier)`); }
  };
}

/** A delayed response may update only the operation that opened it. */
export function invitationResponseForOperation<T extends { operationId?: unknown }>(operationId: string, receipt: T | null) {
  return receipt?.operationId === operationId ? receipt : null;
}

/** Loads the isolated clients only in server code that actually starts an invitation operation. */
export async function getInvitationServices() {
  const [{ invitationPrisma }, { invitationExpiryPrisma }, { invitationMaintenancePrisma }] = await Promise.all([
    import("@/lib/db/invitation-prisma"), import("@/lib/db/invitation-expiry-prisma"),
    import("@/lib/db/invitation-maintenance-prisma")
  ]);
  return createInvitationServices({ runtime: invitationPrisma, expiry: invitationExpiryPrisma, maintenance: invitationMaintenancePrisma });
}
