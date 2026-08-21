import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getContext: vi.fn(),
  getSession: vi.fn()
}));

vi.mock("@/server/auth/context", () => ({
  getEffectiveHouseholdContext: mocks.getContext
}));
vi.mock("@/server/auth/session", () => ({ getSession: mocks.getSession }));

import {
  getAccountBrowserOperationPartition,
  getHouseholdBrowserOperationPartition
} from "@/server/services/browser-operation-partition";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getContext.mockResolvedValue({
    userId: "user-1",
    householdId: "household-1",
    memberId: "member-1",
    role: "parent"
  });
  mocks.getSession.mockResolvedValue({ user: { id: "user-1" }, session: { id: "session-1" } });
});

describe("browser operation partition descriptors", () => {
  it("derives a stable opaque household descriptor from the current session and membership scope", async () => {
    const first = await getHouseholdBrowserOperationPartition();
    const second = await getHouseholdBrowserOperationPartition();

    expect(first).toEqual(second);
    expect(first).toMatchObject({ version: 1, scope: "household" });
    expect(first.partition).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(first)).not.toContain("session-1");
    expect(JSON.stringify(first)).not.toContain("member-1");
  });

  it("changes the household descriptor when the effective membership or session changes", async () => {
    const first = await getHouseholdBrowserOperationPartition();
    mocks.getContext.mockResolvedValue({
      userId: "user-1",
      householdId: "household-2",
      memberId: "member-2",
      role: "parent"
    });
    mocks.getSession.mockResolvedValue({ user: { id: "user-1" }, session: { id: "session-2" } });

    await expect(getHouseholdBrowserOperationPartition()).resolves.not.toEqual(first);
  });

  it("derives an account descriptor without effective-household authority", async () => {
    const partition = await getAccountBrowserOperationPartition();

    expect(partition).toMatchObject({ version: 1, scope: "account" });
    expect(partition.partition).toMatch(/^[a-f0-9]{64}$/);
    expect(mocks.getContext).not.toHaveBeenCalled();
  });

  it("rejects a mismatched authenticated household context", async () => {
    mocks.getContext.mockResolvedValue({
      userId: "other-user",
      householdId: "household-1",
      memberId: "member-1",
      role: "parent"
    });

    await expect(getHouseholdBrowserOperationPartition()).rejects.toThrow("forbidden");
  });
});
