import { describe, expect, it, vi } from "vitest";
import { lockBabyForWrite } from "@/server/services/mutation-locks";

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
