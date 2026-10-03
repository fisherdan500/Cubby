import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  userFindFirst: vi.fn(),
  userUpdate: vi.fn(),
  memberFindMany: vi.fn(),
  memberUpdateMany: vi.fn(),
  lockRaw: vi.fn(),
  transaction: vi.fn(),
  writeAudit: vi.fn()
}));

vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    user: { findFirst: mocks.userFindFirst, update: mocks.userUpdate },
    householdMember: { findMany: mocks.memberFindMany, updateMany: mocks.memberUpdateMany },
    $transaction: mocks.transaction,
    $queryRaw: mocks.lockRaw
  }
}));

vi.mock("@/server/auth/session", () => ({ getSession: mocks.getSession }));
vi.mock("@/server/services/audit", () => ({ writeAudit: mocks.writeAudit }));

import { getOwnProfileName, updateOwnName } from "@/server/services/own-profile";

const USER = { id: "user-1", name: "Dan Fisher" };

function memberships(rows: Array<{ id: string; householdId: string; displayName: string | null }>) {
  mocks.memberFindMany.mockResolvedValue(rows);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSession.mockResolvedValue({ user: { id: USER.id }, session: { id: "session-1" } });
  mocks.userFindFirst.mockResolvedValue(USER);
  mocks.userUpdate.mockResolvedValue({ ...USER, name: "Daniel Fisher" });
  mocks.memberUpdateMany.mockResolvedValue({ count: 1 });
  mocks.lockRaw.mockResolvedValue([{ id: USER.id }]);
  memberships([{ id: "member-1", householdId: "household-1", displayName: "Dan Fisher" }]);
  mocks.transaction.mockImplementation(async (fn: any) =>
    fn({
      user: { findFirst: mocks.userFindFirst, update: mocks.userUpdate },
      householdMember: { findMany: mocks.memberFindMany, updateMany: mocks.memberUpdateMany },
      $queryRaw: mocks.lockRaw
    })
  );
});

describe("reading your own name", () => {
  it("reads the name from the account, not from a household", async () => {
    expect(await getOwnProfileName()).toEqual({ name: "Dan Fisher" });
  });

  it("refuses when nobody is signed in", async () => {
    mocks.getSession.mockResolvedValue(null);

    await expect(getOwnProfileName()).rejects.toThrow("unauthenticated");
  });
});

describe("changing your own name", () => {
  it("writes the new name to the account", async () => {
    await updateOwnName({ name: "Daniel Fisher" });

    expect(mocks.userUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: USER.id }, data: expect.objectContaining({ name: "Daniel Fisher" }) })
    );
  });

  it("carries the new name into every household that was still showing the old one", async () => {
    // Everywhere Cubby shows a person - moments, the full log, the members list - it reads
    // `displayName ?? user.name`, and displayName was seeded from the name at the time of joining.
    // Changing only the account would leave the old name on every screen that matters.
    memberships([
      { id: "member-1", householdId: "household-1", displayName: "Dan Fisher" },
      { id: "member-2", householdId: "household-2", displayName: "Dan Fisher" }
    ]);

    await updateOwnName({ name: "Daniel Fisher" });

    expect(mocks.memberUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: USER.id, displayName: "Dan Fisher" }),
        data: { displayName: "Daniel Fisher" }
      })
    );
  });

  it("leaves a household name alone when it was deliberately set to something else", async () => {
    // A per-household name is somebody's choice. Overwriting every membership would erase it, so
    // only the memberships still echoing the old account name are carried forward.
    memberships([{ id: "member-1", householdId: "household-1", displayName: "Grandpa" }]);

    await updateOwnName({ name: "Daniel Fisher" });

    const call = mocks.memberUpdateMany.mock.calls[0]?.[0];
    expect(call.where.displayName).toBe("Dan Fisher");
    expect(call.data.displayName).toBe("Daniel Fisher");
  });

  it("records the change against every household the person belongs to", async () => {
    memberships([
      { id: "member-1", householdId: "household-1", displayName: "Dan Fisher" },
      { id: "member-2", householdId: "household-2", displayName: "Dan Fisher" }
    ]);

    await updateOwnName({ name: "Daniel Fisher" });

    expect(mocks.writeAudit).toHaveBeenCalledTimes(2);
    const households = mocks.writeAudit.mock.calls.map((call) => call[0].householdId).sort();
    expect(households).toEqual(["household-1", "household-2"]);
    const [ctx, entry] = mocks.writeAudit.mock.calls[0];
    expect(ctx.userId).toBe(USER.id);
    expect(entry.action).toBe("own_profile.name.update");
    expect(entry.entityType).toBe("user");
    expect(entry.entityId).toBe(USER.id);
    expect(entry.before).toEqual({ name: "Dan Fisher" });
    expect(entry.after).toEqual({ name: "Daniel Fisher" });
  });

  it("refuses an empty name", async () => {
    await expect(updateOwnName({ name: "   " })).rejects.toThrow();
    expect(mocks.userUpdate).not.toHaveBeenCalled();
  });

  it("refuses a name longer than the column allows", async () => {
    await expect(updateOwnName({ name: "x".repeat(81) })).rejects.toThrow();
    expect(mocks.userUpdate).not.toHaveBeenCalled();
  });

  it("trims surrounding space rather than storing it", async () => {
    await updateOwnName({ name: "  Daniel Fisher  " });

    expect(mocks.userUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ name: "Daniel Fisher" }) })
    );
  });

  it("does nothing at all when the name has not changed", async () => {
    const result = await updateOwnName({ name: "Dan Fisher" });

    expect(mocks.userUpdate).not.toHaveBeenCalled();
    expect(mocks.memberUpdateMany).not.toHaveBeenCalled();
    expect(mocks.writeAudit).not.toHaveBeenCalled();
    expect(result).toEqual({ name: "Dan Fisher" });
  });

  it("refuses when nobody is signed in", async () => {
    mocks.getSession.mockResolvedValue(null);

    await expect(updateOwnName({ name: "Daniel Fisher" })).rejects.toThrow("unauthenticated");
    expect(mocks.userUpdate).not.toHaveBeenCalled();
  });

  it("takes the row for update before reading the name it compares against", async () => {
    // Two tabs renaming at once must not interleave: the lock is taken inside the transaction so
    // the old name this reads is the one it is about to replace.
    await updateOwnName({ name: "Daniel Fisher" });

    expect(mocks.lockRaw).toHaveBeenCalled();
    expect(mocks.transaction).toHaveBeenCalled();
  });

  it("changes a name nobody else can reach", async () => {
    // The identity comes from the session, never from the caller, so there is no field to aim at
    // another account.
    await updateOwnName({ name: "Daniel Fisher", userId: "someone-else" } as never);

    expect(mocks.userUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: USER.id } })
    );
  });
});
