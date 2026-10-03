import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  userFindFirst: vi.fn(),
  userUpdate: vi.fn(),
  memberFindMany: vi.fn(),
  memberUpdateMany: vi.fn(),
  lockRaw: vi.fn(),
  transaction: vi.fn(),
  writeAudit: vi.fn(),
  order: [] as string[]
}));

vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    user: { findFirst: mocks.userFindFirst, update: mocks.userUpdate },
    householdMember: { findMany: mocks.memberFindMany, updateMany: mocks.memberUpdateMany },
    $transaction: mocks.transaction,
    $queryRaw: mocks.lockRaw
  }
}));

vi.mock("@/server/auth/session", () => ({ requireUser: mocks.requireUser }));
// writeAudit is spied so the per-household calls can be inspected, but everything else in the
// module stays REAL: the action enum and the payload minimizer are the only things that validate an
// audit record, and mocking them away is how an unclassified action reached a green suite.
vi.mock("@/server/services/audit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/services/audit")>()),
  writeAudit: mocks.writeAudit
}));

import { updateOwnName } from "@/server/services/own-profile";

const USER = { id: "user-1", name: "Dan Fisher" };

function memberships(rows: Array<{ id: string; householdId: string; displayName: string | null }>) {
  mocks.memberFindMany.mockResolvedValue(rows);
}

function txHandle() {
  return {
    user: { findFirst: mocks.userFindFirst, update: mocks.userUpdate },
    householdMember: { findMany: mocks.memberFindMany, updateMany: mocks.memberUpdateMany },
    $queryRaw: mocks.lockRaw,
    __tx: true
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.order.length = 0;
  mocks.requireUser.mockResolvedValue({ id: USER.id, name: USER.name });
  mocks.lockRaw.mockImplementation(async () => { mocks.order.push("lock"); return [{ id: USER.id }]; });
  mocks.userFindFirst.mockImplementation(async () => { mocks.order.push("read"); return USER; });
  mocks.userUpdate.mockResolvedValue({ ...USER, name: "Daniel Fisher" });
  mocks.memberUpdateMany.mockResolvedValue({ count: 1 });
  memberships([{ id: "member-1", householdId: "household-1", displayName: "Dan Fisher" }]);
  mocks.transaction.mockImplementation(async (fn: any) => fn(txHandle()));
});

