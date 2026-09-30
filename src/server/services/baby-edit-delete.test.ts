import { beforeEach, describe, expect, it, vi } from "vitest";
import { hasPermission } from "@/domain/roles";

const mocks = vi.hoisted(() => ({
  getEffectiveHouseholdContext: vi.fn(),
  requirePermission: vi.fn(),
  babyFindFirst: vi.fn(),
  babyUpdate: vi.fn(),
  babyDelete: vi.fn(),
  activityCount: vi.fn(),
  activityUpdateMany: vi.fn(),
  feedPostCount: vi.fn(),
  feedPostUpdateMany: vi.fn(),
  reminderCount: vi.fn(),
  plannedScheduleCount: vi.fn(),
  calendarLinkCount: vi.fn(),
  auditEventCount: vi.fn(),
  bindingCount: vi.fn(),
  operationCount: vi.fn(),
  preferenceCount: vi.fn(),
  memberFindUnique: vi.fn(),
  lockRaw: vi.fn(),
  transaction: vi.fn(),
  writeAudit: vi.fn()
}));

vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    baby: { findFirst: mocks.babyFindFirst, update: mocks.babyUpdate, delete: mocks.babyDelete },
    $transaction: mocks.transaction
  }
}));

vi.mock("@/server/auth/context", () => ({
  getEffectiveHouseholdContext: mocks.getEffectiveHouseholdContext,
  requirePermission: mocks.requirePermission
}));

vi.mock("@/server/services/audit", () => ({ writeAudit: mocks.writeAudit }));

import { deleteBaby, removeBabyProfile, updateBaby } from "@/server/services/households";

const ACTIVE_BABY = {
  id: "baby-1",
  householdId: "household-1",
  name: "Sprout",
  birthDate: null,
  notes: null,
  feedingWarningMinutes: null,
  diaperWarningMinutes: null,
  sleepWarningMinutes: null,
  inactiveAt: null,
  deletedAt: null,
  updatedAt: new Date("2026-09-29T10:00:00.000Z")
};

function zeroReferences() {
  mocks.activityCount.mockResolvedValue(0);
  mocks.feedPostCount.mockResolvedValue(0);
  mocks.reminderCount.mockResolvedValue(0);
  mocks.plannedScheduleCount.mockResolvedValue(0);
  mocks.calendarLinkCount.mockResolvedValue(0);
  mocks.auditEventCount.mockResolvedValue(0);
  mocks.bindingCount.mockResolvedValue(0);
  mocks.operationCount.mockResolvedValue(0);
  mocks.preferenceCount.mockResolvedValue(0);
}

