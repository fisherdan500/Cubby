import { GlobalSecurityOperationKey, type Prisma, type PrismaClient } from "@prisma/client";
import { assertGlobalSecurityOperationId, type FreshAuthThrottleContext, type GlobalSecurityContext, withGlobalSecurityTransaction } from "@/server/services/global-security";
import { generateRecoveryCodes, hashRecoveryCode, verifyRecoveryCode, type RecoveryCodeRecord } from "@/server/services/recovery-codes";
import { createFreshAuthAttestationSigner } from "@/server/services/fresh-auth-attestation";
import { optionalConfiguredGlobalSecurityThrottleKey, precheckGlobalSecurityThrottleInTransaction, recordGlobalSecurityThrottleFailureInTransaction, writeGlobalSecurityEvent } from "@/server/services/global-security-throttling";

type RecoveryDatabase = Pick<PrismaClient, "$transaction">;
type EnrollmentInput = { operationId: string; openingFingerprint: string; intentFingerprint: string };
type RecoveryCrypto = {
  generate: () => string[];
  hash: (code: string, ordinal: number) => Promise<RecoveryCodeRecord>;
};
type RecoveryThrottleInput = { key: string; userId: string; accountIdentifier: string; client: string };

function recoveryThrottleContext(context?: FreshAuthThrottleContext): { key: string; client: string } | undefined {
  const key = context?.key ?? optionalConfiguredGlobalSecurityThrottleKey();
  return key ? { key, client: context?.client ?? "unknown_client" } : undefined;
}

const dummyRecoveryRecord: RecoveryCodeRecord = {
  salt: Buffer.alloc(16, 0),
  derivedKey: Buffer.alloc(32, 0),
  kdfVersion: 1
};

async function bindingDeadlineIsCurrent(tx: Prisma.TransactionClient, bindingId: string) {
  const rows = await tx.$queryRaw<Array<{ authorized: boolean }>>`SELECT "expiresAt" > clock_timestamp() AS "authorized" FROM "GlobalSecurityOperationBinding" WHERE "id"=${bindingId} FOR UPDATE`;
  return rows.length === 1 && rows[0]!.authorized;
}

async function recoveryDeadlineIsCurrent(tx: Prisma.TransactionClient, recoverySessionId: string) {
  const rows = await tx.$queryRaw<Array<{ authorized: boolean }>>`SELECT "expiresAt" > clock_timestamp() AS "authorized" FROM "RecoverySession" WHERE "id"=${recoverySessionId} FOR UPDATE`;
  return rows.length === 1 && rows[0]!.authorized;
}

async function freshAuthGrantDeadlineIsCurrent(tx: Prisma.TransactionClient, grantId: string) {
  const rows = await tx.$queryRaw<Array<{ authorized: boolean }>>`SELECT "expiresAt" > clock_timestamp() AS "authorized" FROM "FreshAuthGrant" WHERE "id"=${grantId} FOR UPDATE`;
  return rows.length === 1 && rows[0]!.authorized;
}

async function requireEnrollmentOperation(
  tx: Prisma.TransactionClient,
  context: GlobalSecurityContext,
  input: EnrollmentInput
) {
  const binding = await tx.globalSecurityOperationBinding.findFirst({ where: { userId: context.userId, operationId: input.operationId } });
  if (!binding || binding.sessionId !== context.sessionId || binding.operationKey !== GlobalSecurityOperationKey.recoveryEnrollment || binding.securityVersion !== context.credentialVersion || binding.sessionSecurityVersion !== context.sessionSecurityVersion || binding.openingFingerprint !== input.openingFingerprint || binding.state !== "submitted" || !(await bindingDeadlineIsCurrent(tx, binding.id))) throw new Error("fresh_authentication_required");
  const operation = await tx.globalSecurityOperation.findFirst({ where: { bindingId: binding.id, userId: context.userId, operationId: input.operationId }, select: { intentFingerprint: true, status: true, outcomeCode: true, outcomeSnapshot: true } });
  if (!operation || operation.intentFingerprint !== input.intentFingerprint) throw new Error("idempotency_conflict");
  if (operation.status === "unknown") throw new Error("operation_outcome_unknown");
  if (operation.status !== "pending") throw new Error("idempotency_conflict");
  return binding;
}

async function requirePendingEnrollment(tx: Prisma.TransactionClient, context: GlobalSecurityContext, input: EnrollmentInput) {
  const binding = await requireEnrollmentOperation(tx, context, input);
  const existingSet = await tx.recoveryCodeSet.findFirst({ where: { userId: context.userId, issuanceOperationId: input.operationId }, select: { setVersion: true } });
  if (existingSet) throw new Error("recovery_codes_already_generated");
  return binding;
}

