import { beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserOperationKey, BrowserOperationTargetKind } from "@prisma/client";

const mocks = vi.hoisted(() => ({
  getContext: vi.fn(), issue: vi.fn(), execute: vi.fn(), lockKey: vi.fn(), writeAudit: vi.fn(),
  requireFreshSession: vi.fn(), queryRaw: vi.fn(), apiKeyUpdate: vi.fn()
}));

vi.mock("@/server/services/browser-operations", () => ({
  getBrowserOperationContextForHousehold: mocks.getContext,
  issueHouseholdBrowserOperation: mocks.issue,
  executeHouseholdBrowserOperation: mocks.execute
}));
vi.mock("@/server/services/mutation-locks", () => ({
  lockActorForWrite: vi.fn(), lockBabyForWrite: vi.fn(), lockWebhookForWrite: vi.fn(), lockApiKeyForWrite: vi.fn(),
  lockApiKeyForContainment: mocks.lockKey
}));
vi.mock("@/server/auth/session", () => ({ requireFreshSession: mocks.requireFreshSession, requireUser: vi.fn() }));
vi.mock("@/server/services/audit", () => ({ writeAudit: mocks.writeAudit }));
vi.mock("@/lib/db/prisma", () => ({ prisma: {} }));

import { issueApiKeyRevokeBrowserOperation, submitApiKeyRevokeBrowserOperation } from "@/server/services/integrations";

const operationId = "bmo_0123456789abcdefghjkmnpqrs";
const ctx = { userId: "owner-user", sessionId: "session-1", householdId: "household-1", memberId: "owner-member", role: "owner" as const };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getContext.mockResolvedValue(ctx);
  mocks.requireFreshSession.mockResolvedValue({ user: { id: ctx.userId }, session: { id: ctx.sessionId, createdAt: new Date(), expiresAt: new Date(Date.now() + 60_000) } });
  mocks.lockKey.mockResolvedValue({ id: "key-1", householdId: ctx.householdId, revokedAt: null });
  mocks.issue.mockImplementation(async (input) => { await input.targetSnapshot({}, ctx); return { status: "open", operationId }; });
  mocks.execute.mockImplementation(async (input) => ({ status: "completed", operationId, outcome: await input.execute({ $queryRaw: mocks.queryRaw, apiKey: { update: mocks.apiKeyUpdate } }, ctx, { targetSnapshot: { version: 1 } }) }));
  mocks.queryRaw.mockResolvedValue([{ id: ctx.sessionId, userId: ctx.userId, createdAt: new Date(), expiresAt: new Date(Date.now() + 60_000) }]);
  mocks.apiKeyUpdate.mockResolvedValue({ id: "key-1" });
});

describe("API-key revoke browser operation", () => {
  it("issues an owner-bound API-key target reservation", async () => {
    await expect(issueApiKeyRevokeBrowserOperation({ operationId, apiKeyId: "key-1" })).resolves.toMatchObject({ status: "open" });
    expect(mocks.issue).toHaveBeenCalledWith(expect.objectContaining({ operationKey: BrowserOperationKey.apiKeyRevoke, targetKind: BrowserOperationTargetKind.apiKey, targetId: "key-1" }));
  });

  it("revokes once with correlated audit and returns a content-free terminal result", async () => {
    await expect(submitApiKeyRevokeBrowserOperation({ operationId, apiKeyId: "key-1" })).resolves.toMatchObject({ outcome: { kind: "api_key", code: "revoked" } });
    expect(mocks.apiKeyUpdate).toHaveBeenCalledOnce();
    expect(mocks.writeAudit).toHaveBeenCalledWith(ctx, expect.objectContaining({ action: "api_key.revoke", entityId: "key-1", correlationId: operationId }), expect.anything());
  });

  it("returns already_revoked without duplicate direct audit", async () => {
    mocks.lockKey.mockResolvedValue({ id: "key-1", householdId: ctx.householdId, revokedAt: new Date() });
    await expect(submitApiKeyRevokeBrowserOperation({ operationId, apiKeyId: "key-1" })).resolves.toMatchObject({ outcome: { kind: "api_key", code: "already_revoked" } });
    expect(mocks.apiKeyUpdate).not.toHaveBeenCalled();
    expect(mocks.writeAudit).not.toHaveBeenCalled();
  });
});
