import { GlobalSecurityOperationKey, type Prisma, type PrismaClient } from "@prisma/client";
import { createFreshAuthAttestationSigner } from "@/server/services/fresh-auth-attestation";
import { optionalConfiguredGlobalSecurityThrottleKey, precheckGlobalSecurityThrottleInTransaction, recordGlobalSecurityThrottleFailureInTransaction, writeGlobalSecurityEvent } from "@/server/services/global-security-throttling";

export type GlobalSecurityContext = {
  userId: string;
  sessionId: string;
  credentialVersion: number;
  sessionSecurityVersion: number;
};

type GlobalSecurityTransaction = Prisma.TransactionClient;

type GlobalSecurityDatabase = Pick<PrismaClient, "$transaction">;

export async function lockGlobalSecurityContext(
  tx: GlobalSecurityTransaction,
  identity: { userId: string; sessionId: string }
): Promise<GlobalSecurityContext> {
  const users = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "User" WHERE "id" = ${identity.userId} FOR UPDATE
  `;
  if (users.length !== 1) throw new Error("unauthenticated");
  const state = await tx.accountSecurityState.upsert({
    where: { userId: identity.userId },
    create: { userId: identity.userId, credentialVersion: 1, sessionSecurityVersion: 1 },
    update: {}
  });
  const sessions = await tx.$queryRaw<Array<{ id: string; userId: string }>>`
    SELECT "id", "userId" FROM "Session" WHERE "id"=${identity.sessionId} AND "userId"=${identity.userId}
  `;
  if (sessions.length !== 1) throw new Error("unauthenticated");
  const authorized = await tx.$queryRaw<Array<{ authorized: boolean }>>`
    SELECT "authorized" FROM "authorize_global_session_security"(${identity.userId},${identity.sessionId},NULL)
  `;
  if (authorized.length !== 1 || !authorized[0]?.authorized) throw new Error("unauthenticated");
  return { ...identity, credentialVersion: state.credentialVersion, sessionSecurityVersion: state.sessionSecurityVersion };
}

export async function captureGlobalSecurityContext(
  database: GlobalSecurityDatabase,
  identity: { userId: string; sessionId: string }
): Promise<GlobalSecurityContext> {
  return database.$transaction(
    (tx) => lockGlobalSecurityContext(tx, identity),
    { isolationLevel: "Serializable" }
  );
}

export async function reauthorizeGlobalSecurityContext(
  tx: GlobalSecurityTransaction,
  expected: GlobalSecurityContext
): Promise<GlobalSecurityContext> {
  const current = await lockGlobalSecurityContext(tx, expected);
  if (
    current.credentialVersion !== expected.credentialVersion ||
    current.sessionSecurityVersion !== expected.sessionSecurityVersion
  ) {
    throw new Error("stale_security_version");
  }
  return current;
}

export async function withGlobalSecurityTransaction<T>(
  database: GlobalSecurityDatabase,
  expected: GlobalSecurityContext,
  action: (context: GlobalSecurityContext, tx: GlobalSecurityTransaction) => Promise<T>
): Promise<T> {
  return database.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('global-security-transition:v1', 0))`;
    const context = await reauthorizeGlobalSecurityContext(tx, expected);
    return action(context, tx);
  }, { isolationLevel: "Serializable" });
}

export async function verifyCurrentPassword(
  tx: Prisma.TransactionClient,
  context: GlobalSecurityContext,
  password: string,
  verifier: { verify: (input: { hash: string; password: string }) => Promise<boolean> }
): Promise<boolean> {
  const account = await tx.account.findFirst({
    where: { userId: context.userId, providerId: "credential" },
    select: { password: true }
  });
  if (!account?.password) return false;
  return verifier.verify({ hash: account.password, password });
}

export type FreshAuthPurpose = "password_change" | "recovery_enrollment" | "email_change" | "session_revoke";
export type SessionRevokeGrantBinding = {
  scope: "current" | "one" | "others" | "all";
  canonicalTargetHandle: string;
  resolvedTargetSessionId: string;
};
export type FreshAuthThrottleContext = { key?: string; client?: string; preverified?: boolean };
const globalSecurityOperationIdPattern = /^gso_[0-9abcdefghjkmnpqrstvwxyz]{26}$/;

