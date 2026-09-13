import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { hashRecoveryCode, type RecoveryCodeRecord } from "@/server/services/recovery-codes";

export const invitationOperationKinds = [
  "PRESENTATION_CLAIM", "MANUAL_INVITE_CREATE", "MANUAL_INVITE_REPLACE", "CREDENTIAL_SETUP",
  "RECOVERY_ENROLLMENT", "RECOVERY_REHEARSAL", "MEMBERSHIP_ACCEPTANCE", "INVITE_REVOKE", "INVITE_REVOKE_ALL"
] as const;
export type InvitationOperationKind = typeof invitationOperationKinds[number];

type KeyringEnvironment = Partial<Pick<NodeJS.ProcessEnv, "CUBBY_FRESH_AUTH_ATTESTATION_KEYRING" | "CUBBY_FRESH_AUTH_ATTESTATION_ACTIVE_KEY_VERSION">>;
type SignedCarrier = { keyVersion: number; nonce: Buffer; issuedAt: Date; mac: Buffer };

export type InvitationRequestInput = {
  ordinarySessionId: string | null;
  subjectUserId: string | null;
  issuerMembershipEpisodeId: string | null;
  subjectMembershipEpisodeId: string | null;
  operationKind: InvitationOperationKind;
  operationId: string;
  target: string | null;
  openingFingerprint: Buffer;
  intentFingerprint: Buffer | null;
  purpose: string | null;
};

function keyring(environment: KeyringEnvironment) {
  const active = Number(environment.CUBBY_FRESH_AUTH_ATTESTATION_ACTIVE_KEY_VERSION);
  const configured = environment.CUBBY_FRESH_AUTH_ATTESTATION_KEYRING;
  if (!configured || !Number.isSafeInteger(active) || active < 1) throw new Error("invitation_attestation_keyring_invalid");
  const values = new Map<number, Buffer>();
  for (const entry of configured.split(",")) {
    const [versionText, encoded, extra] = entry.split(":");
    const version = Number(versionText);
    if (extra || !encoded || !Number.isSafeInteger(version) || version < 1 || values.has(version) || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error("invitation_attestation_keyring_invalid");
    const value = Buffer.from(encoded, "base64url");
    if (value.length !== 32) throw new Error("invitation_attestation_keyring_invalid");
    values.set(version, value);
  }
  if (values.size > 2 || !values.has(active)) throw new Error("invitation_attestation_keyring_invalid");
  return { active, key: values.get(active)! };
}

function int32(value: number) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0x7fffffff) throw new Error("invitation_attestation_input_invalid");
  const result = Buffer.allocUnsafe(4);
  result.writeInt32BE(value);
  return result;
}

function bytes(value: string | Buffer | null | undefined) {
  if (value === null || value === undefined) return Buffer.alloc(0);
  return typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
}

/** PostgreSQL's `int4send(length) || bytes` canonical frame. */
export function frameInvitationFields(...values: Array<string | Buffer | null | undefined>) {
  return Buffer.concat(values.flatMap((value) => {
    const field = bytes(value);
    return [int32(field.length), field];
  }));
}

function uuidBytes(value: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new Error("invitation_operation_id_invalid");
  return Buffer.from(value.replaceAll("-", ""), "hex");
}

function fingerprintJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(fingerprintJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${fingerprintJson(object[key])}`).join(",")}}`;
}

export function createInvitationOperationId() {
  return randomUUID();
}

export function invitationFingerprint(scope: string, value: unknown) {
  if (!scope || /[\0\r\n]/.test(scope)) throw new Error("invitation_fingerprint_invalid");
  return createHash("sha256").update(frameInvitationFields("cubby.invitation.intent-fingerprint.v1", scope, fingerprintJson(value))).digest();
}

function assertDigest(value: Buffer | null, nullable = false) {
  if (value === null && nullable) return;
  if (!value || value.length !== 32) throw new Error("invitation_attestation_input_invalid");
}

