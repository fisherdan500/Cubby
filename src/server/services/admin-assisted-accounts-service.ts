import { BrowserOperationKey, BrowserOperationTargetKind, type Prisma } from "@prisma/client";
import { auth } from "@/lib/auth/auth";
import { prisma } from "@/lib/db/prisma";
import {
  buildAssistedPasswordIntentCommitment,
  canAdminAssistHouseholdRole,
  createAssistedCredentialAttestationSigner,
  parseMemberAccountCreateSubmission,
  parseMemberPasswordResetSubmission,
  projectAssistedProcedureResult,
  type AssistedOperationKey,
  type AssistedProcedureResult
} from "@/server/services/admin-assisted-accounts";
import { runAssistedSerializableTransaction } from "@/server/services/assisted-transaction-retry";
import {
  abandonHouseholdBrowserOperation,
  assertBrowserOperationId,
  browserIntentFingerprint,
  getBrowserOperationContextForHousehold,
  issueHouseholdBrowserOperation,
  type BrowserOperationContext
} from "@/server/services/browser-operations";
import { configuredGlobalSecurityThrottleKey } from "@/server/services/global-security-throttling";

type AssistedTransaction = Pick<Prisma.TransactionClient, "$queryRaw" | "$executeRaw">;

type MemberRow = {
  id: string;
  userId: string;
  role: string;
  disabledAt: Date | null;
  deletedAt: Date | null;
  updatedAt: Date;
};

type SecurityRow = { userId: string; credentialVersion: number; sessionSecurityVersion: number };

type PlatformRow = { ownerUserId: string | null; updatedAt: Date };

/**
 * Every assisted lock is NOWAIT and must be taken before the generic substrate touches operation
 * identity or the binding row, so an ordinary browser operation holding a Session lock can never
 * deadlock against an assisted credential transaction.
 */
function assistedPreIdentityLock(ctx: BrowserOperationContext, operationId: string) {
  return async (tx: Prisma.TransactionClient) => {
    const db = tx as AssistedTransaction;
    await db.$executeRaw`SELECT public."acquire_assisted_credential_fence_v1"()`;
    await db.$executeRaw`SELECT public."lock_actor_session_for_assisted_operation_nowait"(${ctx.userId}, ${ctx.sessionId})`;
    await db.$executeRaw`SELECT public."try_lock_assisted_browser_identity_v1"(${ctx.householdId}, ${operationId})`;
    await db.$queryRaw`SELECT "id" FROM "BrowserOperationBinding" WHERE "householdId" = ${ctx.householdId} AND "operationId" = ${operationId} FOR UPDATE NOWAIT`;
  };
}

function isoStamp(value: Date | string) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

async function readPlatformAuthority(tx: Prisma.TransactionClient): Promise<PlatformRow> {
  const rows = await (tx as AssistedTransaction).$queryRaw<PlatformRow[]>`SELECT "ownerUserId", "updatedAt" FROM "PlatformAuthority" WHERE "id" = ${"platform"} FOR SHARE NOWAIT`;
  const platform = rows[0];
  if (!platform) throw new Error("not_found");
  return platform;
}

async function readHouseholdMembers(tx: Prisma.TransactionClient, householdId: string) {
  return (tx as AssistedTransaction).$queryRaw<MemberRow[]>`SELECT "id", "userId", "role", "disabledAt", "deletedAt", "updatedAt" FROM "HouseholdMember" WHERE "householdId" = ${householdId}`;
}

function requireActiveMember(rows: MemberRow[], memberId: string) {
  const member = rows.find((row) => row.id === memberId);
  if (!member || member.deletedAt) throw new Error("not_found");
  return member;
}

/** Owners may assist admins and regular members; admins may assist regular members only. */
function assertAssistAuthority(actorRole: string, targetRole: string) {
  if (!canAdminAssistHouseholdRole(actorRole, targetRole)) throw new Error("forbidden");
}

function assertActorCanAssist(ctx: BrowserOperationContext) {
  assertAssistAuthority(ctx.role, "read_only");
}

function commitmentKey() {
  return configuredGlobalSecurityThrottleKey();
}