const freshAuthOperationKey: Record<FreshAuthPurpose, GlobalSecurityOperationKey> = {
  password_change: GlobalSecurityOperationKey.passwordChange,
  recovery_enrollment: GlobalSecurityOperationKey.recoveryEnrollment,
  email_change: GlobalSecurityOperationKey.emailChange,
  session_revoke: GlobalSecurityOperationKey.sessionRevoke
};

async function freshAuthGrantDeadlineIsCurrent(tx: Pick<Prisma.TransactionClient, "$queryRaw">, grantId: string) {
  const rows = await tx.$queryRaw<Array<{ authorized: boolean }>>`SELECT "expiresAt" > clock_timestamp() AS "authorized" FROM "FreshAuthGrant" WHERE "id"=${grantId} FOR UPDATE`;
  return rows.length === 1 && rows[0]!.authorized;
}

export function assertGlobalSecurityOperationId(value: unknown): string {
  if (typeof value !== "string" || !globalSecurityOperationIdPattern.test(value)) throw new Error("global_security_operation_id_invalid");
  return value;
}

/**
 * Production proof boundary.  Its failed-proof transaction is deliberately
 * separate from the caller's operation transaction so evidence survives the
 * outward rejection.  A retained operation is never treated as a fresh proof.
 */
export async function preauthorizeFreshAuthThrottle(
  database: GlobalSecurityDatabase,
  expected: GlobalSecurityContext,
  input: { operationId: string; purpose: FreshAuthPurpose; openingFingerprint: string; intentFingerprint: string; sessionRevoke?: SessionRevokeGrantBinding },
  password: string,
  verifier: { verify: (input: { hash: string; password: string }) => Promise<boolean> },
  throttle: { key: string; client: string }
) {
  const operationId = assertGlobalSecurityOperationId(input.operationId);
  return database.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('global-security-transition:v1',0))`;
    const context = await reauthorizeGlobalSecurityContext(tx, expected);
    const existing = await tx.globalSecurityOperationBinding.findFirst({ where: { userId: context.userId, operationId } });
    if (existing) {
      const targetSnapshot = input.sessionRevoke
        ? { scope: input.sessionRevoke.scope, canonicalTargetHandle: input.sessionRevoke.canonicalTargetHandle, resolvedTargetSessionId: input.sessionRevoke.resolvedTargetSessionId }
        : {};
      const operation = await tx.globalSecurityOperation.findFirst({
        where: { bindingId: existing.id, userId: context.userId, operationId },
        select: { intentFingerprint: true, status: true }
      });
      const exact = existing.sessionId === context.sessionId &&
        existing.operationKey === freshAuthOperationKey[input.purpose] &&
        existing.securityVersion === context.credentialVersion &&
        existing.sessionSecurityVersion === context.sessionSecurityVersion &&
        existing.openingFingerprint === input.openingFingerprint &&
        existing.state === "submitted" &&
        JSON.stringify(existing.targetSnapshot) === JSON.stringify(targetSnapshot) &&
        operation?.intentFingerprint === input.intentFingerprint &&
        operation.status === "pending";
      // The operation transaction repeats this full check and checks grant
      // expiry.  We deliberately avoid a second password check or a counter
      // increment for every retained operation, including conflicts.
      return { replay: exact, existing: true, valid: true };
    }
    const [user, account] = await Promise.all([
      tx.user.findUnique({ where: { id: context.userId }, select: { email: true } }),
      tx.account.findFirst({ where: { userId: context.userId, providerId: "credential" }, select: { password: true } })
    ]);
    if (!user?.email || !account?.password) {
      if (user?.email) {
        const throttleInput = { key: throttle.key, userId: context.userId, accountIdentifier: user.email, client: throttle.client };
        await recordGlobalSecurityThrottleFailureInTransaction(tx, throttleInput);
        await writeGlobalSecurityEvent(tx, context.userId, "grant", "current_password_failed");
      }
      return { replay: false, existing: false, valid: false };
    }
    const throttleInput = { key: throttle.key, userId: context.userId, accountIdentifier: user.email, client: throttle.client };
    const state = await precheckGlobalSecurityThrottleInTransaction(tx, throttleInput);
    const valid = state.quiet
      ? (await verifier.verify({ hash: account.password, password: "cubby-fixed-dummy-password-proof-v1" }), false)
      : await verifier.verify({ hash: account.password, password });
    if (!valid) {
      await recordGlobalSecurityThrottleFailureInTransaction(tx, throttleInput);
      await writeGlobalSecurityEvent(tx, context.userId, "grant", "current_password_failed");
    }
    return { replay: false, existing: false, valid };
  }, { isolationLevel: "Serializable" });
}

export async function issueFreshAuthGrantForCurrentPassword(
  database: GlobalSecurityDatabase,
  expected: GlobalSecurityContext,
  input: { operationId: string; purpose: FreshAuthPurpose; openingFingerprint: string; intentFingerprint: string; sessionRevoke?: SessionRevokeGrantBinding },
  password: string,
  verifier: { verify: (input: { hash: string; password: string }) => Promise<boolean> },
  passwordTransition?: { replacementPasswordHash: string; signer?: ReturnType<typeof createFreshAuthAttestationSigner> },
  freshAuthSigner?: ReturnType<typeof createFreshAuthAttestationSigner>,
  throttleContext?: FreshAuthThrottleContext
): Promise<{ operationId: string; grantId: string }> {
  const configuredKey = throttleContext?.key ?? optionalConfiguredGlobalSecurityThrottleKey();
  let effectiveThrottle = throttleContext;
  if (configuredKey) {
    const preauthorized = await preauthorizeFreshAuthThrottle(database, expected, input, password, verifier, { key: configuredKey, client: throttleContext?.client ?? "unknown_client" });
    if (!preauthorized.valid) throw new Error("current_password_invalid");
    effectiveThrottle = preauthorized.replay ? undefined : { key: configuredKey, client: throttleContext?.client ?? "unknown_client", preverified: true };
  }
  return withGlobalSecurityTransaction(database, expected, async (context, tx) => {
    return issueFreshAuthGrantForCurrentPasswordInTransaction(tx, context, input, password, verifier, passwordTransition, freshAuthSigner, effectiveThrottle);
  });
}

export async function issueFreshAuthGrantForCurrentPasswordInTransaction(
  tx: GlobalSecurityTransaction,
  context: GlobalSecurityContext,
  input: { operationId: string; purpose: FreshAuthPurpose; openingFingerprint: string; intentFingerprint: string; sessionRevoke?: SessionRevokeGrantBinding },
  password: string,
  verifier: { verify: (input: { hash: string; password: string }) => Promise<boolean> },
  passwordTransition?: { replacementPasswordHash: string; signer?: ReturnType<typeof createFreshAuthAttestationSigner> },
  freshAuthSigner?: ReturnType<typeof createFreshAuthAttestationSigner>,
  throttleContext?: FreshAuthThrottleContext
): Promise<{ operationId: string; grantId: string }> {
  const operationId = assertGlobalSecurityOperationId(input.operationId);
    if (input.purpose === "session_revoke" && !input.sessionRevoke) throw new Error("session_revoke_binding_required");
    if (input.purpose !== "session_revoke" && input.sessionRevoke) throw new Error("fresh_auth_binding_invalid");
    const targetSnapshot = input.sessionRevoke
      ? { scope: input.sessionRevoke.scope, canonicalTargetHandle: input.sessionRevoke.canonicalTargetHandle, resolvedTargetSessionId: input.sessionRevoke.resolvedTargetSessionId }
      : {};
    const existing = await tx.globalSecurityOperationBinding.findFirst({
      where: { userId: context.userId, operationId: operationId }
    });
    if (existing) {
      if (
        existing.sessionId !== context.sessionId ||
        existing.operationKey !== freshAuthOperationKey[input.purpose] ||
        existing.securityVersion !== context.credentialVersion ||
        existing.sessionSecurityVersion !== context.sessionSecurityVersion ||
        existing.openingFingerprint !== input.openingFingerprint ||
        (input.purpose === "session_revoke" && JSON.stringify(existing.targetSnapshot) !== JSON.stringify(targetSnapshot)) ||
        existing.state !== "submitted"
      ) throw new Error("idempotency_conflict");
      const operation = await tx.globalSecurityOperation.findFirst({
        where: { bindingId: existing.id, userId: context.userId, operationId },
        select: { intentFingerprint: true, status: true }
      });
      if (!operation || operation.intentFingerprint !== input.intentFingerprint) throw new Error("idempotency_conflict");
      if (operation.status === "unknown") throw new Error("operation_outcome_unknown");
      if (operation.status !== "pending") throw new Error("idempotency_conflict");
      const grant = await tx.freshAuthGrant.findFirst({
        where: {
          userId: context.userId,
          sessionId: context.sessionId,
          operationId: operationId,
          credentialVersion: context.credentialVersion,
          purpose: input.purpose,
          state: "issued"
        },
        select: { id: true }
      });
      if (!grant || !(await freshAuthGrantDeadlineIsCurrent(tx, grant.id))) throw new Error("fresh_authentication_required");
      return { operationId: operationId, grantId: grant.id };
    }
    if (!(await verifyCurrentPassword(tx, context, password, verifier))) throw new Error("current_password_invalid");
    if (input.purpose === "password_change" && !passwordTransition) throw new Error("password_change_attestation_required");
    const [{ createdAt, expiresAt }] = await tx.$queryRaw<Array<{ createdAt: Date; expiresAt: Date }>>`SELECT clock_timestamp() AS "createdAt", clock_timestamp() + INTERVAL '10 minutes' AS "expiresAt"`;
    const binding = await tx.globalSecurityOperationBinding.create({
      data: {
        userId: context.userId,
        sessionId: context.sessionId,
        operationId: operationId,
        operationKey: freshAuthOperationKey[input.purpose],
        securityVersion: context.credentialVersion,
        sessionSecurityVersion: context.sessionSecurityVersion,
        openingFingerprint: input.openingFingerprint,
        targetSnapshot,
        state: "open",
        expiresAt
      }
    });
    await tx.globalSecurityOperation.create({
      data: {
        bindingId: binding.id,
        userId: context.userId,
        operationId: operationId,
        operationKey: freshAuthOperationKey[input.purpose],
        intentFingerprint: input.intentFingerprint,
        status: "pending"
      }
    });
    const attestation = ["password_change", "recovery_enrollment"].includes(input.purpose)
      ? (() => {
          const signer = passwordTransition?.signer ?? freshAuthSigner ?? createFreshAuthAttestationSigner();
          const replacementPasswordHashDigest = passwordTransition ? signer.digestReplacementPasswordHash(passwordTransition.replacementPasswordHash) : Buffer.alloc(32);
          return { ...signer.sign({ ...context, purpose: input.purpose as "password_change" | "recovery_enrollment", operationId, openingFingerprint: input.openingFingerprint, intentFingerprint: input.intentFingerprint, replacementPasswordHashDigest }), replacementPasswordHashDigest };
        })()
      : input.purpose === "session_revoke"
        ? (() => {
            const signer = freshAuthSigner ?? createFreshAuthAttestationSigner();
            return signer.signSessionRevoke({ ...context, operationId, scope: input.sessionRevoke!.scope, canonicalTargetHandle: input.sessionRevoke!.canonicalTargetHandle, resolvedTargetSessionId: input.sessionRevoke!.resolvedTargetSessionId, openingFingerprint: input.openingFingerprint, intentFingerprint: input.intentFingerprint });
          })()
      : undefined;
    const grant = await issueFreshAuthGrant(tx, { ...context, operationId: operationId, purpose: input.purpose }, { createdAt, expiresAt }, attestation);
    await tx.globalSecurityOperationBinding.update({ where: { id: binding.id }, data: { state: "submitted" } });
    if (throttleContext?.preverified) await writeGlobalSecurityEvent(tx, context.userId, "grant", "current_password_verified", operationId);
    return { operationId: operationId, grantId: grant.id };
}

export async function getFreshAuthGrantStatus(
  database: GlobalSecurityDatabase,
  expected: GlobalSecurityContext,
  input: { operationId: string; purpose: FreshAuthPurpose; openingFingerprint: string }
): Promise<{ operationId: string; grantId: string; state: "issued" | "consumed" | "revoked" | "expired"; expiresAt: Date }> {
  const rawOperationId = input.operationId;
  const operationId = assertGlobalSecurityOperationId(rawOperationId);
  return withGlobalSecurityTransaction(database, expected, async (context, tx) => {
    const binding = await tx.globalSecurityOperationBinding.findFirst({
      where: { userId: context.userId, operationId: operationId }
    });
    if (
      !binding ||
      binding.sessionId !== context.sessionId ||
      binding.operationKey !== freshAuthOperationKey[input.purpose] ||
      binding.securityVersion !== context.credentialVersion ||
      binding.sessionSecurityVersion !== context.sessionSecurityVersion ||
      binding.openingFingerprint !== input.openingFingerprint ||
      binding.state !== "submitted"
    ) throw new Error("not_found");
    const grant = await tx.freshAuthGrant.findFirst({
      where: {
        userId: context.userId,
        sessionId: context.sessionId,
        operationId: operationId,
        credentialVersion: context.credentialVersion,
        purpose: input.purpose
      },
      select: { id: true, state: true, expiresAt: true }
    });
    if (!grant) throw new Error("not_found");
    const state = grant.state === "issued" && !(await freshAuthGrantDeadlineIsCurrent(tx, grant.id))
      ? "expired"
      : grant.state;
    if (state === "expired" && grant.state === "issued") {
      await tx.freshAuthGrant.update({ where: { id: grant.id }, data: { state: "expired" } });
    }
    return { operationId: operationId, grantId: grant.id, state, expiresAt: grant.expiresAt };
  });
}

export async function issueFreshAuthGrant(
  tx: Pick<Prisma.TransactionClient, "freshAuthGrant">,
  input: { userId: string; sessionId: string; credentialVersion: number; operationId: string; purpose?: "password_change" | "recovery_enrollment" | "email_change" | "session_revoke" },
  lease: { createdAt: Date; expiresAt: Date },
  attestation?: { nonce: string; mac: Buffer; keyVersion: number; replacementPasswordHashDigest?: Buffer }
) {
  return tx.freshAuthGrant.create({
    data: {
      userId: input.userId,
      sessionId: input.sessionId,
      operationId: input.operationId,
      purpose: input.purpose ?? "password_change",
      credentialVersion: input.credentialVersion,
      attestationNonce: attestation?.nonce,
      attestationMac: attestation ? Uint8Array.from(attestation.mac) : undefined,
      attestationKeyVersion: attestation?.keyVersion,
      replacementPasswordHashDigest: attestation?.replacementPasswordHashDigest ? Uint8Array.from(attestation.replacementPasswordHashDigest) : undefined,
      state: "issued",
      createdAt: lease.createdAt,
      expiresAt: lease.expiresAt
    }
  });
}

export async function consumeFreshAuthGrantForCurrentContext(
  database: GlobalSecurityDatabase,
  expected: GlobalSecurityContext,
  input: { operationId: string; purpose: FreshAuthPurpose; openingFingerprint: string },
  now = new Date()
) {
  const operationId = assertGlobalSecurityOperationId(input.operationId);
  return withGlobalSecurityTransaction(database, expected, async (context, tx) => {
    const binding = await tx.globalSecurityOperationBinding.findFirst({
      where: { userId: context.userId, operationId }
    });
    if (
      !binding ||
      binding.sessionId !== context.sessionId ||
      binding.operationKey !== freshAuthOperationKey[input.purpose] ||
      binding.securityVersion !== context.credentialVersion ||
      binding.sessionSecurityVersion !== context.sessionSecurityVersion ||
      binding.openingFingerprint !== input.openingFingerprint ||
      binding.state !== "submitted"
    ) throw new Error("fresh_authentication_required");
    const operation = await tx.globalSecurityOperation.findFirst({
      where: { bindingId: binding.id, userId: context.userId, operationId },
      select: { status: true }
    });
    if (!operation || operation.status === "unknown") throw new Error("operation_outcome_unknown");
    if (operation.status !== "pending") throw new Error("fresh_authentication_required");
    return consumeFreshAuthGrant(tx, { ...context, operationId, purpose: input.purpose }, now);
  });
}

export async function finalizePasswordChange(
  database: GlobalSecurityDatabase,
  expected: GlobalSecurityContext,
  input: { operationId: string; openingFingerprint: string; intentFingerprint: string },
  newPassword: string,
  hasher: { hash: (password: string) => Promise<string> },
  prehashedPasswordHash?: string
): Promise<{ operationId: string; status: "signed_out" }> {
  const passwordHash = prehashedPasswordHash ?? await hasher.hash(newPassword);
  const operationId = assertGlobalSecurityOperationId(input.operationId);
  try {
    return await withGlobalSecurityTransaction(database, expected, async (context, tx) => {
    const binding = await tx.globalSecurityOperationBinding.findFirst({ where: { userId: context.userId, operationId } });
    if (!binding || binding.sessionId !== context.sessionId || binding.operationKey !== GlobalSecurityOperationKey.passwordChange || binding.securityVersion !== context.credentialVersion || binding.sessionSecurityVersion !== context.sessionSecurityVersion || binding.openingFingerprint !== input.openingFingerprint || binding.state !== "submitted") throw new Error("fresh_authentication_required");
    const operation = await tx.globalSecurityOperation.findFirst({ where: { bindingId: binding.id, userId: context.userId, operationId }, select: { intentFingerprint: true, status: true } });
    if (!operation || operation.intentFingerprint !== input.intentFingerprint) throw new Error("idempotency_conflict");
    if (operation.status === "unknown") throw new Error("operation_outcome_unknown");
    if (operation.status !== "pending") throw new Error("fresh_authentication_required");
    const grant = await tx.freshAuthGrant.findFirst({ where: { userId: context.userId, sessionId: context.sessionId, operationId, credentialVersion: context.credentialVersion, purpose: "password_change", state: "issued" }, select: { id: true } });
    if (!grant || !(await freshAuthGrantDeadlineIsCurrent(tx, grant.id))) throw new Error("fresh_authentication_required");
    const account = await tx.account.findFirst({ where: { userId: context.userId, providerId: "credential" }, select: { id: true } });
    if (!account) throw new Error("fresh_authentication_required");
    const now = new Date();
    await tx.freshAuthGrant.update({ where: { id: grant.id }, data: { state: "consumed", consumedAt: now } });
    await tx.accountSecurityState.update({ where: { userId: context.userId }, data: { credentialVersion: { increment: 1 }, sessionSecurityVersion: { increment: 1 }, lastCredentialOperationId: operationId, lastSessionSecurityOperationId: operationId } });
    await tx.$executeRaw`SELECT "apply_password_change_credential_mutation"(${context.userId}, ${operationId}, ${account.id}, ${passwordHash})`;
    await tx.$executeRaw`SELECT "revoke_sessions_for_global_security_operation"(${context.userId},${operationId})`;
    await tx.globalSecurityOperation.update({ where: { userId_operationId: { userId: context.userId, operationId } }, data: { status: "completed", outcomeVersion: 1, outcomeCode: "changed", outcomeSnapshot: {}, terminalAt: now } });
    await tx.globalSecurityOperationBinding.update({ where: { id: binding.id }, data: { state: "terminal" } });
    await tx.$executeRaw`SELECT "write_global_security_event"(${context.userId},'operation_outcome','completed',${operationId})`;
    return { operationId, status: "signed_out" };
    });
  } catch (error) {
    if (error instanceof Error && error.message === "stale_security_version") {
      await finalizeStalePasswordChange(database, expected, input);
    }
    throw error;
  }
}

export async function changePasswordWithCurrentPassword(
  database: GlobalSecurityDatabase,
  expected: GlobalSecurityContext,
  input: { operationId: string; openingFingerprint: string; intentFingerprint: string },
  currentPassword: string,
  newPassword: string,
  verifier: { verify: (input: { hash: string; password: string }) => Promise<boolean> },
  hasher: { hash: (password: string) => Promise<string> },
  signer: ReturnType<typeof createFreshAuthAttestationSigner> = createFreshAuthAttestationSigner(),
  throttleContext?: FreshAuthThrottleContext
) {
  const replacementPasswordHash = await hasher.hash(newPassword);
  await issueFreshAuthGrantForCurrentPassword(database, expected, { ...input, purpose: "password_change" }, currentPassword, verifier, { replacementPasswordHash, signer }, undefined, throttleContext);
  return finalizePasswordChange(database, expected, input, newPassword, hasher, replacementPasswordHash);
}

export async function finalizeStalePasswordChange(
  database: GlobalSecurityDatabase,
  expected: GlobalSecurityContext,
  input: { operationId: string; openingFingerprint: string; intentFingerprint: string }
): Promise<void> {
  const operationId = assertGlobalSecurityOperationId(input.operationId);
  await database.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('global-security-transition:v1', 0))`;
    const binding = await tx.globalSecurityOperationBinding.findFirst({ where: { userId: expected.userId, sessionId: expected.sessionId, operationId } });
    const operation = binding && await tx.globalSecurityOperation.findFirst({ where: { bindingId: binding.id, userId: expected.userId, operationId }, select: { intentFingerprint: true, status: true } });
    if (!binding || !operation || binding.operationKey !== GlobalSecurityOperationKey.passwordChange || binding.securityVersion !== expected.credentialVersion || binding.sessionSecurityVersion !== expected.sessionSecurityVersion || binding.openingFingerprint !== input.openingFingerprint || binding.state !== "submitted" || operation.intentFingerprint !== input.intentFingerprint || operation.status !== "pending") throw new Error("stale_security_version");
    const now = new Date();
    await tx.freshAuthGrant.updateMany({ where: { userId: expected.userId, sessionId: expected.sessionId, operationId, state: "issued" }, data: { state: "revoked", revokedAt: now } });
    await tx.globalSecurityOperation.update({ where: { userId_operationId: { userId: expected.userId, operationId } }, data: { status: "stale", outcomeVersion: 1, outcomeCode: "stale_security_version", outcomeSnapshot: {}, terminalAt: now } });
    await tx.globalSecurityOperationBinding.update({ where: { id: binding.id }, data: { state: "terminal" } });
    await tx.$executeRaw`SELECT "write_global_security_event"(${expected.userId},'operation_outcome','stale_security_version',${operationId})`;
  }, { isolationLevel: "Serializable" });
}

