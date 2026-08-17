import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireFreshSession: vi.fn(),
  getEffectiveHouseholdContext: vi.fn(),
  requirePermission: vi.fn(),
  sessionFindFirst: vi.fn(),
  householdFindFirst: vi.fn(),
  babyFindFirst: vi.fn(),
  memberFindFirst: vi.fn(),
  bindingFindFirst: vi.fn(),
  bindingCreate: vi.fn(),
  bindingUpdate: vi.fn(),
  operationCreate: vi.fn(),
  operationUpdate: vi.fn(),
  transaction: vi.fn(),
  queryRaw: vi.fn()
}));

vi.mock("@/server/auth/session", () => ({ requireFreshSession: mocks.requireFreshSession }));
vi.mock("@/server/auth/context", () => ({
  getEffectiveHouseholdContext: mocks.getEffectiveHouseholdContext,
  requirePermission: mocks.requirePermission
}));
vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    session: { findFirst: mocks.sessionFindFirst },
    baby: { findFirst: mocks.babyFindFirst },
    householdMember: { findFirst: mocks.memberFindFirst },
    $transaction: mocks.transaction
  }
}));

import { BrowserOperationKey, BrowserOperationProtocolVersion, BrowserOperationTargetKind } from "@prisma/client";
import {
  assertBrowserOperationId,
  browserIntentFingerprint,
  browserOperationFailureResult,
  getBrowserOperationContextForBaby,
  getBrowserOperationContextForHousehold,
  issueBrowserOperation,
  issueHouseholdBrowserOperation,
  executeBrowserOperation,
  executeHouseholdBrowserOperation
} from "@/server/services/browser-operations";

const operationId = "bmo_0123456789abcdefghjkmnpqrs";
const ctx = {
  userId: "user-1",
  sessionId: "session-1",
  householdId: "household-1",
  memberId: "member-1",
  role: "parent" as const
};

function calendarOpeningFingerprint(opening: unknown) {
  return browserIntentFingerprint({
    version: 2,
    operationKey: BrowserOperationKey.calendarEventCreate,
    householdId: ctx.householdId,
    memberId: ctx.memberId,
    babyId: "baby-1",
    targetKind: BrowserOperationTargetKind.calendar,
    targetId: null,
    opening
  });
}

function calendarBinding(opening: unknown, overrides: Record<string, unknown> = {}) {
  return {
    id: "binding-1",
    householdId: ctx.householdId,
    operationId,
    sessionId: ctx.sessionId,
    actorUserId: ctx.userId,
    actorMemberId: ctx.memberId,
    operationKey: BrowserOperationKey.calendarEventCreate,
    legacyIntentFingerprint: null,
    openingFingerprint: calendarOpeningFingerprint(opening),
    persistenceVersion: 2,
    targetKind: BrowserOperationTargetKind.calendar,
    targetId: null,
    babyId: "baby-1",
    protocolVersion: BrowserOperationProtocolVersion.browserV2,
    state: "open",
    expiresAt: new Date(Date.now() + 60_000),
    operation: null,
    ...overrides
  };
}

