import { createHash, createHmac, randomBytes } from "node:crypto";
import { z } from "zod";
import { assignableHouseholdRoles, canManageHouseholdRole, householdRoles } from "@/domain/roles";
import { singleMailbox } from "@/lib/validation/email";

const operationIdSchema = z.string().regex(/^bmo_[0-9abcdefghjkmnpqrstvwxyz]{26}$/);
const fingerprintSchema = z.string().regex(/^[0-9a-f]{64}$/);
const identitySchema = z.string().min(1).max(191).refine((value) => value.trim() === value && !/[\u0000\r\n]/.test(value));
const versionSchema = z.number().int().min(1).max(2147483647);
const roleSchema = z.enum(assignableHouseholdRoles);
const passwordSchema = z.string().min(8).max(128);
const submissionFields = {
  operationId: operationIdSchema,
  openingFingerprint: fingerprintSchema,
  password: passwordSchema,
  passwordConfirmation: z.string(),
  requireFirstLoginPasswordChange: z.boolean().default(false)
};
const createSubmissionSchema = z.object({
  ...submissionFields,
  name: z.string().trim().min(1).max(191),
  email: z.string(),
  role: roleSchema.default("parent")
}).strict();
const resetSubmissionSchema = z.object({
  ...submissionFields,
  targetUserId: identitySchema,
  credentialVersion: versionSchema,
  sessionSecurityVersion: versionSchema
}).strict();

export function parseMemberAccountCreateSubmission(input: unknown) {
  const parsed = createSubmissionSchema.safeParse(input);
  if (!parsed.success || parsed.data.password !== parsed.data.passwordConfirmation) throw new Error("admin_assisted_request_invalid");
  const { passwordConfirmation: _confirmation, ...request } = parsed.data;
  try { return { ...request, email: singleMailbox(request.email).toLowerCase() }; }
  catch { throw new Error("admin_assisted_request_invalid"); }
}

export function parseMemberPasswordResetSubmission(input: unknown) {
  const parsed = resetSubmissionSchema.safeParse(input);
  if (!parsed.success || parsed.data.password !== parsed.data.passwordConfirmation) throw new Error("admin_assisted_request_invalid");
  const { passwordConfirmation: _confirmation, ...request } = parsed.data;
  return request;
}

export function canAdminAssistHouseholdRole(actor: unknown, target: unknown): boolean {
  const actorRole = z.enum(householdRoles).safeParse(actor);
  const targetRole = roleSchema.safeParse(target);
  return actorRole.success && targetRole.success && canManageHouseholdRole(actorRole.data, targetRole.data);
}
const createValuesSchema = z.object({
  normalizedEmail: z.string().refine((value) => {
    try { return singleMailbox(value).toLowerCase() === value; } catch { return false; }
  }),
  exactDisplayName: z.string().min(1).max(191).refine((value) => value.trim() === value),
  role: roleSchema,
  requireFirstLoginPasswordChange: z.boolean()
}).strict();
const resetValuesSchema = z.object({
  targetUserId: identitySchema, targetMemberId: identitySchema, requireFirstLoginPasswordChange: z.boolean()
}).strict();
const actorFields = {
  operationId: operationIdSchema, householdId: identitySchema, actorUserId: identitySchema,
  actorSessionId: identitySchema, actorMemberId: identitySchema
};
const intentSchema = z.discriminatedUnion("operationKey", [
  createValuesSchema.extend({ ...actorFields, operationKey: z.literal("member.account.create"), password: passwordSchema }),
  resetValuesSchema.extend({ ...actorFields, operationKey: z.literal("member.password.reset"), password: passwordSchema })
]);
export type AssistedPasswordIntent = z.infer<typeof intentSchema>;

function decodeKey(encoded: unknown, error: string): Buffer {
  if (typeof encoded !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(encoded)) throw new Error(error);
  const bytes = Buffer.from(encoded, "base64url");
  // Length only, matching fresh-auth and invitation attestation, which share this keyring. A 32-byte
  // base64url value has 2 unused bits in its last character, so several distinct encodings decode to
  // the same key and re-encoding is not guaranteed to reproduce the configured text. Requiring that
  // round trip rejected valid production keyrings that every other consumer of the same variable
  // accepts.
  if (bytes.length !== 32) throw new Error(error);
  return bytes;
}
function frame(value: Buffer | string): Buffer {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  const size = Buffer.alloc(4);
  size.writeUInt32BE(bytes.length);
  return Buffer.concat([size, bytes]);
}
function booleanByte(value: boolean): Buffer { return Buffer.from([value ? 1 : 0]); }

