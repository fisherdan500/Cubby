import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  operationCount: vi.fn(),
  operationFindMany: vi.fn(),
  bindingFindMany: vi.fn(),
  bindingDeleteMany: vi.fn(),
  queryRaw: vi.fn()
}));
vi.mock("@/lib/db/prisma", () => ({ prisma: { $transaction: mocks.transaction } }));

import { runHouseholdBrowserOperationRetention } from "@/server/services/browser-operation-retention";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.operationCount.mockResolvedValue(0);
  mocks.operationFindMany.mockResolvedValue([]);
  mocks.bindingFindMany.mockResolvedValue([]);
  mocks.bindingDeleteMany.mockResolvedValue({ count: 0 });
  mocks.queryRaw.mockResolvedValue([{ compacted: false }]);
  mocks.transaction.mockImplementation((callback) => callback({
    $queryRaw: mocks.queryRaw,
    browserMutationOperation: { count: mocks.operationCount, findMany: mocks.operationFindMany },
    browserOperationBinding: { findMany: mocks.bindingFindMany, deleteMany: mocks.bindingDeleteMany }
  }));
});

describe("household browser operation retention", () => {
  it("reports unresolved work older than 24 hours without changing its status", async () => {
    mocks.operationCount.mockResolvedValue(3);
    const result = await runHouseholdBrowserOperationRetention({ now: new Date("2026-08-17T12:00:00Z"), batchSize: 25 });
    expect(result.unresolvedAlertCount).toBe(3);
    expect(mocks.operationFindMany).toHaveBeenCalledWith(expect.objectContaining({
      orderBy: [{ terminalAt: "asc" }, { householdId: "asc" }, { operationId: "asc" }],
      take: 25
    }));
    expect(mocks.queryRaw).not.toHaveBeenCalled();
  });

  it("compacts terminal rows in stable order through the guarded database function", async () => {
    mocks.operationFindMany.mockResolvedValue([
      { householdId: "household-1", operationId: "bmo_00000000000000000000000001" },
      { householdId: "household-1", operationId: "bmo_00000000000000000000000002" }
    ]);
    mocks.queryRaw.mockResolvedValue([{ compacted: true }]);
    const result = await runHouseholdBrowserOperationRetention({ now: new Date("2026-08-17T12:00:00Z"), batchSize: 25 });
    expect(result.compactedCount).toBe(2);
    expect(mocks.queryRaw).toHaveBeenCalledTimes(2);
  });

  it("deletes only old never-submitted expired or revoked bindings with no operation", async () => {
    mocks.bindingFindMany.mockResolvedValue([{ id: "binding-1" }, { id: "binding-2" }]);
    mocks.bindingDeleteMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 1 });
    const result = await runHouseholdBrowserOperationRetention({ now: new Date("2026-08-17T12:00:00Z"), batchSize: 25 });
    expect(result.deletedBindingCount).toBe(2);
    expect(mocks.bindingDeleteMany).toHaveBeenCalledWith({
      where: { id: "binding-1", state: { in: ["expired", "revoked"] }, operation: null }
    });
  });
});
