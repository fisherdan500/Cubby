import { beforeEach, describe, expect, it, vi } from "vitest";
import { hasPermission } from "@/domain/roles";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  lockActor: vi.fn(),
  lockBaby: vi.fn(),
  requirePermission: vi.fn(),
  importedCount: vi.fn(),
  importedFind: vi.fn(),
  importedCreate: vi.fn(),
  batchCreate: vi.fn(),
  batchUpdate: vi.fn(),
  backupCreate: vi.fn(),
  babyFindMany: vi.fn(),
  babyCreate: vi.fn(),
  activityCreate: vi.fn(),
  eventCreate: vi.fn(),
  eventBabyUpsert: vi.fn()
}));

vi.mock("@/lib/db/prisma", () => ({ prisma: transactionClient() }));
vi.mock("@/server/auth/context", () => ({
  getHouseholdContext: vi.fn().mockResolvedValue(context("owner")),
  requirePermission: mocks.requirePermission
}));
vi.mock("@/server/services/mutation-locks", () => ({
  lockActorForWrite: mocks.lockActor,
  lockBabyForWrite: mocks.lockBaby
}));

import { importSproutBackup } from "@/server/services/sprout-import";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requirePermission.mockImplementation((ctx, permission) => {
    if (!hasPermission(ctx.role, permission)) throw new Error("forbidden");
  });
  mocks.transaction.mockImplementation((operation) => operation(transactionClient()));
  mocks.lockActor.mockResolvedValue(context("owner"));
  mocks.importedCount.mockResolvedValue(0);
  mocks.importedFind.mockResolvedValue(null);
  mocks.importedCreate.mockResolvedValue({});
  mocks.batchCreate.mockResolvedValue({ id: "batch-1" });
  mocks.batchUpdate.mockResolvedValue({});
  mocks.backupCreate.mockResolvedValue({});
  mocks.babyFindMany.mockResolvedValue([]);
  mocks.babyCreate.mockResolvedValue({ id: "baby-1", householdId: "household-1", inactiveAt: null });
  mocks.activityCreate.mockResolvedValue({ id: "activity-1", vaccine: null });
  mocks.eventCreate.mockResolvedValue({ id: "event-1" });
  mocks.eventBabyUpsert.mockResolvedValue({});
});

describe("Sprout import mutation boundaries", () => {
  it("rechecks backup permission with the locked role before any import write", async () => {
    mocks.lockActor.mockResolvedValue(context("parent"));

    await expect(importSproutBackup(upload({ Baby: [] }))).rejects.toThrow("forbidden");

    expect(mocks.transaction).toHaveBeenCalledOnce();
    expect(mocks.batchCreate).not.toHaveBeenCalled();
    expect(mocks.babyCreate).not.toHaveBeenCalled();
    expect(mocks.activityCreate).not.toHaveBeenCalled();
  });

  it("locks a matched inactive baby and imports its historical activity and event link atomically", async () => {
    const inactiveBaby = {
      id: "baby-1",
      householdId: "household-1",
      name: "Finley",
      birthDate: new Date("2026-03-13T00:00:00.000Z"),
      inactiveAt: new Date("2026-07-14T12:00:00.000Z")
    };
    mocks.babyFindMany.mockResolvedValue([inactiveBaby]);
    mocks.lockBaby.mockResolvedValue(inactiveBaby);

    await expect(
      importSproutBackup(
        upload({
          Baby: [{ id: "source-baby", firstName: "Finley", birthDate: "2026-03-13T00:00:00.000Z" }],
          Note: [{ id: "note-1", babyId: "source-baby", time: "2026-07-13T12:00:00.000Z", content: "Historical" }],
          CalendarEvent: [{ id: "event-1", title: "Appointment", startTime: "2026-07-13T14:00:00.000Z" }],
          BabyEvent: [{ id: "link-1", eventId: "event-1", babyId: "source-baby" }]
        })
      )
    ).resolves.toEqual(expect.objectContaining({ result: expect.objectContaining({ activities: 1, calendarEvents: 1 }) }));
    expect(mocks.transaction).toHaveBeenCalledOnce();
    expect(mocks.importedCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ householdId: "household-1", importBatchId: "batch-1" })
      })
    );
    expect(mocks.lockBaby).toHaveBeenCalledWith(expect.anything(), context("owner"), "baby-1");
    expect(mocks.activityCreate).toHaveBeenCalledOnce();
    expect(mocks.activityCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          household: { connect: { id: "household-1" } },
          baby: { connect: { id: "baby-1" } },
          actorMember: { connect: { id: "member-1" } }
        })
      })
    );
    expect(mocks.eventBabyUpsert).toHaveBeenCalledWith({
      where: { babyId_eventId: { babyId: "baby-1", eventId: "event-1" } },
      update: {},
      create: { eventId: "event-1", babyId: "baby-1" }
    });
    expect(mocks.batchUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "complete" }) }));
  });

  it("rolls back domain writes then records a re-authorized failed import separately", async () => {
    const importError = new Error("activity_write_failed");
    mocks.activityCreate.mockRejectedValueOnce(importError);

    await expect(
      importSproutBackup(
        upload({
          Baby: [{ id: "source-baby", firstName: "Finley" }],
          Note: [{ id: "note-1", babyId: "source-baby", time: "2026-07-13T12:00:00.000Z" }]
        })
      )
    ).rejects.toBe(importError);

    expect(mocks.transaction).toHaveBeenCalledTimes(2);
    expect(mocks.lockActor).toHaveBeenCalledTimes(2);
    expect(mocks.batchCreate).toHaveBeenLastCalledWith({
      data: expect.objectContaining({
        householdId: "household-1",
        actorUserId: "user-1",
        sourceSystem: "sprout-track",
        status: "failed",
        error: "activity_write_failed"
      })
    });
    expect(mocks.backupCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        householdId: "household-1",
        actorUserId: "user-1",
        kind: "sprout_import",
        status: "failed",
        error: "activity_write_failed"
      })
    });
  });
});

function upload(tables: Record<string, unknown[]>) {
  const form = new FormData();
  form.append("file", new Blob([JSON.stringify({ data: tables })], { type: "application/json" }), "data.json");
  return form;
}

function context(role: "owner" | "parent") {
  return {
    userId: "user-1",
    householdId: "household-1",
    memberId: "member-1",
    role
  };
}

function transactionClient() {
  return {
    $transaction: mocks.transaction,
    importedRecord: {
      count: mocks.importedCount,
      findUnique: mocks.importedFind,
      create: mocks.importedCreate
    },
    importBatch: { create: mocks.batchCreate, update: mocks.batchUpdate },
    backupRecord: { create: mocks.backupCreate },
    baby: { findMany: mocks.babyFindMany, create: mocks.babyCreate },
    contact: { findFirst: vi.fn(), create: vi.fn() },
    medicineCatalog: { findFirst: vi.fn(), create: vi.fn() },
    householdSettings: { upsert: vi.fn(), update: vi.fn() },
    activityLog: { create: mocks.activityCreate },
    calendarEvent: { create: mocks.eventCreate },
    calendarEventBaby: { upsert: mocks.eventBabyUpsert },
    calendarEventContact: { upsert: vi.fn() },
    vaccineDocument: { create: vi.fn() }
  };
}