export function buildAssistedPasswordIntentCommitment(encodedKey: string, input: unknown): string {
  const key = decodeKey(encodedKey, "assisted_intent_key_invalid");
  const parsed = intentSchema.safeParse(input);
  if (!parsed.success) throw new Error("assisted_intent_invalid");
  const value = parsed.data;
  const target = value.operationKey === "member.account.create"
    ? [value.normalizedEmail, value.exactDisplayName, value.role]
    : [value.targetMemberId, value.targetUserId];
  const payload = Buffer.concat([
    Buffer.from("cubby.admin-assisted-browser-intent.v1", "utf8"),
    ...[value.operationId, value.householdId, value.actorUserId, value.actorSessionId, value.actorMemberId, value.operationKey, ...target].map(frame),
    frame(booleanByte(value.requireFirstLoginPasswordChange)), frame(value.password.normalize("NFKC"))
  ]);
  return createHmac("sha256", key).update(payload).digest("hex");
}
type AttestationEnvironment = Partial<Pick<NodeJS.ProcessEnv,
  "CUBBY_FRESH_AUTH_ATTESTATION_KEYRING" | "CUBBY_FRESH_AUTH_ATTESTATION_ACTIVE_KEY_VERSION">>;
const attestationFields = {
  ...actorFields, openingFingerprint: fingerprintSchema, intentFingerprint: fingerprintSchema,
  replacementPasswordHash: z.string().min(1)
};
const attestationSchema = z.discriminatedUnion("purpose", [
  z.object({ ...attestationFields, purpose: z.literal("member_account_create"), newValues: createValuesSchema,
    oldCredentialVersion: z.null(), oldSessionSecurityVersion: z.null() }).strict(),
  z.object({ ...attestationFields, purpose: z.literal("member_password_reset"), newValues: resetValuesSchema,
    oldCredentialVersion: versionSchema, oldSessionSecurityVersion: versionSchema }).strict()
]);
export type AssistedCredentialAttestationInput = z.infer<typeof attestationSchema>;

function configuredSigningKey(environment: AttestationEnvironment) {
  const error = "assisted_attestation_keyring_invalid";
  function version(text: unknown): number {
    if (typeof text !== "string" || !/^[1-9][0-9]*$/.test(text) || !versionSchema.safeParse(Number(text)).success) throw new Error(error);
    return Number(text);
  }
  const active = version(environment.CUBBY_FRESH_AUTH_ATTESTATION_ACTIVE_KEY_VERSION);
  const configured = environment.CUBBY_FRESH_AUTH_ATTESTATION_KEYRING;
  if (typeof configured !== "string") throw new Error(error);
  const entries = configured.split(",");
  if (entries.length < 1 || entries.length > 2) throw new Error(error);
  const keys = new Map<number, Buffer>();
  for (const entry of entries) {
    const parts = entry.split(":");
    if (parts.length !== 2) throw new Error(error);
    const keyVersion = version(parts[0]);
    if (keys.has(keyVersion)) throw new Error(error);
    keys.set(keyVersion, decodeKey(parts[1], error));
  }
  const key = keys.get(active);
  if (!key) throw new Error(error);
  return { key, keyVersion: active };
}
function int64(value: bigint): Buffer {
  const bytes = Buffer.alloc(8);
  bytes.writeBigInt64BE(value);
  return bytes;
}

