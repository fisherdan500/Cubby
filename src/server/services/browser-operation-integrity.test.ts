import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ queryRaw: vi.fn() }));
vi.mock("@/lib/db/prisma", () => ({ prisma: { $queryRaw: mocks.queryRaw } }));

import { verifyBrowserOperationInfrastructure } from "@/server/services/browser-operation-integrity";

const ready = {
  household_binding_table: true,
  household_operation_table: true,
  household_tombstone_table: true,
  household_compaction_function: true,
  household_mismatch_count: 0n,
  account_binding_table: true,
  account_operation_table: true,
  account_tombstone_table: true,
  account_compaction_function: true,
  account_mismatch_count: 0n
};

describe("browser operation startup integrity", () => {
  beforeEach(() => vi.resetAllMocks());

  it("passes only when household and account tables/functions and binding-operation equality are present", async () => {
    mocks.queryRaw.mockResolvedValue([ready]);
    await expect(verifyBrowserOperationInfrastructure()).resolves.toEqual({ status: "ready" });
  });

  it("fails closed before readiness for a missing account object", async () => {
    mocks.queryRaw.mockResolvedValue([{ ...ready, account_tombstone_table: false }]);
    await expect(verifyBrowserOperationInfrastructure()).rejects.toThrow("browser_operation_integrity_unavailable");
  });

  it("fails closed for either household or account binding-operation mismatch", async () => {
    mocks.queryRaw.mockResolvedValue([{ ...ready, account_mismatch_count: 1n }]);
    await expect(verifyBrowserOperationInfrastructure()).rejects.toThrow("browser_operation_integrity_mismatch");

    mocks.queryRaw.mockResolvedValue([{ ...ready, household_mismatch_count: 1n }]);
    await expect(verifyBrowserOperationInfrastructure()).rejects.toThrow("browser_operation_integrity_mismatch");
  });
});
