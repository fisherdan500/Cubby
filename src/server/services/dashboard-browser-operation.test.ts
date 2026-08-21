import { beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserOperationKey } from "@prisma/client";

const mocks = vi.hoisted(() => ({
  getBabyContext: vi.fn(),
  issueBrowser: vi.fn(),
  executeBrowser: vi.fn()
}));

vi.mock("@/server/services/browser-operations", () => ({
  getBrowserOperationContextForBaby: mocks.getBabyContext,
  issueBrowserOperation: mocks.issueBrowser,
  executeBrowserOperation: mocks.executeBrowser
}));
vi.mock("@/lib/db/prisma", () => ({ prisma: {} }));
vi.mock("@/server/services/households", () => ({ getHouseholdHome: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: () => ({ get: vi.fn() }) }));

import { issueDashboardWarningBrowserOperation } from "./dashboard";

const operationId = "bmo_0123456789abcdefghjkmnpqrs";
const ctx = { userId: "user-1", sessionId: "session-1", householdId: "household-1", memberId: "member-1", role: "parent" as const };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getBabyContext.mockResolvedValue(ctx);
  mocks.issueBrowser.mockResolvedValue({ status: "open", operationId, bindingId: "binding-1" });
});

describe("dashboard warning browser-v2 opening", () => {
  it("binds the exact warning target and selected-baby revision before dismissal", async () => {
    await expect(issueDashboardWarningBrowserOperation({
      operationId,
      babyId: "baby-1",
      type: "feeding",
      fingerprint: "baby-1:feeding:never"
    })).resolves.toMatchObject({ status: "open", operationId });

    const input = mocks.issueBrowser.mock.calls[0]?.[0];
    expect(input).toMatchObject({
      ctx,
      operationId,
      operationKey: BrowserOperationKey.dashboardWarningDismiss,
      babyId: "baby-1",
      targetKind: "warning",
      targetId: "feeding:baby-1:feeding:never",
      opening: { babyId: "baby-1", type: "feeding", fingerprint: "baby-1:feeding:never" }
    });
    expect(input.targetSnapshot).toBeTypeOf("function");
    expect(input.targetSnapshot({} as never, ctx, {
      id: "baby-1", updatedAt: new Date("2026-08-19T10:00:00.000Z"), inactiveAt: null
    })).toEqual({
      kind: "dashboard-warning-dismiss",
      schemaVersion: 1,
      baby: { id: "baby-1", revision: "2026-08-19T10:00:00.000Z" },
      warning: { babyId: "baby-1", type: "feeding", fingerprint: "baby-1:feeding:never" }
    });
  });
});
