import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  settingsFindUnique: vi.fn(),
  getContext: vi.fn(),
  issue: vi.fn(),
  execute: vi.fn(),
  queryRaw: vi.fn(),
  writeAudit: vi.fn()
}));
vi.mock("@/lib/db/prisma", () => ({ prisma: { householdSettings: { findUnique: mocks.settingsFindUnique } } }));
vi.mock("@/server/services/browser-operations", () => ({
  getBrowserOperationContextForHousehold: mocks.getContext,
  issueHouseholdBrowserOperation: mocks.issue,
  executeHouseholdBrowserOperation: mocks.execute
}));
vi.mock("@/server/services/audit", () => ({ writeAudit: mocks.writeAudit }));

import { issueHouseholdAppearanceBrowserOperation, submitHouseholdAppearanceBrowserOperation } from "@/server/services/appearance";

const ctx = { userId: "user-1", sessionId: "session-1", householdId: "household-1", memberId: "member-1", role: "owner" as const };
const operationId = "bmo_0123456789abcdefghjkmnpqrs";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getContext.mockResolvedValue(ctx);
  mocks.settingsFindUnique.mockResolvedValue(null);
});

describe("household appearance browser operation", () => {
  it("issues an accent operation from the exact selected household's absent serialized settings row", async () => {
    mocks.issue.mockResolvedValue({ status: "open", operationId, bindingId: "binding-1" });
    await expect(issueHouseholdAppearanceBrowserOperation({ operationId })).resolves.toMatchObject({ status: "open" });
    const input = mocks.issue.mock.calls[0][0];
    expect(input).toMatchObject({ operationKey: "householdAccentUpdate", targetKind: "settings", permission: "household.manage" });
    await expect(input.targetSnapshot({ $queryRaw: mocks.queryRaw, householdSettings: { findUnique: mocks.settingsFindUnique } }, ctx)).resolves.toEqual({ settingsState: "absent", updatedAt: null, accentTheme: "sage", schemaVersion: 1 });
  });

  it("submits only normalized accent payload, CASes settings state, and audits in the operation transaction", async () => {
    mocks.execute.mockImplementation(async (input) => {
      const updateMany = vi.fn().mockResolvedValue({ count: 1 });
      await expect(input.execute({ $queryRaw: mocks.queryRaw, householdSettings: { findUnique: vi.fn().mockResolvedValue({ accentTheme: "sage", updatedAt: new Date("2026-08-17T12:00:00.000Z") }), updateMany }, auditEvent: { create: mocks.writeAudit } }, ctx, { targetSnapshot: { settingsState: "present", updatedAt: "2026-08-17T12:00:00.000Z", accentTheme: "sage", schemaVersion: 1 } })).resolves.toEqual({ kind: "household_accent", code: "ok", settingsScope: "household", accentTheme: "rose" });
      expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ householdId: "household-1" }) }));
      return { status: "completed", operationId, outcome: { kind: "household_accent", code: "ok", settingsScope: "household", accentTheme: "rose" } };
    });
    await expect(submitHouseholdAppearanceBrowserOperation({ operationId, accentTheme: "rose" })).resolves.toMatchObject({ status: "completed" });
  });
});
