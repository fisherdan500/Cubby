import { createHash, createHmac } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { env } from "@/lib/env";
import { sessionDeviceLabel } from "@/lib/auth/session-display";
import { issueFreshAuthGrantForCurrentPassword, type FreshAuthThrottleContext, type GlobalSecurityContext } from "@/server/services/global-security";
import { createFreshAuthAttestationSigner } from "@/server/services/fresh-auth-attestation";

type SessionSecurityDatabase = Pick<PrismaClient, "$queryRaw" | "$transaction">;

type SessionAuthorizationRow = {
  authorized: boolean;
  expiresAt: Date | null;
  lastQualifyingAt: Date | null;
  idleWarningAt: Date | null;
};

type SafeSessionListRow = {
  sessionId: string;
  userAgent: string | null;
  createdAt: Date;
  lastQualifyingAt: Date;
  idleWarningAt: Date | null;
  expiresAt: Date;
};

export type QualifyingGlobalSessionUse =
  | "foreground_document_navigation"
  | "cubby_owned_non_get_mutation"
  | "private_security_action";

export type SessionRevokeScope = "current" | "one" | "others" | "all";

const absentTargetHandle = "absent_target_handle";
const absentTargetSessionId = "absent_target_session_id";

type SessionRevokeTarget = {
  scope: SessionRevokeScope;
  canonicalTargetHandle: string;
  resolvedTargetSessionId: string;
};

function resolveSessionRevokeTarget(
  identity: Pick<GlobalSecurityContext, "userId" | "sessionId">,
  scope: unknown,
  targetHandle: unknown,
  sessionIds: string[]
): SessionRevokeTarget {
  if (scope !== "current" && scope !== "one" && scope !== "others" && scope !== "all") throw new Error("session_revoke_scope_invalid");
  if ((scope === "current" || scope === "one") && (typeof targetHandle !== "string" || targetHandle.length === 0)) throw new Error("session_revoke_target_required");
  if ((scope === "others" || scope === "all") && targetHandle !== undefined) throw new Error("session_revoke_target_forbidden");
  if (scope === "current") {
    if (targetHandle !== createGlobalSessionHandle(identity.userId, identity.sessionId)) throw new Error("session_revoke_target_invalid");
    return { scope, canonicalTargetHandle: targetHandle as string, resolvedTargetSessionId: identity.sessionId };
  }
  if (scope === "one") {
    const resolvedTargetSessionId = sessionIds.find((candidate) => candidate !== identity.sessionId && createGlobalSessionHandle(identity.userId, candidate) === targetHandle);
    if (!resolvedTargetSessionId) throw new Error("session_revoke_target_invalid");
    return { scope, canonicalTargetHandle: targetHandle as string, resolvedTargetSessionId };
  }
  return { scope, canonicalTargetHandle: absentTargetHandle, resolvedTargetSessionId: absentTargetSessionId };
}

function validateSessionRevokeScopeAndHandle(scope: unknown, targetHandle: unknown) {
  if (scope !== "current" && scope !== "one" && scope !== "others" && scope !== "all") throw new Error("session_revoke_scope_invalid");
  if ((scope === "current" || scope === "one") && (typeof targetHandle !== "string" || targetHandle.length === 0)) throw new Error("session_revoke_target_required");
  if ((scope === "others" || scope === "all") && targetHandle !== undefined) throw new Error("session_revoke_target_forbidden");
}

export async function revokeGlobalSessionSecurityWithCurrentPassword(
  database: SessionSecurityDatabase,
  expected: GlobalSecurityContext,
  input: { operationId: string; openingFingerprint: string; intentFingerprint: string; scope: SessionRevokeScope; targetHandle?: string; confirmed: boolean },
  currentPassword: string,
  verifier: { verify: (input: { hash: string; password: string }) => Promise<boolean> },
  signer?: ReturnType<typeof createFreshAuthAttestationSigner>,
  throttleContext?: FreshAuthThrottleContext
) {
  if (input.confirmed !== true) throw new Error("session_revoke_confirmation_required");
  validateSessionRevokeScopeAndHandle(input.scope, input.targetHandle);
  const retryTargets = await database.$queryRaw<Array<{ scope: SessionRevokeScope; canonicalTargetHandle: string; resolvedTargetSessionId: string }>>`
    SELECT * FROM "get_session_revoke_retry_target"(${expected.userId},${expected.sessionId},${input.operationId},${input.openingFingerprint},${input.intentFingerprint})
  `;
  let target: SessionRevokeTarget;
  if (retryTargets.length === 1) {
    const persisted = retryTargets[0]!;
    const submittedHandle = input.targetHandle ?? absentTargetHandle;
    if (persisted.scope !== input.scope || persisted.canonicalTargetHandle !== submittedHandle) throw new Error("idempotency_conflict");
    target = persisted;
  } else {
    const targetRows = await database.$queryRaw<Array<{ sessionId: string }>>`
      SELECT "id" AS "sessionId" FROM "Session"
      WHERE "userId" = ${expected.userId}
      ORDER BY "id" ASC
    `;
    target = resolveSessionRevokeTarget(expected, input.scope, input.targetHandle, targetRows.map((row) => row.sessionId));
  }
  if (input.intentFingerprint !== createSessionRevokeIntentFingerprint(target.scope, target.canonicalTargetHandle)) throw new Error("session_revoke_intent_invalid");
  await issueFreshAuthGrantForCurrentPassword(
    database,
    expected,
    { operationId: input.operationId, purpose: "session_revoke", openingFingerprint: input.openingFingerprint, intentFingerprint: input.intentFingerprint, sessionRevoke: target },
    currentPassword,
    verifier,
    undefined,
    signer ?? createFreshAuthAttestationSigner(),
    throttleContext
  );
  const result = await database.$queryRaw<Array<{ status: "revoked" | "already_revoked" }>>`
    SELECT "status" FROM "complete_session_revoke"(${expected.userId}, ${expected.sessionId}, ${input.operationId}, ${input.openingFingerprint}, ${input.intentFingerprint})
  `;
  if (result.length !== 1 || (result[0]?.status !== "revoked" && result[0]?.status !== "already_revoked")) throw new Error("session_revoke_outcome_invalid");
  return { operationId: input.operationId, status: result[0].status };
}

