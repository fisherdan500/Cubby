import { beforeEach, describe, expect, it, vi } from "vitest";
import { hasPermission } from "@/domain/roles";

const mocks = vi.hoisted(() => ({
  getHouseholdContext: vi.fn(),
  requirePermission: vi.fn(),
  activityFindFirst: vi.fn(),
  activityCreate: vi.fn(),
  activityUpdate: vi.fn(),
  activityUpdateMany: vi.fn(),
  activityFindUniqueOrThrow: vi.fn(),
  activityLock: vi.fn(),
  transaction: vi.fn(),
  specificDeleteMany: vi.fn(),
  medicineUpdate: vi.fn(),
  contactFindFirst: vi.fn(),
  vaccineDeleteMany: vi.fn(),
  vaccineUpsert: vi.fn(),
  babyFindFirst: vi.fn(),
  memberFindUnique: vi.fn(),
  webhookFindMany: vi.fn(),
  webhookCreateMany: vi.fn(),
  notificationFindMany: vi.fn(),
  notificationCreateMany: vi.fn(),
  auditFindFirst: vi.fn(),
  writeAudit: vi.fn()
}));

vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    activityLog: {
      findFirst: mocks.activityFindFirst,
      create: mocks.activityCreate,
      update: mocks.activityUpdate,
      updateMany: mocks.activityUpdateMany
    },
    baby: { findFirst: mocks.babyFindFirst },
    webhookEndpoint: { findMany: mocks.webhookFindMany },
    notificationPreference: { findMany: mocks.notificationFindMany },
    auditEvent: { findFirst: mocks.auditFindFirst },
    $transaction: mocks.transaction
  }
}));

vi.mock("@/server/auth/context", () => ({
  getHouseholdContext: mocks.getHouseholdContext,
  requirePermission: mocks.requirePermission
}));

vi.mock("@/server/services/audit", () => ({ writeAudit: mocks.writeAudit }));

import {
  createActivityForContext,
  deleteActivity,
  getActivityForEdit,
  getActivityView,
  pauseTimer,
  restoreHistoricalActivityForContext,
  resumeTimer,
  undoLastActivity,
  updateActivity
} from "@/server/services/activities";

