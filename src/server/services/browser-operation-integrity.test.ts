import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ queryRaw: vi.fn() }));
vi.mock("@/lib/db/prisma", () => ({ prisma: { $queryRaw: mocks.queryRaw } }));

import { verifyBrowserOperationInfrastructure } from "@/server/services/browser-operation-integrity";

describe("browser operation startup integrity", () => {
  beforeEach(() => vi.resetAllMocks());

  it("passes only when tables/functions and binding-operation equality are present", async () => {
    mocks.queryRaw.mockResolvedValue([{ binding_table: true, operation_table: true, tombstone_table: true, compaction_function: true, mismatch_count: 0n }]);
    await expect(verifyBrowserOperationInfrastructure()).resolves.toEqual({ status: "ready" });
  });

  it("fails closed before readiness for missing objects or inconsistent operation rows", async () => {
    mocks.queryRaw.mockResolvedValue([{ binding_table: true, operation_table: true, tombstone_table: false, compaction_function: true, mismatch_count: 0n }]);
    await expect(verifyBrowserOperationInfrastructure()).rejects.toThrow("browser_operation_integrity_unavailable");

    mocks.queryRaw.mockResolvedValue([{ binding_table: true, operation_table: true, tombstone_table: true, compaction_function: true, mismatch_count: 1n }]);
    await expect(verifyBrowserOperationInfrastructure()).rejects.toThrow("browser_operation_integrity_mismatch");
  });
});
