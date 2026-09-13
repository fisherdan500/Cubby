import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createInvitationAttestationSigner,
  frameInvitationFields,
  invitationFingerprint,
  prepareRecoveryVerifierBatch
} from "@/server/services/invitation-attestation";

const key = Buffer.alloc(32, 7).toString("base64url");
const environment = {
  CUBBY_FRESH_AUTH_ATTESTATION_KEYRING: `3:${key}`,
  CUBBY_FRESH_AUTH_ATTESTATION_ACTIVE_KEY_VERSION: "3"
};

describe("invitation attestation", () => {
  it("binds recovery issuance to the verifier batch and the exact security and set versions", () => {
    const signer = createInvitationAttestationSigner(environment, () => Buffer.alloc(32, 9));
    const input = {
      ordinarySessionId: "session-1", subjectUserId: "user-1",
      issuerMembershipEpisodeId: null, subjectMembershipEpisodeId: null,
      operationId: "11111111-1111-4111-8111-111111111111", target: null,
      openingFingerprint: Buffer.alloc(32, 1), intentFingerprint: Buffer.alloc(32, 2),
      purpose: "recovery_enrollment_submit", credentialVersion: 1,
      sessionSecurityVersion: 1, recoverySetVersion: 1, verifierBatchDigest: Buffer.alloc(32, 3)
    };
    const baseline = signer.signRecoveryIssuance(input).mac;
    for (const substitute of [
      { ...input, verifierBatchDigest: Buffer.alloc(32, 4) },
      { ...input, credentialVersion: 2 },
      { ...input, sessionSecurityVersion: 2 },
      { ...input, recoverySetVersion: 2 }
    ]) expect(baseline.equals(signer.signRecoveryIssuance(substitute).mac)).toBe(false);
    expect(baseline.equals(signer.signRequest({ ...input, operationKind: "RECOVERY_ENROLLMENT" }).mac)).toBe(false);
  });

  it("uses canonical binary length framing and a domain-separated request vector", () => {
    expect(frameInvitationFields(Buffer.from("v1"), "a", Buffer.from([1, 2]), "")).toEqual(
      Buffer.from("000000027631000000016100000002010200000000", "hex")
    );

    const signer = createInvitationAttestationSigner(environment, () => Buffer.alloc(32, 9), () => new Date("2026-09-04T12:00:00.000Z"));
    const signed = signer.signRequest({
      ordinarySessionId: "session-1",
      subjectUserId: "user-1",
      issuerMembershipEpisodeId: "member-1",
      subjectMembershipEpisodeId: null,
      operationKind: "MANUAL_INVITE_CREATE",
      operationId: "11111111-1111-4111-8111-111111111111",
      target: "household-1",
      openingFingerprint: Buffer.alloc(32, 1),
      intentFingerprint: Buffer.alloc(32, 2),
      purpose: "manual_invite_create_reserve"
    });

    const payload = Buffer.concat([
      Buffer.from("cubby.invitation.request-attestation.v1"),
      frameInvitationFields("session-1", "user-1", "member-1", ""),
      Buffer.from("MANUAL_INVITE_CREATE"),
      Buffer.from("11111111111141118111111111111111", "hex"),
      frameInvitationFields("household-1"), Buffer.alloc(32, 1), Buffer.alloc(32, 2),
      frameInvitationFields("manual_invite_create_reserve"), Buffer.alloc(32, 9), Buffer.from([0, 0, 0, 3])
    ]);
    expect(signed.mac).toEqual(createHmac("sha256", Buffer.alloc(32, 7)).update(payload).digest());
    expect(signed).toMatchObject({ keyVersion: 3, nonce: Buffer.alloc(32, 9), issuedAt: new Date("2026-09-04T12:00:00.000Z") });
  });

  it("refuses an invalid active keyring and produces stable operation fingerprints", () => {
    expect(() => createInvitationAttestationSigner({ CUBBY_FRESH_AUTH_ATTESTATION_KEYRING: `3:${key}` })).toThrow("invitation_attestation_keyring_invalid");
    expect(invitationFingerprint("manual_invite_create", { recipient: "parent@example.test", role: "parent" }).toString("hex"))
      .toBe(invitationFingerprint("manual_invite_create", { role: "parent", recipient: "parent@example.test" }).toString("hex"));
  });

  it("creates exactly ten ordered scrypt-v1 verifier records and exposes plaintext only in its return", async () => {
    let entropy = 0;
    const batch = await prepareRecoveryVerifierBatch({
      random: () => Buffer.alloc(15, ++entropy),
      codeId: (ordinal) => `code-${ordinal}`
    });
    expect(batch.codes).toHaveLength(10);
    expect(batch.records).toHaveLength(10);
    expect(batch.records.map((record) => record.ordinal)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(batch.records.every((record) => record.salt.length === 16 && record.derivedKey.length === 32 && record.kdfVersion === 1)).toBe(true);
    expect(JSON.stringify({ records: batch.records, digest: batch.digest })).not.toContain(batch.codes[0]!);
  });
});