describe("activity page access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getHouseholdContext.mockResolvedValue(context("parent"));
    mocks.requirePermission.mockImplementation((ctx, permission) => {
      if (!hasPermission(ctx.role, permission)) throw new Error("forbidden");
    });
    mocks.activityFindFirst.mockResolvedValue(activity("member-author"));
    mocks.activityCreate.mockResolvedValue({ id: "activity-created", type: "feeding", timerState: "none" });
    mocks.activityUpdate.mockResolvedValue(activity("member-author"));
    mocks.activityUpdateMany.mockResolvedValue({ count: 1 });
    mocks.activityFindUniqueOrThrow.mockResolvedValue(activity("member-author"));
    mocks.activityLock.mockResolvedValue([{ id: "activity-1" }]);
    mocks.transaction.mockImplementation((operation) => operation(transactionClient()));
    mocks.babyFindFirst.mockResolvedValue({ id: "baby-1" });
    mocks.memberFindUnique.mockResolvedValue({
      id: "member-current",
      householdId: "household-1",
      role: "parent",
      disabledAt: null,
      deletedAt: null
    });
    mocks.contactFindFirst.mockResolvedValue({ id: "contact-2" });
    mocks.webhookFindMany.mockResolvedValue([]);
    mocks.notificationFindMany.mockResolvedValue([]);
    mocks.auditFindFirst.mockImplementation(({ where }) =>
      Promise.resolve(
        where.actorMemberId
          ? {
              id: "audit-create",
              action: "activity.create",
              entityId: "activity-1",
              createdAt: new Date("2026-07-14T10:00:01.000Z"),
              before: null,
              after: { updatedAt: "2026-07-14T10:00:00.000Z", deletedAt: null }
            }
          : null
      )
    );
  });

  it("scopes detail reads to the active household and non-deleted record", async () => {
    await getActivityView("activity-1");

    expect(mocks.activityFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "activity-1", householdId: "household-1", deletedAt: null }
      })
    );
  });

  it.each(["owner", "admin", "parent"] as const)("allows %s to update and delete any activity", async (role) => {
    mocks.getHouseholdContext.mockResolvedValue(context(role));

    await expect(getActivityView("activity-1")).resolves.toMatchObject({ canUpdate: true, canDelete: true });
  });

  it("allows a caretaker to mutate only an activity they recorded", async () => {
    mocks.getHouseholdContext.mockResolvedValue(context("caretaker"));
    mocks.activityFindFirst.mockResolvedValueOnce(activity("member-current")).mockResolvedValueOnce(activity("member-other"));

    await expect(getActivityView("activity-own")).resolves.toMatchObject({ canUpdate: true, canDelete: true });
    await expect(getActivityView("activity-other")).resolves.toMatchObject({ canUpdate: false, canDelete: false });
  });

  it("lets read-only members view without mutation actions", async () => {
    mocks.getHouseholdContext.mockResolvedValue(context("read_only"));

    await expect(getActivityView("activity-1")).resolves.toMatchObject({ canUpdate: false, canDelete: false });
  });

  it("fails closed before rendering an unauthorized edit form", async () => {
    mocks.getHouseholdContext.mockResolvedValue(context("caretaker"));
    mocks.activityFindFirst.mockResolvedValue(activity("member-other"));

    await expect(getActivityForEdit("activity-1")).rejects.toThrow("forbidden");
  });

  it("fails closed before rendering an edit form for a read-only member", async () => {
    mocks.getHouseholdContext.mockResolvedValue(context("read_only"));

    await expect(getActivityForEdit("activity-1")).rejects.toThrow("forbidden");
  });

  it("returns not found for an unavailable scoped record", async () => {
    mocks.activityFindFirst.mockResolvedValue(null);

    await expect(getActivityView("missing")).rejects.toThrow("not_found");
  });

  it("preserves zero-valued feeding side durations in persistence data", async () => {
    await createActivityForContext(
      {
        babyId: "baby-1",
        occurredAt: "2026-07-14T12:00:00.000Z",
        type: "feeding",
        mode: "bottle",
        leftSeconds: 0,
        rightSeconds: "0"
      },
      context("parent")
    );

    expect(mocks.activityCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          feeding: expect.objectContaining({
            create: expect.objectContaining({ leftSeconds: 0, rightSeconds: 0 })
          })
        })
      })
    );
  });

  it("restores stopped timer metadata without recomputing duration", async () => {
    await restoreHistoricalActivityForContext(
      {
        babyId: "baby-1",
        type: "sleep",
        occurredAt: "2026-07-14T10:00:00.000Z",
        startedAt: "2026-07-14T10:00:00.000Z",
        endedAt: "2026-07-14T11:00:00.000Z",
        activeTimer: false,
        notes: undefined,
        sleepType: undefined,
        location: undefined,
        quality: undefined
      },
      context("owner"),
      transactionClient() as never,
      { timerState: "stopped", durationSeconds: 2700, pausedSeconds: 900 }
    );

    expect(mocks.activityCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          timerState: "stopped",
          durationSeconds: 2700,
          pausedAt: null,
          pausedSeconds: 900
        })
      })
    );
  });

  it("restores historical timestamps and timezone without normal-create defaults", async () => {
    await restoreHistoricalActivityForContext(
      {
        babyId: "baby-1",
        type: "medicine",
        occurredAt: "2026-07-14T10:00:00.000Z",
        timezone: "UTC",
        activeTimer: false,
        name: "Medicine",
        notes: undefined,
        dose: undefined,
        unit: undefined,
        contactId: undefined
      },
      context("owner"),
      transactionClient() as never,
      undefined,
      undefined,
      { startedAt: null, endedAt: null, timezone: "UTC" }
    );

    expect(mocks.activityCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ startedAt: null, endedAt: null, timezone: "UTC" })
      })
    );
  });

  it("restores historical attribution without normal activity audits or side effects", async () => {
    await restoreHistoricalActivityForContext(
      {
        babyId: "baby-1",
        type: "note",
        occurredAt: "2026-07-14T10:00:00.000Z",
        text: "history",
        notes: undefined,
        activeTimer: false,
        category: undefined
      },
      context("owner"), transactionClient() as never, undefined,
      { source: "sprout", externalActorName: "Grandma" }
    );

    expect(mocks.activityCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ source: "sprout", externalActorName: "Grandma" })
    }));
    expect(mocks.writeAudit).not.toHaveBeenCalled();
    expect(mocks.webhookFindMany).not.toHaveBeenCalled();
    expect(mocks.notificationFindMany).not.toHaveBeenCalled();
  });

  it("rejects a medicine create contact outside the active household", async () => {
    mocks.contactFindFirst.mockResolvedValue(null);

    await expect(
      createActivityForContext(
        {
          babyId: "baby-1",
          occurredAt: "2026-07-14T12:00:00.000Z",
          type: "medicine",
          name: "Vitamin D",
          contactId: "contact-other-household"
        },
        context("parent")
      )
    ).rejects.toThrow("not_found");

    expect(mocks.activityCreate).not.toHaveBeenCalled();
  });

  it("rejects create for an inactive baby after transactional recheck", async () => {
    mocks.babyFindFirst.mockResolvedValue({
      id: "baby-1",
      inactiveAt: new Date("2026-07-14T12:00:00.000Z")
    });

    await expect(
      createActivityForContext(
        {
          babyId: "baby-1",
          occurredAt: "2026-07-14T12:00:00.000Z",
          type: "feeding",
          mode: "bottle"
        },
        context("parent")
      )
    ).rejects.toThrow("baby_inactive");

    expect(mocks.activityCreate).not.toHaveBeenCalled();
  });

  it("rejects create when the locked actor was demoted after context resolution", async () => {
    mocks.memberFindUnique.mockResolvedValue({
      id: "member-current",
      householdId: "household-1",
      role: "read_only",
      disabledAt: null,
      deletedAt: null
    });

    await expect(createActivityForContext(feedingInput(), context("parent"))).rejects.toThrow("forbidden");

    expect(mocks.activityCreate).not.toHaveBeenCalled();
  });

  it("rejects update when the locked actor was demoted after context resolution", async () => {
    mocks.memberFindUnique.mockResolvedValue({
      id: "member-current",
      householdId: "household-1",
      role: "read_only",
      disabledAt: null,
      deletedAt: null
    });

    await expect(updateActivity("activity-1", feedingInput())).rejects.toThrow("forbidden");

    expect(mocks.activityUpdateMany).not.toHaveBeenCalled();
  });

  it("claims an active household activity inside the update transaction", async () => {
    await updateActivity("activity-1", feedingInput());

    expect(mocks.activityUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: "activity-1", householdId: "household-1", deletedAt: null }) })
    );
  });

  it("claims an edit against the page-load version", async () => {
    await updateActivity("activity-1", {
      ...feedingInput(),
      expectedUpdatedAt: "2026-07-14T09:00:00.000Z"
    });

    expect(mocks.activityUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ updatedAt: new Date("2026-07-14T09:00:00.000Z") }) })
    );
  });

  it("preserves timer-control fields while editing a running timer", async () => {
    mocks.activityFindFirst.mockResolvedValue({
      ...activity("member-author"),
      timerState: "running",
      startedAt: new Date("2026-07-14T09:30:00.000Z"),
      endedAt: null,
      durationSeconds: 1800
    });

    await updateActivity("activity-1", feedingInput());

    expect(mocks.activityUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          timerState: "running",
          startedAt: new Date("2026-07-14T09:30:00.000Z"),
          endedAt: null,
          durationSeconds: 1800
        })
      })
    );
  });

  it("keeps timer state unchanged while editing historical activity for an inactive baby", async () => {
    mocks.activityFindFirst.mockResolvedValue({
      ...activity("member-author"),
      babyId: "baby-1",
      inactiveAt: new Date("2026-07-14T12:00:00.000Z")
    });
    mocks.babyFindFirst.mockResolvedValue({
      id: "baby-1",
      inactiveAt: new Date("2026-07-14T12:00:00.000Z")
    });

    await updateActivity("activity-1", feedingInput());

    expect(mocks.activityUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          timerState: "none"
        })
      })
    );
  });

  it("rejects moving historical activity into a different inactive baby", async () => {
    mocks.activityFindFirst.mockResolvedValue({
      ...activity("member-author"),
      babyId: "baby-active"
    });
    mocks.babyFindFirst.mockResolvedValue({
      id: "baby-inactive",
      inactiveAt: new Date("2026-07-14T12:00:00.000Z")
    });

    await expect(
      updateActivity("activity-1", {
        babyId: "baby-inactive",
        occurredAt: "2026-07-14T12:00:00.000Z",
        type: "feeding",
        mode: "bottle"
      })
    ).rejects.toThrow("baby_inactive");

    expect(mocks.activityUpdateMany).not.toHaveBeenCalled();
  });

  it("rejects edits that would start a timer for an inactive baby", async () => {
    mocks.babyFindFirst.mockResolvedValue({
      id: "baby-1",
      inactiveAt: new Date("2026-07-14T12:00:00.000Z")
    });

    await expect(
      updateActivity("activity-1", {
        babyId: "baby-1",
        occurredAt: "2026-07-14T12:00:00.000Z",
        type: "feeding",
        mode: "bottle",
        activeTimer: true
      })
    ).rejects.toThrow("baby_inactive");
  });

  it("rejects moving an active timer to an inactive baby", async () => {
    mocks.activityFindFirst.mockResolvedValue({
      ...activity("member-author"),
      babyId: "baby-active",
      timerState: "running",
      startedAt: new Date("2026-07-14T11:00:00.000Z")
    });
    mocks.babyFindFirst.mockResolvedValue({
      id: "baby-inactive",
      inactiveAt: new Date("2026-07-14T12:00:00.000Z")
    });

    await expect(
      updateActivity("activity-1", {
        babyId: "baby-inactive",
        occurredAt: "2026-07-14T12:00:00.000Z",
        type: "feeding",
        mode: "bottle"
      })
    ).rejects.toThrow("baby_inactive");

    expect(mocks.activityUpdateMany).not.toHaveBeenCalled();
  });

  it("preserves stopped timer state while allowing completed time edits", async () => {
    mocks.activityFindFirst.mockResolvedValue({ ...activity("member-author"), timerState: "stopped" });

    await updateActivity("activity-1", feedingInput());

    expect(mocks.activityUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ timerState: "stopped" }) })
    );
  });

  it("rejects subtype changes for timer-backed activities", async () => {
    mocks.activityFindFirst.mockResolvedValue({ ...activity("member-author"), timerState: "running" });

    await expect(
      updateActivity("activity-1", {
        babyId: "baby-1",
        occurredAt: "2026-07-14T12:00:00.000Z",
        type: "note",
        text: "Do not replace a running timer"
      })
    ).rejects.toThrow("not_found");

    expect(mocks.activityUpdateMany).not.toHaveBeenCalled();
  });

  it("preserves a linked medicine contact during an edit", async () => {
    mocks.activityFindFirst.mockResolvedValue({
      ...activity("member-author"),
      type: "medicine",
      medicine: { contactId: "contact-1" }
    });

    await updateActivity("activity-1", {
      babyId: "baby-1",
      occurredAt: "2026-07-14T12:00:00.000Z",
      type: "medicine",
      name: "Vitamin D",
      dose: "1",
      unit: "mL"
    });

    expect(mocks.medicineUpdate).toHaveBeenCalledWith({
      where: { activityId: "activity-1" },
      data: { contactId: "contact-1" }
    });
  });

  it("honors an explicitly replaced medicine contact", async () => {
    mocks.activityFindFirst.mockResolvedValue({
      ...activity("member-author"),
      type: "medicine",
      medicine: { contactId: "contact-1" }
    });

    await updateActivity("activity-1", {
      babyId: "baby-1",
      occurredAt: "2026-07-14T12:00:00.000Z",
      type: "medicine",
      name: "Vitamin D",
      dose: "1",
      unit: "mL",
      contactId: "contact-2"
    });

    expect(mocks.activityUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { medicine: { create: expect.objectContaining({ contactId: "contact-2" }) } }
      })
    );
    expect(mocks.medicineUpdate).not.toHaveBeenCalled();
  });

  it("rejects an explicit medicine contact outside the active household", async () => {
    mocks.activityFindFirst.mockResolvedValue({
      ...activity("member-author"),
      type: "medicine",
      medicine: { contactId: "contact-1" }
    });
    mocks.contactFindFirst.mockResolvedValue(null);

    await expect(
      updateActivity("activity-1", {
        babyId: "baby-1",
        occurredAt: "2026-07-14T12:00:00.000Z",
        type: "medicine",
        name: "Vitamin D",
        contactId: "contact-other-household"
      })
    ).rejects.toThrow("not_found");

    expect(mocks.contactFindFirst).toHaveBeenCalledWith({
      where: { id: "contact-other-household", householdId: "household-1", deletedAt: null },
      select: { id: true }
    });
    expect(mocks.activityUpdateMany).not.toHaveBeenCalled();
  });

  it("honors an explicitly cleared medicine contact", async () => {
    mocks.activityFindFirst.mockResolvedValue({
      ...activity("member-author"),
      type: "medicine",
      medicine: { contactId: "contact-1" }
    });

    await updateActivity("activity-1", {
      babyId: "baby-1",
      occurredAt: "2026-07-14T12:00:00.000Z",
      type: "medicine",
      name: "Vitamin D",
      dose: "1",
      unit: "mL",
      contactId: ""
    });

    expect(mocks.medicineUpdate).not.toHaveBeenCalled();
  });

  it("writes update audit and outbox records through the mutation transaction", async () => {
    mocks.webhookFindMany.mockResolvedValue([{ id: "endpoint-1" }]);

    await updateActivity("activity-1", feedingInput());

    expect(mocks.writeAudit).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ activityLog: expect.anything() }));
    expect(mocks.webhookCreateMany).toHaveBeenCalledOnce();
  });

  it("upserts a vaccine subtype without deleting its document parent", async () => {
    mocks.activityFindFirst.mockResolvedValue({ ...activity("member-author"), type: "vaccine" });

    await updateActivity("activity-1", {
      babyId: "baby-1",
      occurredAt: "2026-07-14T12:00:00.000Z",
      type: "vaccine",
      name: "MMR",
      lot: "lot-2"
    });

    expect(mocks.vaccineDeleteMany).not.toHaveBeenCalled();
    expect(mocks.vaccineUpsert).toHaveBeenCalledWith({
      where: { activityId: "activity-1" },
      create: expect.objectContaining({ activityId: "activity-1", name: "MMR", lot: "lot-2" }),
      update: expect.objectContaining({ name: "MMR", lot: "lot-2", dose: null, provider: null, dueDate: null, documentUrl: null })
    });
  });

  it("claims an active household activity before emitting delete side effects", async () => {
    await deleteActivity("activity-1");

    expect(mocks.activityUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: "activity-1", householdId: "household-1", deletedAt: null }) })
    );
  });

  it("denies undo when the current role can no longer delete the activity", async () => {
    mocks.getHouseholdContext.mockResolvedValue(context("read_only"));
    mocks.memberFindUnique.mockResolvedValue({
      id: "member-current",
      householdId: "household-1",
      role: "read_only",
      disabledAt: null,
      deletedAt: null
    });
    mocks.activityFindFirst.mockResolvedValue(activity("member-current"));

    await expect(undoLastActivity()).rejects.toThrow("forbidden");

    expect(mocks.activityUpdateMany).not.toHaveBeenCalled();
  });

  it("claims undo state and writes its audit in the same transaction", async () => {
    mocks.activityFindFirst.mockResolvedValue(activity("member-current"));

    await undoLastActivity();

    expect(mocks.activityUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "activity-1",
        householdId: "household-1",
        deletedAt: null,
        updatedAt: new Date("2026-07-14T10:00:00.000Z")
      },
      data: { deletedAt: expect.any(Date), deletedByMemberId: "member-current" }
    });
    expect(mocks.writeAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "activity.undo", entityId: "activity-1" }),
      expect.objectContaining({ activityLog: expect.anything(), auditEvent: expect.anything() })
    );
  });

  it("locks actor, baby, and activity before rejecting an equal-timestamp superseding audit", async () => {
    mocks.auditFindFirst.mockImplementation(({ where }) =>
      Promise.resolve(
        where.actorMemberId
          ? {
              id: "audit-create",
              action: "activity.create",
              entityId: "activity-1",
              createdAt: new Date("2026-07-14T10:00:01.000Z"),
              after: { updatedAt: "2026-07-14T10:00:00.000Z", deletedAt: null }
            }
          : where.createdAt
            ? { id: "000-lexically-lower-audit" }
            : null
      )
    );

    await expect(undoLastActivity()).rejects.toThrow("not_found");

    expect(mocks.activityLock).toHaveBeenCalledTimes(3);
    expect(mocks.activityLock.mock.invocationCallOrder[0]).toBeLessThan(mocks.auditFindFirst.mock.invocationCallOrder[1]);
    expect(mocks.auditFindFirst).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          createdAt: { gte: new Date("2026-07-14T10:00:01.000Z") },
          id: { not: "audit-create" }
        })
      })
    );
    expect(mocks.activityUpdateMany).not.toHaveBeenCalled();
  });

  it("rejects undo when the current row no longer matches the audit snapshot", async () => {
    mocks.auditFindFirst.mockImplementation(({ where }) =>
      Promise.resolve(
        where.actorMemberId
          ? {
              id: "audit-create",
              action: "activity.create",
              entityId: "activity-1",
              createdAt: new Date("2026-07-14T09:00:01.000Z"),
              after: { updatedAt: "2026-07-14T09:00:00.000Z", deletedAt: null }
            }
          : null
      )
    );
    mocks.activityFindFirst.mockImplementation(({ where }) =>
      Promise.resolve(
        where.updatedAt && where.updatedAt.getTime() !== new Date("2026-07-14T10:00:00.000Z").getTime()
          ? null
          : activity("member-current")
      )
    );

    await expect(undoLastActivity()).rejects.toThrow("not_found");

    expect(mocks.activityUpdateMany).not.toHaveBeenCalled();
  });

  it("claims the current active timer row before pausing", async () => {
    mocks.activityFindFirst.mockResolvedValue({
      ...activity("member-author"),
      timerState: "running",
      startedAt: new Date("2026-07-14T11:00:00.000Z")
    });

    await pauseTimer("activity-1");

    expect(mocks.activityUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "activity-1",
          householdId: "household-1",
          deletedAt: null,
          updatedAt: new Date("2026-07-14T10:00:00.000Z")
        })
      })
    );
  });

  it("rejects timer resume when the baby became inactive before the transactional recheck", async () => {
    mocks.activityFindFirst.mockResolvedValue({
      ...activity("member-author"),
      timerState: "paused",
      pausedAt: new Date("2026-07-14T11:15:00.000Z"),
      babyId: "baby-1"
    });
    mocks.babyFindFirst.mockResolvedValue({
      id: "baby-1",
      inactiveAt: new Date("2026-07-14T12:00:00.000Z")
    });

    await expect(resumeTimer("activity-1")).rejects.toThrow("baby_inactive");

    expect(mocks.activityUpdateMany).not.toHaveBeenCalled();
  });

  it("rejects timer resume when the locked actor was demoted after context resolution", async () => {
    mocks.activityFindFirst.mockResolvedValue({
      ...activity("member-current"),
      timerState: "paused",
      pausedAt: new Date("2026-07-14T11:15:00.000Z"),
      babyId: "baby-1"
    });
    mocks.memberFindUnique.mockResolvedValue({
      id: "member-current",
      householdId: "household-1",
      role: "read_only",
      disabledAt: null,
      deletedAt: null
    });

    await expect(resumeTimer("activity-1")).rejects.toThrow("forbidden");

    expect(mocks.activityUpdateMany).not.toHaveBeenCalled();
  });

  it("does not restore a deleted active timer for an inactive baby", async () => {
    const deletedAt = new Date("2026-07-14T10:05:00.000Z");
    mocks.auditFindFirst.mockImplementation(({ where }) =>
      Promise.resolve(
        where.actorMemberId
          ? {
              id: "audit-delete",
              action: "activity.delete",
              entityId: "activity-1",
              createdAt: new Date("2026-07-14T10:05:01.000Z"),
              before: { updatedAt: "2026-07-14T10:00:00.000Z", deletedAt: null },
              after: { updatedAt: "2026-07-14T10:00:00.000Z", deletedAt: deletedAt.toISOString() }
            }
          : null
      )
    );
    mocks.activityFindFirst.mockResolvedValue({
      ...activity("member-current"),
      babyId: "baby-1",
      deletedAt,
      timerState: "running",
      startedAt: new Date("2026-07-14T09:30:00.000Z")
    });
    mocks.babyFindFirst.mockResolvedValue({
      id: "baby-1",
      inactiveAt: new Date("2026-07-14T12:00:00.000Z")
    });

    await expect(undoLastActivity()).rejects.toThrow("baby_inactive");

    expect(mocks.activityUpdateMany).not.toHaveBeenCalled();
  });
});