export async function getGlobalSessionRevokeStatus(
  database: SessionSecurityDatabase,
  identity: Pick<GlobalSecurityContext, "userId" | "sessionId">,
  input: { operationId: string; openingFingerprint: string; intentFingerprint: string }
) {
  const result = await database.$queryRaw<Array<{ status: "pending" | "unknown" | "revoked" | "already_revoked" | "stale_security_version" }>>`
    SELECT "status" FROM "get_session_revoke_status"(${identity.userId}, ${identity.sessionId}, ${input.operationId}, ${input.openingFingerprint}, ${input.intentFingerprint})
  `;
  if (result.length !== 1 || !["pending", "unknown", "revoked", "already_revoked", "stale_security_version"].includes(result[0]?.status ?? "")) throw new Error("session_revoke_outcome_invalid");
  return { operationId: input.operationId, status: result[0].status };
}

export async function initializeGlobalSessionSecurityActivity(
  database: SessionSecurityDatabase,
  identity: { userId: string; sessionId: string }
) {
  await database.$queryRaw`
    SELECT "initialized"
    FROM "initialize_global_session_security_activity"(${identity.userId}, ${identity.sessionId})
  `;
}

export async function authorizeGlobalSessionSecurity(
  database: SessionSecurityDatabase,
  identity: { userId: string; sessionId: string }
) {
  return authorizeGlobalSessionSecurityWithUse(database, identity, null);
}

export async function recordQualifyingGlobalSessionUseAfterSuccess(
  database: SessionSecurityDatabase,
  identity: { userId: string; sessionId: string },
  qualifyingUse: QualifyingGlobalSessionUse
) {
  return authorizeGlobalSessionSecurityWithUse(database, identity, qualifyingUse);
}

async function authorizeGlobalSessionSecurityWithUse(
  database: SessionSecurityDatabase,
  identity: { userId: string; sessionId: string },
  qualifyingUse: QualifyingGlobalSessionUse | null
) {
  const rows = await database.$queryRaw<SessionAuthorizationRow[]>`
    SELECT "authorized", "expiresAt", "lastQualifyingAt", "idleWarningAt"
    FROM "authorize_global_session_security"(${identity.userId}, ${identity.sessionId}, ${qualifyingUse})
  `;
  const result = rows[0];
  if (!result?.authorized || !result.expiresAt || !result.lastQualifyingAt) {
    throw new Error("unauthenticated");
  }
  return {
    expiresAt: result.expiresAt,
    lastQualifyingAt: result.lastQualifyingAt,
    idleWarningAt: result.idleWarningAt
  };
}

function frameUtf8(value: string) {
  const bytes = Buffer.from(value, "utf8");
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

export function createGlobalSessionHandle(userId: string, sessionId: string) {
  const phase7HandleKey = createHmac("sha256", env.BETTER_AUTH_SECRET)
    .update("cubby:phase7:global-session-handle:v1", "utf8")
    .digest();
  return createHmac("sha256", phase7HandleKey)
    .update(Buffer.concat([frameUtf8(userId), frameUtf8(sessionId)]))
    .digest()
    .subarray(0, 22)
    .toString("base64url");
}

export function createSessionRevokeIntentFingerprint(scope: SessionRevokeScope, canonicalTargetHandle: string) {
  return createHash("sha256")
    .update(Buffer.concat([frameUtf8(scope), frameUtf8(canonicalTargetHandle)]))
    .digest("hex");
}

export async function listGlobalSessionSecurity(
  database: SessionSecurityDatabase,
  identity: { userId: string; sessionId: string }
) {
  const rows = await database.$queryRaw<SafeSessionListRow[]>`
    SELECT * FROM "list_global_session_security"(${identity.userId},${identity.sessionId})
  `;
  return rows.map((row) => ({
    handle: createGlobalSessionHandle(identity.userId, row.sessionId),
    isCurrent: row.sessionId === identity.sessionId,
    deviceLabel: sessionDeviceLabel(row.userAgent),
    createdAt: row.createdAt,
    lastQualifyingAt: row.lastQualifyingAt,
    idleWarningAt: row.idleWarningAt,
    expiresAt: row.expiresAt
  }));
}