function attestationSigner() {
  return createAssistedCredentialAttestationSigner({
    CUBBY_FRESH_AUTH_ATTESTATION_KEYRING: process.env.CUBBY_FRESH_AUTH_ATTESTATION_KEYRING,
    CUBBY_FRESH_AUTH_ATTESTATION_ACTIVE_KEY_VERSION: process.env.CUBBY_FRESH_AUTH_ATTESTATION_ACTIVE_KEY_VERSION
  });
}

type LoadedBinding = {
  openingFingerprint: string;
  targetId: string | null;
  targetSnapshot: Record<string, unknown>;
  expiresAt: Date;
  operation: { intentFingerprint?: string | null } | null;
};

async function loadAssistedBinding(householdId: string, operationId: string): Promise<LoadedBinding> {
  const binding = await prisma.browserOperationBinding.findFirst({
    where: { householdId, operationId },
    include: { operation: true }
  });
  if (!binding) throw new Error("not_found");
  return binding as unknown as LoadedBinding;
}

/**
 * A submitted operation is replayable only when its stored intent is byte-identical; anything else
 * is a genuine conflict. The replay answer is proved from the reviewed status function, never from
 * current credential state.
 */
async function replayOrConflict(
  key: AssistedOperationKey,
  ctx: BrowserOperationContext,
  operationId: string,
  binding: LoadedBinding,
  intentFingerprint: string
): Promise<AssistedProcedureResult | null> {
  if (!binding.operation) {
    if (binding.expiresAt.getTime() <= Date.now()) {
      return { status: "stale", operationId, code: "stale_context" };
    }
    return null;
  }
  if (binding.operation.intentFingerprint !== intentFingerprint) throw new Error("idempotency_conflict");
  return assistedOperationStatus(key, ctx, operationId);
}

async function assistedOperationStatus(
  key: AssistedOperationKey,
  ctx: BrowserOperationContext,
  operationId: string
): Promise<AssistedProcedureResult> {
  return prisma.$transaction(async (tx) => {
    const db = tx as AssistedTransaction;
    await db.$executeRaw`SELECT public."acquire_assisted_credential_fence_v1"()`;
    const rows = await db.$queryRaw<Array<Record<string, unknown>>>`SELECT * FROM public."get_assisted_account_operation_status_v1"(${ctx.userId}, ${ctx.sessionId}, ${ctx.householdId}, ${operationId})`;
    const row = rows[0];
    if (!row) throw new Error("not_found");
    return projectAssistedProcedureResult(key, operationId, row);
  }, { isolationLevel: "Serializable" });
}

function procedureResultOf(rows: Array<{ result: unknown }>) {
  const row = rows[0];
  if (!row) throw new Error("operation_integrity_error");
  return row.result;
}

/**
 * The browser needs the server-computed opening fingerprint (and, for a reset, the server-derived
 * target identity) to submit; neither is client-supplied authority, both are re-verified at commit.
 */
async function withOpeningDetails(
  result: Awaited<ReturnType<typeof issueHouseholdBrowserOperation>>,
  householdId: string,
  operationId: string
) {
  if (result.status !== "open") return result;
  const binding = await prisma.browserOperationBinding.findFirst({
    where: { householdId, operationId },
    select: { openingFingerprint: true, targetSnapshot: true }
  });
  if (!binding) return result;
  return { ...result, openingFingerprint: binding.openingFingerprint, snapshot: binding.targetSnapshot };
}