function calendarOperation(opening: unknown, intent: unknown, overrides: Record<string, unknown> = {}) {
  const openingFingerprint = calendarOpeningFingerprint(opening);
  return {
    operationId,
    status: "pending",
    openingFingerprint,
    intentFingerprint: browserIntentFingerprint({ openingFingerprint, payload: intent }),
    outcomeCode: null,
    outcomeSnapshot: null,
    ...overrides
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireFreshSession.mockResolvedValue({ user: { id: "user-1" }, session: { id: "session-1" } });
  mocks.getEffectiveHouseholdContext.mockResolvedValue({ ...ctx, sessionId: undefined });
  mocks.sessionFindFirst.mockResolvedValue({ id: "session-1", userId: "user-1", expiresAt: new Date(Date.now() + 60_000) });
  mocks.householdFindFirst.mockResolvedValue({ id: "household-1", deletedAt: null });
  mocks.babyFindFirst.mockResolvedValue({ id: "baby-1", householdId: "household-1", inactiveAt: null });
  mocks.memberFindFirst.mockResolvedValue({ id: "member-1", householdId: "household-1", userId: "user-1", role: "parent" });
  mocks.bindingFindFirst.mockResolvedValue(null);
  mocks.bindingCreate.mockResolvedValue({ id: "binding-1" });
  mocks.bindingUpdate.mockResolvedValue({ id: "binding-1", state: "terminal" });
  mocks.operationCreate.mockResolvedValue({
    operationId,
    status: "pending",
    outcomeCode: null,
    outcomeSnapshot: null
  });
  mocks.operationUpdate.mockResolvedValue({
    operationId,
    status: "completed",
    outcomeCode: "ok",
    outcomeSnapshot: { operationId, kind: "calendar_event", code: "ok", eventId: "event-1" }
  });
  mocks.queryRaw.mockResolvedValue([{ id: "locked" }]);
  mocks.transaction.mockImplementation((callback) =>
    callback({
      $queryRaw: mocks.queryRaw,
      session: { findFirst: mocks.sessionFindFirst },
      household: { findFirst: mocks.householdFindFirst },
      baby: { findFirst: mocks.babyFindFirst },
      householdMember: { findFirst: mocks.memberFindFirst },
      browserOperationBinding: { findFirst: mocks.bindingFindFirst, create: mocks.bindingCreate, update: mocks.bindingUpdate },
      browserMutationOperation: { create: mocks.operationCreate, update: mocks.operationUpdate }
    })
  );
});