export async function issueRecoveryCodeSet(
  database: RecoveryDatabase,
  expected: GlobalSecurityContext,
  rawInput: EnrollmentInput,
  crypto: RecoveryCrypto = {
    generate: generateRecoveryCodes,
    hash: (code) => hashRecoveryCode(code)
  }
): Promise<{ operationId: string; setVersion: number; codes: string[] }> {
  const operationId = assertGlobalSecurityOperationId(rawInput.operationId);
  const input = { ...rawInput, operationId };

  await withGlobalSecurityTransaction(database, expected, async (context, tx) => {
    await requirePendingEnrollment(tx, context, input);
  });

  const codes = crypto.generate();
  if (codes.length !== 10 || new Set(codes).size !== 10) throw new Error("recovery_code_set_invalid");
  const hashes = await Promise.all(codes.map((code, index) => crypto.hash(code, index + 1)));

  const setVersion = await withGlobalSecurityTransaction(database, expected, async (context, tx) => {
    await requirePendingEnrollment(tx, context, input);
    const grant = await tx.freshAuthGrant.findFirst({ where: { userId: context.userId, sessionId: context.sessionId, operationId, credentialVersion: context.credentialVersion, purpose: "recovery_enrollment", state: "issued" }, select: { id: true } });
    if (!grant || !(await freshAuthGrantDeadlineIsCurrent(tx, grant.id))) throw new Error("fresh_authentication_required");
    const latest = await tx.recoveryCodeSet.findFirst({ where: { userId: context.userId }, orderBy: { setVersion: "desc" }, select: { setVersion: true } });
    const nextVersion = (latest?.setVersion ?? 0) + 1;
    const now = new Date();
    const supersededSets = await tx.recoveryCodeSet.findMany({ where: { userId: context.userId, state: { not: "invalidated" } }, select: { setVersion: true } });
    const consumedCodes = supersededSets.length === 0 ? [] : await tx.recoveryCode.findMany({ where: { userId: context.userId, setVersion: { in: supersededSets.map(({ setVersion }) => setVersion) }, state: "consumed", consumedPurpose: "recoveryReset" }, select: { id: true } });
    const restrictedSessions = consumedCodes.length === 0 ? [] : await tx.recoverySession.findMany({ where: { userId: context.userId, recoveryCodeId: { in: consumedCodes.map(({ id }) => id) }, state: "restricted" }, select: { id: true, operationId: true } });
    for (const restricted of restrictedSessions) {
      await tx.globalSecurityOperation.updateMany({ where: { userId: context.userId, operationId: restricted.operationId, status: { in: ["pending", "unknown"] } }, data: { status: "rejected", outcomeVersion: 1, outcomeCode: "recovery_set_regenerated", outcomeSnapshot: {}, terminalAt: now } });
      await tx.globalSecurityOperationBinding.updateMany({ where: { userId: context.userId, operationId: restricted.operationId, state: "submitted" }, data: { state: "terminal" } });
      await tx.recoverySession.update({ where: { id: restricted.id }, data: { state: "closed", closedAt: now } });
      await tx.$executeRaw`SELECT "write_global_security_event"(${context.userId},'operation_outcome','rejected',${restricted.operationId})`;
    }
    await tx.recoveryCode.updateMany({ where: { userId: context.userId, state: "active" }, data: { state: "invalidated", invalidatedAt: now } });
    await tx.recoveryCodeSet.updateMany({ where: { userId: context.userId, state: { not: "invalidated" } }, data: { state: "invalidated" } });
    await tx.recoveryCodeSet.create({ data: { userId: context.userId, setVersion: nextVersion, issuanceOperationId: operationId, freshAuthGrantId: grant.id, issuanceSecurityVersion: context.credentialVersion, issuanceSessionSecurityVersion: context.sessionSecurityVersion, expectedCodeCount: 10, state: "generated" } });
    await tx.recoveryCode.createMany({ data: hashes.map((record, index) => ({ userId: context.userId, setVersion: nextVersion, ordinal: index + 1, salt: Buffer.from(record.salt), derivedKey: Buffer.from(record.derivedKey), kdfVersion: record.kdfVersion, state: "active" })) });
    await tx.freshAuthGrant.update({ where: { id: grant.id }, data: { state: "consumed", consumedAt: now } });
    await writeGlobalSecurityEvent(tx, context.userId, "recovery", "code_set_generated", operationId);
    return nextVersion;
  });
  return { operationId, setVersion, codes };
}

export async function acknowledgeRecoveryCodeSetSaved(
  database: RecoveryDatabase,
  expected: GlobalSecurityContext,
  rawInput: { operationId: string; setVersion: number }
): Promise<{ operationId: string; setVersion: number; state: "rehearsal_required" }> {
  const operationId = assertGlobalSecurityOperationId(rawInput.operationId);
  return withGlobalSecurityTransaction(database, expected, async (context, tx) => {
    const set = await tx.recoveryCodeSet.findFirst({
      where: { userId: context.userId, setVersion: rawInput.setVersion, issuanceOperationId: operationId },
      select: { state: true }
    });
    if (!set) throw new Error("recovery_code_set_not_generated");
    if (set.state === "rehearsalRequired") return { operationId, setVersion: rawInput.setVersion, state: "rehearsal_required" };
    if (set.state !== "generated") throw new Error("recovery_code_set_not_generated");
    const now = new Date();
    await tx.recoveryCodeSet.update({
      where: { userId_setVersion: { userId: context.userId, setVersion: rawInput.setVersion } },
      data: { state: "saveAcknowledged", saveAcknowledgedAt: now }
    });
    await tx.recoveryCodeSet.update({
      where: { userId_setVersion: { userId: context.userId, setVersion: rawInput.setVersion } },
      data: { state: "rehearsalRequired" }
    });
    return { operationId, setVersion: rawInput.setVersion, state: "rehearsal_required" };
  });
}