describe("editing a baby", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getEffectiveHouseholdContext.mockResolvedValue({
      userId: "user-owner",
      householdId: "household-1",
      memberId: "member-owner",
      role: "owner"
    });
    mocks.requirePermission.mockImplementation((ctx, permission) => {
      if (!hasPermission(ctx.role, permission)) throw new Error("forbidden");
    });
    mocks.lockRaw.mockImplementation((strings: TemplateStringsArray) =>
      Promise.resolve([{ id: strings.join("").includes('"HouseholdMember"') ? "member-owner" : "baby-1" }])
    );
    mocks.memberFindUnique.mockResolvedValue({
      id: "member-owner",
      householdId: "household-1",
      role: "owner",
      disabledAt: null,
      deletedAt: null
    });
    mocks.babyFindFirst.mockResolvedValue({ ...ACTIVE_BABY });
    mocks.transaction.mockImplementation((operation) =>
      operation({
        $queryRaw: mocks.lockRaw,
        baby: { findFirst: mocks.babyFindFirst, update: mocks.babyUpdate, delete: mocks.babyDelete },
        activityLog: { count: mocks.activityCount, updateMany: mocks.activityUpdateMany },
        feedPost: { count: mocks.feedPostCount, updateMany: mocks.feedPostUpdateMany },
        reminder: { count: mocks.reminderCount },
        plannedSchedule: { count: mocks.plannedScheduleCount },
        calendarEventBaby: { count: mocks.calendarLinkCount },
        auditEvent: { count: mocks.auditEventCount },
        browserOperationBinding: { count: mocks.bindingCount },
        browserMutationOperation: { count: mocks.operationCount },
        notificationPreferenceBaby: { count: mocks.preferenceCount },
        householdMember: { findUnique: mocks.memberFindUnique }
      })
    );
  });

  it("saves the changed details and records what changed", async () => {
    mocks.babyUpdate.mockResolvedValue({ ...ACTIVE_BABY, name: "Rosie", notes: "loves naps" });

    await expect(
      updateBaby("baby-1", { name: "Rosie", notes: "loves naps" })
    ).resolves.toMatchObject({ name: "Rosie" });

    // Exact, not objectContaining: a mutation leaking an extra column (inactiveAt, deletedAt)
    // into the same update would satisfy a containment check.
    expect(mocks.babyUpdate).toHaveBeenCalledWith({
      where: { id: "baby-1" },
      data: { name: "Rosie", notes: "loves naps" }
    });
    // The whole event, exactly: containment here left entityType unasserted anywhere in the
    // suite, so the audit record could have been filed against the wrong entity kind.
    expect(mocks.writeAudit).toHaveBeenCalledTimes(1);
    const [, event] = mocks.writeAudit.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(event).toEqual({
      action: "baby.update",
      entityType: "baby",
      entityId: "baby-1",
      babyId: "baby-1",
      after: { changed: ["name", "notes"] }
    });
  });

  it("writes nothing when every supplied detail already matches", async () => {
    // The point of the change detection: a no-op save must not touch the row or the audit chain,
    // so two people editing different details cannot overwrite each other.
    await expect(
      updateBaby("baby-1", { name: ACTIVE_BABY.name, notes: ACTIVE_BABY.notes ?? undefined })
    ).resolves.toMatchObject({ id: "baby-1" });

    expect(mocks.babyUpdate).not.toHaveBeenCalled();
    expect(mocks.writeAudit).not.toHaveBeenCalled();
  });

  it("records only the detail that actually changed", async () => {
    // notes is resent UNCHANGED alongside a changed name: if the diff check is dropped, `changed`
    // becomes ["name","notes"] and this fails. Sending a new value for both would not detect that.
    mocks.babyFindFirst.mockResolvedValue({ ...ACTIVE_BABY, notes: "same note" });
    mocks.babyUpdate.mockResolvedValue({ ...ACTIVE_BABY, name: "Rosie", notes: "same note" });

    await updateBaby("baby-1", { name: "Rosie", notes: "same note" });

    const [, event] = mocks.writeAudit.mock.calls[0] as [unknown, { after: { changed: string[] } }];
    expect(event.after.changed).toEqual(["name"]);
  });

  it("clears a warning threshold that currently has a value", async () => {
    // The fixture's threshold must START set, or sending null is a no-op and proves nothing.
    mocks.babyFindFirst.mockResolvedValue({ ...ACTIVE_BABY, feedingWarningMinutes: 180 });
    mocks.babyUpdate.mockResolvedValue({ ...ACTIVE_BABY, feedingWarningMinutes: null });

    await updateBaby("baby-1", { feedingWarningMinutes: null });

    expect(mocks.babyUpdate).toHaveBeenCalledWith({
      where: { id: "baby-1" },
      data: { feedingWarningMinutes: null }
    });
    const [, cleared] = mocks.writeAudit.mock.calls[0] as [unknown, { after: { changed: string[] } }];
    expect(cleared.after.changed).toEqual(["feedingWarningMinutes"]);
  });

  it("records which details changed but never their values", async () => {
    mocks.babyUpdate.mockResolvedValue({ ...ACTIVE_BABY, name: "Rosie", notes: "loves naps" });

    await updateBaby("baby-1", { name: "Rosie", notes: "loves naps" });

    const [, event] = mocks.writeAudit.mock.calls[0] as [unknown, { after?: Record<string, unknown> }];
    expect(event.after).toEqual({ changed: ["name", "notes"] });
    // A baby's name and notes are household content, which audit evidence must exclude - the
    // PRIOR values as much as the new ones, since a `before` snapshot would leak the same
    // content. ACTIVE_BABY is named "Sprout" with notes "likes the swing".
    const serialized = JSON.stringify(event);
    for (const value of ["Rosie", "loves naps", ACTIVE_BABY.name, ACTIVE_BABY.notes]) {
      if (value) expect(serialized).not.toContain(value);
    }
  });

  it("refuses an edit from someone without baby.manage", async () => {
    mocks.getEffectiveHouseholdContext.mockResolvedValue({
      userId: "user-read",
      householdId: "household-1",
      memberId: "member-read",
      role: "read_only"
    });

    await expect(updateBaby("baby-1", { name: "Rosie" })).rejects.toThrow("forbidden");
    expect(mocks.babyUpdate).not.toHaveBeenCalled();
  });

  it("rechecks the actor inside the transaction, so a just-suspended member cannot edit", async () => {
    mocks.memberFindUnique.mockResolvedValue({
      id: "member-owner",
      householdId: "household-1",
      role: "owner",
      disabledAt: new Date(),
      deletedAt: null
    });

    await expect(updateBaby("baby-1", { name: "Rosie" })).rejects.toThrow("forbidden");
    expect(mocks.babyUpdate).not.toHaveBeenCalled();
    expect(mocks.writeAudit).not.toHaveBeenCalled();
  });

  it("rechecks permission inside the transaction, so a member demoted mid-request cannot edit", async () => {
    // Distinct from the suspension test above: disabledAt is refused by the actor lock, whereas a
    // role downgrade is only caught by the permission recheck inside the transaction.
    mocks.memberFindUnique.mockResolvedValue({
      id: "member-owner",
      householdId: "household-1",
      role: "read_only",
      disabledAt: null,
      deletedAt: null
    });

    await expect(updateBaby("baby-1", { name: "Rosie" })).rejects.toThrow("forbidden");
    expect(mocks.babyUpdate).not.toHaveBeenCalled();
    expect(mocks.writeAudit).not.toHaveBeenCalled();
  });

  it("does not edit a baby from another household", async () => {
    mocks.babyFindFirst.mockResolvedValue(null);

    await expect(updateBaby("baby-elsewhere", { name: "Rosie" })).rejects.toThrow("not_found");
    expect(mocks.babyUpdate).not.toHaveBeenCalled();
  });
});

