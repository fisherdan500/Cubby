import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createFreshAuthAttestationSigner } from "@/server/services/fresh-auth-attestation";

describe("password fresh-auth attestations", () => {
  it("signs the complete server-resolved session-revoke binding", () => {
    const signer = createFreshAuthAttestationSigner({
      CUBBY_FRESH_AUTH_ATTESTATION_KEYRING: "1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      CUBBY_FRESH_AUTH_ATTESTATION_ACTIVE_KEY_VERSION: "1"
    });
    const result = signer.signSessionRevoke({
      userId: "u|1", sessionId: "s|1", operationId: "gso_00000000000000000000000000",
      credentialVersion: 2, sessionSecurityVersion: 3, scope: "one", canonicalTargetHandle: "h|1",
      resolvedTargetSessionId: "target|1", openingFingerprint: "open|1", intentFingerprint: "intent|1"
    });
    const hex = (value: string) => Buffer.from(value, "utf8").toString("hex");
    const payload = ["session-revoke-attestation-v1", hex("u|1"), hex("s|1"), hex("gso_00000000000000000000000000"), "session_revoke", "2", "3", "one", hex("h|1"), hex("target|1"), hex("open|1"), hex("intent|1"), hex(result.nonce), "1"].join("|");
    expect(result).toMatchObject({ keyVersion: 1, nonce: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), mac: createHmac("sha256", Buffer.alloc(32)).update(payload).digest() });
  });

  it("signs a canonical password-change binding with the active versioned key", () => {
    const signer = createFreshAuthAttestationSigner({
      CUBBY_FRESH_AUTH_ATTESTATION_KEYRING: "1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      CUBBY_FRESH_AUTH_ATTESTATION_ACTIVE_KEY_VERSION: "1"
    });
    const attestation = signer.sign({
      purpose: "password_change",
      userId: "user-1", sessionId: "session-1", operationId: "gso_00000000000000000000000000", credentialVersion: 2, sessionSecurityVersion: 3,
      openingFingerprint: "a".repeat(64), intentFingerprint: "b".repeat(64), replacementPasswordHashDigest: Buffer.alloc(32, 7)
    });
    expect(attestation).toMatchObject({ keyVersion: 1, nonce: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), mac: expect.any(Buffer) });
    expect(attestation.mac).toHaveLength(32);
  });

  it("fails closed for malformed keyring material or an inactive version", () => {
    expect(() => createFreshAuthAttestationSigner({ CUBBY_FRESH_AUTH_ATTESTATION_KEYRING: "1:not-a-key", CUBBY_FRESH_AUTH_ATTESTATION_ACTIVE_KEY_VERSION: "1" })).toThrow("fresh_auth_attestation_keyring_invalid");
    expect(() => createFreshAuthAttestationSigner({ CUBBY_FRESH_AUTH_ATTESTATION_KEYRING: "1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", CUBBY_FRESH_AUTH_ATTESTATION_ACTIVE_KEY_VERSION: "2" })).toThrow("fresh_auth_attestation_keyring_invalid");
  });

  it("uses an unambiguous UTF-8 hex canonical payload", () => {

    const signer = createFreshAuthAttestationSigner({ CUBBY_FRESH_AUTH_ATTESTATION_KEYRING: "1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", CUBBY_FRESH_AUTH_ATTESTATION_ACTIVE_KEY_VERSION: "1" });
    const digest = Buffer.alloc(32, 7);
    const result = signer.sign({
      purpose: "password_change", userId: "u|1", sessionId: "s|1", operationId: "gso_00000000000000000000000000", credentialVersion: 2, sessionSecurityVersion: 3, openingFingerprint: "a|b", intentFingerprint: "c", replacementPasswordHashDigest: digest });
    const hex = (value: string) => Buffer.from(value, "utf8").toString("hex");
    const payload = ["fresh-auth-attestation-v1",hex("u|1"),hex("s|1"),hex("gso_00000000000000000000000000"),"password_change","2","3",hex("a|b"),hex("c"),digest.toString("hex"),hex(result.nonce),"1"].join("|");
    expect(result.mac).toEqual(createHmac("sha256", Buffer.alloc(32)).update(payload).digest());

  });
});