describe("browser operation bindings", () => {
  it("binds a selected household settings target without a dummy baby", async () => {
    await expect(getBrowserOperationContextForHousehold()).resolves.toEqual(ctx);
    const targetSnapshot = vi.fn().mockResolvedValue({ settingsState: "absent", updatedAt: null, schemaVersion: 1 });

    await expect(issueHouseholdBrowserOperation({
      ctx,
      operationId,
      operationKey: BrowserOperationKey.householdAccentUpdate,
      targetKind: BrowserOperationTargetKind.settings,
      permission: "household.manage",
      targetSnapshot
    })).resolves.toEqual({ status: "open", operationId, bindingId: "binding-1" });

    expect(mocks.bindingCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        operationKey: BrowserOperationKey.householdAccentUpdate,
        targetKind: BrowserOperationTargetKind.settings,
        targetId: null,
        babyId: null,
        targetSnapshot: { settingsState: "absent", updatedAt: null, schemaVersion: 1 }
      })
    });
    expect(mocks.queryRaw.mock.calls.map(([query]) => query.join(" "))).toEqual(
      expect.arrayContaining([expect.stringContaining('FROM "Household"')])
    );
    expect(mocks.babyFindFirst).not.toHaveBeenCalled();
  });

  it("submits a settings target with exact non-baby locks and an allowlisted outcome", async () => {
    const opening = { settingsState: "absent", updatedAt: null, schemaVersion: 1 };
    const openingFingerprint = browserIntentFingerprint({
      version: 2,
      operationKey: BrowserOperationKey.settingsUnitsUpdate,
      householdId: ctx.householdId,
      memberId: ctx.memberId,
      babyId: null,
      targetKind: BrowserOperationTargetKind.settings,
      targetId: null,
      opening
    });
    mocks.bindingFindFirst.mockResolvedValue({
      id: "binding-1",
      householdId: ctx.householdId,
      operationId,
      sessionId: ctx.sessionId,
      actorUserId: ctx.userId,
      actorMemberId: ctx.memberId,
      operationKey: BrowserOperationKey.settingsUnitsUpdate,
      openingFingerprint,
      persistenceVersion: 2,
      targetKind: BrowserOperationTargetKind.settings,
      targetId: null,
      babyId: null,
      targetSnapshot: opening,
      protocolVersion: BrowserOperationProtocolVersion.browserV2,
      state: "open",
      expiresAt: new Date(Date.now() + 60_000),
      operation: null
    });
    mocks.operationUpdate.mockResolvedValue({
      operationId,
      status: "completed",
      outcomeCode: "ok",
      outcomeSnapshot: { operationId, kind: "units_updated", code: "ok", settingsScope: "household" }
    });
    const execute = vi.fn().mockResolvedValue({ kind: "units_updated", code: "ok", settingsScope: "household" });

    await expect(executeHouseholdBrowserOperation({
      ctx,
      operationId,
      operationKey: BrowserOperationKey.settingsUnitsUpdate,
      intent: { volume: "mL" },
      targetKind: BrowserOperationTargetKind.settings,
      permission: "household.manage",
      execute
    })).resolves.toMatchObject({ status: "completed", outcome: { kind: "units_updated" } });

    expect(execute).toHaveBeenCalledWith(expect.anything(), expect.objectContaining(ctx), expect.objectContaining({ targetSnapshot: opening }));
    expect(mocks.operationCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ targetKind: BrowserOperationTargetKind.settings, targetId: null, babyId: null })
    });
    expect(mocks.babyFindFirst).not.toHaveBeenCalled();
  });

  it("fails closed for expanded keys without adapters before reserving or executing", async () => {
    const execute = vi.fn();

    await expect(issueBrowserOperation({
      ctx,
      operationId,
      operationKey: BrowserOperationKey.memberRestore,
      opening: { target: "member" },
      babyId: "baby-1",
      targetKind: "member",
      targetId: "member-2",
      permission: "member.manage"
    })).rejects.toThrow("browser_operation_adapter_unavailable");
    await expect(executeBrowserOperation({
      ctx,
      operationId,
      operationKey: BrowserOperationKey.memberRestore,
      intent: { memberId: "member-2" },
      babyId: "baby-1",
      permission: "member.manage",
      execute
    })).rejects.toThrow("browser_operation_adapter_unavailable");

    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.bindingCreate).not.toHaveBeenCalled();
    expect(mocks.operationCreate).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(browserOperationFailureResult(operationId, new Error("browser_operation_adapter_unavailable"))).toEqual({
      status: "rejected",
      operationId,
      code: "operation_integrity_error"
    });
  });

  it("stores only the opening fingerprint and claims the submit intent from payload plus opening fingerprint", async () => {
    const opening = { babyId: "baby-1", revision: "opening-v1" };
    await issueBrowserOperation({
      ctx,
      operationId,
      operationKey: BrowserOperationKey.calendarEventCreate,
      opening,
      babyId: "baby-1",
      targetKind: "calendar",
      permission: "activity.create"
    });

    const createData = mocks.bindingCreate.mock.calls[0]?.[0]?.data;
    expect(createData).toMatchObject({
      persistenceVersion: 2,
      targetKind: "calendar",
      targetId: null,
      legacyIntentFingerprint: null,
      openingFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/)
    });
    expect(createData).not.toHaveProperty("intentFingerprint");

    const intent = { babyId: "baby-1", title: "Changed after opening" };
    mocks.bindingFindFirst.mockResolvedValue({
      ...createData,
      id: "binding-1",
      householdId: "household-1",
      operationId,
      actorUserId: "user-1",
      actorMemberId: "member-1",
      sessionId: "session-1",
      state: "open",
      expiresAt: new Date(Date.now() + 60_000),
      operation: null
    });
    await executeBrowserOperation({
      ctx,
      operationId,
      operationKey: BrowserOperationKey.calendarEventCreate,
      intent,
      babyId: "baby-1",
      permission: "activity.create",
      execute: async () => ({ kind: "calendar_event", code: "ok", eventId: "event-1" })
    });

    expect(mocks.operationCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        persistenceVersion: 2,
        openingFingerprint: createData.openingFingerprint,
        intentFingerprint: browserIntentFingerprint({ openingFingerprint: createData.openingFingerprint, payload: intent })
      })
    });
  });

  it("accepts only canonical browser-v2 operation IDs and fingerprints canonical object order", () => {
    expect(assertBrowserOperationId(operationId)).toBe(operationId);
    expect(() => assertBrowserOperationId("bmo_not-canonical")).toThrow();
    expect(browserIntentFingerprint({ b: 2, a: { z: true, y: "x" } })).toBe(
      browserIntentFingerprint({ a: { y: "x", z: true }, b: 2 })
    );
  });

  it("resolves the issuance context through the selected baby instead of no-argument household selection", async () => {
    await expect(getBrowserOperationContextForBaby("baby-1")).resolves.toEqual(ctx);

    expect(mocks.babyFindFirst).toHaveBeenCalledWith({
      where: { id: "baby-1", deletedAt: null },
      select: { householdId: true }
    });
    expect(mocks.memberFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ userId: "user-1", householdId: "household-1", disabledAt: null, deletedAt: null })
    }));
  });

  it("locks actor and target, reserves only an open opaque binding, and defers the pending operation until submit", async () => {
    const opening = { babyId: "baby-1", revision: "opening-v1" };

    await expect(issueBrowserOperation({
      ctx,
      operationId,
      operationKey: BrowserOperationKey.calendarEventCreate,
      opening,
      babyId: "baby-1",
      targetKind: BrowserOperationTargetKind.calendar,
      permission: "activity.create"
    })).resolves.toEqual({ status: "open", operationId, bindingId: "binding-1" });

    expect(mocks.queryRaw.mock.calls.map(([query]) => query.join(" "))).toEqual(
      expect.arrayContaining([expect.stringContaining('FROM "HouseholdMember"'), expect.stringContaining('FROM "Baby"')])
    );
    expect(mocks.requirePermission).toHaveBeenCalledWith(expect.objectContaining(ctx), "activity.create");
    expect(mocks.bindingCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        sessionId: "session-1",
        actorUserId: "user-1",
        actorMemberId: "member-1",
        householdId: "household-1",
        operationId,
        operationKey: BrowserOperationKey.calendarEventCreate,
        babyId: "baby-1",
        legacyIntentFingerprint: null,
        openingFingerprint: calendarOpeningFingerprint(opening),
        persistenceVersion: 2,
        targetKind: BrowserOperationTargetKind.calendar,
        targetId: null,
        expiresAt: expect.any(Date)
      })
    });
    expect(mocks.operationCreate).not.toHaveBeenCalled();
  });

  it("rejects a same-ID request whose opening binding differs", async () => {
    const originalOpening = { title: "original" };
    mocks.bindingFindFirst.mockResolvedValue(calendarBinding(originalOpening, {
      operation: calendarOperation(originalOpening, { title: "submitted" })
    }));

    await expect(issueBrowserOperation({
      ctx,
      operationId,
      operationKey: BrowserOperationKey.calendarEventCreate,
      opening: { title: "changed" },
      babyId: "baby-1",
      targetKind: BrowserOperationTargetKind.calendar,
      permission: "activity.create"
    })).rejects.toThrow("idempotency_conflict");
    expect(mocks.bindingCreate).not.toHaveBeenCalled();
    expect(mocks.operationCreate).not.toHaveBeenCalled();
  });

  it("replays the winning exact binding after a concurrent binding reservation", async () => {
    const opening = { babyId: "baby-1", revision: "opening-v1" };
    const winner = calendarBinding(opening);
    mocks.transaction.mockRejectedValueOnce({
      code: "P2002",
      meta: { target: ["householdId", "operationId"] }
    });
    mocks.bindingFindFirst.mockResolvedValue(winner);

    await expect(issueBrowserOperation({
      ctx,
      operationId,
      operationKey: BrowserOperationKey.calendarEventCreate,
      opening,
      babyId: "baby-1",
      targetKind: BrowserOperationTargetKind.calendar,
      permission: "activity.create"
    })).resolves.toEqual({ status: "open", operationId, bindingId: "binding-1" });
    expect(mocks.transaction).toHaveBeenCalledTimes(2);
    expect(mocks.bindingCreate).not.toHaveBeenCalled();
  });

  it("replays an exact completed binding before gating a now-inactive target", async () => {
    const opening = { babyId: "baby-1", revision: "opening-v1" };
    const intent = { babyId: "baby-1", title: "Checkup" };
    mocks.bindingFindFirst.mockResolvedValue(calendarBinding(opening, {
      state: "terminal",
      expiresAt: new Date(Date.now() - 60_000),
      operation: calendarOperation(opening, intent, {
        status: "completed",
        outcomeCode: "ok",
        outcomeSnapshot: { operationId, kind: "calendar_event", code: "ok", eventId: "event-1" }
      })
    }));

    await expect(issueBrowserOperation({
      ctx,
      operationId,
      operationKey: BrowserOperationKey.calendarEventCreate,
      opening,
      babyId: "baby-1",
      targetKind: BrowserOperationTargetKind.calendar,
      permission: "activity.create"
    })).resolves.toEqual({ status: "completed", operationId, outcome: { operationId, kind: "calendar_event", code: "ok", eventId: "event-1" } });

    expect(mocks.babyFindFirst).not.toHaveBeenCalled();
    expect(mocks.operationCreate).not.toHaveBeenCalled();
  });

  it("rechecks the immutable binding under lock and persists a terminal replay result", async () => {
    const opening = { babyId: "baby-1", revision: "opening-v1" };
    const intent = { babyId: "baby-1", title: "Checkup" };
    mocks.bindingFindFirst.mockResolvedValue(calendarBinding(opening, {
      state: "submitted",
      operation: calendarOperation(opening, intent)
    }));
    const execute = vi.fn().mockResolvedValue({ kind: "calendar_event", code: "ok", eventId: "event-1" });

    await expect(executeBrowserOperation({
      ctx,
      operationId,
      operationKey: BrowserOperationKey.calendarEventCreate,
      intent,
      babyId: "baby-1",
      permission: "activity.create",
      execute
    })).resolves.toEqual({ status: "completed", operationId, outcome: { operationId, kind: "calendar_event", code: "ok", eventId: "event-1" } });

    expect(execute).toHaveBeenCalledOnce();
    expect(mocks.operationUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { householdId_operationId: { householdId: "household-1", operationId } },
      data: expect.objectContaining({ status: "completed", outcomeVersion: 1, outcomeCode: "ok" })
    }));
    expect(mocks.bindingUpdate).toHaveBeenCalledWith({ where: { id: "binding-1" }, data: { state: "terminal" } });
  });

  it("replays a durable terminal outcome without recomputing or executing a replacement mutation", async () => {
    const opening = { babyId: "baby-1", revision: "opening-v1" };
    const intent = { babyId: "baby-1", title: "Checkup" };
    mocks.bindingFindFirst.mockResolvedValue(calendarBinding(opening, {
      state: "terminal",
      expiresAt: new Date(Date.now() - 60_000),
      operation: calendarOperation(opening, intent, { status: "completed", outcomeCode: "ok", outcomeSnapshot: { operationId, kind: "calendar_event", code: "ok", eventId: "event-1" } })
    }));
    const execute = vi.fn();

    await expect(executeBrowserOperation({
      ctx, operationId, operationKey: BrowserOperationKey.calendarEventCreate, intent, babyId: "baby-1",
      permission: "activity.create", execute
    })).resolves.toEqual({ status: "completed", operationId, outcome: { operationId, kind: "calendar_event", code: "ok", eventId: "event-1" } });

    expect(execute).not.toHaveBeenCalled();
    expect(mocks.operationUpdate).not.toHaveBeenCalled();
  });

  it("refuses a terminal replay when its persisted session is no longer current", async () => {
    const opening = { babyId: "baby-1", revision: "opening-v1" };
    const intent = { babyId: "baby-1", title: "Checkup" };
    mocks.bindingFindFirst.mockResolvedValue(calendarBinding(opening, {
      state: "terminal",
      expiresAt: new Date(Date.now() - 60_000),
      operation: calendarOperation(opening, intent, { status: "completed", outcomeCode: "ok", outcomeSnapshot: { operationId, kind: "calendar_event", code: "ok", eventId: "event-1" } })
    }));
    mocks.sessionFindFirst.mockResolvedValue(null);
    const execute = vi.fn();

    await expect(executeBrowserOperation({
      ctx, operationId, operationKey: BrowserOperationKey.calendarEventCreate, intent, babyId: "baby-1",
      permission: "activity.create", execute
    })).rejects.toThrow("forbidden");

    expect(execute).not.toHaveBeenCalled();
    expect(mocks.operationUpdate).not.toHaveBeenCalled();
  });

  it("expires an open browser-v2 binding without creating an operation or executing its mutation", async () => {
    const opening = { babyId: "baby-1", revision: "opening-v1" };
    const intent = { babyId: "baby-1", title: "Checkup" };
    mocks.bindingFindFirst.mockResolvedValue(calendarBinding(opening, {
      expiresAt: new Date(Date.now() - 60_000), operation: null
    }));
    const execute = vi.fn();

    await expect(executeBrowserOperation({
      ctx, operationId, operationKey: BrowserOperationKey.calendarEventCreate, intent, babyId: "baby-1",
      permission: "activity.create", execute
    })).resolves.toEqual({ status: "stale", operationId, code: "stale_context" });

    expect(execute).not.toHaveBeenCalled();
    expect(mocks.operationCreate).not.toHaveBeenCalled();
    expect(mocks.bindingUpdate).toHaveBeenCalledWith({ where: { id: "binding-1" }, data: { state: "expired" } });
  });

  it("persists a stale validation result as a terminal operation for same-ID replay", async () => {
    const opening = { babyId: "baby-1", revision: "opening-v1" };
    const intent = { babyId: "baby-1", title: "Checkup" };
    mocks.bindingFindFirst.mockResolvedValue(calendarBinding(opening));
    mocks.operationCreate.mockResolvedValue({ operationId, status: "pending", outcomeCode: null, outcomeSnapshot: null });
    mocks.operationUpdate.mockResolvedValue({ operationId, status: "stale", outcomeCode: "stale_target", outcomeSnapshot: null });

    await expect(executeBrowserOperation({
      ctx, operationId, operationKey: BrowserOperationKey.calendarEventCreate, intent, babyId: "baby-1",
      permission: "activity.create", validate: async () => { throw new Error("not_found"); }, execute: vi.fn()
    })).resolves.toEqual({ status: "stale", operationId, code: "stale_target" });

    expect(mocks.operationCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ bindingId: "binding-1", operationId }) });
    expect(mocks.operationUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "stale", outcomeCode: "stale_target" })
    }));

    mocks.bindingFindFirst.mockResolvedValue(calendarBinding(opening, {
      state: "terminal",
      expiresAt: new Date(Date.now() - 60_000),
      operation: calendarOperation(opening, intent, { status: "stale", outcomeCode: "stale_target", outcomeSnapshot: null })
    }));
    await expect(issueBrowserOperation({
      ctx,
      operationId,
      operationKey: BrowserOperationKey.calendarEventCreate,
      opening,
      babyId: "baby-1",
      targetKind: BrowserOperationTargetKind.calendar,
      permission: "activity.create"
    })).resolves.toEqual({ status: "stale", operationId, code: "stale_target" });
  });

  it("fails closed for a legacy open plus pending row without executing or replacing it", async () => {
    const intent = { babyId: "baby-1", title: "Checkup" };
    mocks.bindingFindFirst.mockResolvedValue({
      id: "legacy-binding", householdId: "household-1", operationId, sessionId: "session-1",
      actorUserId: "user-1", actorMemberId: "member-1", operationKey: BrowserOperationKey.calendarEventCreate,
      intentFingerprint: browserIntentFingerprint(intent), babyId: "baby-1", state: "open",
      protocolVersion: BrowserOperationProtocolVersion.browserV1,
      expiresAt: new Date(Date.now() + 60_000),
      operation: { operationId, status: "pending", outcomeCode: null, outcomeSnapshot: null }
    });
    const execute = vi.fn();

    await expect(executeBrowserOperation({
      ctx, operationId, operationKey: BrowserOperationKey.calendarEventCreate, intent, babyId: "baby-1",
      permission: "activity.create", execute
    })).rejects.toThrow("not_found");

    expect(execute).not.toHaveBeenCalled();
    expect(mocks.operationCreate).not.toHaveBeenCalled();
    expect(mocks.operationUpdate).not.toHaveBeenCalled();
  });
});
