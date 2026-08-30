import { createHash, createHmac, randomBytes } from "node:crypto";

type AttestationInput = {
  purpose: "password_change" | "recovery_enrollment";
  userId: string;
  sessionId: string;
  operationId: string;
  credentialVersion: number;
  sessionSecurityVersion: number;
  openingFingerprint: string;
  intentFingerprint: string;
  replacementPasswordHashDigest: Buffer;
};

type Attestation = {
  keyVersion: number;
  nonce: string;
  mac: Buffer;
};

type SessionRevokeAttestationInput = Omit<AttestationInput, "purpose" | "replacementPasswordHashDigest"> & {
  scope: "current" | "one" | "others" | "all";
  canonicalTargetHandle: string;
  resolvedTargetSessionId: string;
};

type RecoveryResetAttestationInput = Omit<AttestationInput, "sessionId" | "purpose"> & { recoveryCodeId: string; setVersion: number };

type AttestationEnvironment = Partial<Pick<NodeJS.ProcessEnv, "CUBBY_FRESH_AUTH_ATTESTATION_KEYRING" | "CUBBY_FRESH_AUTH_ATTESTATION_ACTIVE_KEY_VERSION">>;

function parseKeyring(environment: AttestationEnvironment) {
  const configured = environment.CUBBY_FRESH_AUTH_ATTESTATION_KEYRING;
  const active = Number(environment.CUBBY_FRESH_AUTH_ATTESTATION_ACTIVE_KEY_VERSION);
  if (!configured || !Number.isSafeInteger(active) || active < 1) throw new Error("fresh_auth_attestation_keyring_invalid");
  const keys = new Map<number, Buffer>();
  for (const entry of configured.split(",")) {
    const [versionText, encoded] = entry.split(":");
    const version = Number(versionText);
    if (!Number.isSafeInteger(version) || version < 1 || !encoded || keys.has(version) || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error("fresh_auth_attestation_keyring_invalid");
    const key = Buffer.from(encoded, "base64url");
    if (key.length !== 32) throw new Error("fresh_auth_attestation_keyring_invalid");
    keys.set(version, key);
  }
  const key = keys.get(active);
  if (!key) throw new Error("fresh_auth_attestation_keyring_invalid");
  return { active, key };
}

function canonicalPayload(input: AttestationInput, keyVersion: number, nonce: string) {
  const hex = (value: string) => Buffer.from(value, "utf8").toString("hex");
  return [
    "fresh-auth-attestation-v1", hex(input.userId), hex(input.sessionId), hex(input.operationId), input.purpose,
    String(input.credentialVersion), String(input.sessionSecurityVersion), hex(input.openingFingerprint),
    hex(input.intentFingerprint), input.replacementPasswordHashDigest.toString("hex"), hex(nonce), String(keyVersion)
  ].join("|");
}

export function createFreshAuthAttestationSigner(environment: AttestationEnvironment = { CUBBY_FRESH_AUTH_ATTESTATION_KEYRING: process.env.CUBBY_FRESH_AUTH_ATTESTATION_KEYRING, CUBBY_FRESH_AUTH_ATTESTATION_ACTIVE_KEY_VERSION: process.env.CUBBY_FRESH_AUTH_ATTESTATION_ACTIVE_KEY_VERSION }) {
  const { active, key } = parseKeyring(environment);
  return {
    sign(input: AttestationInput): Attestation {
      if (input.replacementPasswordHashDigest.length !== 32) throw new Error("fresh_auth_attestation_input_invalid");
      const nonce = randomBytes(32).toString("base64url");
      const mac = createHmac("sha256", key).update(canonicalPayload(input, active, nonce), "utf8").digest();
      return { keyVersion: active, nonce, mac };
    },
    signRecoveryReset(input: RecoveryResetAttestationInput): Attestation {
      if (input.replacementPasswordHashDigest.length !== 32) throw new Error("fresh_auth_attestation_input_invalid");
      const nonce = randomBytes(32).toString("base64url");
      const hex = (value: string) => Buffer.from(value, "utf8").toString("hex");
      const payload = ["recovery-reset-attestation-v1",hex(input.userId),hex(input.recoveryCodeId),String(input.setVersion),hex(input.operationId),String(input.credentialVersion),String(input.sessionSecurityVersion),hex(input.openingFingerprint),hex(input.intentFingerprint),input.replacementPasswordHashDigest.toString("hex"),hex(nonce),String(active)].join("|");
      return { keyVersion: active, nonce, mac: createHmac("sha256", key).update(payload, "utf8").digest() };
    },
    signSessionRevoke(input: SessionRevokeAttestationInput): Attestation {
      const nonce = randomBytes(32).toString("base64url");
      const hex = (value: string) => Buffer.from(value, "utf8").toString("hex");
      const payload = [
        "session-revoke-attestation-v1", hex(input.userId), hex(input.sessionId), hex(input.operationId), "session_revoke",
        String(input.credentialVersion), String(input.sessionSecurityVersion), input.scope, hex(input.canonicalTargetHandle),
        hex(input.resolvedTargetSessionId), hex(input.openingFingerprint), hex(input.intentFingerprint), hex(nonce), String(active)
      ].join("|");
      return { keyVersion: active, nonce, mac: createHmac("sha256", key).update(payload, "utf8").digest() };
    },
    digestReplacementPasswordHash(passwordHash: string) {
      return createHash("sha256").update(passwordHash, "utf8").digest();
    }
  };
}
