import { beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserOperationKey, BrowserOperationTargetKind } from "@prisma/client";

const mocks = vi.hoisted(() => ({
  getContext: vi.fn(),
  requireFreshSession: vi.fn(),
  issue: vi.fn(),
  abandon: vi.fn(),
  fingerprint: vi.fn(),
  registerStatusHook: vi.fn(),
  transaction: vi.fn(),
  queryRaw: vi.fn(),
  executeRaw: vi.fn(),
  bindingFindFirst: vi.fn(),
  hash: vi.fn(),
  throttleKey: vi.fn()
}));

const operationIdPattern = /^bmo_[0-9abcdefghjkmnpqrstvwxyz]{26}$/;

vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    $transaction: mocks.transaction,
    browserOperationBinding: { findFirst: mocks.bindingFindFirst }
  }
}));
vi.mock("@/lib/auth/auth", () => ({
  auth: { $context: Promise.resolve({ password: { hash: mocks.hash } }) },
  SESSION_FRESH_AGE_SECONDS: 600
}));
vi.mock("@/server/auth/session", () => ({ requireFreshSession: mocks.requireFreshSession, getSession: vi.fn() }));
vi.mock("@/server/auth/context", () => ({ getEffectiveHouseholdContext: vi.fn(), requirePermission: vi.fn() }));
vi.mock("@/server/services/global-security-throttling", () => ({ configuredGlobalSecurityThrottleKey: mocks.throttleKey }));
vi.mock("@/server/services/browser-operations", () => ({
  getBrowserOperationContextForHousehold: mocks.getContext,
  issueHouseholdBrowserOperation: mocks.issue,
  abandonHouseholdBrowserOperation: mocks.abandon,
  browserIntentFingerprint: mocks.fingerprint,
  registerAssistedBrowserOperationStatusHook: mocks.registerStatusHook,
  assertBrowserOperationId: (value: unknown) => {
    if (typeof value !== "string" || !operationIdPattern.test(value)) throw new Error("validation_error");
    return value;
  }
}));

import {
  abandonAssistedMemberAccountCreate,
  abandonAssistedMemberPasswordReset,
  assistedBrowserOperationStatusHooks,
  getAssistedMemberAccountCreateStatus,
  getAssistedMemberPasswordResetStatus,
  issueAssistedMemberAccountCreate,
  issueAssistedMemberPasswordReset,
  submitAssistedMemberAccountCreate,
  submitAssistedMemberPasswordReset
} from "@/server/services/admin-assisted-accounts-service";

const operationId = "bmo_0123456789abcdefghjkmnpqrs";
const openingFingerprint = "a".repeat(64);
const intentFingerprint = "b".repeat(64);
const throttleKey = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
const keyring = "1:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
const passwordHash = `${"0".repeat(32)}:${"f".repeat(64)}`;
const ownerCtx = { userId: "owner-user", sessionId: "session-1", householdId: "household-1", memberId: "owner-member", role: "owner" as const };
const platformUpdatedAt = new Date("2026-01-01T00:00:00.000Z");
const actorUpdatedAt = new Date("2026-01-02T00:00:00.000Z");
const targetUpdatedAt = new Date("2026-01-03T00:00:00.000Z");

const createBody = {
  operationId,
  openingFingerprint,
  name: "New Person",
  email: "New.Person@Example.COM",
  role: "parent" as const,
  password: "correct horse battery",
  passwordConfirmation: "correct horse battery",
  requireFirstLoginPasswordChange: true
};
const resetBody = {
  operationId,
  openingFingerprint,
  targetUserId: "target-user",
  credentialVersion: 3,
  sessionSecurityVersion: 4,
  password: "replacement secret value",
  passwordConfirmation: "replacement secret value",
  requireFirstLoginPasswordChange: false
};

const createSnapshot = {
  schemaVersion: 1,
  householdId: ownerCtx.householdId,
  actorMemberId: ownerCtx.memberId,
  actorRole: "owner",
  actorMembershipUpdatedAt: actorUpdatedAt.toISOString(),
  platformAuthorityUpdatedAt: platformUpdatedAt.toISOString()
};