describe("removing a baby profile entirely", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getEffectiveHouseholdContext.mockResolvedValue({
      userId: "user-owner",
      householdId: "household-1",
      memberId: "member-owner",
      role: "owner"
    });
    mocks.requirePermission.mockImplementation((ctx, permission) => {
      if (!hasPermission(ctx.role, permission)) throw new Error("forbidden");
    });
    mocks.lockRaw.mockImplementation((strings: TemplateStringsArray) =>
      Promise.resolve([{ id: strings.join("").includes('"HouseholdMember"') ? "member-owner" : "baby-1" }])
    );
    mocks.memberFindUnique.mockResolvedValue({
      id: "member-owner",
      householdId: "household-1",
      role: "owner",
      disabledAt: null,
      deletedAt: null
    });
    mocks.babyFindFirst.mockResolvedValue({ ...ACTIVE_BABY });
    mocks.babyDelete.mockResolvedValue({ ...ACTIVE_BABY });
    mocks.transaction.mockImplementation((operation) =>
      operation({
        $queryRaw: mocks.lockRaw,
        baby: { findFirst: mocks.babyFindFirst, update: mocks.babyUpdate, delete: mocks.babyDelete },
        activityLog: { count: mocks.activityCount, updateMany: mocks.activityUpdateMany },
        feedPost: { count: mocks.feedPostCount, updateMany: mocks.feedPostUpdateMany },
        reminder: { count: mocks.reminderCount },
        plannedSchedule: { count: mocks.plannedScheduleCount },
        calendarEventBaby: { count: mocks.calendarLinkCount },
        auditEvent: { count: mocks.auditEventCount },
        browserOperationBinding: { count: mocks.bindingCount },
        browserMutationOperation: { count: mocks.operationCount },
        notificationPreferenceBaby: { count: mocks.preferenceCount },
        householdMember: { findUnique: mocks.memberFindUnique }
      })
    );
    zeroReferences();
  });

  it("removes an untouched profile for real", async () => {
    await expect(
      removeBabyProfile("baby-1", { confirmation: "Yes Delete Baby Sprout" })
    ).resolves.toMatchObject({ id: "baby-1" });

    expect(mocks.babyDelete).toHaveBeenCalledWith({ where: { id: "baby-1" } });
  });

  it("refuses when the typed confirmation does not match the stored name", async () => {
    await expect(
      removeBabyProfile("baby-1", { confirmation: "Yes Delete Baby Rosie" })
    ).rejects.toThrow("confirmation_mismatch");

    expect(mocks.babyDelete).not.toHaveBeenCalled();
  });

  it("refuses a confirmation that differs only by case, so it cannot be typed absent-mindedly", async () => {
    await expect(
      removeBabyProfile("baby-1", { confirmation: "yes delete baby sprout" })
    ).rejects.toThrow("confirmation_mismatch");

    expect(mocks.babyDelete).not.toHaveBeenCalled();
  });

  it("checks the confirmation against the name in the database, not one supplied by the caller", async () => {
    // A caller that renamed the baby in its own payload must not be able to satisfy the check.
    mocks.babyFindFirst.mockResolvedValue({ ...ACTIVE_BABY, name: "Rosie" });

    await expect(
      removeBabyProfile("baby-1", { confirmation: "Yes Delete Baby Sprout", name: "Sprout" })
    ).rejects.toThrow("confirmation_mismatch");

    expect(mocks.babyDelete).not.toHaveBeenCalled();
  });

  it.each([
    ["activityCount", "baby_has_history"],
    ["feedPostCount", "baby_has_history"],
    ["reminderCount", "baby_has_history"],
    ["plannedScheduleCount", "baby_has_history"],
    ["calendarLinkCount", "baby_has_history"],
    ["auditEventCount", "baby_has_history"],
    ["bindingCount", "baby_has_history"],
    ["operationCount", "baby_has_history"],
    ["preferenceCount", "baby_has_history"]
  ])("refuses a real deletion when %s is non-zero", async (mockName, expected) => {
    (mocks as unknown as Record<string, { mockResolvedValue: (value: number) => void }>)[mockName]
      .mockResolvedValue(1);

    await expect(
      removeBabyProfile("baby-1", { confirmation: "Yes Delete Baby Sprout" })
    ).rejects.toThrow(expected);

    expect(mocks.babyDelete).not.toHaveBeenCalled();
  });

  it("counts references inside the write transaction, after locking the baby", async () => {
    await removeBabyProfile("baby-1", { confirmation: "Yes Delete Baby Sprout" });

    // The lock must precede the counts, or a concurrent insert could slip past the precondition.
    expect(mocks.lockRaw.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.activityCount.mock.invocationCallOrder[0]
    );
    expect(mocks.activityCount.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.babyDelete.mock.invocationCallOrder[0]
    );
  });

  it("refuses a real deletion from someone without baby.manage", async () => {
    mocks.getEffectiveHouseholdContext.mockResolvedValue({
      userId: "user-parent",
      householdId: "household-1",
      memberId: "member-parent",
      role: "read_only"
    });

    await expect(
      removeBabyProfile("baby-1", { confirmation: "Yes Delete Baby Sprout" })
    ).rejects.toThrow("forbidden");

    expect(mocks.babyDelete).not.toHaveBeenCalled();
  });

  it("rechecks authority inside the transaction, so a member demoted mid-request cannot delete", async () => {
    // Permitted when the request arrived, demoted by the time the write transaction locks the actor.
    mocks.memberFindUnique.mockResolvedValue({
      id: "member-owner",
      householdId: "household-1",
      role: "read_only",
      disabledAt: null,
      deletedAt: null
    });

    await expect(
      removeBabyProfile("baby-1", { confirmation: "Yes Delete Baby Sprout" })
    ).rejects.toThrow("forbidden");

    expect(mocks.babyDelete).not.toHaveBeenCalled();
  });
});

