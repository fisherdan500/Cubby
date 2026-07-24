import { describe, expect, it, vi } from "vitest";
import { lockBabyForWrite, lockHouseholdCreation } from "@/server/services/mutation-locks";

describe("deployment-wide household creation lock", () => {
  it("uses one transaction-scoped advisory lock shared across all users", async () => {
    const executeRaw = vi.fn().mockResolvedValue(1);

    await lockHouseholdCreation({ $executeRaw: executeRaw } as never);

    expect(executeRaw).toHaveBeenCalledOnce();
    expect(executeRaw.mock.calls[0]?.[0]?.join(" ")).toContain("pg_advisory_xact_lock");
    expect(executeRaw.mock.calls[0]?.[0]?.join(" ")).toMatch(/,\s*0\s*\)/);
    expect(executeRaw.mock.calls[0]?.slice(1)).toEqual(["cubby.household-creation"]);
  });
});

describe("baby mutation locks", () => {
  it("scopes the row lock itself to the authorized household", async () => {
    const queryRaw = vi.fn().mockResolvedValue([{ id: "baby-1" }]);
    const baby = {
      id: "baby-1",
      householdId: "household-1",
      deletedAt: null,
      inactiveAt: null
    };
    const tx = {
      $queryRaw: queryRaw,
      baby: { findFirst: vi.fn().mockResolvedValue(baby) }
    };

    await expect(
      lockBabyForWrite(
        tx as never,
        {
          userId: "user-1",
          householdId: "household-1",
          memberId: "member-1",
          role: "owner"
        },
        "baby-1"
      )
    ).resolves.toEqual(baby);

    expect(queryRaw).toHaveBeenCalledOnce();
    expect(queryRaw.mock.calls[0].slice(1)).toEqual(["baby-1", "household-1"]);
  });
});
