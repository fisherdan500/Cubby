import { beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserOperationKey } from "@prisma/client";

const mocks = vi.hoisted(() => ({
  getBabyContext: vi.fn(),
  getHouseholdContext: vi.fn(),
  issueBrowser: vi.fn(),
  issueHousehold: vi.fn(),
  executeBrowser: vi.fn(),
  executeHousehold: vi.fn(),
  auditFindFirst: vi.fn(),
  writeAudit: vi.fn(),
  pauseIntervalCreate: vi.fn(),
  pauseIntervalCloseQuery: vi.fn()
}));

vi.mock("@/server/services/browser-operations", () => ({
  getBrowserOperationContextForBaby: mocks.getBabyContext,
  getBrowserOperationContextForHousehold: mocks.getHouseholdContext,
  issueBrowserOperation: mocks.issueBrowser,
  issueHouseholdBrowserOperation: mocks.issueHousehold,
  executeBrowserOperation: mocks.executeBrowser,
  executeHouseholdBrowserOperation: mocks.executeHousehold
}));
vi.mock("@/lib/db/prisma", () => ({ prisma: { auditEvent: { findFirst: mocks.auditFindFirst } } }));
vi.mock("@/server/services/audit", () => ({ writeAudit: mocks.writeAudit }));

import {
  issueActivityCreateBrowserOperation,
  issueActivityDeleteBrowserOperation,
  issueActivityTimerBrowserOperation,
  issueActivityUndoLastBrowserOperation,
  issueActivityUpdateBrowserOperation,
  submitActivityTimerBrowserOperation,
  submitActivityUndoLastBrowserOperation
} from "./activities";

const operationId = "bmo_0123456789abcdefghjkmnpqrs";
const ctx = { userId: "user-1", sessionId: "session-1", householdId: "household-1", memberId: "member-1", role: "parent" };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getBabyContext.mockResolvedValue(ctx);
  mocks.getHouseholdContext.mockResolvedValue(ctx);
  mocks.issueBrowser.mockResolvedValue({ status: "open", operationId, bindingId: "binding-1" });
  mocks.issueHousehold.mockResolvedValue({ status: "open", operationId, bindingId: "binding-1" });
  mocks.auditFindFirst.mockResolvedValue({ id: "audit-1", entityId: "activity-1" });
  mocks.pauseIntervalCreate.mockResolvedValue({ id: "pause-1" });
  mocks.pauseIntervalCloseQuery.mockResolvedValue([{ closeActivityTimerPauseInterval: null }]);
});

describe("activity browser-v2 opening bindings", () => {
  it("opens create against the selected baby without carrying editable activity payload", async () => {
    await expect(issueActivityCreateBrowserOperation({ operationId, babyId: "baby-1", type: "feeding", notes: "editable" })).resolves.toMatchObject({ status: "open" });

    expect(mocks.issueBrowser).toHaveBeenCalledWith(expect.objectContaining({
      ctx,
      operationId,
      operationKey: BrowserOperationKey.activityCreate,
      babyId: "baby-1",
      targetKind: "baby",
      targetId: "baby-1",
      opening: { babyId: "baby-1" }
    }));
  });

  it("opens update with immutable source and replacement-baby scope rather than a mutable update payload", async () => {
    await expect(issueActivityUpdateBrowserOperation({ operationId, activityId: "activity-1", babyId: "baby-2", expectedUpdatedAt: "2026-08-17T12:00:00.000Z", notes: "editable" })).resolves.toMatchObject({ status: "open" });

    expect(mocks.issueHousehold).toHaveBeenCalledWith(expect.objectContaining({
      ctx,
      operationId,
      operationKey: BrowserOperationKey.activityUpdate,
      targetKind: "activity",
      targetId: "activity-1"
    }));
    expect(mocks.issueHousehold.mock.calls[0]?.[0].targetSnapshot).toBeTypeOf("function");
  });

  it("locks source and replacement babies in canonical order before the activity row", async () => {
    await issueActivityUpdateBrowserOperation({ operationId, activityId: "activity-1", babyId: "baby-2" });
    const targetSnapshot = mocks.issueHousehold.mock.calls[0]?.[0].targetSnapshot as (tx: unknown, ctx: unknown) => Promise<unknown>;
    const lockOrder: string[] = [];
    const activity = { id: "activity-1", babyId: "baby-1", updatedAt: new Date("2026-08-17T12:00:00Z"), deletedAt: null, timerState: "none", actorMemberId: "member-1" };
    await targetSnapshot({
      $queryRaw: (parts: TemplateStringsArray) => {
        const query = String(parts);
        lockOrder.push(query.includes('FROM "Baby"') ? "baby" : query.includes('FROM "ActivityLog"') ? "activity" : "other");
        return Promise.resolve([{ id: "locked" }]);
      },
      activityLog: { findFirst: vi.fn().mockResolvedValue(activity) },
      baby: { findFirst: vi.fn(({ where }) => Promise.resolve({ id: where.id, updatedAt: new Date("2026-08-17T12:00:00Z"), inactiveAt: null })) }
    }, ctx);
    expect(lockOrder).toEqual(["baby", "baby", "activity"]);
  });

  it.each([
    ["delete", issueActivityDeleteBrowserOperation, BrowserOperationKey.activityDelete],
    ["undo", issueActivityUndoLastBrowserOperation, BrowserOperationKey.activityUndoLast],
    ["pause", (raw: Record<string, unknown>) => issueActivityTimerBrowserOperation("pause", raw), BrowserOperationKey.activityTimerPause],
    ["resume", (raw: Record<string, unknown>) => issueActivityTimerBrowserOperation("resume", raw), BrowserOperationKey.activityTimerResume],
    ["stop", (raw: Record<string, unknown>) => issueActivityTimerBrowserOperation("stop", raw), BrowserOperationKey.activityTimerStop]
  ] as const)("opens %s with a browser-v2 binding", async (_name, issue, operationKey) => {
    const raw = _name === "undo" ? { operationId } : { operationId, activityId: "activity-1" };
    await expect(issue(raw)).resolves.toMatchObject({ status: "open" });
    expect(mocks.issueHousehold).toHaveBeenCalledWith(expect.objectContaining({ ctx, operationId, operationKey }));
  });

  it("refuses an undo pinned to one entry once the member's latest change is a different one", async () => {
    // The Undo offered after a save names that entry. If anything else became the member's latest
    // add or delete in between, undoing "the latest" would take back the wrong thing.
    mocks.executeHousehold.mockImplementation((contract) =>
      contract.validate({}, ctx, { targetSnapshot: { latest: { id: "audit-2", entityId: "activity-2", action: "activity.create" } } })
    );

    await expect(submitActivityUndoLastBrowserOperation({ operationId, activityId: "activity-9" })).rejects.toThrow("not_found");
    expect(mocks.executeHousehold).toHaveBeenCalledWith(expect.objectContaining({ targetId: "activity-9", intent: { activityId: "activity-9" } }));
  });
});