export function createInvitationAttestationSigner(
  environment: KeyringEnvironment = {
    CUBBY_FRESH_AUTH_ATTESTATION_KEYRING: process.env.CUBBY_FRESH_AUTH_ATTESTATION_KEYRING,
    CUBBY_FRESH_AUTH_ATTESTATION_ACTIVE_KEY_VERSION: process.env.CUBBY_FRESH_AUTH_ATTESTATION_ACTIVE_KEY_VERSION
  },
  random: () => Buffer = () => randomBytes(32),
  now: () => Date = () => new Date()
) {
  const { active, key } = keyring(environment);
  return {
    signRequest(input: InvitationRequestInput): SignedCarrier {
      assertDigest(input.openingFingerprint); assertDigest(input.intentFingerprint, true);
      const nonce = Buffer.from(random());
      if (nonce.length !== 32) throw new Error("invitation_attestation_input_invalid");
      const issuedAt = now();
      const payload = Buffer.concat([
        Buffer.from("cubby.invitation.request-attestation.v1"), frameInvitationFields(input.ordinarySessionId, input.subjectUserId, input.issuerMembershipEpisodeId, input.subjectMembershipEpisodeId),
        Buffer.from(input.operationKind), uuidBytes(input.operationId), frameInvitationFields(input.target), input.openingFingerprint, input.intentFingerprint ?? Buffer.alloc(0), frameInvitationFields(input.purpose), nonce, int32(active)
      ]);
      return { keyVersion: active, nonce, issuedAt, mac: createHmac("sha256", key).update(payload).digest() };
    },
    signRecoveryIssuance(input: Omit<InvitationRequestInput, "operationKind"> & { credentialVersion: number; sessionSecurityVersion: number; recoverySetVersion: number; verifierBatchDigest: Buffer }): SignedCarrier & { target: string } {
      assertDigest(input.openingFingerprint); assertDigest(input.intentFingerprint); assertDigest(input.verifierBatchDigest);
      if (!input.subjectUserId || !input.ordinarySessionId || input.purpose !== "recovery_enrollment_submit" || [input.credentialVersion, input.sessionSecurityVersion, input.recoverySetVersion].some((version) => !Number.isSafeInteger(version) || version < 1)) throw new Error("invitation_attestation_input_invalid");
      const nonce = Buffer.from(random());
      if (nonce.length !== 32) throw new Error("invitation_attestation_input_invalid");
      const payload = Buffer.concat([
        Buffer.from("cubby.invitation.recovery-enrollment-attestation.v1"),
        frameInvitationFields(input.subjectUserId, input.ordinarySessionId), Buffer.from("RECOVERY_ENROLLMENT"), uuidBytes(input.operationId),
        int32(input.credentialVersion), int32(input.sessionSecurityVersion), int32(input.recoverySetVersion),
        input.openingFingerprint, input.intentFingerprint!, input.verifierBatchDigest, nonce, int32(active)
      ]);
      return { keyVersion: active, nonce, issuedAt: now(), mac: createHmac("sha256", key).update(payload).digest(), target: `recovery-v1:${input.credentialVersion}:${input.sessionSecurityVersion}:${input.recoverySetVersion}:${input.verifierBatchDigest.toString("hex")}` };
    },
    signPreaccountCredential(input: { claimIdentityId: string; browserPartitionDigest: Buffer; recipientEmailDigest: Buffer; operationId: string; openingFingerprint: Buffer; intentFingerprint: Buffer | null; passwordHashDigest: Buffer | null }): SignedCarrier {
      assertDigest(input.browserPartitionDigest); assertDigest(input.recipientEmailDigest); assertDigest(input.openingFingerprint); assertDigest(input.intentFingerprint, true); assertDigest(input.passwordHashDigest, true);
      const nonce = Buffer.from(random()); if (nonce.length !== 32) throw new Error("invitation_attestation_input_invalid"); const issuedAt = now();
      const payload = Buffer.concat([Buffer.from("cubby.invitation.preaccount-credential-attestation.v1"), uuidBytes(input.claimIdentityId), input.browserPartitionDigest, input.recipientEmailDigest, Buffer.from("CREDENTIAL_SETUP"), uuidBytes(input.operationId), input.openingFingerprint, input.intentFingerprint ?? Buffer.alloc(0), input.passwordHashDigest ?? Buffer.alloc(0), nonce, int32(active)]);
      return { keyVersion: active, nonce, issuedAt, mac: createHmac("sha256", key).update(payload).digest() };
    },
    signCredentialStatus(input: { claimIdentityId: string; browserPartitionDigest: Buffer; recipientEmailDigest: Buffer; operationId: string }): SignedCarrier {
      assertDigest(input.browserPartitionDigest); assertDigest(input.recipientEmailDigest);
      const nonce = Buffer.from(random()); if (nonce.length !== 32) throw new Error("invitation_attestation_input_invalid"); const issuedAt = now();
      const payload = Buffer.concat([Buffer.from("cubby.invitation.credential-status-attestation.v1"), uuidBytes(input.claimIdentityId), input.browserPartitionDigest, input.recipientEmailDigest, Buffer.from("CREDENTIAL_SETUP"), uuidBytes(input.operationId), nonce, int32(active)]);
      return { keyVersion: active, nonce, issuedAt, mac: createHmac("sha256", key).update(payload).digest() };
    },
    signRecoveryRehearsal(input: { subjectUserId: string; ordinarySessionId: string; operationIdentityId: string; operationId: string; credentialVersion: number; sessionSecurityVersion: number; recoverySetVersion: number; selectedRecoveryCodeId: string; nonce: Buffer; openingFingerprint: Buffer; intentFingerprint: Buffer }): Omit<SignedCarrier, "issuedAt"> {
      assertDigest(input.openingFingerprint); assertDigest(input.intentFingerprint); if (input.nonce.length !== 32) throw new Error("invitation_attestation_input_invalid");
      const payload = Buffer.concat([Buffer.from("invitation-recovery-rehearsal-attestation-v1"), frameInvitationFields(input.subjectUserId, input.ordinarySessionId), Buffer.from("RECOVERY_REHEARSAL"), uuidBytes(input.operationIdentityId), uuidBytes(input.operationId), int32(input.credentialVersion), int32(input.sessionSecurityVersion), int32(input.recoverySetVersion), frameInvitationFields(input.selectedRecoveryCodeId), input.nonce, int32(active), input.openingFingerprint, input.intentFingerprint]);
      return { keyVersion: active, nonce: input.nonce, mac: createHmac("sha256", key).update(payload).digest() };
    },
    signPublicClaim(input: { tokenHashDigest: Buffer }): SignedCarrier {
      assertDigest(input.tokenHashDigest); const nonce = Buffer.from(random()); if (nonce.length !== 32) throw new Error("invitation_attestation_input_invalid"); const issuedAt = now();
      return { keyVersion: active, nonce, issuedAt, mac: createHmac("sha256", key).update(Buffer.concat([Buffer.from("cubby.invitation.public-claim.v1"), input.tokenHashDigest, nonce, int32(active)])).digest() };
    }
  };
}