export async function getRecoveryEnrollmentStatus(
  database: RecoveryDatabase,
  expected: GlobalSecurityContext,
  rawInput: { operationId: string; openingFingerprint: string; intentFingerprint: string }
): Promise<{ operationId: string; setVersion: number; state: string; status: string; outcomeCode: string | null; remainingCodes: number; terminalAt: Date | null }> {
  const operationId = assertGlobalSecurityOperationId(rawInput.operationId);
  return withGlobalSecurityTransaction(database, expected, async (context, tx) => {
    const binding = await tx.globalSecurityOperationBinding.findFirst({ where: { userId: context.userId, operationId } });
    if (!binding || binding.sessionId !== context.sessionId || binding.recoverySessionId !== null || binding.operationKey !== GlobalSecurityOperationKey.recoveryEnrollment || binding.securityVersion !== context.credentialVersion || binding.sessionSecurityVersion !== context.sessionSecurityVersion || binding.openingFingerprint !== rawInput.openingFingerprint || !["submitted", "terminal"].includes(binding.state) || (binding.state === "submitted" && !(await bindingDeadlineIsCurrent(tx, binding.id)))) throw new Error("not_found");
    const operation = await tx.globalSecurityOperation.findFirst({ where: { bindingId: binding.id, userId: context.userId, operationId }, select: { intentFingerprint: true, status: true, outcomeCode: true, terminalAt: true } });
    const set = await tx.recoveryCodeSet.findFirst({ where: { userId: context.userId, issuanceOperationId: operationId }, select: { setVersion: true, state: true } });
    if (!operation || operation.intentFingerprint !== rawInput.intentFingerprint || !set) throw new Error("not_found");
    const remainingCodes = await tx.recoveryCode.count({ where: { userId: context.userId, setVersion: set.setVersion, state: "active" } });
    return { operationId, setVersion: set.setVersion, state: set.state, status: operation.status, outcomeCode: operation.outcomeCode, remainingCodes, terminalAt: operation.terminalAt };
  });
}

export async function rehearseRecoveryCodeSet(
  database: RecoveryDatabase,
  expected: GlobalSecurityContext,
  rawInput: EnrollmentInput & { setVersion: number; code: string },
  crypto: { verify: (code: string, record: RecoveryCodeRecord) => Promise<boolean> } = { verify: verifyRecoveryCode },
  throttleContext?: FreshAuthThrottleContext
): Promise<{ operationId: string; setVersion: number; state: "rehearsed"; remainingCodes: 9 }> {
  const operationId = assertGlobalSecurityOperationId(rawInput.operationId);
  const input = { ...rawInput, operationId };
  const configuredThrottle = recoveryThrottleContext(throttleContext);
  const snapshot = await withGlobalSecurityTransaction(database, expected, async (context, tx) => {
    await requireEnrollmentOperation(tx, context, input);
    const set = await tx.recoveryCodeSet.findFirst({ where: { userId: context.userId, setVersion: input.setVersion, issuanceOperationId: operationId }, select: { state: true } });
    if (!set || set.state !== "rehearsalRequired") throw new Error("recovery_rehearsal_not_required");
    const user = configuredThrottle && await tx.user.findUnique({ where: { id: context.userId }, select: { email: true } });
    if (configuredThrottle && !user?.email) throw new Error("recovery_code_invalid");
    const throttle = configuredThrottle && user ? { key: configuredThrottle.key, userId: context.userId, accountIdentifier: user.email, client: configuredThrottle.client } satisfies RecoveryThrottleInput : undefined;
    const quiet = throttle ? (await precheckGlobalSecurityThrottleInTransaction(tx, throttle)).quiet : false;
    return { records: await tx.recoveryCode.findMany({ where: { userId: context.userId, setVersion: input.setVersion, state: "active" }, select: { id: true, salt: true, derivedKey: true, kdfVersion: true } }), throttle, quiet };
  });
  const matches: typeof snapshot.records = [];
  if (snapshot.quiet) await crypto.verify(input.code, dummyRecoveryRecord);
  for (const record of snapshot.quiet ? [] : snapshot.records) {
    if (await crypto.verify(input.code, { salt: Buffer.from(record.salt), derivedKey: Buffer.from(record.derivedKey), kdfVersion: record.kdfVersion as 1 })) matches.push(record);
  }
  if (matches.length !== 1) {
    await withGlobalSecurityTransaction(database, expected, async (context, tx) => {
      const binding = await requireEnrollmentOperation(tx, context, input);
      const set = await tx.recoveryCodeSet.findFirst({ where: { userId: context.userId, setVersion: input.setVersion, issuanceOperationId: operationId }, select: { state: true } });
      if (!set || set.state !== "rehearsalRequired") throw new Error("recovery_rehearsal_not_required");
      const now = new Date();
      if (snapshot.throttle) await recordGlobalSecurityThrottleFailureInTransaction(tx, snapshot.throttle);
      await tx.globalSecurityOperation.update({ where: { userId_operationId: { userId: context.userId, operationId } }, data: { status: "rejected", outcomeVersion: 1, outcomeCode: "rehearsal_failed", outcomeSnapshot: {}, terminalAt: now } });
      await tx.globalSecurityOperationBinding.update({ where: { id: binding.id }, data: { state: "terminal" } });
      await writeGlobalSecurityEvent(tx, context.userId, "recovery", "rehearsal_failed", operationId);
      await tx.$executeRaw`SELECT "write_global_security_event"(${context.userId},'operation_outcome','rejected',${operationId})`;
    });
    throw new Error("recovery_code_invalid");
  }
  const matched = matches[0]!;
  return withGlobalSecurityTransaction(database, expected, async (context, tx) => {
    const binding = await requireEnrollmentOperation(tx, context, input);
    const set = await tx.recoveryCodeSet.findFirst({ where: { userId: context.userId, setVersion: input.setVersion, issuanceOperationId: operationId }, select: { state: true } });
    if (!set || set.state !== "rehearsalRequired") throw new Error("recovery_rehearsal_not_required");
    const code = await tx.recoveryCode.findFirst({ where: { id: matched.id, userId: context.userId, setVersion: input.setVersion, state: "active" }, select: { id: true, salt: true, derivedKey: true, kdfVersion: true } });
    if (!code || !Buffer.from(code.salt).equals(Buffer.from(matched.salt)) || !Buffer.from(code.derivedKey).equals(Buffer.from(matched.derivedKey)) || code.kdfVersion !== matched.kdfVersion) throw new Error("recovery_code_invalid");
    const now = new Date();
    await tx.recoveryCode.update({ where: { id: code.id }, data: { state: "consumed", consumedPurpose: "enrollmentRehearsal", consumedOperationId: operationId, consumedAt: now } });
    await tx.recoveryCodeSet.update({ where: { userId_setVersion: { userId: context.userId, setVersion: input.setVersion } }, data: { state: "rehearsed", rehearsedAt: now } });
    await tx.globalSecurityOperation.update({ where: { userId_operationId: { userId: context.userId, operationId } }, data: { status: "completed", outcomeVersion: 1, outcomeCode: "rehearsal_completed", outcomeSnapshot: { setVersion: input.setVersion, remainingCodes: 9 }, terminalAt: now } });
    await tx.globalSecurityOperationBinding.update({ where: { id: binding.id }, data: { state: "terminal" } });
    await writeGlobalSecurityEvent(tx, context.userId, "recovery", "rehearsed", operationId);
    await tx.$executeRaw`SELECT "write_global_security_event"(${context.userId},'operation_outcome','completed',${operationId})`;
    return { operationId, setVersion: input.setVersion, state: "rehearsed", remainingCodes: 9 };
  });
}

