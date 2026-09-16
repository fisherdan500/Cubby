import { beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserOperationKey } from "@prisma/client";

const mocks = vi.hoisted(() => ({
  getContext: vi.fn(),
  getSession: vi.fn(),
  assertFreshSession: vi.fn(),
  transaction: vi.fn(),
  queryRaw: vi.fn(),
  sessionFindFirst: vi.fn(),
  memberFindFirst: vi.fn(),
  bindingFindFirst: vi.fn(),
  tombstoneFindUnique: vi.fn(),
  reservationTombstoneFindUnique: vi.fn()
}));

vi.mock("@/server/auth/context", () => ({
  getEffectiveHouseholdContext: mocks.getContext
}));
vi.mock("@/server/auth/session", () => ({ getSession: mocks.getSession, assertFreshSession: mocks.assertFreshSession }));
vi.mock("@/lib/db/prisma", () => ({
  prisma: { $transaction: mocks.transaction }
}));

import { getHouseholdBrowserOperationStatus } from "@/server/services/browser-operation-status";

const operationId = "bmo_0123456789abcdefghjkmnpqrs";
const ctx = { userId: "user-1", householdId: "household-1", memberId: "member-1", role: "parent" };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getContext.mockResolvedValue(ctx);
  mocks.getSession.mockResolvedValue({ user: { id: "user-1" }, session: { id: "session-1" } });
  mocks.assertFreshSession.mockImplementation((session) => session);
  mocks.queryRaw.mockResolvedValue([]);
  mocks.sessionFindFirst.mockResolvedValue({ id: "session-1" });
  mocks.memberFindFirst.mockResolvedValue({ id: "member-1" });
  mocks.bindingFindFirst.mockResolvedValue(null);
  mocks.tombstoneFindUnique.mockResolvedValue(null);
  mocks.reservationTombstoneFindUnique.mockResolvedValue(null);
  mocks.transaction.mockImplementation((callback) => callback({
    $queryRaw: mocks.queryRaw,
    $executeRaw: mocks.queryRaw,
    session: { findFirst: mocks.sessionFindFirst },
    householdMember: { findFirst: mocks.memberFindFirst },
    browserOperationBinding: { findFirst: mocks.bindingFindFirst },
    browserMutationOperationTombstone: { findUnique: mocks.tombstoneFindUnique },
    browserOperationReservationTombstone: { findUnique: mocks.reservationTombstoneFindUnique }
  }));
});