export type InvitationRecoveryVerifierRecord = RecoveryCodeRecord & { codeId: string; ordinal: number };

export async function prepareRecoveryVerifierBatch(options: { random?: () => Buffer; codeId?: (ordinal: number) => string } = {}) {
  const random = options.random ?? (() => randomBytes(15));
  const codeId = options.codeId ?? ((ordinal: number) => `irc_${randomUUID()}_${ordinal}`);
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const encode = (input: Buffer) => {
    let bits = 0; let value = 0; let output = "";
    for (const byte of input) {
      value = (value << 8) | byte; bits += 8;
      while (bits >= 5) { bits -= 5; output += alphabet[(value >> bits) & 31]; }
    }
    return bits === 0 ? output : "";
  };
  const codes = new Set<string>();
  while (codes.size < 10) {
    const encoded = encode(Buffer.from(random()));
    if (/^[0-9A-HJKMNPQRSTVWXYZ]{24}$/.test(encoded)) codes.add(encoded.match(/.{1,4}/g)!.join("-"));
  }
  const records = await Promise.all([...codes].map(async (code, index) => ({ codeId: codeId(index + 1), ordinal: index + 1, ...(await hashRecoveryCode(code)) })));
  const ordered = records.sort((left, right) => left.ordinal - right.ordinal);
  const digest = createHash("sha256").update(Buffer.concat([Buffer.from("cubby.invitation.recovery-verifier-batch.v1"), ...ordered.flatMap((record) => [int32(record.ordinal), frameInvitationFields(record.codeId), record.salt, record.derivedKey, int32(record.kdfVersion)])])).digest();
  return { codes: [...codes], records: ordered, digest };
}