function transactionClient() {
  const child = { deleteMany: mocks.specificDeleteMany };
  return {
    $queryRaw: mocks.activityLock,
    activityLog: {
      findFirst: mocks.activityFindFirst,
      create: mocks.activityCreate,
      update: mocks.activityUpdate,
      updateMany: mocks.activityUpdateMany,
      findUniqueOrThrow: mocks.activityFindUniqueOrThrow
    },
    auditEvent: { findFirst: mocks.auditFindFirst },
    webhookEndpoint: { findMany: mocks.webhookFindMany },
    webhookDelivery: { createMany: mocks.webhookCreateMany },
    notificationPreference: { findMany: mocks.notificationFindMany },
    notificationLog: { createMany: mocks.notificationCreateMany },
    contact: { findFirst: mocks.contactFindFirst },
    householdMember: { findUnique: mocks.memberFindUnique },
    baby: { findFirst: mocks.babyFindFirst },
    feedingLog: child,
    diaperLog: child,
    sleepLog: child,
    pumpingLog: child,
    medicineLog: { deleteMany: mocks.specificDeleteMany, update: mocks.medicineUpdate },
    measurementLog: child,
    milestoneLog: child,
    noteLog: child,
    bathLog: child,
    playLog: child,
    moodLog: child,
    supplementLog: child,
    vaccineLog: { deleteMany: mocks.vaccineDeleteMany, upsert: mocks.vaccineUpsert },
    milkInventoryLog: child
  };
}

function feedingInput() {
  return {
    babyId: "baby-1",
    occurredAt: "2026-07-14T12:00:00.000Z",
    type: "feeding",
    mode: "bottle"
  };
}

function context(role: "owner" | "admin" | "parent" | "caretaker" | "read_only") {
  return {
    userId: "user-current",
    householdId: "household-1",
    memberId: "member-current",
    role
  };
}

function activity(actorMemberId: string) {
  return {
    id: "activity-1",
    householdId: "household-1",
    actorMemberId,
    deletedAt: null,
    type: "feeding",
    updatedAt: new Date("2026-07-14T10:00:00.000Z"),
    timerState: "none",
    startedAt: null,
    pausedAt: null,
    pausedSeconds: 0
  };
}