// Signing only: DB-clock freshness, prior-key expiry and nonce uniqueness remain SQL authority.
export function createAssistedCredentialAttestationSigner(environment: AttestationEnvironment,
  dependencies: { now?: () => Date; randomBytes?: (size: number) => Buffer } = {}) {
  const { key, keyVersion } = configuredSigningKey(environment);
  return {
    sign(input: unknown) {
      const parsed = attestationSchema.safeParse(input);
      if (!parsed.success) throw new Error("assisted_attestation_input_invalid");
      const value = parsed.data;
      const now = (dependencies.now ?? (() => new Date()))();
      const random = (dependencies.randomBytes ?? randomBytes)(32);
      if (!(now instanceof Date) || !Number.isFinite(now.getTime()) || !Buffer.isBuffer(random) || random.length !== 32) {
        throw new Error("assisted_attestation_input_invalid");
      }
      const issuedAt = new Date(now.getTime());
      const nonce = Buffer.from(random);
      const replacementPasswordHashDigest = createHash("sha256").update(value.replacementPasswordHash, "utf8").digest();
      const newValues = value.purpose === "member_account_create"
        ? [value.newValues.normalizedEmail, value.newValues.exactDisplayName, value.newValues.role]
        : [value.newValues.targetUserId, value.newValues.targetMemberId];
      // SQL's new-values digest uses a raw boolean byte, unlike the intent frame.
      const newValuesDigest = createHash("sha256").update(Buffer.concat([
        ...newValues.map(frame), booleanByte(value.newValues.requireFirstLoginPasswordChange)
      ])).digest();
      const encodedVersion = Buffer.alloc(4);
      encodedVersion.writeInt32BE(keyVersion);
      const payload = Buffer.concat([
        Buffer.from("cubby.admin-assisted-credential-mutation.v1", "utf8"),
        ...[value.purpose, value.actorUserId, value.actorSessionId, value.actorMemberId, value.householdId,
          value.operationId, value.openingFingerprint, value.intentFingerprint].map(frame),
        frame(replacementPasswordHashDigest), frame(newValuesDigest),
        int64(BigInt(value.oldCredentialVersion ?? -1)), int64(BigInt(value.oldSessionSecurityVersion ?? -1)),
        int64((BigInt(issuedAt.getTime()) - 946684800000n) * 1000n), frame(nonce), encodedVersion
      ]);
      return { keyVersion, nonce, issuedAt, replacementPasswordHashDigest, mac: createHmac("sha256", key).update(payload).digest() };
    }
  };
}
export type AssistedOperationKey = "member.account.create" | "member.password.reset";
const terminalPolicy = {
  "member.account.create": { kind: "member_account", code: "created", rejected: "existing_account_invitation_required" },
  "member.password.reset": { kind: "member_password", code: "reset", rejected: "personal_recovery_unavailable" }
} as const;
const staleCodeSchema = z.enum(["stale_context", "stale_target", "stale_revision"]);
export type AssistedProcedureResult =
  | { status: "completed"; operationId: string; outcome:
      { kind: "member_account"; code: "created"; memberId: string } | { kind: "member_password"; code: "reset"; memberId: string } }
  | { status: "rejected"; operationId: string; code: "existing_account_invitation_required" | "personal_recovery_unavailable" }
  | { status: "stale"; operationId: string; code: z.infer<typeof staleCodeSchema> }
  | { status: "pending"; operationId: string; code: "operation_unknown" }
  | { status: "expired"; operationId: string; code: "operation_result_expired" };

export function projectAssistedProcedureResult(key: AssistedOperationKey, operationId: string, input: unknown): AssistedProcedureResult {
  if (!Object.hasOwn(terminalPolicy, key) || !operationIdSchema.safeParse(operationId).success) throw new Error("assisted_operation_result_invalid");
  const policy = terminalPolicy[key];
  const identity = { operationId: z.literal(operationId) };
  const success = { ...identity, status: z.literal("completed"), outcomeCode: z.literal(policy.code) };
  const rejected = { ...identity, status: z.literal("rejected"), outcomeCode: z.literal(policy.rejected) };
  const stale = { ...identity, status: z.literal("stale"), outcomeCode: staleCodeSchema };
  const tableFields = {
    outcomeKind: z.literal(policy.kind), targetMemberId: identitySchema.nullable(),
    terminalAt: z.date().optional(), compacted: z.boolean()
  };
  const schema = z.union([
    z.object({ ...success, memberId: identitySchema }).strict(),
    z.object(rejected).strict(), z.object(stale).strict(),
    z.object({ ...success, ...tableFields, targetMemberId: identitySchema }).strict(),
    z.object({ ...rejected, ...tableFields }).strict(),
    z.object({ ...stale, ...tableFields }).strict(),
    z.object({ ...identity, status: z.literal("pending"), outcomeCode: z.null(), outcomeKind: z.null(),
      targetMemberId: identitySchema.nullable(), terminalAt: z.null(), compacted: z.literal(false) }).strict()
  ]);
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new Error("assisted_operation_result_invalid");
  const value = parsed.data;
  if ("compacted" in value && value.compacted) return { status: "expired", operationId, code: "operation_result_expired" };
  if (value.status === "pending") return { status: "pending", operationId, code: "operation_unknown" };
  if (value.status === "rejected") return { status: "rejected", operationId, code: value.outcomeCode };
  if (value.status === "stale") return { status: "stale", operationId, code: value.outcomeCode };
  const memberId = "memberId" in value ? value.memberId : value.targetMemberId;
  return { status: "completed", operationId, outcome: key === "member.account.create"
    ? { kind: "member_account", code: "created", memberId }
    : { kind: "member_password", code: "reset", memberId } };
}
