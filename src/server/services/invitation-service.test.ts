import { describe, expect, it, vi } from "vitest";
import { createInvitationServices, invitationResponseForOperation } from "@/server/services/invitation-service";

const request = {
  ordinarySessionId: "session-1", subjectUserId: "user-1", issuerMembershipEpisodeId: "member-1", subjectMembershipEpisodeId: null,
  openingFingerprint: Buffer.alloc(32, 1), intentFingerprint: Buffer.alloc(32, 2)
};
const verifierRecords = Array.from({ length: 10 }, (_, index) => ({ codeId: `code-${index + 1}`, ordinal: index + 1, salt: Buffer.alloc(16, index + 1), derivedKey: Buffer.alloc(32, index + 1), kdfVersion: 1 as const }));

describe("invitation services", () => {
  it("obtains authorized issuance versions before signing the exact batch", async () => {
    const runtime = { $queryRaw: vi.fn().mockResolvedValueOnce([{ receipt: { status: "prepared", credentialVersion: 3, sessionSecurityVersion: 4, recoverySetVersion: 5 } }]).mockResolvedValueOnce([{ receipt: { status: "generated" } }]) };
    const carrier = { keyVersion: 1, nonce: Buffer.alloc(32), issuedAt: new Date(), mac: Buffer.alloc(32) };
    const signRecoveryIssuance = vi.fn((_input: Record<string, unknown>) => ({ ...carrier, target: "synthetic-issuance-target" }));
    const signer = { signRequest: vi.fn(() => carrier), signRecoveryIssuance };
    const services = createInvitationServices({ runtime, expiry: runtime, maintenance: runtime, signer: signer as never });
    await services.recoveryEnrollment.submit({ operationId: "11111111-1111-4111-8111-111111111111", request, prepareBatch: async () => ({ records: verifierRecords, digest: Buffer.alloc(32, 8) }) });
    const input = signRecoveryIssuance.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    expect(input?.credentialVersion === 3 && input?.sessionSecurityVersion === 4 && input?.recoverySetVersion === 5).toBe(true);
    expect(Buffer.isBuffer(input?.verifierBatchDigest) && input.verifierBatchDigest.equals(Buffer.alloc(32, 8))).toBe(true);
    expect(runtime.$queryRaw.mock.calls.length).toBe(2);
  });

  it("calls each guarded runtime procedure through the invitation client with its typed carrier", async () => {
    const runtime = { $queryRaw: vi.fn().mockResolvedValue([{ status: "prepared", credentialVersion: 1, sessionSecurityVersion: 1, recoverySetVersion: 1 }]) };
    const expiry = { $queryRaw: vi.fn().mockResolvedValue([]) };
    const maintenance = { $queryRaw: vi.fn().mockResolvedValue([]) };
    const signedRequests: Array<{ operationKind: string; purpose: string }> = [];
    const services = createInvitationServices({ runtime, expiry, maintenance, signer: {
      signRequest: vi.fn((input: { operationKind: string; purpose: string }) => {
        signedRequests.push(input);
        return { keyVersion: 1, nonce: Buffer.alloc(32), issuedAt: new Date(), mac: Buffer.alloc(32) };
      }),
      signRecoveryIssuance: vi.fn(() => ({ keyVersion: 1, nonce: Buffer.alloc(32), issuedAt: new Date(), mac: Buffer.alloc(32) })),
      signPreaccountCredential: vi.fn(() => ({ keyVersion: 1, nonce: Buffer.alloc(32), issuedAt: new Date(), mac: Buffer.alloc(32) })),
      signCredentialStatus: vi.fn(() => ({ keyVersion: 1, nonce: Buffer.alloc(32), issuedAt: new Date(), mac: Buffer.alloc(32) })),
      signRecoveryRehearsal: vi.fn(() => ({ keyVersion: 1, nonce: Buffer.alloc(32), mac: Buffer.alloc(32) })),
      signPublicClaim: vi.fn(() => ({ nonce: Buffer.alloc(32), issuedAt: new Date(), mac: Buffer.alloc(32) }))
    } as never });
    const operationId = "11111111-1111-4111-8111-111111111111";
    const claimId = "22222222-2222-4222-8222-222222222222";

    await services.claim({ token: "raw-token", browserPartitionDigest: Buffer.alloc(32) });
    await services.close({ claimIdentityId: claimId, reason: "explicit_close", request: { ...request, operationId: claimId } });
    await services.manualCreate.reserve({ operationId, householdId: "household-1", role: "parent", expiresInHours: 48, recipientEmail: "p@example.test", request });
    await services.manualCreate.submit({ operationId, householdId: "household-1", request }); await services.manualCreate.status({ operationId, householdId: "household-1", request }); await services.manualCreate.abandon({ operationId, householdId: "household-1", request });
    await services.manualReplace.reserve({ operationId, inviteId: "invite-1", expiresInHours: 48, request }); await services.manualReplace.submit({ operationId, inviteId: "invite-1", request }); await services.manualReplace.status({ operationId, inviteId: "invite-1", request }); await services.manualReplace.abandon({ operationId, inviteId: "invite-1", request });
    await services.bind({ sessionId: "session-1", claimIdentityId: claimId, request: { ...request, operationId: claimId } });
    await services.review({ sessionId: "session-1", claimIdentityId: claimId, request: { ...request, operationId: claimId } });
    const credential = { operationId, claimIdentityId: claimId, browserPartitionDigest: Buffer.alloc(32), recipientEmailDigest: Buffer.alloc(32), request };
    await services.credential.reserve(credential); await services.credential.submit({ ...credential, displayName: "Taylor", password: "not-sent-to-sql", hashPassword: vi.fn().mockResolvedValue("better-auth-hash") }); await services.credential.status(credential); await services.credential.abandon(credential);
    await services.recoveryEnrollment.reserve({ operationId, request }); await services.recoveryEnrollment.submit({ operationId, request, prepareBatch: async () => ({ records: verifierRecords, digest: Buffer.alloc(32) }) }); await services.recoveryEnrollment.status({ operationId, request }); await services.recoveryEnrollment.abandon({ operationId, request });
    await services.rehearsal.reserve({ operationId, selectedRecoveryCodeId: "code-1", acknowledgement: "I SAVED MY RECOVERY CODES", request }); await services.rehearsal.submit({ operationId, selectedRecoveryCodeId: "code-1", nonce: Buffer.alloc(32), attestation: { keyVersion: 1, mac: Buffer.alloc(32) }, request }); await services.rehearsal.status({ operationId, request }); await services.rehearsal.abandon({ operationId, request });
    await services.acceptance.reserve({ operationId, claimIdentityId: claimId, reviewVersion: 1, reviewSnapshotDigest: "a".repeat(64), request }); await services.acceptance.submit({ operationId, reviewVersion: 1, reviewSnapshotDigest: "a".repeat(64), typedHouseholdName: "Home", adminAcknowledgement: null, request }); await services.acceptance.status({ operationId, request }); await services.acceptance.abandon({ operationId, request });
    await services.revoke({ inviteId: "invite-1", operationId, request }); await services.revokeAll({ householdId: "household-1", operationId, acknowledgement: "I_REVOKE_ALL_PENDING_INVITATIONS", request });
    await services.expire({ inviteId: "invite-1" }); await services.compact({ identityId: claimId });

    const text = (query: { strings?: readonly string[] }) => query.strings?.join("?") ?? String(query);
    const calls = runtime.$queryRaw.mock.calls.map((call: unknown[]) => text(call[0] as { strings?: readonly string[] }));
    const reserveCreate = calls.find((query) => query.includes("reserve_manual_invite_create_v2"));
    expect(reserveCreate).toContain('?::uuid, ?::text, ?::public."HouseholdRole", ?::integer, ?::text, ?::bytea');
    for (const [procedure, target] of [
      ["submit_manual_invite_create_v2", "household-1"], ["status_manual_invite_create_v2", "household-1"], ["abandon_manual_invite_create_v2", "household-1"],
      ["submit_manual_invite_replace_v2", "invite-1"], ["status_manual_invite_replace_v2", "invite-1"], ["abandon_manual_invite_replace_v2", "invite-1"],
    ]) {
      const call = runtime.$queryRaw.mock.calls.find(([query]) => text(query as { strings?: readonly string[] }).includes(procedure));
      expect((call?.[0] as { values?: unknown[] })?.values).toContain(target);
    }
    expect(signedRequests).toEqual(expect.arrayContaining([
      expect.objectContaining({ operationKind: "MANUAL_INVITE_CREATE", purpose: "manual_invite_status" }),
      expect.objectContaining({ operationKind: "MANUAL_INVITE_REPLACE", purpose: "manual_invite_replace_status" })
    ]));
    expect(signedRequests).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ purpose: "manual_invite_create_status" })
    ]));
    for (const call of runtime.$queryRaw.mock.calls) {
      const query = call[0] as { strings: string[]; values: unknown[] };
      query.values.forEach((value, index) => {
        if (typeof value === "number") expect(query.strings[index + 1]).toMatch(/^::integer/);
      });
    }
    for (const procedure of ["claim_invitation_presentation_v2", "close_invitation_presentation_v2", "reserve_manual_invite_create_v2", "submit_manual_invite_create_v2", "status_manual_invite_create_v2", "abandon_manual_invite_create_v2", "reserve_manual_invite_replace_v2", "submit_manual_invite_replace_v2", "status_manual_invite_replace_v2", "abandon_manual_invite_replace_v2", "bind_post_signin_invitation_claim_v2", "issue_invitation_review_v2", "reserve_invitation_credential_setup_v2", "submit_invitation_credential_setup_v2", "status_invitation_credential_setup_v2", "abandon_invitation_credential_setup_v2", "reserve_invitation_recovery_enrollment_v2", "submit_invitation_recovery_enrollment_v2", "status_invitation_recovery_enrollment_v2", "abandon_invitation_recovery_enrollment_v2", "reserve_invitation_recovery_rehearsal_v2", "submit_invitation_recovery_rehearsal_v2", "status_invitation_recovery_rehearsal_v2", "abandon_invitation_recovery_rehearsal_v2", "reserve_invitation_acceptance_v2", "submit_invitation_acceptance_v2", "status_invitation_acceptance_v2", "abandon_invitation_acceptance_v2", "revoke_invitation_v2", "revoke_all_invitations_v2"]) expect(calls.some((query) => query.includes(procedure))).toBe(true);
    expect(text(expiry.$queryRaw.mock.calls[0]?.[0])).toContain("expire_invitation_v2");
    expect(text(maintenance.$queryRaw.mock.calls[0]?.[0])).toContain("compact_invitation_operation_v2");
  });

  it("does not apply a delayed receipt for another operation", () => {
    expect(invitationResponseForOperation("operation-1", { operationId: "operation-2", status: "completed" })).toBeNull();
    expect(invitationResponseForOperation("operation-1", { operationId: "operation-1", status: "completed" })).toEqual({ operationId: "operation-1", status: "completed" });
  });

  it("verifies a reserve-bound recovery verifier before issuing its rehearsal MAC", async () => {
    const verifyRecoveryCode = vi.fn().mockResolvedValue(true);
    const signer = {
      signRequest: vi.fn(), signRecoveryIssuance: vi.fn(), signPreaccountCredential: vi.fn(), signCredentialStatus: vi.fn(), signPublicClaim: vi.fn(),
      signRecoveryRehearsal: vi.fn(() => ({ keyVersion: 1, nonce: Buffer.alloc(32, 5), mac: Buffer.alloc(32, 6) }))
    };
    const client = { $queryRaw: vi.fn() };
    const services = createInvitationServices({ runtime: client, expiry: client, maintenance: client, signer: signer as never, verifyRecoveryCode });
    const operationId = "11111111-1111-4111-8111-111111111111";
    await expect(services.rehearsal.attestReservation({
      operationId, selectedRecoveryCodeId: "code-1", recoveryCode: "AAAA-AAAA-AAAA-AAAA-AAAA-AAAA", request,
      reservation: { operationIdentityId: "22222222-2222-4222-8222-222222222222", credentialVersion: 1, sessionSecurityVersion: 1, recoverySetVersion: 1, nonce: Buffer.alloc(32, 5), salt: Buffer.alloc(16, 2), derivedKey: Buffer.alloc(32, 3), kdfVersion: 1 }
    })).resolves.toEqual({ keyVersion: 1, nonce: Buffer.alloc(32, 5), mac: Buffer.alloc(32, 6) });
    expect(verifyRecoveryCode).toHaveBeenCalledWith("AAAA-AAAA-AAAA-AAAA-AAAA-AAAA", { salt: Buffer.alloc(16, 2), derivedKey: Buffer.alloc(32, 3), kdfVersion: 1 });
    expect(signer.signRecoveryRehearsal).toHaveBeenCalledWith(expect.objectContaining({ operationId, selectedRecoveryCodeId: "code-1" }));
  });
});
