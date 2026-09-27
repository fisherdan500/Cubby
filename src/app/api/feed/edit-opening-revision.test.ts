import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ issue: vi.fn(), execute: vi.fn(), audit: vi.fn(), bindings: vi.fn(), update: vi.fn(), read: vi.fn() }));
const ctx = { householdId: "h", memberId: "m", userId: "u", sessionId: "s", role: "parent" };
const tx = { $queryRaw: vi.fn(), feedPost: { findFirst: mocks.read, updateMany: mocks.update }, feedComment: { findFirst: mocks.read, updateMany: mocks.update } };
vi.mock("@/server/services/browser-operations", () => ({ getBrowserOperationContextForHousehold: async () => ctx, issueHouseholdBrowserOperation: mocks.issue, executeHouseholdBrowserOperation: mocks.execute, browserOperationFailureResult: () => null }));
vi.mock("@/server/services/audit", () => ({ writeAudit: mocks.audit }));
vi.mock("@/lib/db/prisma", () => ({ prisma: {} }));
vi.mock("@/server/auth/context", () => ({ getEffectiveHouseholdContext: vi.fn(), requirePermission: vi.fn() }));
vi.mock("@/server/services/attachments", () => ({ claimStagedFeedPhotos: vi.fn(), removePostPhotos: vi.fn(), restorePostPhotos: vi.fn() }));
vi.mock("@/server/http", () => ({ ok: (data: unknown, init: ResponseInit) => Response.json({ ok: true, data }, init), handleError: (error: Error) => Response.json({ error: error.message }, { status: 409 }) }));
import { PATCH as post } from "./posts/[id]/route";
import { PATCH as comment } from "./comments/[id]/route";
const opening = "2026-09-25T10:00:00.000Z";
beforeEach(() => {
  vi.clearAllMocks();
  mocks.read.mockResolvedValue({ id: "target", authorMemberId: "m", updatedAt: new Date("2026-09-25T11:00:00Z") });
  mocks.issue.mockImplementation(async (contract) => {
    const snapshot = await contract.targetSnapshot(tx, ctx);
    mocks.bindings(snapshot);
    return { status: "open", operationId: "op", bindingId: "binding" };
  });
});
it.each([["post", post], ["comment", comment]] as const)("%s route refuses opening a stale revision before binding or effects", async (_kind, route) => {
  const response = await route(new Request("http://cubby.test/api/feed/target?issue=1", { method: "PATCH", body: JSON.stringify({ expectedUpdatedAt: opening }) }), { params: { id: "target" } });
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "stale_revision" });
  expect(mocks.bindings).not.toHaveBeenCalled(); expect(mocks.execute).not.toHaveBeenCalled();
  expect(mocks.update).not.toHaveBeenCalled(); expect(mocks.audit).not.toHaveBeenCalled();
});
it.each([["post", post], ["comment", comment]] as const)("%s forwards the matching opening revision into the real service", async (_kind, route) => {
  mocks.read.mockResolvedValue({ id: "target", authorMemberId: "m", updatedAt: new Date(opening) });
  const response = await route(new Request("http://cubby.test/api/feed/target?issue=1", { method: "PATCH", body: JSON.stringify({ expectedUpdatedAt: opening }) }), { params: { id: "target" } });
  expect(response.status).toBe(200);
  expect(mocks.bindings).toHaveBeenCalledWith(expect.objectContaining({ updatedAt: opening }));
});
it.each([["post", post], ["comment", comment]] as const)("%s rejects a missing revision before issuing", async (_kind, route) => {
  const response = await route(new Request("http://cubby.test/api/feed/target?issue=1", { method: "PATCH", body: "{}" }), { params: { id: "target" } });
  expect(response.status).toBe(409); expect(mocks.bindings).not.toHaveBeenCalled();
});
