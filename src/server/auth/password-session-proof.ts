import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const PURPOSE = "credential_sign_in";
const DOMAIN = "cubby.password-session-proof.v1";
const POSTGRES_EPOCH_MILLISECONDS = 946684800000n;

type ProofEnvironment = Partial<Pick<NodeJS.ProcessEnv,
  "CUBBY_FRESH_AUTH_ATTESTATION_KEYRING" | "CUBBY_FRESH_AUTH_ATTESTATION_ACTIVE_KEY_VERSION">>;

type RequestProof = {
  purpose: typeof PURPOSE;
  credentialHashDigest: Buffer;
};

type PasswordVerification = (hash: string, password: string) => Promise<boolean>;

export type PasswordSessionProof = {
  credentialProofPurpose: typeof PURPOSE;
  credentialProofHashDigest: string;
  credentialProofIssuedAt: Date;
  credentialProofNonce: string;
  credentialProofKeyVersion: number;
  credentialProofMac: string;
};

const requestProofStorage = new AsyncLocalStorage<{ proof?: RequestProof }>();

function configuredKeyring(environment: ProofEnvironment) {
  const configured = environment.CUBBY_FRESH_AUTH_ATTESTATION_KEYRING;
  const active = Number(environment.CUBBY_FRESH_AUTH_ATTESTATION_ACTIVE_KEY_VERSION);
  if (!configured || !Number.isSafeInteger(active) || active < 1) throw new Error("password_session_proof_keyring_invalid");
  const keys = new Map<number, Buffer>();
  for (const entry of configured.split(",")) {
    const [versionText, encoded, extra] = entry.split(":");
    const version = Number(versionText);
    const key = encoded && /^[A-Za-z0-9_-]+$/.test(encoded) ? Buffer.from(encoded, "base64url") : null;
    if (extra || !key || key.length !== 32 || !Number.isSafeInteger(version) || version < 1 || keys.has(version)) {
      throw new Error("password_session_proof_keyring_invalid");
    }
    keys.set(version, key);
  }
  const activeKey = keys.get(active);
  if (keys.size > 2 || !activeKey) throw new Error("password_session_proof_keyring_invalid");
  return { active, activeKey, keys };
}

function frame(value: Buffer) {
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(value.length);
  return Buffer.concat([length, value]);
}

function timestamp3(value: Date) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error("password_session_proof_input_invalid");
  const encoded = Buffer.allocUnsafe(8);
  encoded.writeBigInt64BE((BigInt(value.getTime()) - POSTGRES_EPOCH_MILLISECONDS) * 1000n);
  return encoded;
}

function int32(value: number) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647) throw new Error("password_session_proof_input_invalid");
  const encoded = Buffer.allocUnsafe(4);
  encoded.writeInt32BE(value);
  return encoded;
}

function proofPayload(input: {
  userId: string;
  sessionTokenDigest: Buffer;
  credentialHashDigest: Buffer;
  issuedAt: Date;
  nonce: Buffer;
  keyVersion: number;
}) {
  if (!input.userId || input.userId.trim() !== input.userId || /[\0\r\n]/.test(input.userId)) throw new Error("password_session_proof_input_invalid");
  if (input.sessionTokenDigest.length !== 32 || input.credentialHashDigest.length !== 32 || input.nonce.length !== 32) {
    throw new Error("password_session_proof_input_invalid");
  }
  return Buffer.concat([
    Buffer.from(DOMAIN, "utf8"),
    frame(Buffer.from(PURPOSE, "utf8")),
    frame(Buffer.from(input.userId, "utf8")),
    frame(input.sessionTokenDigest),
    frame(input.credentialHashDigest),
    timestamp3(input.issuedAt),
    frame(input.nonce),
    int32(input.keyVersion)
  ]);
}

function decodePrivateBinary(value: unknown) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) throw new Error("password_session_proof_binary_invalid");
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== 32 || decoded.toString("base64url") !== value) throw new Error("password_session_proof_binary_invalid");
  return decoded;
}

function encodePrivateBinary(value: unknown) {
  if (value === null || value === undefined) return value;
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) throw new Error("password_session_proof_binary_invalid");
  return Buffer.from(value).toString("base64url");
}

// Better Auth 1.6.19 has no bytea DBFieldType. This narrow codec intentionally
// returns a Buffer at runtime so the installed Prisma adapter receives Bytes.
function binaryInput(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return value;
  return decodePrivateBinary(value) as unknown as string;
}

