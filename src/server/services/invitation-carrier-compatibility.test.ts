import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createInvitationAttestationSigner, frameInvitationFields } from "@/server/services/invitation-attestation";

const key = Buffer.alloc(32, 7).toString("base64url");
const environment = {
  CUBBY_FRESH_AUTH_ATTESTATION_KEYRING: `3:${key}`,
  CUBBY_FRESH_AUTH_ATTESTATION_ACTIVE_KEY_VERSION: "3"
};
const migration = () => readFileSync(resolve(process.cwd(), "prisma/migrations/20260904120000_invitation_protocol_v2/migration.sql"), "utf8");
const routeLayer = () => readFileSync(resolve(process.cwd(), "src/server/services/invitation-route-layer.ts"), "utf8");
const service = () => readFileSync(resolve(process.cwd(), "src/server/services/invitation-service.ts"), "utf8");

function procedureBody(source: string, name: string) {
  return source.match(new RegExp(`CREATE OR REPLACE FUNCTION invitation_protocol\\.${name}\\([\\s\\S]*?AS \\$\\$([\\s\\S]*?)\\$\\$;`))?.[1] ?? "";
}

describe("invitation carrier compatibility", () => {
  it("signs public claims with the explicit Fresh Auth key version used by SQL", () => {
    const signer = createInvitationAttestationSigner(environment, () => Buffer.alloc(32, 9), () => new Date("2026-09-04T12:00:00.000Z"));
    const signed = signer.signPublicClaim({ tokenHashDigest: Buffer.alloc(32, 1) });
    const payload = Buffer.concat([Buffer.from("cubby.invitation.public-claim.v1"), Buffer.alloc(32, 1), Buffer.alloc(32, 9), Buffer.from([0, 0, 0, 3])]);

    expect(signed.keyVersion).toBe(3);
    expect(signed.mac).toEqual(createHmac("sha256", Buffer.alloc(32, 7)).update(payload).digest());

    const source = migration();
    expect(source).toContain("CREATE TYPE invitation_protocol.invitation_public_token_claim AS (token_hash_digest BYTEA, key_version INTEGER");
    expect(source).toContain('CREATE TABLE invitation_protocol."InvitationPublicClaimAttestation"');
    expect(procedureBody(source, "reauthorize_invitation_public_claim_carrier_v2")).toContain('public."FreshAuthAttestationKey"');
    expect(procedureBody(source, "reauthorize_invitation_public_claim_carrier_v2")).toContain("public.hmac");
    expect(procedureBody(source, "reauthorize_invitation_public_claim_carrier_v2")).toContain('InvitationPublicClaimAttestation');
  });

  it("uses PostgreSQL's fixed and length-prefixed recovery rehearsal MAC frame", () => {
    const signer = createInvitationAttestationSigner(environment);
    const signed = signer.signRecoveryRehearsal({
      subjectUserId: "user-1", ordinarySessionId: "session-1", operationIdentityId: "11111111-1111-4111-8111-111111111111", operationId: "22222222-2222-4222-8222-222222222222",
      credentialVersion: 1, sessionSecurityVersion: 2, recoverySetVersion: 3, selectedRecoveryCodeId: "code-1", nonce: Buffer.alloc(32, 9), openingFingerprint: Buffer.alloc(32, 4), intentFingerprint: Buffer.alloc(32, 5)
    });
    const payload = Buffer.concat([
      Buffer.from("invitation-recovery-rehearsal-attestation-v1"), frameInvitationFields("user-1", "session-1"), Buffer.from("RECOVERY_REHEARSAL"),
      Buffer.from("11111111111141118111111111111111", "hex"), Buffer.from("22222222222242228222222222222222", "hex"),
      Buffer.from([0, 0, 0, 1]), Buffer.from([0, 0, 0, 2]), Buffer.from([0, 0, 0, 3]), frameInvitationFields("code-1"), Buffer.alloc(32, 9), Buffer.from([0, 0, 0, 3]), Buffer.alloc(32, 4), Buffer.alloc(32, 5)
    ]);
    expect(signed.mac).toEqual(createHmac("sha256", Buffer.alloc(32, 7)).update(payload).digest());
  });

  it("keeps the presentation operation ID inside the HttpOnly claim carrier", () => {
    const source = routeLayer();
    expect(source).toContain("function claimPresentation()");
    expect(source).toContain("presentationOperationId");
    expect(source).toContain("httpOnly: true");
    expect(source).toContain("`${claimId}.${presentationOperationId}`");
  });

  it("uses one exact manual purpose vocabulary at Node and SQL boundaries", () => {
    const node = service();
    for (const purpose of ["manual_invite_create", "manual_invite_status", "manual_invite_create_abandon", "manual_invite_replace", "manual_invite_replace_status", "manual_invite_replace_abandon"]) expect(node).toContain(`purpose: \"${purpose}\"`);
    expect(procedureBody(migration(), "status_manual_invite_create_v2")).toContain("'manual_invite_status'");
    expect(node).not.toContain("manual_invite_create_status");
    expect(node).not.toContain("manual_invite_create_reserve");
    expect(node).not.toContain("manual_invite_create_submit");
    expect(node).not.toContain("manual_invite_replace_reserve");
    expect(node).not.toContain("manual_invite_replace_submit");
  });

  it("authenticates the presentation claim before authorizing the distinct acceptance identity", () => {
    const reserve = procedureBody(migration(), "reserve_invitation_acceptance_v2");
    expect(reserve).toContain("InvitationPresentationClaim");
    expect(reserve).toContain("public.\"Session\"");
    expect(reserve).toContain("create_invitation_identity_v2(operation_id");
    expect(reserve).toContain("reauthorize_invitation_carrier_v2(identity_row.\"id\",operation_id,'MEMBERSHIP_ACCEPTANCE'");
    expect(reserve).not.toContain("reauthorize_invitation_carrier_v2(claim_identity.\"id\",claim_identity.\"operationId\",'PRESENTATION_CLAIM',request_attestation)");
  });

  it("carries the computed recovery rehearsal intent into reserve and attestation without authorizing reserve by it", () => {
    const route = routeLayer();
    const reserve = procedureBody(migration(), "reserve_invitation_recovery_rehearsal_v2");
    expect(route).toContain('fingerprint("recovery_rehearsal", { operationId, selectedRecoveryCodeId })');
    expect(route).toContain("intentFingerprint: rehearsalIntentFingerprint");
    expect(reserve).not.toContain("intent_fingerprint IS DISTINCT FROM");
    expect(route).toContain("services.rehearsal.attestReservation");
  });
});
