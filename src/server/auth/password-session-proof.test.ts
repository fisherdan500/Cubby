import { createHash, createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  createPasswordSessionProof,
  passwordSessionProofAdditionalFields,
  runWithPasswordSessionProofRequest,
  verifyPasswordAndCaptureSessionProof,
  verifyPasswordSessionProof
} from "@/server/auth/password-session-proof";

const key = Buffer.alloc(32, 7);
const environment = {
  CUBBY_FRESH_AUTH_ATTESTATION_KEYRING: `1:${key.toString("base64url")}`,
  CUBBY_FRESH_AUTH_ATTESTATION_ACTIVE_KEY_VERSION: "1"
};

describe("password session proof request scope", () => {
  it("stores no proof after a failed password verification", async () => {
    const verify = vi.fn().mockResolvedValue(false);

    await runWithPasswordSessionProofRequest(async () => {
      await expect(verifyPasswordAndCaptureSessionProof(verify, {
        hash: "stored-password-hash",
        password: "wrong-password"
      })).resolves.toBe(false);
      expect(() => createPasswordSessionProof({ userId: "user-1", token: "token-1" }, { environment })).toThrow("password_session_proof_missing");
    });
  });

  it("fails closed when a session is created outside the auth request scope", () => {
    expect(() => createPasswordSessionProof({ userId: "user-1", token: "token-1" }, { environment })).toThrow("password_session_proof_missing");
  });

  it("keeps interleaved request digests isolated", async () => {
    const first = runWithPasswordSessionProofRequest(async () => {
      await verifyPasswordAndCaptureSessionProof(async () => true, { hash: "hash-first", password: "password-first" });
      await new Promise((resolve) => setTimeout(resolve, 5));
      return createPasswordSessionProof({ userId: "user-first", token: "token-first" }, { environment });
    });
    const second = runWithPasswordSessionProofRequest(async () => {
      await verifyPasswordAndCaptureSessionProof(async () => true, { hash: "hash-second", password: "password-second" });
      return createPasswordSessionProof({ userId: "user-second", token: "token-second" }, { environment });
    });

    const [firstProof, secondProof] = await Promise.all([first, second]);
    expect(Buffer.from(firstProof.credentialProofHashDigest, "base64url")).toEqual(createHash("sha256").update("hash-first").digest());
    expect(Buffer.from(secondProof.credentialProofHashDigest, "base64url")).toEqual(createHash("sha256").update("hash-second").digest());
  });

  it("binds purpose, user, token digest, stored-hash digest, timestamp, nonce, and key version", async () => {
    const issuedAt = new Date("2026-09-27T12:34:56.789Z");
    const nonce = Buffer.alloc(32, 9);
    const proof = await runWithPasswordSessionProofRequest(async () => {
      await verifyPasswordAndCaptureSessionProof(async () => true, { hash: "exact-stored-hash", password: "plain-secret" });
      return createPasswordSessionProof(
        { userId: "user-1", token: "session-token" },
        { environment, now: () => issuedAt, random: () => nonce }
      );
    });

    const frame = (value: Buffer) => {
      const length = Buffer.alloc(4);
      length.writeUInt32BE(value.length);
      return Buffer.concat([length, value]);
    };
    const timestamp = Buffer.alloc(8);
    timestamp.writeBigInt64BE((BigInt(issuedAt.getTime()) - 946684800000n) * 1000n);
    const keyVersion = Buffer.alloc(4);
    keyVersion.writeInt32BE(1);
    const expected = createHmac("sha256", key).update(Buffer.concat([
      Buffer.from("cubby.password-session-proof.v1"),
      frame(Buffer.from("credential_sign_in")),
      frame(Buffer.from("user-1")),
      frame(createHash("sha256").update("session-token").digest()),
      frame(createHash("sha256").update("exact-stored-hash").digest()),
      timestamp,
      frame(nonce),
      keyVersion
    ])).digest("base64url");

    expect(proof).toEqual({
      credentialProofPurpose: "credential_sign_in",
      credentialProofHashDigest: createHash("sha256").update("exact-stored-hash").digest("base64url"),
      credentialProofIssuedAt: issuedAt,
      credentialProofNonce: nonce.toString("base64url"),
      credentialProofKeyVersion: 1,
      credentialProofMac: expected
    });
    expect(JSON.stringify(proof)).not.toContain("plain-secret");
    expect(JSON.stringify(proof)).not.toContain("exact-stored-hash");
    for (const field of [proof.credentialProofHashDigest, proof.credentialProofNonce, proof.credentialProofMac]) {
      expect(Buffer.from(field, "base64url")).toHaveLength(32);
    }
  });

  it("rejects every mutated binding and accepts a configured prior key", async () => {
    const priorEnvironment = {
      CUBBY_FRESH_AUTH_ATTESTATION_KEYRING: `1:${key.toString("base64url")}`,
      CUBBY_FRESH_AUTH_ATTESTATION_ACTIVE_KEY_VERSION: "1"
    };
    const proof = await runWithPasswordSessionProofRequest(async () => {
      await verifyPasswordAndCaptureSessionProof(async () => true, { hash: "stored-hash", password: "password" });
      return createPasswordSessionProof({ userId: "user-1", token: "token-1" }, { environment: priorEnvironment });
    });
    const activeKey = Buffer.alloc(32, 8);
    const rotatedEnvironment = {
      CUBBY_FRESH_AUTH_ATTESTATION_KEYRING: `1:${key.toString("base64url")},2:${activeKey.toString("base64url")}`,
      CUBBY_FRESH_AUTH_ATTESTATION_ACTIVE_KEY_VERSION: "2"
    };

    expect(verifyPasswordSessionProof(proof, { userId: "user-1", token: "token-1" }, rotatedEnvironment)).toBe(true);
    expect(verifyPasswordSessionProof({ ...proof, credentialProofPurpose: "other" as never }, { userId: "user-1", token: "token-1" }, rotatedEnvironment)).toBe(false);
    expect(verifyPasswordSessionProof(proof, { userId: "user-2", token: "token-1" }, rotatedEnvironment)).toBe(false);
    expect(verifyPasswordSessionProof(proof, { userId: "user-1", token: "token-2" }, rotatedEnvironment)).toBe(false);
    expect(verifyPasswordSessionProof({ ...proof, credentialProofHashDigest: Buffer.alloc(32, 4).toString("base64url") }, { userId: "user-1", token: "token-1" }, rotatedEnvironment)).toBe(false);
    expect(verifyPasswordSessionProof({ ...proof, credentialProofIssuedAt: new Date(proof.credentialProofIssuedAt.getTime() + 1) }, { userId: "user-1", token: "token-1" }, rotatedEnvironment)).toBe(false);
    expect(verifyPasswordSessionProof({ ...proof, credentialProofNonce: Buffer.alloc(32, 5).toString("base64url") }, { userId: "user-1", token: "token-1" }, rotatedEnvironment)).toBe(false);
    expect(verifyPasswordSessionProof({ ...proof, credentialProofKeyVersion: 2 }, { userId: "user-1", token: "token-1" }, rotatedEnvironment)).toBe(false);
  });

  it("marks all six proof fields private, optional for legacy rows, and non-client-writable", () => {
    expect(Object.keys(passwordSessionProofAdditionalFields)).toEqual([
      "credentialProofPurpose", "credentialProofHashDigest", "credentialProofIssuedAt",
      "credentialProofNonce", "credentialProofKeyVersion", "credentialProofMac"
    ]);
    for (const field of Object.values(passwordSessionProofAdditionalFields)) {
      expect(field).toMatchObject({ required: false, input: false, returned: false });
    }
  });
});
