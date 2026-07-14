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

  it("locks the row and rejects an equal-timestamp superseding audit regardless of id ordering", async () => {
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

    expect(mocks.activityLock).toHaveBeenCalledOnce();
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
