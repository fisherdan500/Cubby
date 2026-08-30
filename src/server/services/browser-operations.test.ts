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
  bindingDelete: vi.fn(),
  reservationTombstoneCreate: vi.fn(),
  reservationTombstoneFindUnique: vi.fn(),
  operationCreate: vi.fn(),
  operationUpdate: vi.fn(),
  tombstoneFindUnique: vi.fn(),
  transaction: vi.fn(),
  queryRaw: vi.fn(),
  recordQualifyingUse: vi.fn()
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
vi.mock("@/server/services/global-session-security", () => ({ recordQualifyingGlobalSessionUseAfterSuccess: mocks.recordQualifyingUse }));

import { BrowserOperationKey, BrowserOperationProtocolVersion, BrowserOperationTargetKind } from "@prisma/client";
import {
  assertBrowserOperationId,
  browserIntentFingerprint,
  browserOperationFailureResult,
  getBrowserOperationContextForBaby,
  getBrowserOperationContextForHousehold,
  issueBrowserOperation,
  issueHouseholdBrowserOperation,
  abandonHouseholdBrowserOperation,
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
    issuedAt: new Date("2026-08-19T00:00:00Z"),
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
  mocks.bindingDelete.mockResolvedValue({ id: "binding-1" });
  mocks.reservationTombstoneCreate.mockResolvedValue({ operationId });
  mocks.reservationTombstoneFindUnique.mockResolvedValue(null);
  mocks.tombstoneFindUnique.mockResolvedValue(null);
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
      $executeRaw: mocks.queryRaw,
      session: { findFirst: mocks.sessionFindFirst },
      household: { findFirst: mocks.householdFindFirst },
      baby: { findFirst: mocks.babyFindFirst },
      householdMember: { findFirst: mocks.memberFindFirst },
      browserOperationBinding: { findFirst: mocks.bindingFindFirst, create: mocks.bindingCreate, update: mocks.bindingUpdate, delete: mocks.bindingDelete },
      browserMutationOperation: { create: mocks.operationCreate, update: mocks.operationUpdate },
      browserMutationOperationTombstone: { findUnique: mocks.tombstoneFindUnique },
      browserOperationReservationTombstone: {
        create: mocks.reservationTombstoneCreate,
        findUnique: mocks.reservationTombstoneFindUnique
      }
    })
  );
});