async function lockRecoverySecurityState(tx: Prisma.TransactionClient, userId: string) {
  const users = await tx.$queryRaw<Array<{ id: string; email: string }>>`SELECT "id","email" FROM "User" WHERE "id"=${userId} FOR UPDATE`;
  const states = await tx.$queryRaw<Array<{ credentialVersion: number; sessionSecurityVersion: number }>>`SELECT "credentialVersion", "sessionSecurityVersion" FROM "AccountSecurityState" WHERE "userId"=${userId} FOR UPDATE`;
  if (users.length !== 1 || states.length !== 1) throw new Error("recovery_code_invalid");
  return { ...states[0]!, email: users[0]!.email };
}

async function terminalizeRecoveryResetStale(tx: Prisma.TransactionClient, userId: string, recoverySessionId: string, bindingId: string, operationId: string) {
  const now = new Date();
  await tx.globalSecurityOperation.update({ where: { userId_operationId: { userId, operationId } }, data: { status: "stale", outcomeVersion: 1, outcomeCode: "stale_security_version", outcomeSnapshot: {}, terminalAt: now } });
  await tx.globalSecurityOperationBinding.update({ where: { id: bindingId }, data: { state: "terminal" } });
  await tx.recoverySession.update({ where: { id: recoverySessionId }, data: { state: "closed", closedAt: now } });
  await tx.$executeRaw`SELECT "write_global_security_event"(${userId},'operation_outcome','stale_security_version',${operationId})`;
}

async function terminalizeRecoveryResetRegenerated(tx: Prisma.TransactionClient, userId: string, recoverySessionId: string, bindingId: string, operationId: string) {
  const now = new Date();
  await tx.globalSecurityOperation.update({ where: { userId_operationId: { userId, operationId } }, data: { status: "rejected", outcomeVersion: 1, outcomeCode: "recovery_set_regenerated", outcomeSnapshot: {}, terminalAt: now } });
  await tx.globalSecurityOperationBinding.update({ where: { id: bindingId }, data: { state: "terminal" } });
  await tx.recoverySession.update({ where: { id: recoverySessionId }, data: { state: "closed", closedAt: now } });
  await tx.$executeRaw`SELECT "write_global_security_event"(${userId},'operation_outcome','rejected',${operationId})`;
}

async function recoveryCarrierSetIsCurrent(tx: Prisma.TransactionClient, userId: string, recoveryCodeId: string) {
  const code = await tx.recoveryCode.findFirst({ where: { id: recoveryCodeId, userId }, select: { setVersion: true } });
  if (!code) return false;
  const set = await tx.recoveryCodeSet.findFirst({ where: { userId, setVersion: code.setVersion }, select: { state: true } });
  if (!set || set.state !== "rehearsed") return false;
  return (await tx.recoveryCodeSet.count({ where: { userId, setVersion: { gt: code.setVersion }, state: { not: "invalidated" } } })) === 0;
}