describe("browser Undo superseding changes", () => {
  const createdAt = new Date("2026-08-17T12:00:00.000Z");
  function undoFixture(supersedingAt: Date | null) {
    const activity = timerActivity("running");
    if (!supersedingAt) activity.updatedAt = createdAt;
    const tx = timerTransaction(activity);
    const latest = { id: "audit-1", entityId: activity.id, action: "activity.create", createdAt, after: { updatedAt: createdAt.toISOString(), deletedAt: null } };
    const auditFindFirst = vi.fn(async ({ where }) => {
      if (where.actorMemberId) return latest;
      expect(where).toEqual({ householdId: ctx.householdId, entityType: "activity", entityId: activity.id, createdAt: { gte: createdAt }, id: { not: latest.id } });
      // An update by a different caregiver; equal-time lower IDs must also block.
      return supersedingAt && supersedingAt >= where.createdAt.gte ? { id: "audit-0", action: "activity.update", actorMemberId: "other-member" } : null;
    });
    return { activity, latest, tx: { ...tx, auditEvent: { findFirst: auditFindFirst } } };
  }

  it.each(["later", "equal"])("refuses a %s-time edit already present before Undo issue", async (timing) => {
    const { activity, tx } = undoFixture(new Date(createdAt.getTime() + (timing === "later" ? 1000 : 0)));
    mocks.issueHousehold.mockImplementation((contract) => contract.targetSnapshot(tx, ctx));
    await expect(issueActivityUndoLastBrowserOperation({ operationId })).rejects.toThrow("stale_revision");
    expect(tx.activityLog.updateMany).not.toHaveBeenCalled();
    expect(activity.deletedAt).toBeNull();
    expect(mocks.writeAudit).not.toHaveBeenCalled();
  });

  it.each(["validate", "execute"])("rejects a pre-issue edit through %s of an older binding", async (phase) => {
    const { activity, latest, tx } = undoFixture(createdAt);
    mocks.executeHousehold.mockImplementation((contract) => contract[phase](tx, ctx, {
      targetSnapshot: { latest: { ...latest, createdAt: createdAt.toISOString(), state: { updatedAt: createdAt, deletedAt: null } }, binding: timerSnapshot(activity) }
    }));
    await expect(submitActivityUndoLastBrowserOperation({ operationId, activityId: activity.id })).rejects.toThrow("stale_revision");
    expect(tx.activityLog.updateMany).not.toHaveBeenCalled();
    expect(mocks.writeAudit).not.toHaveBeenCalled();
  });

  it("still refuses a revision changed after issue without a superseding audit", async () => {
    const { activity, latest, tx } = undoFixture(null);
    const binding = timerSnapshot(activity);
    activity.updatedAt = new Date(activity.updatedAt.getTime() + 1000);
    mocks.executeHousehold.mockImplementation((contract) => contract.validate(tx, ctx, { targetSnapshot: { latest, binding } }));
    await expect(submitActivityUndoLastBrowserOperation({ operationId, activityId: activity.id })).rejects.toThrow("stale_revision");
    expect(tx.activityLog.updateMany).not.toHaveBeenCalled();
  });

  it("allows an unchanged original action to open and undo", async () => {
    const { activity, tx } = undoFixture(null);
    mocks.issueHousehold.mockImplementation((contract) => contract.targetSnapshot(tx, ctx));
    const snapshot = await issueActivityUndoLastBrowserOperation({ operationId });
    mocks.executeHousehold.mockImplementation(async (contract) => {
      const binding = { targetSnapshot: snapshot };
      await contract.validate(tx, ctx, binding);
      return contract.execute(tx, ctx, binding);
    });
    await expect(submitActivityUndoLastBrowserOperation({ operationId, activityId: activity.id })).resolves.toMatchObject({ action: "undo" });
    expect(tx.activityLog.updateMany).toHaveBeenCalledOnce();
    expect(mocks.writeAudit).toHaveBeenCalledOnce();
  });
});

