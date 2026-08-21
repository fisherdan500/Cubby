import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ queryRaw: vi.fn() }));
vi.mock("@/lib/db/prisma", () => ({ prisma: { $queryRaw: mocks.queryRaw } }));

import { verifyBrowserOperationInfrastructure } from "@/server/services/browser-operation-integrity";

const ready = {
  household_binding_table: true,
  household_operation_table: true,
  household_tombstone_table: true,
  household_reservation_tombstone_table: true,
  household_compaction_function: true,
  household_binding_insert_guard: true,
  household_reservation_insert_guard: true,
  household_binding_delete_guard: true,
  household_reservation_immutability_guard: true,
  household_terminal_outcome_constraint: true,
  household_operation_transition_guard: true,
  household_mismatch_count: 0n,
  account_binding_table: true,
  account_operation_table: true,
  account_tombstone_table: true,
  account_reservation_tombstone_table: true,
  account_compaction_function: true,
  account_binding_insert_guard: true,
  account_reservation_insert_guard: true,
  account_binding_delete_guard: true,
  account_reservation_immutability_guard: true,
  account_terminal_outcome_constraint: true,
  account_operation_transition_guard: true,
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

  it.each([
    "household_reservation_tombstone_table",
    "account_reservation_tombstone_table",
    "household_binding_insert_guard",
    "account_binding_insert_guard",
    "household_reservation_insert_guard",
    "account_reservation_insert_guard",
    "household_binding_delete_guard",
    "account_binding_delete_guard",
    "household_reservation_immutability_guard",
    "account_reservation_immutability_guard",
    "household_terminal_outcome_constraint",
    "account_terminal_outcome_constraint",
    "household_operation_transition_guard",
    "account_operation_transition_guard"
  ] as const)("fails closed before readiness when %s is missing or inexact", async (field) => {
    mocks.queryRaw.mockResolvedValue([{ ...ready, [field]: false }]);
    await expect(verifyBrowserOperationInfrastructure()).rejects.toThrow("browser_operation_integrity_unavailable");
  });

  it("fails closed for either household or account binding-operation mismatch", async () => {
    mocks.queryRaw.mockResolvedValue([{ ...ready, account_mismatch_count: 1n }]);
    await expect(verifyBrowserOperationInfrastructure()).rejects.toThrow("browser_operation_integrity_mismatch");

    mocks.queryRaw.mockResolvedValue([{ ...ready, household_mismatch_count: 1n }]);
    await expect(verifyBrowserOperationInfrastructure()).rejects.toThrow("browser_operation_integrity_mismatch");
  });
});
