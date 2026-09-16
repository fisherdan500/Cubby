import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getContext: vi.fn(),
  requireFreshSession: vi.fn(),
  issue: vi.fn(),
  execute: vi.fn(),
  writeAudit: vi.fn()
}));

vi.mock("@/server/services/browser-operations", () => ({
  getBrowserOperationContextForHousehold: mocks.getContext,
  issueHouseholdBrowserOperation: mocks.issue,
  executeHouseholdBrowserOperation: mocks.execute
}));
vi.mock("@/server/auth/session", () => ({ requireFreshSession: mocks.requireFreshSession }));
vi.mock("@/server/services/audit", () => ({ writeAudit: mocks.writeAudit }));

import {
  issueMemberBrowserOperation,
  submitMemberBrowserOperation
} from "@/server/services/invites";

const ctx = { userId: "user-owner", sessionId: "session-owner", householdId: "household-1", memberId: "member-owner", role: "owner" as const };
const operationId = "bmo_0123456789abcdefghjkmnpqrs";
const target = {
  id: "member-target",
  householdId: "household-1",
  userId: "user-target",
  role: "parent",
  disabledAt: null,
  deletedAt: null,
  updatedAt: new Date("2026-08-17T12:00:00.000Z")
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getContext.mockResolvedValue(ctx);
  mocks.requireFreshSession.mockResolvedValue({ user: { id: "user-owner" }, session: { id: "session-owner", createdAt: new Date("2026-08-17T11:55:00.000Z") } });
  mocks.issue.mockResolvedValue({ status: "open", operationId, bindingId: "binding-1" });
});

describe("member browser-v2 operations", () => {
  it.each([
    ["restore", "memberRestore", "restore"],
    ["remove", "memberRemove", "remove"],
    ["role.update", "memberRoleUpdate", "role.update"],
    ["suspend", "memberSuspend", "suspend"]
  ] as const)("opens %s against one immutable target membership episode", async (action, operationKey, inputAction) => {
    await expect(issueMemberBrowserOperation(inputAction, { operationId, memberId: target.id, role: "caretaker" })).resolves.toMatchObject({ status: "open", operationId });

    const input = mocks.issue.mock.calls[0][0];
    expect(input).toMatchObject({ operationKey, targetKind: "member", targetId: target.id, permission: "member.manage" });
    const snapshot = await input.targetSnapshot({
      $queryRaw: vi.fn().mockResolvedValue([{ id: target.id }]),
      householdMember: { findUnique: vi.fn().mockResolvedValue(target) }
    }, ctx);
    expect(snapshot).toEqual({
      version: 1,
      memberId: target.id,
      role: "parent",
      disabledAt: null,
      deletedAt: null,
      updatedAt: "2026-08-17T12:00:00.000Z"
    });
  });

  it("rejects a foreign target without exposing it from the opening binding", async () => {
    await issueMemberBrowserOperation("remove", { operationId, memberId: target.id });
    const input = mocks.issue.mock.calls[0][0];
    await expect(input.targetSnapshot({
      $queryRaw: vi.fn().mockResolvedValue([{ id: target.id }]),
      householdMember: { findUnique: vi.fn().mockResolvedValue({ ...target, householdId: "household-2" }) }
    }, ctx)).rejects.toThrow("not_found");
  });

  it("submits only the exact opened target, revision, role, disabled and deleted state", async () => {
    const update = vi.fn();
    mocks.execute.mockImplementation(async (input) => input.execute({
      $queryRaw: vi.fn().mockImplementation((parts) => /lock_(actor_session|user_sessions)_for_operation/.test(String(parts[0]))
        ? [{ id: "session-owner", userId: "user-owner", createdAt: new Date(), expiresAt: new Date(Date.now() + 60_000) }]
        : [{ id: target.id }]),
      householdMember: { findUnique: vi.fn().mockResolvedValue({ ...target, role: "admin" }), update },
      session: { deleteMany: vi.fn() },
      webhookEndpoint: { updateMany: vi.fn() },
      webhookDelivery: { updateMany: vi.fn() },
      apiKey: { updateMany: vi.fn() },
      notificationPreference: { deleteMany: vi.fn() },
      pushSubscription: { updateMany: vi.fn() },
      notificationLog: { deleteMany: vi.fn() }
    }, ctx, { targetSnapshot: { version: 1, memberId: target.id, role: "parent", disabledAt: null, deletedAt: null, updatedAt: "2026-08-17T12:00:00.000Z" } }));

    await expect(submitMemberBrowserOperation("role.update", { operationId, memberId: target.id, role: "caretaker" })).rejects.toThrow("stale_revision");
    expect(update).not.toHaveBeenCalled();
  });

  it("locks target sessions before the target member during suspension", async () => {
    const queryRaw = vi.fn().mockImplementation((parts) => {
      const query = String(parts[0]);
      if (query.includes('"lock_actor_session_for_operation"') || query.includes('"lock_user_sessions_for_operation"')) return [{ id: "session-locked", userId: query.includes("user-target") ? "user-target" : "user-owner", createdAt: new Date(), expiresAt: new Date(Date.now() + 60_000) }];
      return [{ id: target.id }];
    });
    mocks.execute.mockImplementation(async (input) => {
      const tx = {
        $queryRaw: queryRaw,
        $executeRaw: vi.fn(),
        householdMember: { findFirst: vi.fn().mockResolvedValue(target), findUnique: vi.fn().mockResolvedValue(target), update: vi.fn().mockResolvedValue({ ...target, disabledAt: new Date() }) },
        session: { deleteMany: vi.fn() },
        webhookEndpoint: { updateMany: vi.fn() }, webhookDelivery: { updateMany: vi.fn() }, apiKey: { updateMany: vi.fn() },
        notificationPreference: { deleteMany: vi.fn() }, pushSubscription: { updateMany: vi.fn() }, notificationLog: { deleteMany: vi.fn() }
      };
      await input.preActorLock?.(tx);
      return input.execute(tx, ctx, { targetSnapshot: { version: 1, memberId: target.id, role: target.role, disabledAt: null, deletedAt: null, updatedAt: target.updatedAt.toISOString() } });
    });

    await submitMemberBrowserOperation("suspend", { operationId, memberId: target.id });
    const queries = queryRaw.mock.calls.map(([parts]) => String(parts[0]));
    const sessionCalls = queries.map((query, index) => query.includes('"lock_actor_session_for_operation"') || query.includes('"lock_user_sessions_for_operation"') ? index : -1).filter((index) => index >= 0);
    const memberCall = queries.findIndex((query) => query.includes('FROM "HouseholdMember"'));
    expect(sessionCalls).toHaveLength(2);
    expect(sessionCalls[1]).toBeLessThan(memberCall);
  });

  it("requires fresh reauthentication and retains a deterministic actor-target lock for every submit", async () => {
    mocks.execute.mockResolvedValue({ status: "completed", operationId, outcome: { kind: "member", code: "removed", memberId: target.id } });
    await submitMemberBrowserOperation("remove", { operationId, memberId: target.id });
    expect(mocks.requireFreshSession).toHaveBeenCalledOnce();
    expect(mocks.execute).toHaveBeenCalledWith(expect.objectContaining({
      operationKey: "memberRemove", targetKind: "member", targetId: target.id, intent: {}
    }));
  });
});