const resetSnapshot = {
  schemaVersion: 1,
  householdId: ownerCtx.householdId,
  actorMemberId: ownerCtx.memberId,
  actorRole: "owner",
  actorMembershipUpdatedAt: actorUpdatedAt.toISOString(),
  targetMemberId: "target-member",
  targetUserId: "target-user",
  targetRole: "parent",
  targetMembershipUpdatedAt: targetUpdatedAt.toISOString(),
  credentialVersion: 3,
  sessionSecurityVersion: 4,
  platformAuthorityUpdatedAt: platformUpdatedAt.toISOString()
};

function sqlText(query: unknown) {
  return Array.isArray(query) ? query.join(" ? ") : String((query as { sql?: string })?.sql ?? query);
}

type RecordedCall = { text: string; values: unknown[] };
let recorded: RecordedCall[] = [];
let procedureResult: unknown = null;
let statusRows: unknown[] = [];
let platformOwnerUserId = "platform-owner-user";
let memberRows: Array<Record<string, unknown>> = [];
let securityRow: Record<string, unknown> | null = null;

function record(kind: string) {
  return async (query: unknown, ...values: unknown[]) => {
    const text = sqlText(query);
    recorded.push({ text: `${kind} ${text}`, values });
    if (text.includes("PlatformAuthority")) return [{ ownerUserId: platformOwnerUserId, updatedAt: platformUpdatedAt }];
    if (text.includes("create_assisted_member_account_v1") || text.includes("reset_assisted_member_password_v1")) {
      return [{ result: procedureResult }];
    }
    if (text.includes("get_assisted_account_operation_status_v1")) return statusRows;
    if (text.includes("AccountSecurityState")) return securityRow ? [securityRow] : [];
    if (text.includes("HouseholdMember")) return memberRows;
    return [];
  };
}

function fakeTransactionClient() {
  return { $queryRaw: mocks.queryRaw, $executeRaw: mocks.executeRaw } as never;
}

function openBinding(overrides: Record<string, unknown> = {}) {
  return {
    id: "binding-1",
    householdId: ownerCtx.householdId,
    operationId,
    operationKey: BrowserOperationKey.memberAccountCreate,
    sessionId: ownerCtx.sessionId,
    actorUserId: ownerCtx.userId,
    actorMemberId: ownerCtx.memberId,
    openingFingerprint,
    persistenceVersion: 2,
    protocolVersion: "browser_v2",
    targetKind: BrowserOperationTargetKind.household,
    targetId: null,
    babyId: null,
    targetSnapshot: createSnapshot,
    state: "open",
    expiresAt: new Date(Date.now() + 600_000),
    operation: null,
    ...overrides
  };
}

