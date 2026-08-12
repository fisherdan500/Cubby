import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireFreshSession: vi.fn(),
  requirePermission: vi.fn(),
  sessionFindFirst: vi.fn(),
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
vi.mock("@/server/auth/context", () => ({ requirePermission: mocks.requirePermission }));
vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    session: { findFirst: mocks.sessionFindFirst },
    baby: { findFirst: mocks.babyFindFirst },
    householdMember: { findFirst: mocks.memberFindFirst },
    $transaction: mocks.transaction
  }
}));

import { BrowserOperationKey, BrowserOperationProtocolVersion } from "@prisma/client";
import {
  assertBrowserOperationId,
  browserIntentFingerprint,
  getBrowserOperationContextForBaby,
  issueBrowserOperation,
  executeBrowserOperation
} from "@/server/services/browser-operations";

const operationId = "bmo_0123456789abcdefghjkmnpqrs";
const ctx = {
  userId: "user-1",
  sessionId: "session-1",
  householdId: "household-1",
  memberId: "member-1",
  role: "parent" as const
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireFreshSession.mockResolvedValue({ user: { id: "user-1" }, session: { id: "session-1" } });
  mocks.sessionFindFirst.mockResolvedValue({ id: "session-1", userId: "user-1", expiresAt: new Date(Date.now() + 60_000) });
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
      baby: { findFirst: mocks.babyFindFirst },
      householdMember: { findFirst: mocks.memberFindFirst },
      browserOperationBinding: { findFirst: mocks.bindingFindFirst, create: mocks.bindingCreate, update: mocks.bindingUpdate },
      browserMutationOperation: { create: mocks.operationCreate, update: mocks.operationUpdate }
    })
  );
});

