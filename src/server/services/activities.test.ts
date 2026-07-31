import { beforeEach, describe, expect, it, vi } from "vitest";
import { hasPermission } from "@/domain/roles";
import { activityCreateSchema, activityUpdateSchema } from "@/lib/validation/activity";

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
  mutationReceiptFindFirst: vi.fn(),
  mutationReceiptCreate: vi.fn(),
  apiKeyFindFirst: vi.fn(),
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
    mutationReceipt: { findFirst: mocks.mutationReceiptFindFirst, create: mocks.mutationReceiptCreate },
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
  activityCreateFingerprint,
  activityUpdateFingerprint,
  deleteActivity,
  getActivityForEdit,
  getActivityView,
  pauseTimer,
  restoreHistoricalActivityForContext,
  resumeTimer,
  stopTimer,
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
    mocks.activityFindFirst.mockImplementation(({ where }) =>
      Promise.resolve("clientMutationId" in where ? null : activity("member-author"))
    );
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
    mocks.mutationReceiptFindFirst.mockReset();
    mocks.mutationReceiptFindFirst.mockResolvedValue(null);
    mocks.mutationReceiptCreate.mockReset();
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

  it("rejects a revoked API key inside the activity write transaction", async () => {
    mocks.apiKeyFindFirst.mockResolvedValue({ id: "key-1", householdId: "household-1", revokedAt: new Date(), expiresAt: null });
    await expect(createActivityForContext(feedingInput(), { ...context("parent"), apiKeyId: "key-1", scopes: ["write"] })).rejects.toThrow("unauthenticated");
    expect(mocks.activityCreate).not.toHaveBeenCalled();
  });

  it("writes a new activity create into the shared receipt namespace", async () => {
    const mutationId = "018f2b6c-8f5f-7e0b-8c3f-9f42c0a64011";

    await createActivityForContext({ ...feedingInput(), clientMutationId: mutationId }, context("parent"));

    expect(mocks.mutationReceiptCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          householdId: "household-1",
          actorMemberId: "member-current",
          operation: "activity.create",
          targetActivityId: "activity-created",
          clientMutationId: mutationId,
          outcomeActivityId: "activity-created",
          outcomeSnapshot: expect.objectContaining({ id: "activity-created" })
        })
      })
    );
  });

  it("returns the immutable new-ledger create snapshot without a second create", async () => {
    const mutationId = "018f2b6c-8f5f-7e0b-8c3f-9f42c0a64012";
    const request = { ...feedingInput(), clientMutationId: mutationId };
    const outcomeSnapshot = { id: "activity-created", type: "feeding", notes: "original response" };
    mocks.mutationReceiptFindFirst.mockResolvedValue({
      householdId: "household-1",
      actorMemberId: "member-current",
      apiKeyId: null,
      operation: "activity.create",
      targetActivityId: "activity-created",
      clientMutationId: mutationId,
      intentFingerprint: activityCreateFingerprint(activityCreateSchema.parse(request)),
      outcomeActivityId: "activity-created",
      outcomeSnapshot
    });

    await expect(createActivityForContext(request, context("parent"))).resolves.toEqual(outcomeSnapshot);
    expect(mocks.activityCreate).not.toHaveBeenCalled();
    expect(mocks.writeAudit).not.toHaveBeenCalled();
  });

  it("replays the authoritative activity for the same household mutation ID and normalized request", async () => {
    const mutationId = "018f2b6c-8f5f-7e0b-8c3f-9f42c0a64001";
    const request = { ...feedingInput(), clientMutationId: mutationId };
    const existing = {
      ...activity("member-current"),
      id: "activity-existing",
      clientMutationId: mutationId,
      clientMutationFingerprint: activityCreateFingerprint(activityCreateSchema.parse(request))
    };
    mocks.activityFindFirst.mockResolvedValue(existing);

    await expect(createActivityForContext(request, context("parent"))).resolves.toBe(existing);

    expect(mocks.activityFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { householdId: "household-1", clientMutationId: mutationId } })
    );
    expect(mocks.activityCreate).not.toHaveBeenCalled();
  });

  it("replays an existing mutation before checking a now-inactive baby", async () => {
    const mutationId = "018f2b6c-8f5f-7e0b-8c3f-9f42c0a64008";
    const request = { ...feedingInput(), clientMutationId: mutationId };
    const existing = {
      ...activity("member-current"),
      id: "activity-inactive-replay",
      clientMutationId: mutationId,
      clientMutationFingerprint: activityCreateFingerprint(activityCreateSchema.parse(request))
    };
    mocks.activityFindFirst.mockResolvedValue(existing);
    mocks.babyFindFirst.mockRejectedValue(new Error("baby_inactive"));

    await expect(createActivityForContext(request, context("parent"))).resolves.toBe(existing);
    expect(mocks.babyFindFirst).not.toHaveBeenCalled();
  });

  it("rejects a reused household mutation ID for a different normalized activity request", async () => {
    const mutationId = "018f2b6c-8f5f-7e0b-8c3f-9f42c0a64002";
    mocks.activityFindFirst.mockResolvedValue({
      ...activity("member-current"),
      clientMutationId: mutationId,
      clientMutationFingerprint: activityCreateFingerprint({ ...feedingInput(), clientMutationId: mutationId })
    });

    await expect(
      createActivityForContext({ ...feedingInput(), clientMutationId: mutationId, mode: "formula" }, context("parent"))
    ).rejects.toThrow("idempotency_conflict");
    expect(mocks.activityCreate).not.toHaveBeenCalled();
  });

  it("replays a lost-response retry after the unique household mutation key wins concurrently", async () => {
    const mutationId = "018f2b6c-8f5f-7e0b-8c3f-9f42c0a64003";
    const request = { ...feedingInput(), clientMutationId: mutationId };
    const existing = {
      ...activity("member-current"),
      id: "activity-concurrent",
      clientMutationId: mutationId,
      clientMutationFingerprint: activityCreateFingerprint(activityCreateSchema.parse(request))
    };
    mocks.transaction.mockRejectedValueOnce({ code: "P2002", meta: { target: ["householdId", "clientMutationId"] } });
    mocks.activityFindFirst.mockResolvedValue(existing);

    await expect(createActivityForContext(request, context("parent"))).resolves.toBe(existing);
    expect(mocks.writeAudit).not.toHaveBeenCalled();
  });

  it("does not treat an unrelated unique constraint as an idempotent replay", async () => {
    const error = { code: "P2002", meta: { target: ["householdId", "otherUniqueField"] } };
    mocks.transaction.mockRejectedValueOnce(error);

    await expect(createActivityForContext(feedingInput(), context("parent"))).rejects.toBe(error);
    expect(mocks.activityFindFirst).not.toHaveBeenCalled();
  });

  it("preserves zero-valued feeding side durations in persistence data", async () => {
    await createActivityForContext(
      {
        clientMutationId: "018f2b6c-8f5f-7e0b-8c3f-9f42c0a64006",
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

  it("writes an activity with the locked household, baby, and actor member", async () => {
    await createActivityForContext(feedingInput(), context("parent"));

    expect(mocks.activityCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          household: { connect: { id: "household-1" } },
          baby: { connect: { id: "baby-1" } },
          actorMember: { connect: { id: "member-current" } }
        })
      })
    );
  });

  it("does not queue a notification for a recipient whose membership closes before the notification lock", async () => {
    mocks.notificationFindMany.mockResolvedValue([{ userId: "departed-user" }]);
    mocks.activityLock.mockImplementation((query: TemplateStringsArray) =>
      String(query).includes('FROM "HouseholdMember"') && String(query).includes('"userId"')
        ? []
        : [{ id: "locked" }]
    );

    await createActivityForContext(feedingInput(), context("parent"));

    expect(mocks.notificationCreateMany).not.toHaveBeenCalled();
    expect(String(mocks.activityLock.mock.calls.find(([query]) =>
      String(query).includes('FROM "HouseholdMember"') && String(query).includes('"userId"')
    )?.[0])).toContain("FOR SHARE SKIP LOCKED");
  });

  it("restores stopped timer metadata without recomputing duration", async () => {
    await restoreHistoricalActivityForContext(
      {
        clientMutationId: "018f2b6c-8f5f-7e0b-8c3f-9f42c0a64006",
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
          pausedSeconds: 900,
          clientMutationId: undefined,
          clientMutationFingerprint: undefined
        })
      })
    );
  });

  it("restores historical timestamps and timezone without normal-create defaults", async () => {
    await restoreHistoricalActivityForContext(
      {
        clientMutationId: "018f2b6c-8f5f-7e0b-8c3f-9f42c0a64006",
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
        clientMutationId: "018f2b6c-8f5f-7e0b-8c3f-9f42c0a64006",
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
          clientMutationId: "018f2b6c-8f5f-7e0b-8c3f-9f42c0a64006",
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
          clientMutationId: "018f2b6c-8f5f-7e0b-8c3f-9f42c0a64006",
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

  it("reauthorizes activity-update permission inside the mutation transaction", async () => {
    mocks.memberFindUnique
      .mockResolvedValueOnce({ id: "member-current", householdId: "household-1", role: "parent", disabledAt: null, deletedAt: null })
      .mockResolvedValueOnce({ id: "member-current", householdId: "household-1", role: "read_only", disabledAt: null, deletedAt: null });

    await expect(updateActivity("activity-1", feedingInput())).rejects.toThrow("forbidden");
    expect(mocks.activityUpdateMany).not.toHaveBeenCalled();
    expect(mocks.mutationReceiptCreate).not.toHaveBeenCalled();
  });

  it("claims an active household activity inside the update transaction", async () => {
    await updateActivity("activity-1", feedingInput());

    expect(mocks.activityUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: "activity-1", householdId: "household-1", deletedAt: null }) })
    );
  });

  it("returns stale_revision without effects when a concurrent move wins after the source-baby read", async () => {
    mocks.activityFindFirst
      .mockResolvedValueOnce({ babyId: "baby-1" })
      .mockResolvedValueOnce({ ...activity("member-author"), babyId: "baby-2" });

    await expect(updateActivity("activity-1", feedingInput())).rejects.toThrow("stale_revision");
    expect(mocks.activityUpdateMany).not.toHaveBeenCalled();
    expect(mocks.mutationReceiptCreate).not.toHaveBeenCalled();
    expect(mocks.writeAudit).not.toHaveBeenCalled();
    expect(mocks.webhookCreateMany).not.toHaveBeenCalled();
  });

  it("returns stale_revision without effects when a concurrent delete wins after the source-baby read", async () => {
    mocks.activityFindFirst
      .mockResolvedValueOnce({ babyId: "baby-1" })
      .mockResolvedValueOnce({ ...activity("member-author"), babyId: "baby-1", deletedAt: new Date("2026-07-14T10:01:00.000Z") });

    await expect(updateActivity("activity-1", feedingInput())).rejects.toThrow("stale_revision");
    expect(mocks.activityUpdateMany).not.toHaveBeenCalled();
    expect(mocks.mutationReceiptCreate).not.toHaveBeenCalled();
    expect(mocks.writeAudit).not.toHaveBeenCalled();
    expect(mocks.webhookCreateMany).not.toHaveBeenCalled();
  });

  it("rejects legacy PATCH payloads without a stable mutation ID or optimistic revision", async () => {
    const { clientMutationId: _withoutMutationId, ...withoutMutationId } = feedingInput();
    const { expectedUpdatedAt: _withoutRevision, ...withoutRevision } = feedingInput();

    await expect(updateActivity("activity-1", withoutMutationId)).rejects.toBeDefined();
    await expect(updateActivity("activity-1", withoutRevision)).rejects.toBeDefined();
    expect(mocks.activityUpdateMany).not.toHaveBeenCalled();
  });

  it("rejects an update mutation ID reserved by a pre-ledger activity create", async () => {
    mocks.activityFindFirst
      .mockResolvedValueOnce(activity("member-author"))
      .mockResolvedValueOnce(activity("member-author"))
      .mockResolvedValueOnce({ id: "legacy-create", clientMutationId: "018f2b6c-8f5f-7e0b-8c3f-9f42c0a64005" });

    await expect(updateActivity("activity-1", feedingInput())).rejects.toThrow("idempotency_conflict");
    expect(mocks.activityUpdateMany).not.toHaveBeenCalled();
    expect(mocks.mutationReceiptCreate).not.toHaveBeenCalled();
    expect(mocks.writeAudit).not.toHaveBeenCalled();
  });

  it("returns stale_revision when the expected update version no longer claims the activity", async () => {
    mocks.activityUpdateMany.mockResolvedValueOnce({ count: 0 });

    await expect(updateActivity("activity-1", {
      ...feedingInput(),
      clientMutationId: "11111111-1111-4111-8111-111111111111",
      expectedUpdatedAt: "2026-07-14T09:00:00.000Z"
    })).rejects.toThrow("stale_revision");
    expect(mocks.mutationReceiptCreate).not.toHaveBeenCalled();
  });

  it("persists a durable activity-update receipt with the update", async () => {
    await updateActivity("activity-1", {
      ...feedingInput(),
      clientMutationId: "11111111-1111-4111-8111-111111111111"
    });

    expect(mocks.mutationReceiptCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          householdId: "household-1",
          actorMemberId: "member-current",
          operation: "activity.update",
          targetActivityId: "activity-1",
          clientMutationId: "11111111-1111-4111-8111-111111111111",
          outcomeActivityId: "activity-1"
        })
      })
    );
  });

  it("returns the immutable update receipt snapshot after later resource changes", async () => {
    const input = { ...feedingInput(), clientMutationId: "11111111-1111-4111-8111-111111111112" };
    const snapshot = { id: "activity-1", type: "feeding", notes: "before later edit" };
    mocks.mutationReceiptFindFirst.mockResolvedValue({
      householdId: "household-1",
      actorMemberId: "member-current",
      apiKeyId: null,
      operation: "activity.update",
      targetActivityId: "activity-1",
      outcomeActivityId: "activity-1",
      clientMutationId: input.clientMutationId,
      intentFingerprint: activityUpdateFingerprint("activity-1", activityUpdateSchema.parse({ ...input, id: "activity-1" })),
      outcomeSnapshot: snapshot
    });

    await expect(updateActivity("activity-1", input)).resolves.toEqual(snapshot);
    expect(mocks.activityUpdateMany).not.toHaveBeenCalled();
    expect(mocks.writeAudit).not.toHaveBeenCalled();
    expect(mocks.webhookCreateMany).not.toHaveBeenCalled();
  });

  it("replays a matching activity-update receipt without a second update, audit, or side effect", async () => {
    const input = { ...feedingInput(), clientMutationId: "11111111-1111-4111-8111-111111111111" };
    await updateActivity("activity-1", input);
    const receipt = mocks.mutationReceiptCreate.mock.calls[0]?.[0]?.data;
    mocks.mutationReceiptFindFirst.mockResolvedValue(receipt);
    mocks.activityUpdateMany.mockClear();
    mocks.writeAudit.mockClear();
    mocks.webhookCreateMany.mockClear();

    const replay = await updateActivity("activity-1", input);

    expect(replay).toMatchObject({ id: "activity-1" });
    expect(mocks.activityUpdateMany).not.toHaveBeenCalled();
    expect(mocks.writeAudit).not.toHaveBeenCalled();
    expect(mocks.webhookCreateMany).not.toHaveBeenCalled();
  });

  it("fails closed when an activity-update mutation ID is rebound to different update intent", async () => {
    const input = { ...feedingInput(), clientMutationId: "11111111-1111-4111-8111-111111111111" };
    await updateActivity("activity-1", input);
    mocks.mutationReceiptFindFirst.mockResolvedValue(mocks.mutationReceiptCreate.mock.calls[0]?.[0]?.data);

    await expect(updateActivity("activity-1", { ...input, notes: "different intent" })).rejects.toThrow("idempotency_conflict");
    expect(mocks.activityUpdateMany).toHaveBeenCalledTimes(1);
  });

  it("recovers the matching activity-update winner after a receipt uniqueness race", async () => {
    const input = { ...feedingInput(), clientMutationId: "11111111-1111-4111-8111-111111111111" };
    await updateActivity("activity-1", input);
    const receipt = mocks.mutationReceiptCreate.mock.calls[0]?.[0]?.data;
    mocks.mutationReceiptFindFirst.mockReset();
    mocks.mutationReceiptFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce(receipt);
    mocks.mutationReceiptCreate.mockRejectedValue({
      code: "P2002",
      meta: { target: ["householdId", "clientMutationId"] }
    });
    mocks.activityUpdateMany.mockClear();
    mocks.writeAudit.mockClear();

    const replay = await updateActivity("activity-1", input);

    expect(replay).toMatchObject({ id: "activity-1" });
    expect(mocks.activityUpdateMany).toHaveBeenCalledTimes(1);
    expect(mocks.writeAudit).not.toHaveBeenCalled();
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
    mockActivityRead({
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
    mockActivityRead({
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
    mockActivityRead({
      ...activity("member-author"),
      babyId: "baby-active"
    });
    mocks.babyFindFirst.mockResolvedValue({
      id: "baby-inactive",
      inactiveAt: new Date("2026-07-14T12:00:00.000Z")
    });

    await expect(
      updateActivity("activity-1", {
        ...feedingInput(),
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
        ...feedingInput(),
        babyId: "baby-1",
        occurredAt: "2026-07-14T12:00:00.000Z",
        type: "feeding",
        mode: "bottle",
        activeTimer: true
      })
    ).rejects.toThrow("baby_inactive");
  });

  it("rejects moving an active timer to an inactive baby", async () => {
    mockActivityRead({
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
        ...feedingInput(),
        babyId: "baby-inactive",
        occurredAt: "2026-07-14T12:00:00.000Z",
        type: "feeding",
        mode: "bottle"
      })
    ).rejects.toThrow("baby_inactive");

    expect(mocks.activityUpdateMany).not.toHaveBeenCalled();
  });

  it("preserves stopped timer state while allowing completed time edits", async () => {
    mockActivityRead({ ...activity("member-author"), timerState: "stopped" });

    await updateActivity("activity-1", feedingInput());

    expect(mocks.activityUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ timerState: "stopped" }) })
    );
  });

  it("rejects subtype changes for timer-backed activities", async () => {
    mockActivityRead({ ...activity("member-author"), timerState: "running" });

    await expect(
      updateActivity("activity-1", {
        ...feedingInput(),
        babyId: "baby-1",
        occurredAt: "2026-07-14T12:00:00.000Z",
        type: "note",
        text: "Do not replace a running timer"
      })
    ).rejects.toThrow("not_found");

    expect(mocks.activityUpdateMany).not.toHaveBeenCalled();
  });

  it("preserves a linked medicine contact during an edit", async () => {
    mockActivityRead({
      ...activity("member-author"),
      type: "medicine",
      medicine: { contactId: "contact-1" }
    });

    await updateActivity("activity-1", {
      ...feedingInput(),
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
    mockActivityRead({
      ...activity("member-author"),
      type: "medicine",
      medicine: { contactId: "contact-1" }
    });

    await updateActivity("activity-1", {
      ...feedingInput(),
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
    mockActivityRead({
      ...activity("member-author"),
      type: "medicine",
      medicine: { contactId: "contact-1" }
    });
    mocks.contactFindFirst.mockResolvedValue(null);

    await expect(
      updateActivity("activity-1", {
        ...feedingInput(),
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
    mockActivityRead({
      ...activity("member-author"),
      type: "medicine",
      medicine: { contactId: "contact-1" }
    });

    await updateActivity("activity-1", {
      ...feedingInput(),
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
    mocks.webhookFindMany.mockResolvedValue([{ id: "endpoint-1", legacyUnattributed: true, delegatedByMemberId: null }]);

    await updateActivity("activity-1", feedingInput());

    expect(mocks.writeAudit).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ activityLog: expect.anything() }));
    expect(mocks.webhookFindMany).toHaveBeenCalledWith(expect.objectContaining({ orderBy: { id: "asc" } }));
    expect(mocks.webhookCreateMany).toHaveBeenCalledOnce();
    expect(mocks.webhookCreateMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ householdId: "household-1", endpointId: "endpoint-1" })]
    });
  });

  it("locks every eligible webhook endpoint sequentially in canonical ID order", async () => {
    mocks.webhookFindMany.mockResolvedValue([
      { id: "endpoint-a", legacyUnattributed: true, delegatedByMemberId: null },
      { id: "endpoint-b", legacyUnattributed: true, delegatedByMemberId: null }
    ]);

    await updateActivity("activity-1", feedingInput());

    const endpointLocks = mocks.activityLock.mock.calls
      .filter(([query]) => String(query).includes('FROM "WebhookEndpoint"'));

    expect(endpointLocks.map(([, endpointId]) => endpointId)).toEqual(["endpoint-a", "endpoint-b"]);
    expect(endpointLocks.map(([query]) => String(query))).toEqual([
      expect.stringContaining("FOR UPDATE"),
      expect.stringContaining("FOR UPDATE")
    ]);
  });

  it("does not enqueue a delegated webhook after its issuing membership is no longer authorized", async () => {
    mocks.webhookFindMany.mockResolvedValue([
      { id: "endpoint-issued", legacyUnattributed: false, delegatedByMemberId: "member-delegator" }
    ]);
    mocks.activityLock.mockImplementation((query: TemplateStringsArray) =>
      String(query).includes('FROM "HouseholdMember"') && String(query).includes('"disabledAt" IS NULL')
        ? []
        : [{ id: "locked" }]
    );

    await updateActivity("activity-1", feedingInput());

    expect(mocks.webhookCreateMany).not.toHaveBeenCalled();
    expect(String(mocks.activityLock.mock.calls.find(([query]) =>
      String(query).includes('FROM "HouseholdMember"') && String(query).includes('"disabledAt" IS NULL')
    )?.[0])).toContain("FOR SHARE SKIP LOCKED");
  });

  it("upserts a vaccine subtype without deleting its document parent", async () => {
    mockActivityRead({ ...activity("member-author"), type: "vaccine" });

    await updateActivity("activity-1", {
      ...feedingInput(),
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
      expect.objectContaining({
        where: expect.objectContaining({ id: "activity-1", householdId: "household-1", deletedAt: null }),
        data: { deletedAt: expect.any(Date), deletedByMemberId: "member-current" }
      })
    );
  });

  it("persists a durable activity-delete receipt with the soft delete and side effects", async () => {
    mocks.webhookFindMany.mockResolvedValue([
      { id: "webhook-1", legacyUnattributed: true, delegatedByMemberId: null }
    ]);
    await (deleteActivity as unknown as (id: string, raw: unknown) => Promise<unknown>)("activity-1", {
      clientMutationId: "55555555-5555-4555-8555-555555555555"
    });

    expect(mocks.mutationReceiptCreate).toHaveBeenCalledWith({
      data: {
        householdId: "household-1",
        actorMemberId: "member-current",
        apiKeyId: null,
        operation: "activity.delete",
        targetActivityId: "activity-1",
        clientMutationId: "55555555-5555-4555-8555-555555555555",
        intentFingerprint: "5410baf832f94d84c5511e6e28a4520a51d684c0430ea656fc2b3d077a5d95b1",
        outcomeActivityId: "activity-1",
        outcomeSnapshot: expect.objectContaining({ id: "activity-1" })
      }
    });
    expect(mocks.writeAudit).toHaveBeenCalledTimes(1);
    expect(mocks.webhookCreateMany).toHaveBeenCalledTimes(1);
  });

  it("replays a matching activity-delete receipt without a second soft delete, audit, or side effect", async () => {
    mocks.mutationReceiptFindFirst.mockResolvedValue({
      householdId: "household-1",
      actorMemberId: "member-current",
      operation: "activity.delete",
      targetActivityId: "activity-1",
      clientMutationId: "55555555-5555-4555-8555-555555555555",
      intentFingerprint: "5410baf832f94d84c5511e6e28a4520a51d684c0430ea656fc2b3d077a5d95b1",
      outcomeActivityId: "activity-1"
    });

    const replay = await (deleteActivity as unknown as (id: string, raw: unknown) => Promise<{ id: string }>)("activity-1", {
      clientMutationId: "55555555-5555-4555-8555-555555555555"
    });

    expect(replay).toMatchObject({ id: "activity-1" });
    expect(mocks.activityUpdateMany).not.toHaveBeenCalled();
    expect(mocks.mutationReceiptCreate).not.toHaveBeenCalled();
    expect(mocks.writeAudit).not.toHaveBeenCalled();
    expect(mocks.webhookCreateMany).not.toHaveBeenCalled();
  });

  it("fails closed when an activity-delete mutation ID is bound to another target", async () => {
    mocks.mutationReceiptFindFirst.mockResolvedValue({
      householdId: "household-1",
      actorMemberId: "member-current",
      operation: "activity.delete",
      targetActivityId: "activity-other",
      clientMutationId: "55555555-5555-4555-8555-555555555555",
      intentFingerprint: "5410baf832f94d84c5511e6e28a4520a51d684c0430ea656fc2b3d077a5d95b1",
      outcomeActivityId: "activity-other"
    });

    await expect((deleteActivity as unknown as (id: string, raw: unknown) => Promise<unknown>)("activity-1", {
      clientMutationId: "55555555-5555-4555-8555-555555555555"
    })).rejects.toThrow("idempotency_conflict");

    expect(mocks.activityUpdateMany).not.toHaveBeenCalled();
    expect(mocks.writeAudit).not.toHaveBeenCalled();
  });

  it("returns the matching receipt winner after a stale activity-delete claim", async () => {
    const receipt = {
      householdId: "household-1",
      actorMemberId: "member-current",
      operation: "activity.delete",
      targetActivityId: "activity-1",
      clientMutationId: "55555555-5555-4555-8555-555555555555",
      intentFingerprint: "5410baf832f94d84c5511e6e28a4520a51d684c0430ea656fc2b3d077a5d95b1",
      outcomeActivityId: "activity-1"
    };
    mocks.mutationReceiptFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce(receipt);
    mocks.activityUpdateMany.mockResolvedValue({ count: 0 });

    const result = await (deleteActivity as unknown as (id: string, raw: unknown) => Promise<{ id: string }>)("activity-1", {
      clientMutationId: "55555555-5555-4555-8555-555555555555"
    });

    expect(result).toMatchObject({ id: "activity-1" });
    expect(mocks.mutationReceiptCreate).not.toHaveBeenCalled();
    expect(mocks.writeAudit).not.toHaveBeenCalled();
    expect(mocks.webhookCreateMany).not.toHaveBeenCalled();
  });

  it("returns stale revision when a losing activity-delete claim has no matching receipt winner", async () => {
    mocks.activityUpdateMany.mockResolvedValue({ count: 0 });

    await expect((deleteActivity as unknown as (id: string, raw: unknown) => Promise<unknown>)("activity-1", {
      clientMutationId: "55555555-5555-4555-8555-555555555555"
    })).rejects.toThrow("stale_revision");

    expect(mocks.mutationReceiptCreate).not.toHaveBeenCalled();
    expect(mocks.writeAudit).not.toHaveBeenCalled();
    expect(mocks.webhookCreateMany).not.toHaveBeenCalled();
  });

  it("returns the matching receipt winner after an activity-delete receipt uniqueness race", async () => {
    const receipt = {
      householdId: "household-1",
      actorMemberId: "member-current",
      operation: "activity.delete",
      targetActivityId: "activity-1",
      clientMutationId: "55555555-5555-4555-8555-555555555555",
      intentFingerprint: "5410baf832f94d84c5511e6e28a4520a51d684c0430ea656fc2b3d077a5d95b1",
      outcomeActivityId: "activity-1"
    };
    mocks.mutationReceiptFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce(receipt);
    mocks.mutationReceiptCreate.mockRejectedValue({ code: "P2002", meta: { target: ["householdId", "clientMutationId"] } });

    const result = await (deleteActivity as unknown as (id: string, raw: unknown) => Promise<{ id: string }>)("activity-1", {
      clientMutationId: "55555555-5555-4555-8555-555555555555"
    });

    expect(result).toMatchObject({ id: "activity-1" });
    expect(mocks.writeAudit).not.toHaveBeenCalled();
    expect(mocks.webhookCreateMany).not.toHaveBeenCalled();
  });

  it("rechecks a matching activity-delete receipt after the mutation actor lock", async () => {
    const receipt = {
      householdId: "household-1",
      actorMemberId: "member-current",
      operation: "activity.delete",
      targetActivityId: "activity-1",
      clientMutationId: "55555555-5555-4555-8555-555555555555",
      intentFingerprint: "5410baf832f94d84c5511e6e28a4520a51d684c0430ea656fc2b3d077a5d95b1",
      outcomeActivityId: "activity-1"
    };
    mocks.mutationReceiptFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(receipt);

    const replay = await (deleteActivity as unknown as (id: string, raw: unknown) => Promise<{ id: string }>)("activity-1", {
      clientMutationId: "55555555-5555-4555-8555-555555555555"
    });

    expect(replay).toMatchObject({ id: "activity-1" });
    expect(mocks.activityUpdateMany).not.toHaveBeenCalled();
    expect(mocks.mutationReceiptCreate).not.toHaveBeenCalled();
    expect(mocks.writeAudit).not.toHaveBeenCalled();
  });

  it("reauthorizes delete permission inside the mutation transaction", async () => {
    mocks.memberFindUnique.mockResolvedValue({
      id: "member-current",
      householdId: "household-1",
      role: "read_only",
      disabledAt: null,
      deletedAt: null
    });

    await expect(deleteActivity("activity-1")).rejects.toThrow("forbidden");

    expect(mocks.activityUpdateMany).not.toHaveBeenCalled();
    expect(mocks.mutationReceiptCreate).not.toHaveBeenCalled();
    expect(mocks.writeAudit).not.toHaveBeenCalled();
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

  it("persists a durable activity-undo receipt in the mutation transaction", async () => {
    mocks.activityFindFirst.mockResolvedValue(activity("member-current"));

    await (undoLastActivity as unknown as (raw: unknown) => Promise<unknown>)({
      clientMutationId: "44444444-4444-4444-8444-444444444444"
    });

    expect(mocks.mutationReceiptCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        householdId: "household-1",
        actorMemberId: "member-current",
        apiKeyId: null,
        operation: "activity.undo",
        targetActivityId: "activity-1",
        clientMutationId: "44444444-4444-4444-8444-444444444444",
        intentFingerprint: "07991d35845b92b2f8479e0f70aa8e52ffd2a9f78756b600796cda1d9e050e1f",
        outcomeActivityId: "activity-1"
      })
    });
    expect(mocks.writeAudit).toHaveBeenCalledTimes(1);
  });

  it("replays the immutable delete direction after an undone create is restored again", async () => {
    mocks.mutationReceiptFindFirst.mockResolvedValue({
      householdId: "household-1",
      actorMemberId: "member-current",
      operation: "activity.undo",
      targetActivityId: "activity-1",
      clientMutationId: "44444444-4444-4444-8444-444444444444",
      intentFingerprint: "07991d35845b92b2f8479e0f70aa8e52ffd2a9f78756b600796cda1d9e050e1f",
      outcomeActivityId: "activity-1"
    });

    await expect(undoLastActivity({ clientMutationId: "44444444-4444-4444-8444-444444444444" })).resolves.toEqual({
      id: "activity-1"
    });

    expect(mocks.activityUpdateMany).not.toHaveBeenCalled();
    expect(mocks.mutationReceiptCreate).not.toHaveBeenCalled();
    expect(mocks.writeAudit).not.toHaveBeenCalled();
  });

  it("replays the immutable update direction after a restored activity is deleted again", async () => {
    mocks.mutationReceiptFindFirst.mockResolvedValue({
      householdId: "household-1",
      actorMemberId: "member-current",
      operation: "activity.undo",
      targetActivityId: "activity-1",
      clientMutationId: "44444444-4444-4444-8444-444444444444",
      intentFingerprint: "d4f846e74d20a5a02606770e683f984f28273c8a40046df0d23aeeab205fdc0e",
      outcomeActivityId: "activity-1"
    });
    mocks.activityFindFirst.mockResolvedValue({ ...activity("member-current"), deletedAt: new Date("2026-07-14T10:05:00.000Z") });

    await expect(undoLastActivity({ clientMutationId: "44444444-4444-4444-8444-444444444444" })).resolves.toEqual({
      id: "activity-1"
    });

    expect(mocks.activityUpdateMany).not.toHaveBeenCalled();
    expect(mocks.writeAudit).not.toHaveBeenCalled();
  });

  it("locks and rereads the receipt activity before authorizing replay", async () => {
    mocks.mutationReceiptFindFirst.mockResolvedValue({
      householdId: "household-1",
      actorMemberId: "member-current",
      operation: "activity.undo",
      targetActivityId: "activity-1",
      clientMutationId: "44444444-4444-4444-8444-444444444444",
      intentFingerprint: "07991d35845b92b2f8479e0f70aa8e52ffd2a9f78756b600796cda1d9e050e1f",
      outcomeActivityId: "activity-1"
    });
    mocks.activityFindFirst.mockResolvedValue(activity("member-current"));

    await undoLastActivity({ clientMutationId: "44444444-4444-4444-8444-444444444444" });

    expect(mocks.activityLock).toHaveBeenCalledTimes(3);
    expect(mocks.activityFindFirst).toHaveBeenCalledTimes(2);
  });

  it("rechecks a matching receipt after the mutation actor lock before resolving latest", async () => {
    const receipt = {
      householdId: "household-1",
      actorMemberId: "member-current",
      operation: "activity.undo",
      targetActivityId: "activity-1",
      clientMutationId: "44444444-4444-4444-8444-444444444444",
      intentFingerprint: "07991d35845b92b2f8479e0f70aa8e52ffd2a9f78756b600796cda1d9e050e1f",
      outcomeActivityId: "activity-1"
    };
    mocks.mutationReceiptFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(receipt);
    mocks.activityFindFirst.mockResolvedValue(activity("member-current"));

    await expect(undoLastActivity({ clientMutationId: receipt.clientMutationId })).resolves.toEqual({ id: "activity-1" });

    expect(mocks.auditFindFirst).not.toHaveBeenCalled();
    expect(mocks.activityUpdateMany).not.toHaveBeenCalled();
    expect(mocks.writeAudit).not.toHaveBeenCalled();
  });

  it("reauthorizes the actor before replaying an activity-undo receipt", async () => {
    mocks.getHouseholdContext.mockResolvedValue(context("read_only"));
    mocks.memberFindUnique.mockResolvedValue({
      id: "member-current",
      householdId: "household-1",
      role: "read_only",
      disabledAt: null,
      deletedAt: null
    });
    mocks.mutationReceiptFindFirst.mockResolvedValue({
      householdId: "household-1",
      actorMemberId: "member-current",
      operation: "activity.undo",
      targetActivityId: "activity-1",
      clientMutationId: "44444444-4444-4444-8444-444444444444",
      intentFingerprint: "07991d35845b92b2f8479e0f70aa8e52ffd2a9f78756b600796cda1d9e050e1f",
      outcomeActivityId: "activity-1"
    });
    mocks.activityFindFirst.mockResolvedValue(activity("member-current"));

    await expect(undoLastActivity({ clientMutationId: "44444444-4444-4444-8444-444444444444" })).rejects.toThrow(
      "forbidden"
    );
    expect(mocks.activityUpdateMany).not.toHaveBeenCalled();
  });

  it("rejects an activity-undo retry when its mutation ID belongs to another operation", async () => {
    mocks.mutationReceiptFindFirst.mockResolvedValue({
      householdId: "household-1",
      actorMemberId: "member-current",
      operation: "timer.stop",
      targetActivityId: "activity-1",
      clientMutationId: "44444444-4444-4444-8444-444444444444",
      intentFingerprint: "07991d35845b92b2f8479e0f70aa8e52ffd2a9f78756b600796cda1d9e050e1f",
      outcomeActivityId: "activity-1"
    });

    await expect(undoLastActivity({ clientMutationId: "44444444-4444-4444-8444-444444444444" })).rejects.toThrow(
      "idempotency_conflict"
    );
    expect(mocks.activityUpdateMany).not.toHaveBeenCalled();
  });

  it("replays the matching winner after a same-key activity-undo claim race", async () => {
    const receipt = {
      householdId: "household-1",
      actorMemberId: "member-current",
      operation: "activity.undo",
      targetActivityId: "activity-1",
      clientMutationId: "44444444-4444-4444-8444-444444444444",
      intentFingerprint: "07991d35845b92b2f8479e0f70aa8e52ffd2a9f78756b600796cda1d9e050e1f",
      outcomeActivityId: "activity-1"
    };
    mocks.mutationReceiptFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce(receipt);
    mocks.activityFindFirst.mockResolvedValue(activity("member-current"));
    mocks.activityUpdateMany.mockResolvedValue({ count: 0 });

    await expect(undoLastActivity({ clientMutationId: receipt.clientMutationId })).resolves.toEqual({ id: "activity-1" });

    expect(mocks.mutationReceiptCreate).not.toHaveBeenCalled();
    expect(mocks.writeAudit).not.toHaveBeenCalled();
  });

  it("replays the matching winner after an activity-undo receipt uniqueness race", async () => {
    const receipt = {
      householdId: "household-1",
      actorMemberId: "member-current",
      operation: "activity.undo",
      targetActivityId: "activity-1",
      clientMutationId: "44444444-4444-4444-8444-444444444444",
      intentFingerprint: "07991d35845b92b2f8479e0f70aa8e52ffd2a9f78756b600796cda1d9e050e1f",
      outcomeActivityId: "activity-1"
    };
    mocks.mutationReceiptFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce(receipt);
    mocks.activityFindFirst.mockResolvedValue(activity("member-current"));
    mocks.mutationReceiptCreate.mockRejectedValueOnce({
      code: "P2002",
      meta: { target: ["householdId", "clientMutationId"] }
    });

    await expect(undoLastActivity({ clientMutationId: receipt.clientMutationId })).resolves.toEqual({ id: "activity-1" });

    expect(mocks.writeAudit).not.toHaveBeenCalled();
  });

  it("clears deletion attribution when undo restores a deleted activity", async () => {
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
    mocks.activityFindFirst.mockResolvedValue({ ...activity("member-current"), deletedAt });

    await undoLastActivity();

    expect(mocks.activityUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { deletedAt: null, deletedByMemberId: null } })
    );
    expect(mocks.mutationReceiptCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        intentFingerprint: "d4f846e74d20a5a02606770e683f984f28273c8a40046df0d23aeeab205fdc0e"
      })
    });
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

    expect(mocks.activityLock).toHaveBeenCalledTimes(4);
    expect(mocks.activityLock.mock.invocationCallOrder[3]).toBeLessThan(mocks.auditFindFirst.mock.invocationCallOrder[1]);
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

  it("persists a durable receipt with a timer-pause outcome before returning", async () => {
    mocks.activityFindFirst.mockResolvedValue({
      ...activity("member-author"),
      timerState: "running",
      startedAt: new Date("2026-07-14T11:00:00.000Z")
    });

    await (pauseTimer as unknown as (id: string, raw: unknown) => Promise<unknown>)("activity-1", {
      clientMutationId: "22222222-2222-4222-8222-222222222222"
    });

    expect(mocks.mutationReceiptCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          householdId: "household-1",
          actorMemberId: "member-current",
          operation: "timer.pause",
          targetActivityId: "activity-1",
          clientMutationId: "22222222-2222-4222-8222-222222222222",
          outcomeActivityId: "activity-1"
        })
      })
    );
  });

  it("persists a durable receipt with a timer-resume outcome before returning", async () => {
    mocks.activityFindFirst.mockResolvedValue({
      ...activity("member-author"),
      timerState: "paused",
      pausedAt: new Date("2026-07-14T11:15:00.000Z")
    });

    await (resumeTimer as unknown as (id: string, raw: unknown) => Promise<unknown>)("activity-1", {
      clientMutationId: "33333333-3333-4333-8333-333333333333"
    });

    expect(mocks.mutationReceiptCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ operation: "timer.resume", clientMutationId: "33333333-3333-4333-8333-333333333333" }) })
    );
  });

  it("replays a matching timer-pause receipt without repeating its audit", async () => {
    const outcome = { ...activity("member-author"), id: "activity-1", timerState: "paused" };
    mocks.mutationReceiptFindFirst.mockResolvedValue({
      householdId: "household-1", actorMemberId: "member-current", operation: "timer.pause", targetActivityId: "activity-1",
      clientMutationId: "22222222-2222-4222-8222-222222222222", intentFingerprint: "848dfa4672b3a388436481ce3947f82e4f545278f730a4e7b764d92441b44992", outcomeActivityId: "activity-1"
    });
    mocks.activityFindFirst.mockResolvedValue(outcome);

    await expect((pauseTimer as unknown as (id: string, raw: unknown) => Promise<unknown>)("activity-1", {
      clientMutationId: "22222222-2222-4222-8222-222222222222"
    })).resolves.toEqual(outcome);

    expect(mocks.activityUpdateMany).not.toHaveBeenCalled();
    expect(mocks.mutationReceiptCreate).not.toHaveBeenCalled();
    expect(mocks.writeAudit).not.toHaveBeenCalled();
  });

  it("replays a persisted timer outcome after the activity is later soft-deleted", async () => {
    const snapshot = { ...activity("member-author"), id: "activity-1", timerState: "paused", deletedAt: null, updatedAt: "2026-07-14T10:00:00.000Z" };
    mocks.mutationReceiptFindFirst.mockResolvedValue({
      householdId: "household-1", actorMemberId: "member-current", operation: "timer.pause", targetActivityId: "activity-1",
      clientMutationId: "22222222-2222-4222-8222-222222222222", intentFingerprint: "848dfa4672b3a388436481ce3947f82e4f545278f730a4e7b764d92441b44992", outcomeActivityId: "activity-1", outcomeSnapshot: snapshot
    });
    mocks.activityFindFirst.mockResolvedValue({ ...snapshot, deletedAt: new Date("2026-07-14T12:00:00.000Z") });

    await expect((pauseTimer as unknown as (id: string, raw: unknown) => Promise<unknown>)("activity-1", {
      clientMutationId: "22222222-2222-4222-8222-222222222222"
    })).resolves.toEqual(snapshot);

    expect(mocks.activityFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "activity-1", householdId: "household-1" }
    }));
    expect(mocks.activityUpdateMany).not.toHaveBeenCalled();
    expect(mocks.writeAudit).not.toHaveBeenCalled();
  });

  it("replays the winner after a same-key timer-pause claim loses its revision race", async () => {
    const outcome = { ...activity("member-author"), id: "activity-1", timerState: "paused" };
    mocks.mutationReceiptFindFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        householdId: "household-1", actorMemberId: "member-current", operation: "timer.pause", targetActivityId: "activity-1",
        clientMutationId: "22222222-2222-4222-8222-222222222222", intentFingerprint: "848dfa4672b3a388436481ce3947f82e4f545278f730a4e7b764d92441b44992", outcomeActivityId: "activity-1"
      });
    mocks.activityFindFirst
      .mockResolvedValueOnce({ ...outcome, timerState: "running", startedAt: new Date("2026-07-14T11:00:00.000Z") })
      .mockResolvedValueOnce(outcome);
    mocks.activityUpdateMany.mockResolvedValue({ count: 0 });

    await expect((pauseTimer as unknown as (id: string, raw: unknown) => Promise<unknown>)("activity-1", {
      clientMutationId: "22222222-2222-4222-8222-222222222222"
    })).resolves.toEqual(outcome);
    expect(mocks.mutationReceiptCreate).not.toHaveBeenCalled();
    expect(mocks.writeAudit).not.toHaveBeenCalled();
  });

  it("replays the winner after a same-key timer-resume claim loses its revision race", async () => {
    const outcome = { ...activity("member-author"), id: "activity-1", timerState: "running" };
    mocks.mutationReceiptFindFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        householdId: "household-1", actorMemberId: "member-current", operation: "timer.resume", targetActivityId: "activity-1",
        clientMutationId: "33333333-3333-4333-8333-333333333333", intentFingerprint: "ebd4d64837b5b1f1cd538646dc8eb2ab73380fe49a947cf61fb49ba920401ec4", outcomeActivityId: "activity-1"
      });
    mocks.activityFindFirst
      .mockResolvedValueOnce({ ...outcome, timerState: "paused", pausedAt: new Date("2026-07-14T11:15:00.000Z") })
      .mockResolvedValueOnce(outcome);
    mocks.activityUpdateMany.mockResolvedValue({ count: 0 });

    await expect((resumeTimer as unknown as (id: string, raw: unknown) => Promise<unknown>)("activity-1", {
      clientMutationId: "33333333-3333-4333-8333-333333333333"
    })).resolves.toEqual(outcome);
    expect(mocks.mutationReceiptCreate).not.toHaveBeenCalled();
    expect(mocks.writeAudit).not.toHaveBeenCalled();
  });

  it("rejects a timer-pause retry when its mutation ID belongs to another operation", async () => {
    mocks.mutationReceiptFindFirst.mockResolvedValue({
      householdId: "household-1", actorMemberId: "member-current", operation: "timer.stop", targetActivityId: "activity-1",
      clientMutationId: "22222222-2222-4222-8222-222222222222", intentFingerprint: "eec91cbb8fef2770e0b696a32f25051436c46caabb2be913a1053397fc34beb2", outcomeActivityId: "activity-1"
    });

    await expect((pauseTimer as unknown as (id: string, raw: unknown) => Promise<unknown>)("activity-1", {
      clientMutationId: "22222222-2222-4222-8222-222222222222"
    })).rejects.toThrow("idempotency_conflict");
    expect(mocks.activityUpdateMany).not.toHaveBeenCalled();
    expect(mocks.writeAudit).not.toHaveBeenCalled();
  });

  it("persists a durable receipt with a timer-stop outcome before returning", async () => {
    mocks.mutationReceiptFindFirst.mockReset();
    mocks.mutationReceiptFindFirst.mockResolvedValue(null);
    mocks.activityFindFirst.mockResolvedValue({
      ...activity("member-author"),
      timerState: "running",
      startedAt: new Date("2026-07-14T11:00:00.000Z")
    });

    await (stopTimer as unknown as (id: string, raw: unknown) => Promise<unknown>)("activity-1", {
      clientMutationId: "11111111-1111-4111-8111-111111111111"
    });

    expect(mocks.mutationReceiptCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          householdId: "household-1",
          actorMemberId: "member-current",
          operation: "timer.stop",
          targetActivityId: "activity-1",
          clientMutationId: "11111111-1111-4111-8111-111111111111",
          outcomeActivityId: "activity-1"
        })
      })
    );
  });

  it("replays a matching timer-stop receipt without repeating its side effects", async () => {
    const outcome = { ...activity("member-author"), id: "activity-1", timerState: "stopped" };
    mocks.mutationReceiptFindFirst.mockResolvedValue({
      householdId: "household-1",
      actorMemberId: "member-current",
      operation: "timer.stop",
      targetActivityId: "activity-1",
      clientMutationId: "11111111-1111-4111-8111-111111111111",
      intentFingerprint: "eec91cbb8fef2770e0b696a32f25051436c46caabb2be913a1053397fc34beb2",
      outcomeActivityId: "activity-1"
    });
    mocks.activityFindFirst.mockResolvedValue(outcome);

    await expect((stopTimer as unknown as (id: string, raw: unknown) => Promise<unknown>)("activity-1", {
      clientMutationId: "11111111-1111-4111-8111-111111111111"
    })).resolves.toEqual(outcome);

    expect(mocks.activityUpdateMany).not.toHaveBeenCalled();
    expect(mocks.mutationReceiptCreate).not.toHaveBeenCalled();
    expect(mocks.writeAudit).not.toHaveBeenCalled();
  });

  it("rejects a timer-stop retry when its mutation ID belongs to another operation", async () => {
    mocks.mutationReceiptFindFirst.mockResolvedValue({
      householdId: "household-1",
      actorMemberId: "member-current",
      operation: "timer.pause",
      targetActivityId: "activity-1",
      clientMutationId: "11111111-1111-4111-8111-111111111111",
      intentFingerprint: "eec91cbb8fef2770e0b696a32f25051436c46caabb2be913a1053397fc34beb2",
      outcomeActivityId: "activity-1"
    });

    await expect((stopTimer as unknown as (id: string, raw: unknown) => Promise<unknown>)("activity-1", {
      clientMutationId: "11111111-1111-4111-8111-111111111111"
    })).rejects.toThrow("idempotency_conflict");

    expect(mocks.activityUpdateMany).not.toHaveBeenCalled();
    expect(mocks.writeAudit).not.toHaveBeenCalled();
  });

  it("recovers a concurrent timer-stop receipt winner after the receipt unique race", async () => {
    const outcome = { ...activity("member-author"), id: "activity-1", timerState: "stopped" };
    mocks.mutationReceiptFindFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        householdId: "household-1",
        actorMemberId: "member-current",
        operation: "timer.stop",
        targetActivityId: "activity-1",
        clientMutationId: "11111111-1111-4111-8111-111111111111",
        intentFingerprint: "eec91cbb8fef2770e0b696a32f25051436c46caabb2be913a1053397fc34beb2",
        outcomeActivityId: "activity-1"
      });
    mocks.activityFindFirst
      .mockResolvedValueOnce({ ...outcome, timerState: "running", startedAt: new Date("2026-07-14T11:00:00.000Z") })
      .mockResolvedValueOnce(outcome)
      .mockResolvedValueOnce(outcome);
    mocks.mutationReceiptCreate.mockRejectedValueOnce({ code: "P2002", meta: { target: ["householdId", "clientMutationId"] } });

    await expect((stopTimer as unknown as (id: string, raw: unknown) => Promise<unknown>)("activity-1", {
      clientMutationId: "11111111-1111-4111-8111-111111111111"
    })).resolves.toEqual(outcome);
    expect(mocks.writeAudit).not.toHaveBeenCalled();
  });

  it("replays the winner after a same-key timer-stop claim loses its revision race", async () => {
    const outcome = { ...activity("member-author"), id: "activity-1", timerState: "stopped" };
    mocks.mutationReceiptFindFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        householdId: "household-1", actorMemberId: "member-current", operation: "timer.stop", targetActivityId: "activity-1",
        clientMutationId: "11111111-1111-4111-8111-111111111111", intentFingerprint: "eec91cbb8fef2770e0b696a32f25051436c46caabb2be913a1053397fc34beb2", outcomeActivityId: "activity-1"
      });
    mocks.activityFindFirst
      .mockResolvedValueOnce({ ...outcome, timerState: "running", startedAt: new Date("2026-07-14T11:00:00.000Z") })
      .mockResolvedValueOnce(outcome);
    mocks.activityUpdateMany.mockResolvedValue({ count: 0 });

    await expect((stopTimer as unknown as (id: string, raw: unknown) => Promise<unknown>)("activity-1", {
      clientMutationId: "11111111-1111-4111-8111-111111111111"
    })).resolves.toEqual(outcome);
    expect(mocks.mutationReceiptCreate).not.toHaveBeenCalled();
    expect(mocks.writeAudit).not.toHaveBeenCalled();
  });

  it("preserves a generated legacy timer-stop mutation ID while recovering a receipt race", async () => {
    const outcome = { ...activity("member-author"), id: "activity-1", timerState: "stopped" };
    let receiptLookupCount = 0;
    mocks.mutationReceiptFindFirst.mockImplementation(async ({ where }) => {
      receiptLookupCount += 1;
      if (receiptLookupCount === 1) return null;
      return {
        householdId: "household-1", actorMemberId: "member-current", operation: "timer.stop", targetActivityId: "activity-1",
        clientMutationId: where.clientMutationId, intentFingerprint: "eec91cbb8fef2770e0b696a32f25051436c46caabb2be913a1053397fc34beb2", outcomeActivityId: "activity-1"
      };
    });
    mocks.activityFindFirst
      .mockResolvedValueOnce({ ...outcome, timerState: "running", startedAt: new Date("2026-07-14T11:00:00.000Z") })
      .mockResolvedValueOnce(outcome)
      .mockResolvedValueOnce(outcome);
    mocks.mutationReceiptCreate.mockRejectedValueOnce({ code: "P2002", meta: { target: ["householdId", "clientMutationId"] } });

    await expect(stopTimer("activity-1")).resolves.toEqual(outcome);
    expect(mocks.mutationReceiptFindFirst).toHaveBeenCalledTimes(2);
  });

  it("reports a stale revision when a concurrent timer pause wins the conditional claim", async () => {
    mocks.activityFindFirst.mockReset();
    mocks.mutationReceiptFindFirst.mockReset();
    mocks.mutationReceiptFindFirst.mockResolvedValue(null);
    mocks.activityFindFirst.mockResolvedValue({
      ...activity("member-author"),
      timerState: "running",
      startedAt: new Date("2026-07-14T11:00:00.000Z")
    });
    mocks.activityUpdateMany.mockResolvedValueOnce({ count: 0 });

    await expect(pauseTimer("activity-1")).rejects.toThrow("stale_revision");

    expect(mocks.writeAudit).not.toHaveBeenCalled();
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
    mutationReceipt: { findFirst: mocks.mutationReceiptFindFirst, create: mocks.mutationReceiptCreate },
    webhookEndpoint: { findMany: mocks.webhookFindMany },
    webhookDelivery: { createMany: mocks.webhookCreateMany },
    notificationPreference: { findMany: mocks.notificationFindMany },
    notificationLog: { createMany: mocks.notificationCreateMany },
    contact: { findFirst: mocks.contactFindFirst },
    householdMember: { findUnique: mocks.memberFindUnique },
    apiKey: { findFirst: mocks.apiKeyFindFirst },
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
    clientMutationId: "018f2b6c-8f5f-7e0b-8c3f-9f42c0a64005",
    babyId: "baby-1",
    occurredAt: "2026-07-14T12:00:00.000Z",
    expectedUpdatedAt: "2026-07-14T10:00:00.000Z",
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

function mockActivityRead(value: unknown) {
  mocks.activityFindFirst.mockImplementation(({ where }) =>
    Promise.resolve("clientMutationId" in where ? null : value)
  );
}