/** Safe terminal replay for a password transition after the user signs in again. */
export async function getPasswordChangeStatus(
  database: GlobalSecurityDatabase,
  userId: string,
  rawInput: { operationId: string; openingFingerprint: string; intentFingerprint: string }
): Promise<{ operationId: string; status: string; outcomeCode: string | null; terminalAt: Date | null }> {
  const operationId = assertGlobalSecurityOperationId(rawInput.operationId);
  return database.$transaction(async (tx) => {
    const binding = await tx.globalSecurityOperationBinding.findFirst({ where: { userId, operationId } });
    const operation = binding && await tx.globalSecurityOperation.findFirst({
      where: { bindingId: binding.id, userId, operationId },
      select: { intentFingerprint: true, status: true, outcomeCode: true, terminalAt: true }
    });
    if (!binding || !operation || binding.operationKey !== GlobalSecurityOperationKey.passwordChange || binding.openingFingerprint !== rawInput.openingFingerprint || operation.intentFingerprint !== rawInput.intentFingerprint) throw new Error("not_found");
    return { operationId, status: operation.status, outcomeCode: operation.outcomeCode, terminalAt: operation.terminalAt };
  }, { isolationLevel: "Serializable" });
}

async function consumeFreshAuthGrant(
  tx: Pick<Prisma.TransactionClient, "freshAuthGrant" | "$queryRaw">,
  input: { userId: string; sessionId: string; operationId: string; credentialVersion: number; purpose: FreshAuthPurpose },
  now = new Date()
) {
  const grant = await tx.freshAuthGrant.findFirst({ where: { userId: input.userId, sessionId: input.sessionId, operationId: input.operationId, credentialVersion: input.credentialVersion, purpose: input.purpose, state: "issued" } });
  if (!grant || !(await freshAuthGrantDeadlineIsCurrent(tx, grant.id))) throw new Error("fresh_authentication_required");
  return tx.freshAuthGrant.update({ where: { id: grant.id }, data: { state: "consumed", consumedAt: now } });
}