export async function issueAssistedMemberAccountCreate(raw: unknown) {
  const input = (raw ?? {}) as Record<string, unknown>;
  const operationId = assertBrowserOperationId(input.operationId);
  const ctx = await getBrowserOperationContextForHousehold();
  assertActorCanAssist(ctx);

  return withOpeningDetails(await issueHouseholdBrowserOperation({
    ctx,
    operationId,
    operationKey: BrowserOperationKey.memberAccountCreate,
    targetKind: BrowserOperationTargetKind.household,
    permission: "member.manage",
    preIdentityLock: assistedPreIdentityLock(ctx, operationId),
    targetSnapshot: async (tx, lockedCtx) => {
      const platform = await readPlatformAuthority(tx);
      const members = await readHouseholdMembers(tx, lockedCtx.householdId);
      const actor = requireActiveMember(members, lockedCtx.memberId);
      assertActorCanAssist({ ...lockedCtx, role: actor.role } as BrowserOperationContext);
      return {
        schemaVersion: 1,
        householdId: lockedCtx.householdId,
        actorMemberId: actor.id,
        actorRole: actor.role,
        actorMembershipUpdatedAt: isoStamp(actor.updatedAt),
        platformAuthorityUpdatedAt: isoStamp(platform.updatedAt)
      };
    }
  }), ctx.householdId, operationId);
}

export async function submitAssistedMemberAccountCreate(raw: unknown): Promise<AssistedProcedureResult> {
  const request = parseMemberAccountCreateSubmission(raw);
  const ctx = await getBrowserOperationContextForHousehold();
  assertAssistAuthority(ctx.role, request.role);

  const stablePasswordIntentCommitment = buildAssistedPasswordIntentCommitment(commitmentKey(), {
    operationId: request.operationId,
    householdId: ctx.householdId,
    actorUserId: ctx.userId,
    actorSessionId: ctx.sessionId,
    actorMemberId: ctx.memberId,
    operationKey: "member.account.create",
    normalizedEmail: request.email,
    exactDisplayName: request.name,
    role: request.role,
    requireFirstLoginPasswordChange: request.requireFirstLoginPasswordChange,
    password: request.password
  });
  const intentFingerprint = browserIntentFingerprint({
    openingFingerprint: request.openingFingerprint,
    stablePasswordIntentCommitment,
    normalizedEmail: request.email,
    exactDisplayName: request.name,
    role: request.role,
    requireFirstLoginPasswordChange: request.requireFirstLoginPasswordChange
  });

  const binding = await loadAssistedBinding(ctx.householdId, request.operationId);
  if (binding.openingFingerprint !== request.openingFingerprint) throw new Error("idempotency_conflict");
  const replay = await replayOrConflict("member.account.create", ctx, request.operationId, binding, intentFingerprint);
  if (replay) return replay;

  const passwordHash = await (await auth.$context).password.hash(request.password);
  const attestation = attestationSigner().sign({
    purpose: "member_account_create",
    actorUserId: ctx.userId,
    actorSessionId: ctx.sessionId,
    actorMemberId: ctx.memberId,
    householdId: ctx.householdId,
    operationId: request.operationId,
    openingFingerprint: request.openingFingerprint,
    intentFingerprint,
    replacementPasswordHash: passwordHash,
    newValues: {
      normalizedEmail: request.email,
      exactDisplayName: request.name,
      role: request.role,
      requireFirstLoginPasswordChange: request.requireFirstLoginPasswordChange
    },
    oldCredentialVersion: null,
    oldSessionSecurityVersion: null
  });

  return runAssistedSerializableTransaction(async () =>
    prisma.$transaction(async (tx) => {
      const rows = await (tx as AssistedTransaction).$queryRaw<Array<{ result: unknown }>>`SELECT public."create_assisted_member_account_v1"(${ctx.userId}, ${ctx.sessionId}, ${ctx.memberId}, ${ctx.householdId}, ${request.operationId}, ${request.openingFingerprint}, ${intentFingerprint}, ${request.name}, ${request.email}, ${request.role}::public."HouseholdRole", ${passwordHash}, ${attestation.replacementPasswordHashDigest}, ${request.requireFirstLoginPasswordChange}, ${attestation.keyVersion}::INTEGER, ${attestation.nonce}, ${attestation.issuedAt}::TIMESTAMP, ${attestation.mac}) AS "result"`;
      return projectAssistedProcedureResult("member.account.create", request.operationId, procedureResultOf(rows));
    }, { isolationLevel: "Serializable" })
  );
}

export async function getAssistedMemberAccountCreateStatus(raw: unknown) {
  const input = (raw ?? {}) as Record<string, unknown>;
  const operationId = assertBrowserOperationId(input.operationId);
  const ctx = await getBrowserOperationContextForHousehold();
  return assistedOperationStatus("member.account.create", ctx, operationId);
}