describe("browser operation bindings", () => {
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
    const intent = { babyId: "baby-1", title: "Checkup", startDate: "2026-08-12", startTime: "09:00" };

    await expect(issueBrowserOperation({
      ctx,
      operationId,
      operationKey: BrowserOperationKey.calendarEventCreate,
      intent,
      babyId: "baby-1",
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
        intentFingerprint: browserIntentFingerprint(intent),
        expiresAt: expect.any(Date)
      })
    });
    expect(mocks.operationCreate).not.toHaveBeenCalled();
  });

  it("rejects a same-ID request whose opening binding differs", async () => {
    mocks.bindingFindFirst.mockResolvedValue({
      sessionId: "session-1",
      actorUserId: "user-1",
      actorMemberId: "member-1",
      operationKey: BrowserOperationKey.calendarEventCreate,
      intentFingerprint: browserIntentFingerprint({ title: "original" }),
      babyId: "baby-1",
      operation: { operationId, status: "pending", outcomeCode: null, outcomeSnapshot: null }
    });

    await expect(issueBrowserOperation({
      ctx,
      operationId,
      operationKey: BrowserOperationKey.calendarEventCreate,
      intent: { title: "changed" },
      babyId: "baby-1",
      permission: "activity.create"
    })).rejects.toThrow("idempotency_conflict");
    expect(mocks.bindingCreate).not.toHaveBeenCalled();
    expect(mocks.operationCreate).not.toHaveBeenCalled();
  });

  it("replays the winning exact binding after a concurrent binding reservation", async () => {
    const intent = { babyId: "baby-1", title: "Checkup" };
    const winner = {
      id: "binding-1",
      sessionId: "session-1",
      actorUserId: "user-1",
      actorMemberId: "member-1",
      operationKey: BrowserOperationKey.calendarEventCreate,
      intentFingerprint: browserIntentFingerprint(intent),
      babyId: "baby-1",
      protocolVersion: BrowserOperationProtocolVersion.browserV2,
      operation: null
    };
    mocks.transaction.mockRejectedValueOnce({
      code: "P2002",
      meta: { target: ["householdId", "operationId"] }
    });
    mocks.bindingFindFirst.mockResolvedValue(winner);

    await expect(issueBrowserOperation({
      ctx,
      operationId,
      operationKey: BrowserOperationKey.calendarEventCreate,
      intent,
      babyId: "baby-1",
      permission: "activity.create"
    })).resolves.toEqual({ status: "open", operationId, bindingId: "binding-1" });
    expect(mocks.transaction).toHaveBeenCalledTimes(2);
    expect(mocks.bindingCreate).not.toHaveBeenCalled();
  });

  it("replays an exact completed binding before gating a now-inactive target", async () => {
    const intent = { babyId: "baby-1", title: "Checkup" };
    mocks.bindingFindFirst.mockResolvedValue({
      id: "binding-1", householdId: "household-1", operationId, sessionId: "session-1",
      actorUserId: "user-1", actorMemberId: "member-1", operationKey: BrowserOperationKey.calendarEventCreate,
      intentFingerprint: browserIntentFingerprint(intent), babyId: "baby-1",
      protocolVersion: BrowserOperationProtocolVersion.browserV2,
      state: "terminal", expiresAt: new Date(Date.now() - 60_000),
      operation: { operationId, status: "completed", outcomeCode: "ok", outcomeSnapshot: { operationId, kind: "calendar_event", code: "ok", eventId: "event-1" } }
    });

    await expect(issueBrowserOperation({
      ctx, operationId, operationKey: BrowserOperationKey.calendarEventCreate, intent, babyId: "baby-1",
      permission: "activity.create"
    })).resolves.toEqual({ status: "completed", operationId, outcome: { operationId, kind: "calendar_event", code: "ok", eventId: "event-1" } });

    expect(mocks.babyFindFirst).not.toHaveBeenCalled();
    expect(mocks.operationCreate).not.toHaveBeenCalled();
  });

  it("rechecks the immutable binding under lock and persists a terminal replay result", async () => {
    const intent = { babyId: "baby-1", title: "Checkup" };
    mocks.bindingFindFirst.mockResolvedValue({
      id: "binding-1",
      householdId: "household-1",
      operationId,
      sessionId: "session-1",
      actorUserId: "user-1",
      actorMemberId: "member-1",
      operationKey: BrowserOperationKey.calendarEventCreate,
      intentFingerprint: browserIntentFingerprint(intent),
      babyId: "baby-1",
      protocolVersion: BrowserOperationProtocolVersion.browserV2,
      state: "submitted",
      expiresAt: new Date(Date.now() + 60_000),
      operation: { operationId, status: "pending", outcomeCode: null, outcomeSnapshot: null }
    });
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
    const intent = { babyId: "baby-1", title: "Checkup" };
    mocks.bindingFindFirst.mockResolvedValue({
      id: "binding-1", householdId: "household-1", operationId, sessionId: "session-1",
      actorUserId: "user-1", actorMemberId: "member-1", operationKey: BrowserOperationKey.calendarEventCreate,
      intentFingerprint: browserIntentFingerprint(intent), babyId: "baby-1", state: "terminal",
      protocolVersion: BrowserOperationProtocolVersion.browserV2,
      expiresAt: new Date(Date.now() - 60_000),
      operation: { operationId, status: "completed", outcomeCode: "ok", outcomeSnapshot: { operationId, kind: "calendar_event", code: "ok", eventId: "event-1" } }
    });
    const execute = vi.fn();

    await expect(executeBrowserOperation({
      ctx, operationId, operationKey: BrowserOperationKey.calendarEventCreate, intent, babyId: "baby-1",
      permission: "activity.create", execute
    })).resolves.toEqual({ status: "completed", operationId, outcome: { operationId, kind: "calendar_event", code: "ok", eventId: "event-1" } });

    expect(execute).not.toHaveBeenCalled();
    expect(mocks.operationUpdate).not.toHaveBeenCalled();
  });

  it("refuses a terminal replay when its persisted session is no longer current", async () => {
    const intent = { babyId: "baby-1", title: "Checkup" };
    mocks.bindingFindFirst.mockResolvedValue({
      id: "binding-1", householdId: "household-1", operationId, sessionId: "session-1",
      actorUserId: "user-1", actorMemberId: "member-1", operationKey: BrowserOperationKey.calendarEventCreate,
      intentFingerprint: browserIntentFingerprint(intent), babyId: "baby-1", state: "terminal",
      protocolVersion: BrowserOperationProtocolVersion.browserV2,
      expiresAt: new Date(Date.now() - 60_000),
      operation: { operationId, status: "completed", outcomeCode: "ok", outcomeSnapshot: { operationId, kind: "calendar_event", code: "ok", eventId: "event-1" } }
    });
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
    const intent = { babyId: "baby-1", title: "Checkup" };
    mocks.bindingFindFirst.mockResolvedValue({
      id: "binding-1", householdId: "household-1", operationId, sessionId: "session-1",
      actorUserId: "user-1", actorMemberId: "member-1", operationKey: BrowserOperationKey.calendarEventCreate,
      intentFingerprint: browserIntentFingerprint(intent), babyId: "baby-1", state: "open",
      protocolVersion: BrowserOperationProtocolVersion.browserV2,
      expiresAt: new Date(Date.now() - 60_000), operation: null
    });
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
    const intent = { babyId: "baby-1", title: "Checkup" };
    mocks.bindingFindFirst.mockResolvedValue({
      id: "binding-1", householdId: "household-1", operationId, sessionId: "session-1",
      actorUserId: "user-1", actorMemberId: "member-1", operationKey: BrowserOperationKey.calendarEventCreate,
      intentFingerprint: browserIntentFingerprint(intent), babyId: "baby-1", state: "open",
      protocolVersion: BrowserOperationProtocolVersion.browserV2,
      expiresAt: new Date(Date.now() + 60_000), operation: null
    });
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

    mocks.bindingFindFirst.mockResolvedValue({
      id: "binding-1", householdId: "household-1", operationId, sessionId: "session-1",
      actorUserId: "user-1", actorMemberId: "member-1", operationKey: BrowserOperationKey.calendarEventCreate,
      intentFingerprint: browserIntentFingerprint(intent), babyId: "baby-1", state: "terminal",
      protocolVersion: BrowserOperationProtocolVersion.browserV2,
      expiresAt: new Date(Date.now() - 60_000),
      operation: { operationId, status: "stale", outcomeCode: "stale_target", outcomeSnapshot: null }
    });
    await expect(issueBrowserOperation({
      ctx, operationId, operationKey: BrowserOperationKey.calendarEventCreate, intent, babyId: "baby-1", permission: "activity.create"
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
