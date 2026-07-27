import { describe, expect, it, vi } from "vitest";
import { lockApiKeyForWrite, lockBabyForWrite, lockHouseholdCreation } from "@/server/services/mutation-locks";

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
    const baby = { id: "baby-1", householdId: "household-1", deletedAt: null, inactiveAt: null };
    await expect(lockBabyForWrite({ $queryRaw: queryRaw, baby: { findFirst: vi.fn().mockResolvedValue(baby) } } as never, {
      userId: "user-1", householdId: "household-1", memberId: "member-1", role: "owner"
    }, "baby-1")).resolves.toEqual(baby);
    expect(queryRaw.mock.calls[0].slice(1)).toEqual(["baby-1", "household-1"]);
  });
});

describe("API-key mutation locks", () => {
  it("scopes an active key lock to the authorized household", async () => {
    const queryRaw = vi.fn().mockResolvedValue([{ id: "key-1" }]);
    const findFirst = vi.fn().mockResolvedValue({ id: "key-1", householdId: "household-1", revokedAt: null });
    await expect(lockApiKeyForWrite({ $queryRaw: queryRaw, apiKey: { findFirst } } as never, {
      userId: "user-1", householdId: "household-1", memberId: "member-1", role: "owner"
    }, "key-1")).resolves.toMatchObject({ id: "key-1" });
    expect(queryRaw.mock.calls[0].slice(1)).toEqual(["key-1", "household-1"]);
  });
});