describe("deleting a baby along with its history", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getEffectiveHouseholdContext.mockResolvedValue({
      userId: "user-owner",
      householdId: "household-1",
      memberId: "member-owner",
      role: "owner"
    });
    mocks.requirePermission.mockImplementation((ctx, permission) => {
      if (!hasPermission(ctx.role, permission)) throw new Error("forbidden");
    });
    mocks.lockRaw.mockImplementation((strings: TemplateStringsArray) =>
      Promise.resolve([{ id: strings.join("").includes('"HouseholdMember"') ? "member-owner" : "baby-1" }])
    );
    mocks.memberFindUnique.mockResolvedValue({
      id: "member-owner",
      householdId: "household-1",
      role: "owner",
      disabledAt: null,
      deletedAt: null
    });
    mocks.babyFindFirst.mockResolvedValue({ ...ACTIVE_BABY });
    mocks.babyUpdate.mockResolvedValue({ ...ACTIVE_BABY, deletedAt: new Date() });
    mocks.activityUpdateMany.mockResolvedValue({ count: 3 });
    mocks.feedPostUpdateMany.mockResolvedValue({ count: 1 });
    mocks.transaction.mockImplementation((operation) =>
      operation({
        $queryRaw: mocks.lockRaw,
        baby: { findFirst: mocks.babyFindFirst, update: mocks.babyUpdate, delete: mocks.babyDelete },
        activityLog: { count: mocks.activityCount, updateMany: mocks.activityUpdateMany },
        feedPost: { count: mocks.feedPostCount, updateMany: mocks.feedPostUpdateMany },
        reminder: { count: mocks.reminderCount },
        plannedSchedule: { count: mocks.plannedScheduleCount },
        calendarEventBaby: { count: mocks.calendarLinkCount },
        auditEvent: { count: mocks.auditEventCount },
        browserOperationBinding: { count: mocks.bindingCount },
        browserMutationOperation: { count: mocks.operationCount },
        notificationPreferenceBaby: { count: mocks.preferenceCount },
        householdMember: { findUnique: mocks.memberFindUnique }
      })
    );
  });

  it("hides the baby and its history without removing any row", async () => {
    await expect(
      deleteBaby("baby-1", { confirmation: "Yes Delete Baby Sprout" })
    ).resolves.toMatchObject({ id: "baby-1" });

    expect(mocks.babyUpdate).toHaveBeenCalledWith({
      where: { id: "baby-1" },
      data: { deletedAt: expect.any(Date) }
    });
    // Scoped to THIS baby. A bare toHaveBeenCalled() here was blind to the where-clause, so
    // dropping babyId - which would hide every baby's history in the household - passed.
    expect(mocks.activityUpdateMany).toHaveBeenCalledWith({
      where: { householdId: "household-1", babyId: "baby-1", deletedAt: null },
      data: { deletedAt: expect.any(Date) }
    });
    expect(mocks.feedPostUpdateMany).toHaveBeenCalledWith({
      where: { householdId: "household-1", babyId: "baby-1", deletedAt: null },
      data: { deletedAt: expect.any(Date) }
    });
    // Only running or paused timers block a hide; ordinary history must not.
    expect(mocks.activityCount).toHaveBeenCalledWith({
      where: {
        householdId: "household-1",
        babyId: "baby-1",
        deletedAt: null,
        timerState: { in: ["running", "paused"] }
      }
    });
    // The audit chain hashes babyId, so removing rows would invalidate it.
    expect(mocks.babyDelete).not.toHaveBeenCalled();
  });

  it("requires the same typed confirmation", async () => {
    await expect(
      deleteBaby("baby-1", { confirmation: "Yes Delete Baby Rosie" })
    ).rejects.toThrow("confirmation_mismatch");

    expect(mocks.babyUpdate).not.toHaveBeenCalled();
    expect(mocks.activityUpdateMany).not.toHaveBeenCalled();
  });

  it("records the deletion with the counts it hid", async () => {
    await deleteBaby("baby-1", { confirmation: "Yes Delete Baby Sprout" });

    expect(mocks.writeAudit).toHaveBeenCalledTimes(1);
    const [, event] = mocks.writeAudit.mock.calls[0] as [unknown, {
      action: string;
      entityId: string;
      babyId: string;
      after: Record<string, unknown>;
    }];
    expect(event.action).toBe("baby.delete");
    expect(event.entityId).toBe("baby-1");
    expect(event.babyId).toBe("baby-1");
    // The fixtures set 3 activities and 1 feed post precisely so the counts can be checked;
    // asserting the shape only would let the two be swapped.
    expect(event.after).toEqual({
      deletedAt: expect.any(String),
      activityCount: 3,
      feedPostCount: 1
    });
  });

  it("is idempotent: deleting an already-deleted baby changes nothing further", async () => {
    mocks.babyFindFirst.mockResolvedValue({ ...ACTIVE_BABY, deletedAt: new Date("2026-09-01T00:00:00.000Z") });

    await expect(
      deleteBaby("baby-1", { confirmation: "Yes Delete Baby Sprout" })
    ).resolves.toMatchObject({ id: "baby-1" });

    expect(mocks.babyUpdate).not.toHaveBeenCalled();
    expect(mocks.writeAudit).not.toHaveBeenCalled();
  });

  it("refuses when the baby has a running timer, matching deactivation", async () => {
    mocks.activityCount.mockResolvedValue(1);

    await expect(
      deleteBaby("baby-1", { confirmation: "Yes Delete Baby Sprout" })
    ).rejects.toThrow("baby_has_active_timer");

    expect(mocks.babyUpdate).not.toHaveBeenCalled();
  });

  it("rechecks authority inside the transaction, so a member demoted mid-request cannot delete", async () => {
    mocks.memberFindUnique.mockResolvedValue({
      id: "member-owner",
      householdId: "household-1",
      role: "read_only",
      disabledAt: null,
      deletedAt: null
    });

    await expect(
      deleteBaby("baby-1", { confirmation: "Yes Delete Baby Sprout" })
    ).rejects.toThrow("forbidden");

    expect(mocks.babyUpdate).not.toHaveBeenCalled();
    expect(mocks.activityUpdateMany).not.toHaveBeenCalled();
  });
});
