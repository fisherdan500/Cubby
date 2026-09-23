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
  submitActivityTimerBrowserOperation
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
