import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  householdOperationCount: vi.fn(),
  householdOperationFindMany: vi.fn(),
  householdBindingFindMany: vi.fn(),
  householdBindingUpdateMany: vi.fn(),
  householdBindingDeleteMany: vi.fn(),
  accountOperationCount: vi.fn(),
  accountOperationFindMany: vi.fn(),
  accountBindingFindMany: vi.fn(),
  accountBindingUpdateMany: vi.fn(),
  accountBindingDeleteMany: vi.fn(),
  queryRaw: vi.fn()
}));
vi.mock("@/lib/db/prisma", () => ({ prisma: { $transaction: mocks.transaction } }));

import { runBrowserOperationRetention } from "@/server/services/browser-operation-retention";

beforeEach(() => {
  vi.resetAllMocks();
  for (const count of [mocks.householdOperationCount, mocks.accountOperationCount]) count.mockResolvedValue(0);
  for (const findMany of [
    mocks.householdOperationFindMany,
    mocks.householdBindingFindMany,
    mocks.accountOperationFindMany,
    mocks.accountBindingFindMany
  ]) findMany.mockResolvedValue([]);
  for (const mutation of [mocks.householdBindingUpdateMany, mocks.accountBindingUpdateMany, mocks.householdBindingDeleteMany, mocks.accountBindingDeleteMany]) {
    mutation.mockResolvedValue({ count: 0 });
  }
  mocks.queryRaw.mockResolvedValue([{ compacted: false }]);
  mocks.transaction.mockImplementation((callback) => callback({
    $queryRaw: mocks.queryRaw,
    browserMutationOperation: { count: mocks.householdOperationCount, findMany: mocks.householdOperationFindMany },
    browserOperationBinding: { findMany: mocks.householdBindingFindMany, updateMany: mocks.householdBindingUpdateMany, deleteMany: mocks.householdBindingDeleteMany },
    accountMutationOperation: { count: mocks.accountOperationCount, findMany: mocks.accountOperationFindMany },
    accountOperationBinding: { findMany: mocks.accountBindingFindMany, updateMany: mocks.accountBindingUpdateMany, deleteMany: mocks.accountBindingDeleteMany }
  }));
});

describe("browser operation retention", () => {
  it("reports household and account unresolved work older than 24 hours without changing status", async () => {
    mocks.householdOperationCount.mockResolvedValue(3);
    mocks.accountOperationCount.mockResolvedValue(2);
    const now = new Date("2026-08-17T12:00:00Z");
    const result = await runBrowserOperationRetention({ now, batchSize: 25 });
    expect(result).toMatchObject({
      household: { unresolvedAlertCount: 3 },
      account: { unresolvedAlertCount: 2 }
    });
    const expectedCutoff = new Date("2026-08-16T12:00:00Z");
    expect(mocks.householdOperationCount).toHaveBeenCalledWith({
      where: { status: { in: ["pending", "unknown"] }, createdAt: { lte: expectedCutoff } }
    });
    expect(mocks.accountOperationCount).toHaveBeenCalledWith({
      where: { status: { in: ["pending", "unknown"] }, createdAt: { lte: expectedCutoff } }
    });
  });

  it("compacts household and account terminal rows after 30 days through their guarded functions", async () => {
    mocks.householdOperationFindMany.mockResolvedValue([
      { householdId: "household-1", operationId: "bmo_00000000000000000000000001" }
    ]);
    mocks.accountOperationFindMany.mockResolvedValue([
      { userId: "user-1", operationId: "bmo_00000000000000000000000002" }
    ]);
    mocks.queryRaw.mockResolvedValue([{ compacted: true }]);
    const result = await runBrowserOperationRetention({ now: new Date("2026-08-17T12:00:00Z"), batchSize: 25 });
    expect(result.household.compactedCount).toBe(1);
    expect(result.account.compactedCount).toBe(1);
    expect(mocks.queryRaw).toHaveBeenCalledTimes(2);
  });

  it("deletes only old never-submitted expired/revoked bindings in both scopes", async () => {
    mocks.householdBindingFindMany.mockResolvedValue([{ id: "binding-h" }]);
    mocks.accountBindingFindMany.mockResolvedValue([{ id: "binding-a" }]);
    mocks.householdBindingDeleteMany.mockResolvedValue({ count: 1 });
    mocks.accountBindingDeleteMany.mockResolvedValue({ count: 1 });
    const result = await runBrowserOperationRetention({ now: new Date("2026-08-17T12:00:00Z"), batchSize: 25 });
    expect(result).toEqual({
      household: { unresolvedAlertCount: 0, compactedCount: 0, deletedBindingCount: 1 },
      account: { unresolvedAlertCount: 0, compactedCount: 0, deletedBindingCount: 1 }
    });
    expect(mocks.accountBindingDeleteMany).toHaveBeenCalledWith({
      where: { id: "binding-a", state: { in: ["expired", "revoked"] }, operation: null }
    });
  });

  it("expires abandoned open bindings before their delayed deletion window in both scopes", async () => {
    const now = new Date("2026-08-17T12:00:00Z");
    mocks.householdBindingFindMany.mockResolvedValueOnce([{ id: "binding-h", householdId: "household-1", operationId: "bmo_00000000000000000000000001" }]);
    mocks.accountBindingFindMany.mockResolvedValueOnce([{ id: "binding-a", userId: "user-1", operationId: "bmo_00000000000000000000000002" }]);
    await runBrowserOperationRetention({ now, batchSize: 25 });
    const householdExpected = { where: { id: "binding-h", state: "open", operation: null }, data: { state: "expired" } };
    const accountExpected = { where: { id: "binding-a", state: "open", operation: null }, data: { state: "expired" } };
    expect(mocks.householdBindingUpdateMany).toHaveBeenCalledWith(householdExpected);
    expect(mocks.accountBindingUpdateMany).toHaveBeenCalledWith(accountExpected);
    expect(mocks.queryRaw.mock.calls.map(([query]) => query.join(" "))).toEqual(expect.arrayContaining([
      expect.stringContaining('lock_household_browser_operation_identity'),
      expect.stringContaining('lock_account_browser_operation_identity')
    ]));
  });
});