export async function beginRecoveryReset(
  database: RecoveryDatabase,
  rawInput: { userId: string; operationId: string; openingFingerprint: string; intentFingerprint: string; code: string },
  crypto: { verify: (code: string, record: RecoveryCodeRecord) => Promise<boolean> } = { verify: verifyRecoveryCode },
  passwordTransition?: { replacementPasswordHash: string; signer?: ReturnType<typeof createFreshAuthAttestationSigner> },
  throttleContext?: FreshAuthThrottleContext
): Promise<{ operationId: string; recoverySessionId: string; expiresAt: Date }> {
  const operationId = assertGlobalSecurityOperationId(rawInput.operationId);
  const configuredThrottle = recoveryThrottleContext(throttleContext);
  const snapshot = await database.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('global-security-transition:v1', 0))`;
    const state = await lockRecoverySecurityState(tx, rawInput.userId);
    const existing = await tx.recoverySession.findFirst({ where: { userId: rawInput.userId, operationId } });
    if (existing) {
      const binding = await tx.globalSecurityOperationBinding.findFirst({ where: { userId: rawInput.userId, operationId } });
      const operation = binding && await tx.globalSecurityOperation.findFirst({ where: { bindingId: binding.id, userId: rawInput.userId, operationId }, select: { intentFingerprint: true, status: true } });
      if (!binding || !operation || existing.state !== "restricted" || binding.recoverySessionId !== existing.id || binding.sessionId !== null || binding.operationKey !== GlobalSecurityOperationKey.recoveryReset || binding.openingFingerprint !== rawInput.openingFingerprint || binding.state !== "submitted" || operation.intentFingerprint !== rawInput.intentFingerprint || operation.status !== "pending") throw new Error("idempotency_conflict");
      if (!(await recoveryCarrierSetIsCurrent(tx, rawInput.userId, existing.recoveryCodeId))) {
        await terminalizeRecoveryResetRegenerated(tx, rawInput.userId, existing.id, binding.id, operationId);
        return { replay: null, codes: null, error: "recovery_set_regenerated" };
      }
      if (!(await recoveryDeadlineIsCurrent(tx, existing.id))) {
        await tx.$executeRaw`SELECT "expire_recovery_session_finalization"(${rawInput.userId}, ${existing.id})`;
        return { replay: null, codes: null, error: "recovery_session_expired" };
      }
      if (binding.securityVersion !== state.credentialVersion || binding.sessionSecurityVersion !== state.sessionSecurityVersion) {
        await terminalizeRecoveryResetStale(tx, rawInput.userId, existing.id, binding.id, operationId);
        return { replay: null, codes: null, error: "stale_security_version" };
      }
      return { replay: { operationId, recoverySessionId: existing.id, expiresAt: existing.expiresAt }, codes: null, error: null };
    }
    const throttle = configuredThrottle ? { key: configuredThrottle.key, userId: rawInput.userId, accountIdentifier: state.email, client: configuredThrottle.client } satisfies RecoveryThrottleInput : undefined;
    const quiet = throttle ? (await precheckGlobalSecurityThrottleInTransaction(tx, throttle)).quiet : false;
    const set = await tx.recoveryCodeSet.findFirst({ where: { userId: rawInput.userId, state: "rehearsed" }, orderBy: { setVersion: "desc" }, select: { setVersion: true } });
    const codes = set ? await tx.recoveryCode.findMany({ where: { userId: rawInput.userId, setVersion: set.setVersion, state: "active" }, select: { id: true, setVersion: true, salt: true, derivedKey: true, kdfVersion: true } }) : [];
    return { replay: null, codes, throttle, quiet, error: null };
  }, { isolationLevel: "Serializable" });
  if (snapshot.error) throw new Error(snapshot.error);
  if (snapshot.replay) return snapshot.replay;
  const snapshotThrottle = "throttle" in snapshot ? snapshot.throttle : undefined;
  const snapshotQuiet = "quiet" in snapshot && snapshot.quiet;
  const matches: NonNullable<typeof snapshot.codes> = [];
  const records = snapshot.codes ?? [];
  if (records.length > 9) throw new Error("recovery_code_invalid");
  for (let index = 0; index < 9; index += 1) {
    const record = snapshotQuiet ? undefined : records[index];
    const candidate = record
      ? { salt: Buffer.from(record.salt), derivedKey: Buffer.from(record.derivedKey), kdfVersion: record.kdfVersion as 1 }
      : dummyRecoveryRecord;
    const valid = await crypto.verify(rawInput.code, candidate).catch(() => false);
    if (record && valid) matches.push(record);
  }
  if (matches.length !== 1) {
    await database.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('global-security-transition:v1', 0))`;
      const state = await lockRecoverySecurityState(tx, rawInput.userId);
      const existing = await tx.recoverySession.findFirst({ where: { userId: rawInput.userId, operationId } });
      if (existing) throw new Error("idempotency_conflict");
      if (snapshotThrottle) await recordGlobalSecurityThrottleFailureInTransaction(tx, { ...snapshotThrottle, accountIdentifier: state.email });
      if (snapshotThrottle) await writeGlobalSecurityEvent(tx, rawInput.userId, "recovery", "reset_failed");
    }, { isolationLevel: "Serializable" });
    throw new Error("recovery_code_invalid");
  }
  const matched = matches[0]!;
  const result = await database.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('global-security-transition:v1', 0))`;
    const state = await lockRecoverySecurityState(tx, rawInput.userId);
    const existing = await tx.recoverySession.findFirst({ where: { userId: rawInput.userId, operationId } });
    if (existing) {
      const binding = await tx.globalSecurityOperationBinding.findFirst({ where: { userId: rawInput.userId, operationId } });
      const operation = binding && await tx.globalSecurityOperation.findFirst({ where: { bindingId: binding.id, userId: rawInput.userId, operationId }, select: { intentFingerprint: true, status: true } });
      if (!binding || !operation || existing.state !== "restricted" || existing.recoveryCodeId !== matched.id || binding.recoverySessionId !== existing.id || binding.openingFingerprint !== rawInput.openingFingerprint || binding.state !== "submitted" || operation.intentFingerprint !== rawInput.intentFingerprint || operation.status !== "pending") throw new Error("idempotency_conflict");
      if (!(await recoveryCarrierSetIsCurrent(tx, rawInput.userId, existing.recoveryCodeId))) {
        await terminalizeRecoveryResetRegenerated(tx, rawInput.userId, existing.id, binding.id, operationId);
        return { operationId, recoverySessionId: null, expiresAt: null, error: "recovery_set_regenerated" };
      }
      if (!(await recoveryDeadlineIsCurrent(tx, existing.id))) {
        await tx.$executeRaw`SELECT "expire_recovery_session_finalization"(${rawInput.userId}, ${existing.id})`;
        return { operationId, recoverySessionId: null, expiresAt: null, error: "recovery_session_expired" };
      }
      if (binding.securityVersion !== state.credentialVersion || binding.sessionSecurityVersion !== state.sessionSecurityVersion) {
        await terminalizeRecoveryResetStale(tx, rawInput.userId, existing.id, binding.id, operationId);
        return { operationId, recoverySessionId: null, expiresAt: null, error: "stale_security_version" };
      }
      return { operationId, recoverySessionId: existing.id, expiresAt: existing.expiresAt, error: null };
    }
    const set = await tx.recoveryCodeSet.findFirst({ where: { userId: rawInput.userId, setVersion: matched.setVersion, state: "rehearsed" }, select: { setVersion: true } });
    const code = set && await tx.recoveryCode.findFirst({ where: { id: matched.id, userId: rawInput.userId, setVersion: matched.setVersion, state: "active" }, select: { id: true, salt: true, derivedKey: true, kdfVersion: true } });
    if (!code || !Buffer.from(code.salt).equals(Buffer.from(matched.salt)) || !Buffer.from(code.derivedKey).equals(Buffer.from(matched.derivedKey)) || code.kdfVersion !== matched.kdfVersion) throw new Error("recovery_code_invalid");
    const [{ createdAt, expiresAt }] = await tx.$queryRaw<Array<{ createdAt: Date; expiresAt: Date }>>`SELECT clock_timestamp() AS "createdAt", clock_timestamp() + INTERVAL '10 minutes' AS "expiresAt"`;
    const signer = passwordTransition?.signer ?? (passwordTransition ? createFreshAuthAttestationSigner() : undefined);
    const replacementPasswordHashDigest = passwordTransition && signer ? signer.digestReplacementPasswordHash(passwordTransition.replacementPasswordHash) : undefined;
    const attestation = signer && replacementPasswordHashDigest ? signer.signRecoveryReset({ userId: rawInput.userId, recoveryCodeId: code.id, setVersion: matched.setVersion, operationId, credentialVersion: state.credentialVersion, sessionSecurityVersion: state.sessionSecurityVersion, openingFingerprint: rawInput.openingFingerprint, intentFingerprint: rawInput.intentFingerprint, replacementPasswordHashDigest }) : undefined;
    const recoverySession = await tx.recoverySession.create({ data: { userId: rawInput.userId, recoveryCodeId: code.id, operationId, purpose: "recovery_reset", state: "restricted", createdAt, expiresAt, attestationNonce: attestation?.nonce, attestationMac: attestation ? Uint8Array.from(attestation.mac) : undefined, attestationKeyVersion: attestation?.keyVersion, replacementPasswordHashDigest: replacementPasswordHashDigest ? Uint8Array.from(replacementPasswordHashDigest) : undefined, attestedOpeningFingerprint: attestation ? rawInput.openingFingerprint : undefined, attestedIntentFingerprint: attestation ? rawInput.intentFingerprint : undefined } });
    const binding = await tx.globalSecurityOperationBinding.create({ data: { userId: rawInput.userId, sessionId: null, recoverySessionId: recoverySession.id, operationId, operationKey: GlobalSecurityOperationKey.recoveryReset, securityVersion: state.credentialVersion, sessionSecurityVersion: state.sessionSecurityVersion, openingFingerprint: rawInput.openingFingerprint, targetSnapshot: {}, state: "open", expiresAt } });
    await tx.globalSecurityOperation.create({ data: { bindingId: binding.id, userId: rawInput.userId, operationId, operationKey: GlobalSecurityOperationKey.recoveryReset, intentFingerprint: rawInput.intentFingerprint, status: "pending" } });
    await tx.globalSecurityOperationBinding.update({ where: { id: binding.id }, data: { state: "submitted" } });
    await tx.recoveryCode.update({ where: { id: code.id }, data: { state: "consumed", consumedPurpose: "recoveryReset", consumedOperationId: operationId, consumedAt: createdAt } });
    if (configuredThrottle) await writeGlobalSecurityEvent(tx, rawInput.userId, "recovery", "reset_started", operationId);
    return { operationId, recoverySessionId: recoverySession.id, expiresAt, error: null };
  }, { isolationLevel: "Serializable" });
  if (result.error) throw new Error(result.error);
  return { operationId: result.operationId, recoverySessionId: result.recoverySessionId!, expiresAt: result.expiresAt! };
}

export type RecoverySecurityContext = {
  userId: string;
  recoverySessionId: string;
  operationId: string;
  credentialVersion: number;
  sessionSecurityVersion: number;
};

export async function finalizeRecoveryPasswordReset(
  database: RecoveryDatabase,
  expected: RecoverySecurityContext,
  input: { openingFingerprint: string; intentFingerprint: string },
  newPassword: string,
  hasher: { hash: (password: string) => Promise<string> },
  prehashedPasswordHash?: string
): Promise<{ operationId: string; status: "signed_out" }> {
  const passwordHash = prehashedPasswordHash ?? await hasher.hash(newPassword);
  const operationId = assertGlobalSecurityOperationId(expected.operationId);
  try {
    return await database.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('global-security-transition:v1', 0))`;
    const state = await lockRecoverySecurityState(tx, expected.userId);
    if (state.credentialVersion !== expected.credentialVersion || state.sessionSecurityVersion !== expected.sessionSecurityVersion) throw new Error("stale_security_version");
    const recoverySession = await tx.recoverySession.findFirst({ where: { id: expected.recoverySessionId, userId: expected.userId, operationId } });
    if (!recoverySession || recoverySession.purpose !== "recovery_reset" || recoverySession.state !== "restricted" || !(await recoveryDeadlineIsCurrent(tx, recoverySession.id))) throw new Error("recovery_session_expired");
    const binding = await tx.globalSecurityOperationBinding.findFirst({ where: { userId: expected.userId, operationId } });
    if (!binding || binding.sessionId !== null || binding.recoverySessionId !== recoverySession.id || binding.operationKey !== GlobalSecurityOperationKey.recoveryReset || binding.securityVersion !== expected.credentialVersion || binding.sessionSecurityVersion !== expected.sessionSecurityVersion || binding.openingFingerprint !== input.openingFingerprint || binding.state !== "submitted") throw new Error("recovery_reset_authorization_required");
    const operation = await tx.globalSecurityOperation.findFirst({ where: { bindingId: binding.id, userId: expected.userId, operationId }, select: { intentFingerprint: true, status: true } });
    if (!operation || operation.intentFingerprint !== input.intentFingerprint) throw new Error("idempotency_conflict");
    if (operation.status === "unknown") throw new Error("operation_outcome_unknown");
    if (operation.status !== "pending") throw new Error("recovery_reset_authorization_required");
    const account = await tx.account.findFirst({ where: { userId: expected.userId, providerId: "credential" }, select: { id: true } });
    if (!account) throw new Error("recovery_reset_authorization_required");
    const now = new Date();
    await tx.accountSecurityState.update({ where: { userId: expected.userId }, data: { credentialVersion: { increment: 1 }, sessionSecurityVersion: { increment: 1 }, lastCredentialOperationId: operationId, lastSessionSecurityOperationId: operationId } });
    await tx.$executeRaw`SELECT "apply_recovery_reset_credential_mutation"(${expected.userId}, ${operationId}, ${account.id}, ${passwordHash})`;
    await tx.freshAuthGrant.updateMany({ where: { userId: expected.userId, state: "issued" }, data: { state: "revoked", revokedAt: now } });
    await tx.$executeRaw`SELECT "revoke_sessions_for_global_security_operation"(${expected.userId},${operationId})`;
    await tx.globalSecurityOperation.update({ where: { userId_operationId: { userId: expected.userId, operationId } }, data: { status: "completed", outcomeVersion: 1, outcomeCode: "reset_completed", outcomeSnapshot: {}, terminalAt: now } });
    await tx.globalSecurityOperationBinding.update({ where: { id: binding.id }, data: { state: "terminal" } });
    await tx.recoverySession.update({ where: { id: recoverySession.id }, data: { state: "closed", closedAt: now } });
    await writeGlobalSecurityEvent(tx, expected.userId, "recovery", "reset_completed", operationId);
    await tx.$executeRaw`SELECT "write_global_security_event"(${expected.userId},'operation_outcome','completed',${operationId})`;
    return { operationId, status: "signed_out" };
    }, { isolationLevel: "Serializable" });
  } catch (error) {
    if (error instanceof Error && error.message === "stale_security_version") await finalizeStaleRecoveryReset(database, expected, input);
    throw error;
  }
}