describe("household browser operation status", () => {
  it("returns operation_prepared for a currently authorized reserved binding without a submitted operation", async () => {
    mocks.bindingFindFirst.mockResolvedValue({
      sessionId: "session-1",
      actorUserId: "user-1",
      actorMemberId: "member-1",
      operation: null
    });

    await expect(getHouseholdBrowserOperationStatus(operationId)).resolves.toEqual({
      status: "prepared",
      operationId,
      code: "operation_prepared"
    });
    const locks = mocks.queryRaw.mock.calls.map(([query]) => query.join(" "));
    expect(locks.findIndex((query) => query.includes('"lock_actor_session_for_operation"') || query.includes('"lock_user_sessions_for_operation"'))).toBeLessThan(
      locks.findIndex((query) => query.includes('FROM "HouseholdMember"'))
    );
  });

  it("requires fresh current-owner authority for API-key revoke status", async () => {
    mocks.memberFindFirst.mockResolvedValue({ id: "member-1", role: "owner" });
    mocks.bindingFindFirst.mockResolvedValue({
      sessionId: "session-1", actorUserId: "user-1", actorMemberId: "member-1",
      operationKey: BrowserOperationKey.apiKeyRevoke, operation: null
    });
    mocks.assertFreshSession.mockImplementation(() => { throw new Error("fresh_authentication_required"); });
    await expect(getHouseholdBrowserOperationStatus(operationId)).rejects.toThrow("fresh_authentication_required");
  });

  it("is existence-neutral for a non-owner asking about an API-key revoke operation", async () => {
    mocks.memberFindFirst.mockResolvedValue({ id: "member-1", role: "admin" });
    mocks.bindingFindFirst.mockResolvedValue({
      sessionId: "session-1", actorUserId: "user-1", actorMemberId: "member-1",
      operationKey: BrowserOperationKey.apiKeyRevoke, operation: null
    });
    await expect(getHouseholdBrowserOperationStatus(operationId)).rejects.toThrow("not_found");
  });

  it("returns operation_result_expired for a currently authorized expired unsubmitted reservation", async () => {
    mocks.bindingFindFirst.mockResolvedValue({
      sessionId: "session-1",
      actorUserId: "user-1",
      actorMemberId: "member-1",
      state: "expired",
      operation: null
    });

    await expect(getHouseholdBrowserOperationStatus(operationId)).resolves.toEqual({
      status: "expired", operationId, code: "operation_result_expired"
    });
  });

  it("returns operation_unknown for a currently authorized pending or unknown operation", async () => {
    mocks.bindingFindFirst.mockResolvedValue({
      sessionId: "session-1",
      actorUserId: "user-1",
      actorMemberId: "member-1",
      operation: { operationId, status: "unknown", outcomeCode: null, outcomeSnapshot: null }
    });

    await expect(getHouseholdBrowserOperationStatus(operationId)).resolves.toEqual({
      status: "pending",
      operationId,
      code: "operation_unknown"
    });
    expect(mocks.queryRaw).toHaveBeenCalled();
  });

  it("replays only the allowlisted persisted terminal result", async () => {
    mocks.bindingFindFirst.mockResolvedValue({
      sessionId: "session-1",
      actorUserId: "user-1",
      actorMemberId: "member-1",
      operation: {
        operationId,
        status: "completed",
        outcomeCode: "ok",
        outcomeSnapshot: { operationId, kind: "calendar_event", code: "ok", eventId: "event-1" }
      }
    });

    await expect(getHouseholdBrowserOperationStatus(operationId)).resolves.toEqual({
      status: "completed",
      operationId,
      outcome: { operationId, kind: "calendar_event", code: "ok", eventId: "event-1" }
    });
  });

  it("returns operation_abandoned for a currently authorized reservation tombstone", async () => {
    mocks.reservationTombstoneFindUnique.mockResolvedValue({ sessionId: "session-1", actorUserId: "user-1", actorMemberId: "member-1", terminalCode: "operation_abandoned" });
    await expect(getHouseholdBrowserOperationStatus(operationId)).resolves.toEqual({
      status: "expired", operationId, code: "operation_abandoned"
    });
  });

  it("returns operation_result_expired for a currently authorized expiry reservation tombstone", async () => {
    mocks.reservationTombstoneFindUnique.mockResolvedValue({ sessionId: "session-1", actorUserId: "user-1", actorMemberId: "member-1", terminalCode: "operation_result_expired" });
    await expect(getHouseholdBrowserOperationStatus(operationId)).resolves.toEqual({
      status: "expired", operationId, code: "operation_result_expired"
    });
  });

  it("returns operation_result_expired for a currently authorized compacted identity", async () => {
    mocks.tombstoneFindUnique.mockResolvedValue({ actorUserId: "user-1", actorMemberId: "member-1" });

    await expect(getHouseholdBrowserOperationStatus(operationId)).resolves.toEqual({
      status: "expired",
      operationId,
      code: "operation_result_expired"
    });
  });

  it("is existence-neutral for missing, foreign, or former-member identities", async () => {
    mocks.tombstoneFindUnique.mockResolvedValue({ actorUserId: "other-user", actorMemberId: "other-member" });
    await expect(getHouseholdBrowserOperationStatus(operationId)).rejects.toThrow("not_found");

    mocks.tombstoneFindUnique.mockResolvedValue(null);
    await expect(getHouseholdBrowserOperationStatus(operationId)).rejects.toThrow("not_found");
  });

  it("is existence-neutral for a reservation tombstone issued by another current session", async () => {
    mocks.reservationTombstoneFindUnique.mockResolvedValue({
      sessionId: "other-session",
      actorUserId: "user-1",
      actorMemberId: "member-1",
      terminalCode: "operation_abandoned"
    });

    await expect(getHouseholdBrowserOperationStatus(operationId)).rejects.toThrow("not_found");
  });
});
