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
vi.mock("@/server/services/audit", () => ({ writeAudit: mocks.writeAudit }));
vi.mock("@/server/auth/session", () => ({ requireFreshSession: mocks.requireFreshSession }));

import {
  issueInviteCreateBrowserOperation,
  issueInviteRevokeAllBrowserOperation,
  issueInviteRevokeBrowserOperation,
  submitInviteCreateBrowserOperation,
  submitInviteRevokeAllBrowserOperation,
  submitInviteRevokeBrowserOperation
} from "@/server/services/invites";

const ctx = { userId: "user-1", sessionId: "session-1", householdId: "household-1", memberId: "member-1", role: "owner" as const };
const operationId = "bmo_0123456789abcdefghjkmnpqrs";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getContext.mockResolvedValue(ctx);
  mocks.requireFreshSession.mockResolvedValue({
    user: { id: "user-1" },
    session: { id: "session-1", createdAt: new Date("2026-08-17T11:55:00.000Z") }
  });
  mocks.issue.mockResolvedValue({ status: "open", operationId, bindingId: "binding-1" });
});

describe("invite browser-v2 operations", () => {
  it("opens invite creation with a safe frozen role and expiry policy", async () => {
    await expect(issueInviteCreateBrowserOperation({
      operationId,
      email: "recipient@example.test",
      role: "parent",
      expiresInHours: 48
    })).resolves.toMatchObject({ status: "open", operationId });

    const input = mocks.issue.mock.calls[0][0];
    expect(input).toMatchObject({
      operationKey: "inviteCreate",
      targetKind: "invite",
      permission: "invite.create"
    });
    expect(await input.targetSnapshot({}, ctx)).toEqual({
      version: 1,
      role: "parent",
      expiresInHours: 48,
      expiresAt: expect.any(String)
    });
    expect(JSON.stringify(await input.targetSnapshot({}, ctx))).not.toContain("recipient@example.test");
  });

  it("returns the invitation link only from the original create response", async () => {
    const create = vi.fn().mockResolvedValue({
      id: "invite-1",
      email: "recipient@example.test",
      role: "parent",
      expiresAt: new Date("2026-09-01T12:00:00.000Z")
    });
    mocks.execute.mockImplementation(async (input) => {
      const outcome = await input.execute({
        $executeRaw: vi.fn(),
        $queryRaw: vi.fn().mockResolvedValue([]),
        invite: { findMany: vi.fn().mockResolvedValue([]), create, update: vi.fn() },
        auditEvent: { create: mocks.writeAudit }
      }, ctx, { targetSnapshot: { version: 1, role: "parent", expiresInHours: 48, expiresAt: "2026-09-01T12:00:00.000Z" } });
      expect(outcome).toEqual({
        kind: "invite",
        code: "created",
        inviteId: "invite-1",
        email: "recipient@example.test",
        role: "parent",
        expiresAt: "2026-09-01T12:00:00.000Z"
      });
      return { status: "completed", operationId, outcome };
    });

    const first = await submitInviteCreateBrowserOperation({
      operationId,
      email: "recipient@example.test",
      role: "parent",
      expiresInHours: 48
    });
    expect(first).toMatchObject({ status: "completed", outcome: { kind: "invite", inviteId: "invite-1" } });
    expect((first as { outcome: { acceptUrl?: string } }).outcome.acceptUrl).toMatch(/^\/invite\//);
    expect(JSON.stringify(mocks.execute.mock.calls)).not.toContain((first as unknown as { outcome: { acceptUrl: string } }).outcome.acceptUrl);

    mocks.execute.mockResolvedValueOnce({
      status: "completed",
      operationId,
      outcome: { kind: "invite", code: "created", inviteId: "invite-1", email: "recipient@example.test", role: "parent", expiresAt: "2026-09-01T12:00:00.000Z" }
    });
    const replay = await submitInviteCreateBrowserOperation({ operationId, email: "recipient@example.test", role: "parent", expiresInHours: 48 });
    expect((replay as { outcome: { acceptUrl?: string } }).outcome.acceptUrl).toBeUndefined();
  });

  it("binds an exact invite revision and bulk acknowledgement without candidate IDs", async () => {
    mocks.issue.mockResolvedValue({ status: "open", operationId, bindingId: "binding-1" });
    await issueInviteRevokeBrowserOperation({ operationId, inviteId: "invite-1" });
    const revoke = mocks.issue.mock.calls[0][0];
    expect(revoke).toMatchObject({ operationKey: "inviteRevoke", targetKind: "invite", targetId: "invite-1", permission: "member.manage" });
    const snapshot = await revoke.targetSnapshot({
      $queryRaw: vi.fn().mockImplementation((parts) => String(parts[0]).includes("Session") ? [{ id: "session-1", userId: "user-1", createdAt: new Date(), expiresAt: new Date(Date.now() + 60_000) }] : [{ id: "invite-1" }]),
      invite: { findUnique: vi.fn().mockResolvedValue({ id: "invite-1", householdId: "household-1", role: "parent", status: "pending", updatedAt: new Date("2026-08-17T12:00:00.000Z") }) }
    }, ctx);
    expect(snapshot).toEqual({ version: 1, status: "pending", updatedAt: "2026-08-17T12:00:00.000Z" });

    await issueInviteRevokeAllBrowserOperation({ operationId });
    const bulk = mocks.issue.mock.calls[1][0];
    expect(bulk).toMatchObject({ operationKey: "inviteRevokeAll", targetKind: "invite", permission: "household.manage" });
    expect(await bulk.targetSnapshot({}, ctx)).toEqual({ version: 1, policy: "all_pending_at_submit" });
    expect(JSON.stringify(await bulk.targetSnapshot({}, ctx))).not.toContain("invite-1");
  });

  it("revokes only the exact opening revision and returns a content-free outcome", async () => {
    mocks.execute.mockImplementation(async (input) => {
      const update = vi.fn().mockResolvedValue({ id: "invite-1", status: "revoked", revokedAt: new Date("2026-08-17T12:01:00.000Z") });
      const outcome = await input.execute({
        $queryRaw: vi.fn().mockImplementation((parts) => String(parts[0]).includes("Session") ? [{ id: "session-1", userId: "user-1", createdAt: new Date(), expiresAt: new Date(Date.now() + 60_000) }] : [{ id: "invite-1" }]),
        invite: { findUnique: vi.fn().mockResolvedValue({
          id: "invite-1", householdId: "household-1", email: "recipient@example.test", role: "parent", status: "pending",
          updatedAt: new Date("2026-08-17T12:00:00.000Z")
        }), update }
      }, ctx, { targetSnapshot: { version: 1, status: "pending", updatedAt: "2026-08-17T12:00:00.000Z" } });
      expect(outcome).toEqual({ kind: "invite", code: "revoked", inviteId: "invite-1" });
      expect(JSON.stringify(outcome)).not.toContain("recipient@example.test");
      expect(update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "invite-1" }, data: expect.objectContaining({ status: "revoked" }) }));
      return { status: "completed", operationId, outcome };
    });

    await expect(submitInviteRevokeBrowserOperation({ operationId, inviteId: "invite-1" })).resolves.toMatchObject({ status: "completed", operationId });
    expect(mocks.execute).toHaveBeenCalledWith(expect.objectContaining({
      operationKey: "inviteRevoke", targetKind: "invite", targetId: "invite-1", permission: "member.manage", intent: {}
    }));
    expect(mocks.requireFreshSession).toHaveBeenCalledOnce();
  });

  it("fails closed before mutation when an invite revision, target state, actor, or role changed", async () => {
    mocks.execute.mockImplementation(async (input) => input.execute({
      $queryRaw: vi.fn().mockImplementation((parts) => String(parts[0]).includes("Session") ? [{ id: "session-1", userId: "user-1", createdAt: new Date(), expiresAt: new Date(Date.now() + 60_000) }] : [{ id: "invite-1" }]),
      invite: { findUnique: vi.fn().mockResolvedValue({
        id: "invite-1", householdId: "household-1", email: "recipient@example.test", role: "parent", status: "revoked",
        updatedAt: new Date("2026-08-17T12:01:00.000Z")
      }), update: vi.fn() }
    }, { ...ctx, role: "read_only" }, { targetSnapshot: { version: 1, status: "pending", updatedAt: "2026-08-17T12:00:00.000Z" } }));

    await expect(submitInviteRevokeBrowserOperation({ operationId, inviteId: "invite-1" })).rejects.toThrow("stale_revision");
  });

  it("executes bulk revoke from the owner-only submit-time candidate set without persisting candidate identities", async () => {
    mocks.execute.mockImplementation(async (input) => {
      const update = vi.fn().mockResolvedValue({ status: "revoked" });
      const outcome = await input.execute({
        $executeRaw: vi.fn(),
        $queryRaw: vi.fn().mockImplementation((parts) => String(parts[0]).includes("Session") ? [{ id: "session-1", userId: "user-1", createdAt: new Date(), expiresAt: new Date(Date.now() + 60_000) }] : [{ id: "invite-a" }, { id: "invite-b" }]),
        invite: { findMany: vi.fn().mockResolvedValue([
          { id: "invite-a", email: "a@example.test", role: "parent", status: "pending" },
          { id: "invite-b", email: "b@example.test", role: "caretaker", status: "pending" }
        ]), update }
      }, ctx, { targetSnapshot: { version: 1, policy: "all_pending_at_submit" } });
      expect(outcome).toEqual({ kind: "invite_bulk", code: "revoked", revokedCount: 2 });
      expect(JSON.stringify(outcome)).not.toContain("invite-a");
      expect(JSON.stringify(mocks.execute.mock.calls)).not.toContain("a@example.test");
      return { status: "completed", operationId, outcome };
    });

    await expect(submitInviteRevokeAllBrowserOperation({ operationId, acknowledgement: "I_REVOKE_ALL_PENDING_INVITATIONS" })).resolves.toMatchObject({ status: "completed", operationId });
    expect(mocks.execute).toHaveBeenCalledWith(expect.objectContaining({
      operationKey: "inviteRevokeAll", targetKind: "invite", permission: "household.manage",
      intent: { acknowledgement: "I_REVOKE_ALL_PENDING_INVITATIONS" }
    }));
  });
});