export async function finalizeStaleRecoveryReset(
  database: RecoveryDatabase,
  expected: RecoverySecurityContext,
  input: { openingFingerprint: string; intentFingerprint: string }
): Promise<void> {
  const operationId = assertGlobalSecurityOperationId(expected.operationId);
  await database.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('global-security-transition:v1', 0))`;
    const recoverySession = await tx.recoverySession.findFirst({ where: { id: expected.recoverySessionId, userId: expected.userId, operationId } });
    const binding = recoverySession && await tx.globalSecurityOperationBinding.findFirst({ where: { userId: expected.userId, operationId } });
    const operation = binding && await tx.globalSecurityOperation.findFirst({ where: { bindingId: binding.id, userId: expected.userId, operationId }, select: { intentFingerprint: true, status: true } });
    if (!recoverySession || !binding || !operation || recoverySession.purpose !== "recovery_reset" || recoverySession.state !== "restricted" || binding.recoverySessionId !== recoverySession.id || binding.sessionId !== null || binding.operationKey !== GlobalSecurityOperationKey.recoveryReset || binding.securityVersion !== expected.credentialVersion || binding.sessionSecurityVersion !== expected.sessionSecurityVersion || binding.openingFingerprint !== input.openingFingerprint || binding.state !== "submitted" || operation.intentFingerprint !== input.intentFingerprint || operation.status !== "pending") throw new Error("stale_security_version");
    const now = new Date();
    await tx.globalSecurityOperation.update({ where: { userId_operationId: { userId: expected.userId, operationId } }, data: { status: "stale", outcomeVersion: 1, outcomeCode: "stale_security_version", outcomeSnapshot: {}, terminalAt: now } });
    await tx.globalSecurityOperationBinding.update({ where: { id: binding.id }, data: { state: "terminal" } });
    await tx.recoverySession.update({ where: { id: recoverySession.id }, data: { state: "closed", closedAt: now } });
    await tx.$executeRaw`SELECT "write_global_security_event"(${expected.userId},'operation_outcome','stale_security_version',${operationId})`;
  }, { isolationLevel: "Serializable" });
}

export async function recoverPasswordWithCode(
  database: RecoveryDatabase,
  input: { userId: string; operationId: string; openingFingerprint: string; intentFingerprint: string; code: string; credentialVersion: number; sessionSecurityVersion: number },
  newPassword: string,
  hasher: { hash: (password: string) => Promise<string> },
  crypto: { verify: (code: string, record: RecoveryCodeRecord) => Promise<boolean> } = { verify: verifyRecoveryCode },
  signer: ReturnType<typeof createFreshAuthAttestationSigner> = createFreshAuthAttestationSigner(),
  throttleContext?: FreshAuthThrottleContext
) {
  const replacementPasswordHash = await hasher.hash(newPassword);
  const opened = await beginRecoveryReset(database, input, crypto, { replacementPasswordHash, signer }, throttleContext);
  const finalized = await finalizeRecoveryPasswordReset(database, { userId: input.userId, recoverySessionId: opened.recoverySessionId, operationId: input.operationId, credentialVersion: input.credentialVersion, sessionSecurityVersion: input.sessionSecurityVersion }, input, newPassword, hasher, replacementPasswordHash);
  return { ...finalized, recoverySessionId: opened.recoverySessionId };
}

export async function getRecoveryResetStatus(
  database: RecoveryDatabase,
  rawInput: { userId: string; recoverySessionId: string; operationId: string; openingFingerprint: string; intentFingerprint: string }
): Promise<{ operationId: string; state: string; status: string; outcomeCode: string | null; terminalAt: Date | null }> {
  const operationId = assertGlobalSecurityOperationId(rawInput.operationId);
  return database.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('global-security-transition:v1', 0))`;
    let recoverySession = await tx.recoverySession.findFirst({ where: { id: rawInput.recoverySessionId, userId: rawInput.userId, operationId } });
    if (!recoverySession || recoverySession.purpose !== "recovery_reset") throw new Error("not_found");
    const binding = await tx.globalSecurityOperationBinding.findFirst({ where: { userId: rawInput.userId, operationId } });
    if (!binding || binding.recoverySessionId !== recoverySession.id || binding.sessionId !== null || binding.operationKey !== GlobalSecurityOperationKey.recoveryReset || binding.openingFingerprint !== rawInput.openingFingerprint) throw new Error("not_found");
    if (recoverySession.state === "restricted" && !(await recoveryDeadlineIsCurrent(tx, recoverySession.id))) {
      await tx.$executeRaw`SELECT "expire_recovery_session_finalization"(${rawInput.userId}, ${recoverySession.id})`;
      recoverySession = await tx.recoverySession.findFirst({ where: { id: rawInput.recoverySessionId, userId: rawInput.userId, operationId } });
      if (!recoverySession) throw new Error("not_found");
    }
    const operation = await tx.globalSecurityOperation.findFirst({ where: { bindingId: binding.id, userId: rawInput.userId, operationId }, select: { intentFingerprint: true, status: true, outcomeCode: true, terminalAt: true } });
    if (!operation || operation.intentFingerprint !== rawInput.intentFingerprint) throw new Error("not_found");
    return { operationId, state: recoverySession.state, status: operation.status, outcomeCode: operation.outcomeCode, terminalAt: operation.terminalAt };
  }, { isolationLevel: "Serializable" });
}