describe("activity browser-v2 timer writes", () => {
  it("records an exact pause interval through the browser operation path", async () => {
    const pausedAt = new Date("2026-08-17T12:30:00.000Z");
    const before = timerActivity("running");
    const tx = timerTransaction(before);
    vi.useFakeTimers();
    vi.setSystemTime(pausedAt);
    mocks.executeHousehold.mockImplementation((contract) =>
      contract.execute(tx, ctx, { targetSnapshot: timerSnapshot(before) })
    );

    try {
      await submitActivityTimerBrowserOperation("pause", { operationId, activityId: "activity-1" });
    } finally {
      vi.useRealTimers();
    }

    expect(mocks.pauseIntervalCreate).toHaveBeenCalledWith({
      data: { activityId: "activity-1", startedAt: pausedAt }
    });
  });

  it.each(["resume", "stop"] as const)("closes the open pause interval when the browser path performs %s", async (operation) => {
    const endedAt = new Date("2026-08-17T12:45:00.000Z");
    const before = timerActivity("paused");
    const tx = timerTransaction(before);
    vi.useFakeTimers();
    vi.setSystemTime(endedAt);
    mocks.executeHousehold.mockImplementation((contract) =>
      contract.execute(tx, ctx, { targetSnapshot: timerSnapshot(before) })
    );

    try {
      await submitActivityTimerBrowserOperation(operation, { operationId, activityId: "activity-1" });
    } finally {
      vi.useRealTimers();
    }

    expect(mocks.pauseIntervalCloseQuery).toHaveBeenCalledTimes(1);
  });

  it("refuses a browser stop when a running timer has an impossible open pause interval", async () => {
    const before = timerActivity("running");
    const tx = timerTransaction(before, 1);
    mocks.executeHousehold.mockImplementation((contract) =>
      contract.execute(tx, ctx, { targetSnapshot: timerSnapshot(before) })
    );

    await expect(
      submitActivityTimerBrowserOperation("stop", { operationId, activityId: "activity-1" })
    ).rejects.toThrow("pause_interval_state_invalid");
  });
});

function timerActivity(timerState: "running" | "paused") {
  return {
    id: "activity-1",
    householdId: "household-1",
    babyId: "baby-1",
    actorMemberId: "member-1",
    type: "sleep",
    timerState,
    startedAt: new Date("2026-08-17T12:00:00.000Z"),
    endedAt: null,
    pausedAt: timerState === "paused" ? new Date("2026-08-17T12:15:00.000Z") : null,
    pausedSeconds: 0,
    updatedAt: new Date("2026-08-17T12:20:00.000Z"),
    deletedAt: null
  };
}

function timerSnapshot(activity: ReturnType<typeof timerActivity>) {
  return {
    activity: {
      id: activity.id,
      babyId: activity.babyId,
      updatedAt: activity.updatedAt.toISOString(),
      deletedAt: null,
      timerState: activity.timerState,
      actorMemberId: activity.actorMemberId
    },
    babies: []
  };
}

function timerTransaction(activity: ReturnType<typeof timerActivity>, openPauseCount = 0) {
  return {
    $queryRaw: (...args: unknown[]) => String(args[0]).includes("closeActivityTimerPauseInterval")
      ? mocks.pauseIntervalCloseQuery(...args)
      : Promise.resolve([{ id: "locked" }]),
    activityLog: {
      findFirst: vi.fn().mockResolvedValue(activity),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: vi.fn().mockResolvedValue(activity)
    },
    baby: {
      findFirst: vi.fn().mockResolvedValue({
        id: "baby-1",
        updatedAt: new Date("2026-08-17T12:00:00.000Z"),
        inactiveAt: null
      })
    },
    activityTimerPauseInterval: {
      create: mocks.pauseIntervalCreate,
      count: vi.fn().mockResolvedValue(openPauseCount)
    },
    webhookEndpoint: { findMany: vi.fn().mockResolvedValue([]) },
    notificationPreference: { findMany: vi.fn().mockResolvedValue([]) }
  };
}