function resetBinding(overrides: Record<string, unknown> = {}) {
  return openBinding({
    operationKey: BrowserOperationKey.memberPasswordReset,
    targetKind: BrowserOperationTargetKind.member,
    targetId: "target-member",
    targetSnapshot: resetSnapshot,
    ...overrides
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  recorded = [];
  procedureResult = { operationId, status: "completed", outcomeCode: "created", memberId: "created-member" };
  statusRows = [];
  platformOwnerUserId = "platform-owner-user";
  securityRow = { userId: "target-user", credentialVersion: 3, sessionSecurityVersion: 4 };
  memberRows = [
    { id: ownerCtx.memberId, userId: ownerCtx.userId, role: "owner", disabledAt: null, deletedAt: null, updatedAt: actorUpdatedAt },
    { id: "target-member", userId: "target-user", role: "parent", disabledAt: null, deletedAt: null, updatedAt: targetUpdatedAt }
  ];
  process.env.CUBBY_FRESH_AUTH_ATTESTATION_KEYRING = keyring;
  process.env.CUBBY_FRESH_AUTH_ATTESTATION_ACTIVE_KEY_VERSION = "1";
  mocks.getContext.mockResolvedValue(ownerCtx);
  mocks.requireFreshSession.mockResolvedValue({
    user: { id: ownerCtx.userId },
    session: { id: ownerCtx.sessionId, createdAt: new Date(), expiresAt: new Date(Date.now() + 600_000) }
  });
  mocks.throttleKey.mockReturnValue(throttleKey);
  mocks.fingerprint.mockReturnValue(intentFingerprint);
  mocks.hash.mockResolvedValue(passwordHash);
  mocks.queryRaw.mockImplementation(record("query"));
  mocks.executeRaw.mockImplementation(record("execute"));
  mocks.transaction.mockImplementation(async (run: (tx: unknown) => Promise<unknown>) => run(fakeTransactionClient()));
  mocks.bindingFindFirst.mockResolvedValue(openBinding());
  mocks.issue.mockImplementation(async (input: any) => {
    await input.preIdentityLock?.(fakeTransactionClient());
    const snapshot = await input.targetSnapshot(fakeTransactionClient(), ownerCtx);
    return { status: "open", operationId, bindingId: "binding-1", snapshot };
  });
  mocks.abandon.mockImplementation(async (input: any) => {
    await input.preIdentityLock?.(fakeTransactionClient());
    return { status: "expired", operationId, code: "operation_abandoned" };
  });
});

describe("assisted member account create reservation", () => {
  it("reserves a household-scoped assisted operation with the protocol opening snapshot", async () => {
    const result = await issueAssistedMemberAccountCreate({ operationId });

    expect(result).toMatchObject({ status: "open", operationId });
    expect(mocks.issue).toHaveBeenCalledWith(expect.objectContaining({
      ctx: ownerCtx,
      operationId,
      operationKey: BrowserOperationKey.memberAccountCreate,
      targetKind: BrowserOperationTargetKind.household,
      permission: "member.manage"
    }));
    expect((result as unknown as { snapshot: Record<string, unknown> }).snapshot).toEqual({
      schemaVersion: 1,
      householdId: ownerCtx.householdId,
      actorMemberId: ownerCtx.memberId,
      actorRole: "owner",
      actorMembershipUpdatedAt: actorUpdatedAt.toISOString(),
      platformAuthorityUpdatedAt: platformUpdatedAt.toISOString()
    });
  });

  it("takes the assisted fence and every NOWAIT lock before any browser identity or binding access", async () => {
    await issueAssistedMemberAccountCreate({ operationId });

    const text = recorded.map((call) => call.text);
    const fence = text.findIndex((entry) => entry.includes("acquire_assisted_credential_fence_v1"));
    const identity = text.findIndex((entry) => entry.includes("try_lock_assisted_browser_identity_v1"));
    const binding = text.findIndex((entry) => entry.includes("BrowserOperationBinding"));
    expect(fence).toBe(0);
    expect(identity).toBeGreaterThan(fence);
    expect(binding).toBeGreaterThan(identity);
    expect(text.some((entry) => entry.includes("lock_actor_session_for_assisted_operation_nowait"))).toBe(true);
    expect(text.filter((entry) => /FOR (UPDATE|SHARE|KEY SHARE)/.test(entry))
      .every((entry) => entry.includes("NOWAIT"))).toBe(true);
    expect(text.some((entry) => entry.includes("lock_actor_session_for_operation\"") || entry.includes("lock_user_sessions_for_operation"))).toBe(false);
  });

  it("refuses a reservation without a client assisted operation id", async () => {
    await expect(issueAssistedMemberAccountCreate({})).rejects.toThrow();
    expect(mocks.issue).not.toHaveBeenCalled();
  });

  it("refuses a reservation from a member without household member authority", async () => {
    mocks.getContext.mockResolvedValue({ ...ownerCtx, role: "parent" });
    await expect(issueAssistedMemberAccountCreate({ operationId })).rejects.toThrow("forbidden");
    expect(mocks.issue).not.toHaveBeenCalled();
  });
});

describe("assisted member account create submission", () => {
  it("hashes outside the transaction and calls the reviewed create procedure with the attested intent", async () => {
    const result = await submitAssistedMemberAccountCreate(createBody);

    expect(result).toEqual({
      status: "completed",
      operationId,
      outcome: { kind: "member_account", code: "created", memberId: "created-member" }
    });
    expect(mocks.hash).toHaveBeenCalledTimes(1);
    expect(mocks.hash.mock.invocationCallOrder[0]).toBeLessThan(mocks.transaction.mock.invocationCallOrder[0]);
    const call = recorded.find((entry) => entry.text.includes("create_assisted_member_account_v1"));
    expect(call).toBeDefined();
    expect(call!.values.slice(0, 10)).toEqual([
      ownerCtx.userId, ownerCtx.sessionId, ownerCtx.memberId, ownerCtx.householdId,
      operationId, openingFingerprint, intentFingerprint, "New Person", "new.person@example.com", "parent"
    ]);
    expect(call!.values).toContain(passwordHash);
    expect(call!.values).toContain(true);
  });

  it("binds the stable password commitment and nonsecret canonical fields into the intent fingerprint", async () => {
    await submitAssistedMemberAccountCreate(createBody);

    expect(mocks.throttleKey).toHaveBeenCalled();
    expect(mocks.fingerprint).toHaveBeenCalledTimes(1);
    const input = mocks.fingerprint.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(input).sort()).toEqual([
      "exactDisplayName", "normalizedEmail", "openingFingerprint", "requireFirstLoginPasswordChange",
      "role", "stablePasswordIntentCommitment"
    ]);
    expect(input.openingFingerprint).toBe(openingFingerprint);
    expect(input.normalizedEmail).toBe("new.person@example.com");
    expect(input.stablePasswordIntentCommitment).toMatch(/^[0-9a-f]{64}$/);
  });

  it("never sends the plaintext password, its confirmation, or an unkeyed digest to the database", async () => {
    await submitAssistedMemberAccountCreate(createBody);

    const serialized = JSON.stringify(recorded);
    expect(serialized).not.toContain(createBody.password);
    expect(serialized).not.toContain("passwordConfirmation");
  });

  it("fails closed before hashing when the commitment key is unconfigured", async () => {
    mocks.throttleKey.mockImplementation(() => { throw new Error("global_security_throttle_key_invalid"); });

    await expect(submitAssistedMemberAccountCreate(createBody)).rejects.toThrow("global_security_throttle_key_invalid");
    expect(mocks.hash).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("rejects an admin actor assisting an admin role without reaching the database", async () => {
    mocks.getContext.mockResolvedValue({ ...ownerCtx, role: "admin" });

    await expect(submitAssistedMemberAccountCreate({ ...createBody, role: "admin" })).rejects.toThrow("forbidden");
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("lets an owner assist an admin role", async () => {
    await expect(submitAssistedMemberAccountCreate({ ...createBody, role: "admin" })).resolves.toMatchObject({ status: "completed" });
  });

  it("surfaces the frozen existing-account rejection instead of an error", async () => {
    procedureResult = { operationId, status: "rejected", outcomeCode: "existing_account_invitation_required" };

    await expect(submitAssistedMemberAccountCreate(createBody)).resolves.toEqual({
      status: "rejected", operationId, code: "existing_account_invitation_required"
    });
  });

  it("surfaces a database stale outcome as the frozen stale code", async () => {
    procedureResult = { operationId, status: "stale", outcomeCode: "stale_revision" };

    await expect(submitAssistedMemberAccountCreate(createBody)).resolves.toEqual({
      status: "stale", operationId, code: "stale_revision"
    });
  });

  it("retries the whole serializable transaction on an assisted NOWAIT conflict", async () => {
    let attempts = 0;
    mocks.transaction.mockImplementation(async (run: (tx: unknown) => Promise<unknown>) => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error("lock not available"), { code: "55P03" });
      return run(fakeTransactionClient());
    });

    await expect(submitAssistedMemberAccountCreate(createBody)).resolves.toMatchObject({ status: "completed" });
    expect(attempts).toBe(2);
    expect(mocks.hash).toHaveBeenCalledTimes(1);
  });

  it("conflicts when a submitted operation carries a different canonical intent", async () => {
    mocks.bindingFindFirst.mockResolvedValue(openBinding({
      state: "submitted",
      operation: { operationId, status: "pending", outcomeCode: null, outcomeSnapshot: null, intentFingerprint: "c".repeat(64) }
    }));

    await expect(submitAssistedMemberAccountCreate(createBody)).rejects.toThrow("idempotency_conflict");
    expect(mocks.hash).not.toHaveBeenCalled();
  });

  it("replays an identical retry through the reviewed status projection without hashing again", async () => {
    mocks.bindingFindFirst.mockResolvedValue(openBinding({
      state: "terminal",
      operation: { operationId, status: "completed", outcomeCode: "created", outcomeSnapshot: { memberId: "created-member" }, intentFingerprint }
    }));
    statusRows = [{
      operationId, status: "completed", outcomeCode: "created", outcomeKind: "member_account",
      targetMemberId: "created-member", terminalAt: new Date(), compacted: false
    }];

    await expect(submitAssistedMemberAccountCreate(createBody)).resolves.toEqual({
      status: "completed", operationId, outcome: { kind: "member_account", code: "created", memberId: "created-member" }
    });
    expect(mocks.hash).not.toHaveBeenCalled();
    expect(recorded.some((entry) => entry.text.includes("get_assisted_account_operation_status_v1"))).toBe(true);
  });

  it("reports a stale context for an expired reservation", async () => {
    mocks.bindingFindFirst.mockResolvedValue(openBinding({ expiresAt: new Date(Date.now() - 1_000) }));

    await expect(submitAssistedMemberAccountCreate(createBody)).resolves.toEqual({
      status: "stale", operationId, code: "stale_context"
    });
    expect(mocks.hash).not.toHaveBeenCalled();
  });

  it("conflicts when the client replays a different opening fingerprint", async () => {
    await expect(submitAssistedMemberAccountCreate({ ...createBody, openingFingerprint: "d".repeat(64) }))
      .rejects.toThrow("idempotency_conflict");
  });

  it("reports a stale target when no assisted reservation exists", async () => {
    mocks.bindingFindFirst.mockResolvedValue(null);

    await expect(submitAssistedMemberAccountCreate(createBody)).rejects.toThrow("not_found");
  });

  it("rejects a confirmation mismatch as an invalid request", async () => {
    await expect(submitAssistedMemberAccountCreate({ ...createBody, passwordConfirmation: "different value" }))
      .rejects.toThrow("admin_assisted_request_invalid");
    expect(mocks.hash).not.toHaveBeenCalled();
  });
});

describe("assisted member password reset", () => {
  beforeEach(() => {
    mocks.bindingFindFirst.mockResolvedValue(resetBinding());
    procedureResult = { operationId, status: "completed", outcomeCode: "reset", memberId: "target-member" };
  });

  it("reserves a member-scoped reset with the protocol opening snapshot", async () => {
    const result = await issueAssistedMemberPasswordReset("target-member", { operationId });

    expect(mocks.issue).toHaveBeenCalledWith(expect.objectContaining({
      operationKey: BrowserOperationKey.memberPasswordReset,
      targetKind: BrowserOperationTargetKind.member,
      targetId: "target-member",
      permission: "member.manage"
    }));
    expect((result as unknown as { snapshot: Record<string, unknown> }).snapshot).toEqual(resetSnapshot);
  });

  it("refuses to reserve a reset of the actor's own account", async () => {
    memberRows = [
      memberRows[0],
      { id: "target-member", userId: ownerCtx.userId, role: "parent", disabledAt: null, deletedAt: null, updatedAt: targetUpdatedAt }
    ];

    await expect(issueAssistedMemberPasswordReset("target-member", { operationId })).rejects.toThrow("forbidden");
  });

  it("refuses to reserve a reset of the protected platform owner", async () => {
    platformOwnerUserId = "target-user";

    await expect(issueAssistedMemberPasswordReset("target-member", { operationId })).rejects.toThrow("forbidden");
  });

  it("refuses to reserve a reset of the household owner", async () => {
    memberRows = [
      memberRows[0],
      { id: "target-member", userId: "target-user", role: "owner", disabledAt: null, deletedAt: null, updatedAt: targetUpdatedAt }
    ];

    await expect(issueAssistedMemberPasswordReset("target-member", { operationId })).rejects.toThrow("forbidden");
  });

  it("refuses to reserve a reset of an admin when the actor is an admin", async () => {
    mocks.getContext.mockResolvedValue({ ...ownerCtx, role: "admin" });
    memberRows = [
      { id: ownerCtx.memberId, userId: ownerCtx.userId, role: "admin", disabledAt: null, deletedAt: null, updatedAt: actorUpdatedAt },
      { id: "target-member", userId: "target-user", role: "admin", disabledAt: null, deletedAt: null, updatedAt: targetUpdatedAt }
    ];

    await expect(issueAssistedMemberPasswordReset("target-member", { operationId })).rejects.toThrow("forbidden");
  });

  it("refuses to reserve a reset of a removed member", async () => {
    memberRows = [
      memberRows[0],
      { id: "target-member", userId: "target-user", role: "parent", disabledAt: null, deletedAt: new Date(), updatedAt: targetUpdatedAt }
    ];

    await expect(issueAssistedMemberPasswordReset("target-member", { operationId })).rejects.toThrow("not_found");
  });

  it("calls the reviewed reset procedure with server-derived target identity and versions", async () => {
    await expect(submitAssistedMemberPasswordReset("target-member", { ...resetBody, memberId: "spoofed-member" }))
      .resolves.toEqual({
        status: "completed",
        operationId,
        outcome: { kind: "member_password", code: "reset", memberId: "target-member" }
      });

    const call = recorded.find((entry) => entry.text.includes("reset_assisted_member_password_v1"));
    expect(call).toBeDefined();
    expect(call!.values.slice(0, 10)).toEqual([
      ownerCtx.userId, ownerCtx.sessionId, ownerCtx.memberId, ownerCtx.householdId,
      operationId, openingFingerprint, intentFingerprint, "target-member", 3, 4
    ]);
    expect(call!.values).toContain(passwordHash);
  });

  it("binds only the reset canonical fields into the intent fingerprint", async () => {
    await submitAssistedMemberPasswordReset("target-member", resetBody);

    const input = mocks.fingerprint.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(input).sort()).toEqual([
      "openingFingerprint", "requireFirstLoginPasswordChange", "stablePasswordIntentCommitment",
      "targetMemberId", "targetUserId"
    ]);
    expect(input.targetMemberId).toBe("target-member");
    expect(input.targetUserId).toBe("target-user");
  });

  it("surfaces the truthful privacy rejection from the database", async () => {
    procedureResult = { operationId, status: "rejected", outcomeCode: "personal_recovery_unavailable" };

    await expect(submitAssistedMemberPasswordReset("target-member", resetBody)).resolves.toEqual({
      status: "rejected", operationId, code: "personal_recovery_unavailable"
    });
  });

  it("reports a stale revision when the client version vector no longer matches the reservation", async () => {
    await expect(submitAssistedMemberPasswordReset("target-member", { ...resetBody, credentialVersion: 2 }))
      .resolves.toEqual({ status: "stale", operationId, code: "stale_revision" });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("conflicts when the client replays a different canonical target user", async () => {
    await expect(submitAssistedMemberPasswordReset("target-member", { ...resetBody, targetUserId: "other-user" }))
      .rejects.toThrow("idempotency_conflict");
  });

  it("reports a stale target when the path member is not the reserved target", async () => {
    await expect(submitAssistedMemberPasswordReset("other-member", resetBody)).rejects.toThrow("not_found");
  });
});

describe("assisted operation status and abandon", () => {
  it("projects the reviewed status function rows", async () => {
    const terminalAt = new Date("2026-02-01T00:00:00.000Z");
    statusRows = [{
      operationId, status: "completed", outcomeCode: "reset", outcomeKind: "member_password",
      targetMemberId: "target-member", terminalAt, compacted: false
    }];

    await expect(getAssistedMemberPasswordResetStatus({ operationId })).resolves.toEqual({
      status: "completed", operationId, outcome: { kind: "member_password", code: "reset", memberId: "target-member" }
    });
    const call = recorded.find((entry) => entry.text.includes("get_assisted_account_operation_status_v1"));
    expect(call!.values).toEqual([ownerCtx.userId, ownerCtx.sessionId, ownerCtx.householdId, operationId]);
    expect(mocks.requireFreshSession).not.toHaveBeenCalled();
  });

  it("maps a compacted terminal projection to an expired result", async () => {
    statusRows = [{
      operationId, status: "completed", outcomeCode: "created", outcomeKind: "member_account",
      targetMemberId: "created-member", terminalAt: new Date(), compacted: true
    }];

    await expect(getAssistedMemberAccountCreateStatus({ operationId })).resolves.toEqual({
      status: "expired", operationId, code: "operation_result_expired"
    });
  });

  it("maps a pending projection to the unknown pending code", async () => {
    statusRows = [{
      operationId, status: "pending", outcomeCode: null, outcomeKind: null,
      targetMemberId: null, terminalAt: null, compacted: false
    }];

    await expect(getAssistedMemberAccountCreateStatus({ operationId })).resolves.toEqual({
      status: "pending", operationId, code: "operation_unknown"
    });
  });

  it("discloses nothing when the fixed projection returns no row", async () => {
    statusRows = [];

    await expect(getAssistedMemberAccountCreateStatus({ operationId })).rejects.toThrow("not_found");
  });

  it("takes the assisted fence without demanding a recent sign-in for status", async () => {
    statusRows = [{
      operationId, status: "pending", outcomeCode: null, outcomeKind: null,
      targetMemberId: null, terminalAt: null, compacted: false
    }];

    await getAssistedMemberAccountCreateStatus({ operationId });

    expect(recorded[0]?.text).toContain("acquire_assisted_credential_fence_v1");
    expect(recorded.some((entry) => entry.text.includes("lock_actor_session_for_assisted_operation_nowait"))).toBe(false);
  });

  it("abandons an open reservation behind the same assisted fence and NOWAIT order", async () => {
    await expect(abandonAssistedMemberAccountCreate({ operationId })).resolves.toEqual({
      status: "expired", operationId, code: "operation_abandoned"
    });
    expect(mocks.abandon).toHaveBeenCalledWith(expect.objectContaining({
      ctx: ownerCtx, operationId, operationKey: BrowserOperationKey.memberAccountCreate
    }));
    expect(recorded[0]?.text).toContain("acquire_assisted_credential_fence_v1");
  });

  it("abandons a reset reservation under its own operation key", async () => {
    await expect(abandonAssistedMemberPasswordReset({ operationId })).resolves.toMatchObject({ status: "expired" });
    expect(mocks.abandon).toHaveBeenCalledWith(expect.objectContaining({
      operationKey: BrowserOperationKey.memberPasswordReset
    }));
  });

  it("exposes one status hook per assisted key for the substrate registry", () => {
    expect(Object.keys(assistedBrowserOperationStatusHooks).sort()).toEqual([
      BrowserOperationKey.memberAccountCreate, BrowserOperationKey.memberPasswordReset
    ].sort());
    expect(typeof assistedBrowserOperationStatusHooks[BrowserOperationKey.memberAccountCreate]).toBe("function");
  });
});

describe("assisted pre-identity lock substrate", () => {
  async function substrate() {
    return vi.importActual<typeof import("@/server/services/browser-operations")>("@/server/services/browser-operations");
  }

  function substrateTransaction(calls: string[]) {
    return {
      $executeRaw: async (query: unknown) => { calls.push(sqlText(query)); return 1; },
      $queryRaw: async (query: unknown) => { calls.push(sqlText(query)); return []; },
      session: { findFirst: async () => ({ id: ownerCtx.sessionId, userId: ownerCtx.userId }) },
      household: { findFirst: async () => ({ id: ownerCtx.householdId }) },
      householdMember: { findFirst: async () => ({ id: ownerCtx.memberId, role: "owner", updatedAt: actorUpdatedAt }) },
      browserOperationBinding: {
        findFirst: async () => { calls.push("binding.findFirst"); return null; },
        create: async () => ({ id: "binding-1" })
      },
      browserMutationOperationTombstone: { findUnique: async () => null },
      browserOperationReservationTombstone: { findUnique: async () => null }
    };
  }

  it("runs the assisted pre-identity hook before the household identity lock and binding read", async () => {
    const actual = await substrate();
    const calls: string[] = [];
    mocks.transaction.mockImplementation(async (run: (client: unknown) => Promise<unknown>) => run(substrateTransaction(calls)));

    const result = await actual.issueHouseholdBrowserOperation({
      ctx: ownerCtx,
      operationId,
      operationKey: BrowserOperationKey.memberAccountCreate,
      targetKind: BrowserOperationTargetKind.household,
      permission: "member.manage",
      preIdentityLock: async (client) => {
        await (client as { $executeRaw: (query: unknown) => Promise<unknown> }).$executeRaw(["SELECT assisted_fence"] as never);
      },
      targetSnapshot: () => ({ schemaVersion: 1 })
    });

    expect(result).toMatchObject({ status: "open", operationId });
    expect(calls[0]).toContain("assisted_fence");
    const identity = calls.findIndex((entry) => entry.includes("lock_household_browser_operation_identity"));
    expect(identity).toBeGreaterThan(0);
    expect(calls.findIndex((entry) => entry === "binding.findFirst")).toBeGreaterThan(identity);
  });

  it("fails closed when an assisted key reserves without a pre-identity lock", async () => {
    const actual = await substrate();

    await expect(actual.issueHouseholdBrowserOperation({
      ctx: ownerCtx,
      operationId,
      operationKey: BrowserOperationKey.memberPasswordReset,
      targetKind: BrowserOperationTargetKind.member,
      targetId: "target-member",
      permission: "member.manage",
      targetSnapshot: () => ({ schemaVersion: 1 })
    })).rejects.toThrow("browser_operation_adapter_unavailable");
  });

  it("refuses a pre-identity lock on a nonassisted key", async () => {
    const actual = await substrate();

    await expect(actual.issueHouseholdBrowserOperation({
      ctx: ownerCtx,
      operationId,
      operationKey: BrowserOperationKey.memberSuspend,
      targetKind: BrowserOperationTargetKind.member,
      targetId: "target-member",
      permission: "member.manage",
      preIdentityLock: async () => undefined,
      targetSnapshot: () => ({ schemaVersion: 1 })
    })).rejects.toThrow("browser_operation_adapter_unavailable");
  });

  it("refuses to submit an assisted key through the generic household executor", async () => {
    const actual = await substrate();

    await expect(actual.executeHouseholdBrowserOperation({
      ctx: ownerCtx,
      operationId,
      operationKey: BrowserOperationKey.memberAccountCreate,
      intent: {},
      targetKind: BrowserOperationTargetKind.household,
      permission: "member.manage",
      execute: async () => ({ kind: "member_account", code: "created", memberId: "created-member" })
    })).rejects.toThrow("browser_operation_adapter_unavailable");
  });

  it("returns a registered assisted status hook and nothing for other keys", async () => {
    const actual = await substrate();
    const hook = async () => ({ status: "pending" as const, operationId, code: "operation_unknown" as const });

    actual.registerAssistedBrowserOperationStatusHook(BrowserOperationKey.memberAccountCreate, hook);

    expect(actual.assistedBrowserOperationStatusHook(BrowserOperationKey.memberAccountCreate)).toBe(hook);
    expect(actual.assistedBrowserOperationStatusHook(BrowserOperationKey.memberSuspend)).toBeUndefined();
  });
});