export const passwordSessionProofAdditionalFields = {
  credentialProofPurpose: { type: "string", required: false, input: false, returned: false },
  credentialProofHashDigest: {
    type: "string", required: false, input: false, returned: false,
    transform: { input: binaryInput, output: encodePrivateBinary }
  },
  credentialProofIssuedAt: { type: "date", required: false, input: false, returned: false },
  credentialProofNonce: {
    type: "string", required: false, input: false, returned: false,
    transform: { input: binaryInput, output: encodePrivateBinary }
  },
  credentialProofKeyVersion: { type: "number", required: false, input: false, returned: false },
  credentialProofMac: {
    type: "string", required: false, input: false, returned: false,
    transform: { input: binaryInput, output: encodePrivateBinary }
  }
} as const;

export function runWithPasswordSessionProofRequest<T>(action: () => T): T {
  return requestProofStorage.run({}, action);
}

export async function verifyPasswordAndCaptureSessionProof(
  verify: PasswordVerification,
  input: { hash: string; password: string }
) {
  const store = requestProofStorage.getStore();
  // Only sign-in runs inside a proof request. Other legitimate callers verify the current password
  // outside one (recovery enrollment, email change, password change, the assisted first-login
  // corridor); they take no session proof, so verify normally rather than failing closed. Session
  // creation still requires a captured proof, so a missing store cannot forge a session.
  if (!store) return verify(input.hash, input.password);
  delete store.proof;
  const verified = await verify(input.hash, input.password);
  if (verified) {
    store.proof = {
      purpose: PURPOSE,
      credentialHashDigest: createHash("sha256").update(input.hash, "utf8").digest()
    };
  }
  return verified;
}

export function createPasswordSessionProof(
  session: { userId: string; token: string },
  dependencies: {
    environment?: ProofEnvironment;
    random?: () => Buffer;
    now?: () => Date;
  } = {}
): PasswordSessionProof {
  const captured = requestProofStorage.getStore()?.proof;
  if (!captured || captured.purpose !== PURPOSE) throw new Error("password_session_proof_missing");
  const environment = dependencies.environment ?? {
    CUBBY_FRESH_AUTH_ATTESTATION_KEYRING: process.env.CUBBY_FRESH_AUTH_ATTESTATION_KEYRING,
    CUBBY_FRESH_AUTH_ATTESTATION_ACTIVE_KEY_VERSION: process.env.CUBBY_FRESH_AUTH_ATTESTATION_ACTIVE_KEY_VERSION
  };
  const { active, activeKey } = configuredKeyring(environment);
  const nonce = Buffer.from((dependencies.random ?? (() => randomBytes(32)))());
  const issuedAt = (dependencies.now ?? (() => new Date()))();
  const sessionTokenDigest = createHash("sha256").update(session.token, "utf8").digest();
  const payload = proofPayload({
    userId: session.userId,
    sessionTokenDigest,
    credentialHashDigest: captured.credentialHashDigest,
    issuedAt,
    nonce,
    keyVersion: active
  });
  return {
    credentialProofPurpose: PURPOSE,
    credentialProofHashDigest: captured.credentialHashDigest.toString("base64url"),
    credentialProofIssuedAt: issuedAt,
    credentialProofNonce: nonce.toString("base64url"),
    credentialProofKeyVersion: active,
    credentialProofMac: createHmac("sha256", activeKey).update(payload).digest("base64url")
  };
}

export function verifyPasswordSessionProof(
  proof: PasswordSessionProof,
  input: { userId: string; token: string },
  environment: ProofEnvironment
) {
  try {
    if (proof.credentialProofPurpose !== PURPOSE) return false;
    const { keys } = configuredKeyring(environment);
    const key = keys.get(proof.credentialProofKeyVersion);
    if (!key) return false;
    const hashDigest = decodePrivateBinary(proof.credentialProofHashDigest);
    const nonce = decodePrivateBinary(proof.credentialProofNonce);
    const mac = decodePrivateBinary(proof.credentialProofMac);
    const expected = createHmac("sha256", key).update(proofPayload({
      userId: input.userId,
      sessionTokenDigest: createHash("sha256").update(input.token, "utf8").digest(),
      credentialHashDigest: hashDigest,
      issuedAt: proof.credentialProofIssuedAt,
      nonce,
      keyVersion: proof.credentialProofKeyVersion
    })).digest();
    return timingSafeEqual(mac, expected);
  } catch {
    return false;
  }
}