export async function abandonAssistedMemberAccountCreate(raw: unknown) {
  const input = (raw ?? {}) as Record<string, unknown>;
  const operationId = assertBrowserOperationId(input.operationId);
  const ctx = await getBrowserOperationContextForHousehold();
  return abandonHouseholdBrowserOperation({
    ctx,
    operationId,
    operationKey: BrowserOperationKey.memberAccountCreate,
    preIdentityLock: assistedPreIdentityLock(ctx, operationId)
  });
}

async function resetOpeningSnapshot(
  tx: Prisma.TransactionClient,
  ctx: BrowserOperationContext,
  targetMemberId: string
) {
  const platform = await readPlatformAuthority(tx);
  const members = await readHouseholdMembers(tx, ctx.householdId);
  const actor = requireActiveMember(members, ctx.memberId);
  const target = requireActiveMember(members, targetMemberId);
  if (target.userId === actor.userId || target.userId === ctx.userId) throw new Error("forbidden");
  if (platform.ownerUserId === target.userId) throw new Error("forbidden");
  assertAssistAuthority(actor.role, target.role);

  const securityRows = await (tx as AssistedTransaction).$queryRaw<SecurityRow[]>`SELECT "userId", "credentialVersion", "sessionSecurityVersion" FROM "AccountSecurityState" WHERE "userId" = ${target.userId} FOR SHARE NOWAIT`;
  const security = securityRows.find((row) => row.userId === target.userId) ?? securityRows[0];
  if (!security) throw new Error("not_found");

  return {
    schemaVersion: 1,
    householdId: ctx.householdId,
    actorMemberId: actor.id,
    actorRole: actor.role,
    actorMembershipUpdatedAt: isoStamp(actor.updatedAt),
    targetMemberId: target.id,
    targetUserId: target.userId,
    targetRole: target.role,
    targetMembershipUpdatedAt: isoStamp(target.updatedAt),
    credentialVersion: security.credentialVersion,
    sessionSecurityVersion: security.sessionSecurityVersion,
    platformAuthorityUpdatedAt: isoStamp(platform.updatedAt)
  };
}

export async function issueAssistedMemberPasswordReset(memberId: string, raw: unknown) {
  const input = (raw ?? {}) as Record<string, unknown>;
  const operationId = assertBrowserOperationId(input.operationId);
  const ctx = await getBrowserOperationContextForHousehold();
  assertActorCanAssist(ctx);

  return withOpeningDetails(await issueHouseholdBrowserOperation({
    ctx,
    operationId,
    operationKey: BrowserOperationKey.memberPasswordReset,
    targetKind: BrowserOperationTargetKind.member,
    targetId: memberId,
    permission: "member.manage",
    preIdentityLock: assistedPreIdentityLock(ctx, operationId),
    targetSnapshot: async (tx, lockedCtx) => resetOpeningSnapshot(tx, lockedCtx, memberId)
  }), ctx.householdId, operationId);
}