describe("changing your own name", () => {
  it("writes the new name to the account", async () => {
    await updateOwnName({ name: "Daniel Fisher" });

    expect(mocks.userUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: USER.id }, data: expect.objectContaining({ name: "Daniel Fisher" }) })
    );
  });

  it("lets every household that was still showing the old name follow the account again", async () => {
    // Everywhere Cubby shows a person it reads `displayName ?? user.name`, and displayName was
    // seeded from the name at the time of joining. Clearing the seeded copy is better than writing
    // the new string into it: the membership follows the account from then on, so a later rename
    // needs no carry at all, and a copy can no longer be mistaken for somebody's own choice.
    memberships([
      { id: "member-1", householdId: "household-1", displayName: "Dan Fisher" },
      { id: "member-2", householdId: "household-2", displayName: "Dan Fisher" }
    ]);

    await updateOwnName({ name: "Daniel Fisher" });

    expect(mocks.memberUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: USER.id, displayName: "Dan Fisher" }),
        data: { displayName: null }
      })
    );
  });

  it("leaves a household name alone when it was deliberately set to something else", async () => {
    memberships([{ id: "member-1", householdId: "household-1", displayName: "Grandpa" }]);

    await updateOwnName({ name: "Daniel Fisher" });

    const call = mocks.memberUpdateMany.mock.calls[0]?.[0];
    expect(call.where.displayName).toBe("Dan Fisher");
    expect(call.where.userId).toBe(USER.id);
  });

  it("narrows by the person as well as the name, so nobody else's membership is reachable", async () => {
    // Two people can share a display name. Without the userId conjunct this would clear every
    // membership in the database holding that string.
    await updateOwnName({ name: "Daniel Fisher" });

    expect(mocks.memberUpdateMany.mock.calls[0]?.[0].where.userId).toBe(USER.id);
  });

  it("records, for each household, the name that household will now show", async () => {
    // One household follows the account; the other has its own name. Writing the same before and
    // after into both would claim the second household's shown name changed, which it did not -
    // and an audit trail is the one place that has to be literally true.
    memberships([
      { id: "member-1", householdId: "household-1", displayName: "Dan Fisher" },
      { id: "member-2", householdId: "household-2", displayName: "Grandpa" }
    ]);

    await updateOwnName({ name: "Daniel Fisher" });

    expect(mocks.writeAudit).toHaveBeenCalledTimes(2);
    const byHousehold = new Map(
      mocks.writeAudit.mock.calls.map((call) => [call[0].householdId, call[1]])
    );
    // The household that followed the account records that its shown name moved; the household with
    // its own name records that it did not. Neither carries the name itself.
    expect(byHousehold.get("household-1")?.after).toEqual({ changed: ["name"], shownNameFollowed: true });
    expect(byHousehold.get("household-2")?.after).toEqual({ changed: ["name"], shownNameFollowed: false });
    for (const entry of byHousehold.values()) {
      expect(JSON.stringify(entry)).not.toContain("Dan Fisher");
      expect(JSON.stringify(entry)).not.toContain("Daniel Fisher");
    }

    const [ctx, entry] = mocks.writeAudit.mock.calls[0];
    expect(ctx.userId).toBe(USER.id);
    expect(entry.action).toBe("own_profile.name.update");
    expect(entry.entityType).toBe("user");
    expect(entry.entityId).toBe(USER.id);
  });

  it("treats a membership that already follows the account as following it still", async () => {
    memberships([{ id: "member-1", householdId: "household-1", displayName: null }]);

    await updateOwnName({ name: "Daniel Fisher" });

    const entry = mocks.writeAudit.mock.calls[0][1];
    expect(entry.after).toEqual({ changed: ["name"], shownNameFollowed: true });
  });

  it("writes the audit inside the same transaction as the rename", async () => {
    // A rename that commits without its audit record cannot be reconstructed later. updateBaby
    // passes the transaction to writeAudit for this reason; so does this.
    await updateOwnName({ name: "Daniel Fisher" });

    expect(mocks.writeAudit).toHaveBeenCalled();
    for (const call of mocks.writeAudit.mock.calls) {
      expect(call[2]).toMatchObject({ __tx: true });
    }
  });

  it("refuses an empty name", async () => {
    await expect(updateOwnName({ name: "   " })).rejects.toThrow();
    expect(mocks.userUpdate).not.toHaveBeenCalled();
  });

  it("refuses a name longer than this allows", async () => {
    await expect(updateOwnName({ name: "x".repeat(81) })).rejects.toThrow();
    expect(mocks.userUpdate).not.toHaveBeenCalled();
  });

  it("refuses a name carrying characters that only confuse how it reads", async () => {
    for (const name of ["Dan\u202eFisher", "Dan\nFisher", "Dan\u0000Fisher"]) {
      await expect(updateOwnName({ name })).rejects.toThrow();
    }
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
    mocks.requireUser.mockRejectedValue(new Error("unauthenticated"));

    await expect(updateOwnName({ name: "Daniel Fisher" })).rejects.toThrow("unauthenticated");
    expect(mocks.userUpdate).not.toHaveBeenCalled();
  });

  it("refuses an identity still owing a password change", async () => {
    // The corridor invariant: getSession deliberately does NOT gate on the assisted first-login
    // obligation, because the corridor itself authorizes through it. Anything that writes must use a
    // helper that does, or a corralled identity renames itself across every household by calling
    // this route directly instead of navigating the app.
    mocks.requireUser.mockRejectedValue(new Error("password_change_required"));

    await expect(updateOwnName({ name: "Daniel Fisher" })).rejects.toThrow("password_change_required");
    expect(mocks.userUpdate).not.toHaveBeenCalled();
    expect(mocks.memberUpdateMany).not.toHaveBeenCalled();
  });

  it("takes the row for update before reading the name it compares against", async () => {
    // Ordering, not mere invocation: a lock taken after the read would guarantee nothing.
    await updateOwnName({ name: "Daniel Fisher" });

    expect(mocks.order).toEqual(["lock", "read"]);
    expect(mocks.transaction).toHaveBeenCalled();
  });

  it("retries a serialization conflict rather than failing the save", async () => {
    // The appearance service locks this very row the same way, so a conflict is reachable.
    let attempts = 0;
    mocks.transaction.mockImplementation(async (fn: any) => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error("conflict"), { code: "P2034" });
      return fn(txHandle());
    });

    await expect(updateOwnName({ name: "Daniel Fisher" })).resolves.toEqual({ name: "Daniel Fisher" });
    expect(attempts).toBe(2);
  });

  it("changes a name nobody else can reach", async () => {
    await updateOwnName({ name: "Daniel Fisher", userId: "someone-else" } as never);

    expect(mocks.userUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: USER.id } })
    );
  });
  it("sends the real audit trail only payloads it will store", async () => {
    const { minimizeAuditPayload } = await import("@/server/services/audit");
    const action = "own_profile.name.update" as Parameters<typeof minimizeAuditPayload>[0];
    memberships([
      { id: "member-1", householdId: "household-1", displayName: "Dan Fisher" },
      { id: "member-2", householdId: "household-2", displayName: "Grandpa" }
    ]);

    await updateOwnName({ name: "Daniel Fisher" });

    expect(mocks.writeAudit).toHaveBeenCalledTimes(2);
    for (const call of mocks.writeAudit.mock.calls) {
      // Refused if the payload carries a name, or if the action is unclassified.
      expect(() => minimizeAuditPayload(action, call[1].after, "after")).not.toThrow();
      expect(call[1].before).toBeUndefined();
    }
  });

  it("does not retry a refusal, only a serialization conflict", async () => {
    // An over-broad classifier would retry a validation failure three times before surfacing it.
    let attempts = 0;
    mocks.transaction.mockImplementation(async () => {
      attempts += 1;
      throw Object.assign(new Error("nope"), { code: "P2002" });
    });

    await expect(updateOwnName({ name: "Daniel Fisher" })).rejects.toThrow();
    expect(attempts).toBe(1);

    attempts = 0;
    mocks.requireUser.mockRejectedValue(new Error("password_change_required"));
    await expect(updateOwnName({ name: "Daniel Fisher" })).rejects.toThrow("password_change_required");
    expect(attempts).toBe(0);
  });
});