describe("browser operation bindings", () => {
  it("replays an authorized abandoned household reservation tombstone during issue", async () => {
    mocks.reservationTombstoneFindUnique.mockResolvedValue({
      householdId: ctx.householdId,
      operationId,
      operationKey: BrowserOperationKey.settingsUnitsUpdate,
      sessionId: ctx.sessionId,
      actorUserId: ctx.userId,
      actorMemberId: ctx.memberId,
      terminalCode: "operation_abandoned"
    });
    const targetSnapshot = vi.fn();

    await expect(issueHouseholdBrowserOperation({
      ctx,
      operationId,
      operationKey: BrowserOperationKey.settingsUnitsUpdate,
      targetKind: BrowserOperationTargetKind.settings,
      permission: "household.manage",
      targetSnapshot
    })).resolves.toEqual({ status: "expired", operationId, code: "operation_abandoned" });

    expect(targetSnapshot).not.toHaveBeenCalled();
    expect(mocks.bindingCreate).not.toHaveBeenCalled();
  });

  it("keeps another session's household reservation tombstone existence-neutral during issue", async () => {
    mocks.reservationTombstoneFindUnique.mockResolvedValue({
      householdId: ctx.householdId,
      operationId,
      operationKey: BrowserOperationKey.settingsUnitsUpdate,
      sessionId: "session-other",
      actorUserId: ctx.userId,
      actorMemberId: ctx.memberId,
      terminalCode: "operation_abandoned"
    });

    await expect(issueHouseholdBrowserOperation({
      ctx,
      operationId,
      operationKey: BrowserOperationKey.settingsUnitsUpdate,
      targetKind: BrowserOperationTargetKind.settings,
      permission: "household.manage",
      targetSnapshot: vi.fn()
    })).rejects.toThrow("not_found");

    expect(mocks.bindingCreate).not.toHaveBeenCalled();
  });

  it("recovers an authorized household reservation tombstone that wins the binding insert race", async () => {
    mocks.transaction.mockRejectedValueOnce({
      code: "P2004",
      meta: { database_error: "browser_operation_reservation_identity_already_owned" }
    });
    mocks.reservationTombstoneFindUnique.mockResolvedValue({
      householdId: ctx.householdId,
      operationId,
      operationKey: BrowserOperationKey.settingsUnitsUpdate,
      sessionId: ctx.sessionId,
      actorUserId: ctx.userId,
      actorMemberId: ctx.memberId,
      terminalCode: "operation_result_expired"
    });

    await expect(issueHouseholdBrowserOperation({
      ctx,
      operationId,
      operationKey: BrowserOperationKey.settingsUnitsUpdate,
      targetKind: BrowserOperationTargetKind.settings,
      permission: "household.manage",
      targetSnapshot: vi.fn()
    })).resolves.toEqual({ status: "expired", operationId, code: "operation_result_expired" });

    expect(mocks.transaction).toHaveBeenCalledTimes(2);
    expect(mocks.bindingCreate).not.toHaveBeenCalled();
  });

  it("records an immutable reservation tombstone before deleting an authorized unsubmitted household binding", async () => {
    mocks.bindingFindFirst.mockResolvedValue(calendarBinding({ babyId: "baby-1", revision: "opening-v1" }));

    await expect(abandonHouseholdBrowserOperation({
      ctx,
      operationId
    })).resolves.toEqual({ status: "expired", operationId, code: "operation_abandoned" });

    expect(mocks.reservationTombstoneCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ householdId: "household-1", operationId, sessionId: "session-1", terminalCode: "operation_abandoned" })
    }));
    expect(mocks.reservationTombstoneCreate.mock.invocationCallOrder[0]).toBeLessThan(mocks.bindingDelete.mock.invocationCallOrder[0]);
  });

  it("retries a serialization write conflict while abandoning the same reservation", async () => {
    mocks.bindingFindFirst.mockResolvedValue(calendarBinding({ babyId: "baby-1", revision: "opening-v1" }));
    mocks.transaction.mockRejectedValueOnce(Object.assign(new Error("write conflict"), { code: "P2034" }));

    await expect(abandonHouseholdBrowserOperation({ ctx, operationId })).resolves.toEqual({ status: "expired", operationId, code: "operation_abandoned" });
    expect(mocks.transaction).toHaveBeenCalledTimes(2);
  });

  it("locks Session before HouseholdMember in the canonical actor order", async () => {
    await issueHouseholdBrowserOperation({
      ctx,
      operationId,
      operationKey: BrowserOperationKey.settingsUnitsUpdate,
      targetKind: BrowserOperationTargetKind.settings,
      permission: "household.manage",
      targetSnapshot: () => ({ settingsState: "absent", updatedAt: null, schemaVersion: 1 })
    });
    const locks = mocks.queryRaw.mock.calls.map(([query]) => query.join(" "));
    expect(locks.findIndex((query) => query.includes('FROM "Session"'))).toBeLessThan(
      locks.findIndex((query) => query.includes('FROM "HouseholdMember"'))
    );
  });

  it("issues a server-generated household reservation when the browser has no operation identity", async () => {
    await expect(issueHouseholdBrowserOperation({
      ctx,
      operationId: undefined,
      operationKey: BrowserOperationKey.settingsUnitsUpdate,
      targetKind: BrowserOperationTargetKind.settings,
      permission: "household.manage",
      targetSnapshot: () => ({ settingsState: "absent", updatedAt: null, schemaVersion: 1 })
    })).resolves.toMatchObject({
      status: "open",
      operationId: expect.stringMatching(/^bmo_[0-9abcdefghjkmnpqrstvwxyz]{26}$/),
      bindingId: "binding-1"
    });
  });

  it("retries a serialization conflict across the full household issue transaction", async () => {
    mocks.transaction.mockRejectedValueOnce(Object.assign(new Error("write conflict"), { code: "P2034" }));
    await expect(issueHouseholdBrowserOperation({
      ctx,
      operationId,
      operationKey: BrowserOperationKey.settingsUnitsUpdate,
      targetKind: BrowserOperationTargetKind.settings,
      permission: "household.manage",
      targetSnapshot: () => ({ settingsState: "absent", updatedAt: null, schemaVersion: 1 })
    })).resolves.toEqual({ status: "open", operationId, bindingId: "binding-1" });
    expect(mocks.transaction).toHaveBeenCalledTimes(2);
  });

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

  it("reauthorizes a replayed household reservation under the identity lock", async () => {
    const opening = { settingsState: "absent", updatedAt: null, schemaVersion: 1 };
    mocks.bindingFindFirst.mockResolvedValue({
      id: "binding-1", householdId: ctx.householdId, operationId, sessionId: ctx.sessionId,
      actorUserId: ctx.userId, actorMemberId: ctx.memberId, operationKey: BrowserOperationKey.settingsUnitsUpdate,
      openingFingerprint: browserIntentFingerprint({ version: 2, operationKey: BrowserOperationKey.settingsUnitsUpdate, householdId: ctx.householdId, memberId: ctx.memberId, babyId: null, targetKind: BrowserOperationTargetKind.settings, targetId: null, opening }),
      persistenceVersion: 2, targetKind: BrowserOperationTargetKind.settings, targetId: null, babyId: null,
      protocolVersion: BrowserOperationProtocolVersion.browserV2, state: "open", expiresAt: new Date(Date.now() + 60_000), operation: null
    });
    const reauthorize = vi.fn().mockRejectedValue(new Error("fresh_authentication_required"));

    await expect(issueHouseholdBrowserOperation({
      ctx, operationId, operationKey: BrowserOperationKey.settingsUnitsUpdate,
      targetKind: BrowserOperationTargetKind.settings, permission: "household.manage",
      targetSnapshot: () => opening,
      reauthorize
    } as never)).rejects.toThrow("fresh_authentication_required");
    expect(reauthorize).toHaveBeenCalledOnce();
  });

  it("replays an authorized household reservation tombstone during submit", async () => {
    mocks.reservationTombstoneFindUnique.mockResolvedValue({
      householdId: ctx.householdId,
      operationId,
      operationKey: BrowserOperationKey.settingsUnitsUpdate,
      sessionId: ctx.sessionId,
      actorUserId: ctx.userId,
      actorMemberId: ctx.memberId,
      terminalCode: "operation_result_expired"
    });
    const execute = vi.fn();

    await expect(executeHouseholdBrowserOperation({
      ctx,
      operationId,
      operationKey: BrowserOperationKey.settingsUnitsUpdate,
      intent: { volume: "mL" },
      targetKind: BrowserOperationTargetKind.settings,
      permission: "household.manage",
      execute
    })).resolves.toEqual({ status: "expired", operationId, code: "operation_result_expired" });

    expect(execute).not.toHaveBeenCalled();
    expect(mocks.operationCreate).not.toHaveBeenCalled();
  });

  it("retries a serialization conflict across the full household submit transaction", async () => {
    mocks.transaction.mockRejectedValueOnce(Object.assign(new Error("write conflict"), { code: "P2034" }));
    mocks.reservationTombstoneFindUnique.mockResolvedValue({
      householdId: ctx.householdId,
      operationId,
      operationKey: BrowserOperationKey.settingsUnitsUpdate,
      sessionId: ctx.sessionId,
      actorUserId: ctx.userId,
      actorMemberId: ctx.memberId,
      terminalCode: "operation_result_expired"
    });
    await expect(executeHouseholdBrowserOperation({
      ctx,
      operationId,
      operationKey: BrowserOperationKey.settingsUnitsUpdate,
      intent: { volume: "mL" },
      targetKind: BrowserOperationTargetKind.settings,
      permission: "household.manage",
      execute: vi.fn()
    })).resolves.toEqual({ status: "expired", operationId, code: "operation_result_expired" });
    expect(mocks.transaction).toHaveBeenCalledTimes(2);
  });

  it("keeps another session's household reservation tombstone existence-neutral during submit", async () => {
    mocks.reservationTombstoneFindUnique.mockResolvedValue({
      householdId: ctx.householdId,
      operationId,
      operationKey: BrowserOperationKey.settingsUnitsUpdate,
      sessionId: "session-other",
      actorUserId: ctx.userId,
      actorMemberId: ctx.memberId,
      terminalCode: "operation_abandoned"
    });

    await expect(executeHouseholdBrowserOperation({
      ctx,
      operationId,
      operationKey: BrowserOperationKey.settingsUnitsUpdate,
      intent: { volume: "mL" },
      targetKind: BrowserOperationTargetKind.settings,
      permission: "household.manage",
      execute: vi.fn()
    })).rejects.toThrow("not_found");
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

    expect(mocks.recordQualifyingUse).toHaveBeenCalledWith(expect.anything(), ctx, "cubby_owned_non_get_mutation");
    expect(execute).toHaveBeenCalledWith(expect.anything(), expect.objectContaining(ctx), expect.objectContaining({ targetSnapshot: opening }));
    expect(mocks.operationCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ targetKind: BrowserOperationTargetKind.settings, targetId: null, babyId: null })
    });
    expect(mocks.babyFindFirst).not.toHaveBeenCalled();
  });

  it("does not qualify an already-terminal household mutation replay", async () => {
    const opening = { settingsState: "absent", updatedAt: null, schemaVersion: 1 };
    const openingFingerprint = browserIntentFingerprint({ version: 2, operationKey: BrowserOperationKey.settingsUnitsUpdate, householdId: ctx.householdId, memberId: ctx.memberId, babyId: null, targetKind: BrowserOperationTargetKind.settings, targetId: null, opening });
    const intent = { volume: "mL" };
    const intentFingerprint = browserIntentFingerprint({ openingFingerprint, payload: intent });
    mocks.bindingFindFirst.mockResolvedValue({
      id: "binding-1", householdId: ctx.householdId, operationId, sessionId: ctx.sessionId,
      actorUserId: ctx.userId, actorMemberId: ctx.memberId, operationKey: BrowserOperationKey.settingsUnitsUpdate,
      openingFingerprint, persistenceVersion: 2, targetKind: BrowserOperationTargetKind.settings, targetId: null, babyId: null,
      targetSnapshot: opening, protocolVersion: BrowserOperationProtocolVersion.browserV2, state: "terminal",
      expiresAt: new Date(Date.now() - 60_000),
      operation: { operationId, intentFingerprint, status: "completed", outcomeCode: "ok", outcomeSnapshot: { operationId, kind: "units_updated", code: "ok", settingsScope: "household" } }
    });
    const execute = vi.fn();

    await expect(executeHouseholdBrowserOperation({ ctx, operationId, operationKey: BrowserOperationKey.settingsUnitsUpdate, intent, targetKind: BrowserOperationTargetKind.settings, permission: "household.manage", execute })).resolves.toMatchObject({ status: "completed" });

    expect(execute).not.toHaveBeenCalled();
    expect(mocks.recordQualifyingUse).not.toHaveBeenCalled();
  });

  it.each(Object.values(BrowserOperationKey).map((operationKey, index) => ({
    operationKey,
    operationId: `bmo_${"0".repeat(25)}${"abcdefghjkmnpqrstvwxyz"[index % "abcdefghjkmnpqrstvwxyz".length]}`
  })))("opens every registered ordinary adapter key", async ({ operationKey, operationId: adapterOperationId }) => {

    await expect(issueHouseholdBrowserOperation({
      ctx,
      operationId: adapterOperationId,
      operationKey,
      targetKind: BrowserOperationTargetKind.household,
      targetId: operationKey,
      permission: "member.manage",
      targetSnapshot: () => ({ version: 1, operationKey })
    })).resolves.toEqual({ status: "open", operationId: adapterOperationId, bindingId: "binding-1" });

    expect(mocks.bindingCreate).toHaveBeenLastCalledWith({
      data: expect.objectContaining({ operationId: adapterOperationId, operationKey })
    });
  });

  it("issues a server-generated baby-scoped reservation when the browser has no operation identity", async () => {
    await expect(issueBrowserOperation({
      ctx,
      operationId: undefined,
      operationKey: BrowserOperationKey.calendarEventCreate,
      opening: { babyId: "baby-1", revision: "opening-v1" },
      babyId: "baby-1",
      targetKind: BrowserOperationTargetKind.calendar,
      permission: "activity.create"
    })).resolves.toMatchObject({
      status: "open",
      operationId: expect.stringMatching(/^bmo_[0-9abcdefghjkmnpqrstvwxyz]{26}$/),
      bindingId: "binding-1"
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

  it("resolves the baby only inside the explicitly selected household carrier", async () => {
    await expect(getBrowserOperationContextForBaby("baby-1")).resolves.toEqual(ctx);

    expect(mocks.getEffectiveHouseholdContext).toHaveBeenCalledTimes(1);
    expect(mocks.babyFindFirst).toHaveBeenCalledWith({
      where: { id: "baby-1", householdId: "household-1", deletedAt: null },
      select: { id: true }
    });
    expect(mocks.memberFindFirst).not.toHaveBeenCalled();
  });

  it("rejects a baby from another household while the current carrier selects this household", async () => {
    mocks.babyFindFirst.mockResolvedValueOnce(null);
    await expect(getBrowserOperationContextForBaby("baby-from-household-b")).rejects.toThrow("not_found");
    expect(mocks.babyFindFirst).toHaveBeenCalledWith({
      where: { id: "baby-from-household-b", householdId: "household-1", deletedAt: null },
      select: { id: true }
    });
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

  it("takes the operation identity lock before actor or target rows during baby-scoped issuance", async () => {
    await issueBrowserOperation({
      ctx,
      operationId,
      operationKey: BrowserOperationKey.calendarEventCreate,
      opening: { babyId: "baby-1", revision: "opening-v1" },
      babyId: "baby-1",
      targetKind: BrowserOperationTargetKind.calendar,
      permission: "activity.create"
    });

    const identityLockCall = mocks.queryRaw.mock.calls.findIndex(([query]) => query.join(" ").includes("lock_household_browser_operation_identity"));
    expect(identityLockCall).toBeGreaterThanOrEqual(0);
    expect(mocks.queryRaw.mock.invocationCallOrder[identityLockCall]).toBeLessThan(mocks.memberFindFirst.mock.invocationCallOrder[0]);
    expect(mocks.queryRaw.mock.invocationCallOrder[identityLockCall]).toBeLessThan(mocks.babyFindFirst.mock.invocationCallOrder[0]);
    expect(mocks.queryRaw.mock.invocationCallOrder[identityLockCall]).toBeLessThan(mocks.sessionFindFirst.mock.invocationCallOrder[0]);
    expect(mocks.sessionFindFirst.mock.invocationCallOrder[0]).toBeLessThan(mocks.memberFindFirst.mock.invocationCallOrder[0]);
  });

  it("returns the compacted 410 result instead of reissuing a household browser operation", async () => {
    mocks.tombstoneFindUnique.mockResolvedValue({
      householdId: ctx.householdId,
      operationId,
      actorUserId: ctx.userId,
      actorMemberId: ctx.memberId
    });

    await expect(issueBrowserOperation({
      ctx,
      operationId,
      operationKey: BrowserOperationKey.calendarEventCreate,
      opening: { babyId: "baby-1", revision: "opening-v1" },
      babyId: "baby-1",
      targetKind: BrowserOperationTargetKind.calendar,
      permission: "activity.create"
    })).resolves.toEqual({ status: "expired", operationId, code: "operation_result_expired" });

    expect(mocks.bindingCreate).not.toHaveBeenCalled();
  });

  it("replays an authorized reservation tombstone before reissuing a baby-scoped household operation", async () => {
    mocks.reservationTombstoneFindUnique.mockResolvedValue({
      householdId: ctx.householdId,
      operationId,
      operationKey: BrowserOperationKey.calendarEventCreate,
      sessionId: ctx.sessionId,
      actorUserId: ctx.userId,
      actorMemberId: ctx.memberId,
      terminalCode: "operation_abandoned"
    });

    await expect(issueBrowserOperation({
      ctx,
      operationId,
      operationKey: BrowserOperationKey.calendarEventCreate,
      opening: { babyId: "baby-1", revision: "opening-v1" },
      babyId: "baby-1",
      targetKind: BrowserOperationTargetKind.calendar,
      permission: "activity.create"
    })).resolves.toEqual({ status: "expired", operationId, code: "operation_abandoned" });

    expect(mocks.babyFindFirst).not.toHaveBeenCalled();
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

  it("replays an authorized reservation tombstone before submitting a baby-scoped household operation", async () => {
    mocks.reservationTombstoneFindUnique.mockResolvedValue({
      householdId: ctx.householdId,
      operationId,
      operationKey: BrowserOperationKey.calendarEventCreate,
      sessionId: ctx.sessionId,
      actorUserId: ctx.userId,
      actorMemberId: ctx.memberId,
      terminalCode: "operation_abandoned"
    });
    const execute = vi.fn();

    await expect(executeBrowserOperation({
      ctx,
      operationId,
      operationKey: BrowserOperationKey.calendarEventCreate,
      intent: { babyId: "baby-1", title: "Checkup" },
      babyId: "baby-1",
      permission: "activity.create",
      execute
    })).resolves.toEqual({ status: "expired", operationId, code: "operation_abandoned" });

    expect(execute).not.toHaveBeenCalled();
    expect(mocks.babyFindFirst).not.toHaveBeenCalled();
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
    expect(mocks.recordQualifyingUse).not.toHaveBeenCalled();
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