export async function submitAssistedMemberPasswordReset(memberId: string, raw: unknown): Promise<AssistedProcedureResult> {
  const { memberId: _pathEcho, ...submitted } = (raw ?? {}) as Record<string, unknown>;
  const request = parseMemberPasswordResetSubmission(submitted);
  const ctx = await getBrowserOperationContextForHousehold();
  assertActorCanAssist(ctx);

  const binding = await loadAssistedBinding(ctx.householdId, request.operationId);
  if (binding.targetId !== memberId) throw new Error("not_found");
  if (binding.openingFingerprint !== request.openingFingerprint) throw new Error("idempotency_conflict");

  const snapshot = binding.targetSnapshot as Record<string, unknown>;
  const targetMemberId = String(snapshot.targetMemberId ?? "");
  const targetUserId = String(snapshot.targetUserId ?? "");
  if (targetMemberId !== memberId) throw new Error("not_found");
  if (targetUserId !== request.targetUserId) throw new Error("idempotency_conflict");
  if (snapshot.credentialVersion !== request.credentialVersion || snapshot.sessionSecurityVersion !== request.sessionSecurityVersion) {
    return { status: "stale", operationId: request.operationId, code: "stale_revision" };
  }

  const stablePasswordIntentCommitment = buildAssistedPasswordIntentCommitment(commitmentKey(), {
    operationId: request.operationId,
    householdId: ctx.householdId,
    actorUserId: ctx.userId,
    actorSessionId: ctx.sessionId,
    actorMemberId: ctx.memberId,
    operationKey: "member.password.reset",
    targetMemberId,
    targetUserId,
    requireFirstLoginPasswordChange: request.requireFirstLoginPasswordChange,
    password: request.password
  });
  const intentFingerprint = browserIntentFingerprint({
    openingFingerprint: request.openingFingerprint,
    stablePasswordIntentCommitment,
    targetMemberId,
    targetUserId,
    requireFirstLoginPasswordChange: request.requireFirstLoginPasswordChange
  });

  const replay = await replayOrConflict("member.password.reset", ctx, request.operationId, binding, intentFingerprint);
  if (replay) return replay;

  const passwordHash = await (await auth.$context).password.hash(request.password);
  const attestation = attestationSigner().sign({
    purpose: "member_password_reset",
    actorUserId: ctx.userId,
    actorSessionId: ctx.sessionId,
    actorMemberId: ctx.memberId,
    householdId: ctx.householdId,
    operationId: request.operationId,
    openingFingerprint: request.openingFingerprint,
    intentFingerprint,
    replacementPasswordHash: passwordHash,
    newValues: { targetUserId, targetMemberId, requireFirstLoginPasswordChange: request.requireFirstLoginPasswordChange },
    oldCredentialVersion: request.credentialVersion,
    oldSessionSecurityVersion: request.sessionSecurityVersion
  });

  return runAssistedSerializableTransaction(async () =>
    prisma.$transaction(async (tx) => {
      const rows = await (tx as AssistedTransaction).$queryRaw<Array<{ result: unknown }>>`SELECT public."reset_assisted_member_password_v1"(${ctx.userId}, ${ctx.sessionId}, ${ctx.memberId}, ${ctx.householdId}, ${request.operationId}, ${request.openingFingerprint}, ${intentFingerprint}, ${targetMemberId}, ${request.credentialVersion}::INTEGER, ${request.sessionSecurityVersion}::INTEGER, ${passwordHash}, ${attestation.replacementPasswordHashDigest}, ${request.requireFirstLoginPasswordChange}, ${attestation.keyVersion}::INTEGER, ${attestation.nonce}, ${attestation.issuedAt}::TIMESTAMP, ${attestation.mac}) AS "result"`;
      return projectAssistedProcedureResult("member.password.reset", request.operationId, procedureResultOf(rows));
    }, { isolationLevel: "Serializable" })
  );
}

export async function getAssistedMemberPasswordResetStatus(raw: unknown) {
  const input = (raw ?? {}) as Record<string, unknown>;
  const operationId = assertBrowserOperationId(input.operationId);
  const ctx = await getBrowserOperationContextForHousehold();
  return assistedOperationStatus("member.password.reset", ctx, operationId);
}

export async function abandonAssistedMemberPasswordReset(raw: unknown) {
  const input = (raw ?? {}) as Record<string, unknown>;
  const operationId = assertBrowserOperationId(input.operationId);
  const ctx = await getBrowserOperationContextForHousehold();
  return abandonHouseholdBrowserOperation({
    ctx,
    operationId,
    operationKey: BrowserOperationKey.memberPasswordReset,
    preIdentityLock: assistedPreIdentityLock(ctx, operationId)
  });
}

export const assistedBrowserOperationStatusHooks = {
  [BrowserOperationKey.memberAccountCreate]: async (operationId: string) =>
    getAssistedMemberAccountCreateStatus({ operationId }),
  [BrowserOperationKey.memberPasswordReset]: async (operationId: string) =>
    getAssistedMemberPasswordResetStatus({ operationId })
} as const;
