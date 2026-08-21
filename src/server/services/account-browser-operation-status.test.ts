import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  transaction: vi.fn(),
  queryRaw: vi.fn(),
  sessionFindFirst: vi.fn(),
  userFindFirst: vi.fn(),
  bindingFindFirst: vi.fn(),
  tombstoneFindUnique: vi.fn(),
  reservationTombstoneFindUnique: vi.fn()
}));

vi.mock("@/server/auth/session", () => ({ getSession: mocks.getSession }));
vi.mock("@/lib/db/prisma", () => ({ prisma: { $transaction: mocks.transaction } }));

import { getAccountBrowserOperationStatus } from "@/server/services/account-browser-operation-status";

const operationId = "bmo_0123456789abcdefghjkmnpqrs";
const session = { user: { id: "user-1" }, session: { id: "session-1" } };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getSession.mockResolvedValue(session);
  mocks.queryRaw.mockResolvedValue([]);
  mocks.sessionFindFirst.mockResolvedValue({ id: "session-1", userId: "user-1" });
  mocks.userFindFirst.mockResolvedValue({ id: "user-1" });
  mocks.bindingFindFirst.mockResolvedValue(null);
  mocks.tombstoneFindUnique.mockResolvedValue(null);
  mocks.reservationTombstoneFindUnique.mockResolvedValue(null);
  mocks.transaction.mockImplementation((callback) => callback({
    $queryRaw: mocks.queryRaw,
    $executeRaw: mocks.queryRaw,
    session: { findFirst: mocks.sessionFindFirst },
    user: { findFirst: mocks.userFindFirst },
    accountOperationBinding: { findFirst: mocks.bindingFindFirst },
    accountMutationOperationTombstone: { findUnique: mocks.tombstoneFindUnique },
    accountOperationReservationTombstone: { findUnique: mocks.reservationTombstoneFindUnique }
  }));
});

describe("account browser operation status", () => {
  it("returns operation_prepared for the current session's reserved binding without a submitted operation", async () => {
    mocks.bindingFindFirst.mockResolvedValue({
      sessionId: "session-1",
      userId: "user-1",
      operation: null
    });

    await expect(getAccountBrowserOperationStatus(operationId)).resolves.toEqual({
      status: "prepared",
      operationId,
      code: "operation_prepared"
    });
  });

  it("returns operation_result_expired for the current user's expired unsubmitted reservation", async () => {
    mocks.bindingFindFirst.mockResolvedValue({ sessionId: "session-1", userId: "user-1", state: "expired", operation: null });
    await expect(getAccountBrowserOperationStatus(operationId)).resolves.toEqual({
      status: "expired", operationId, code: "operation_result_expired"
    });
  });

  it("returns operation_unknown for pending and unknown account operations using only current Session/User authority", async () => {
    mocks.bindingFindFirst.mockResolvedValue({
      sessionId: "session-1",
      userId: "user-1",
      operation: { operationId, status: "unknown", outcomeCode: null, outcomeSnapshot: null }
    });

    await expect(getAccountBrowserOperationStatus(operationId)).resolves.toEqual({
      status: "pending",
      operationId,
      code: "operation_unknown"
    });
    expect(mocks.sessionFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "session-1", userId: "user-1" })
    }));
  });

  it("replays the allowlisted terminal account appearance result", async () => {
    mocks.bindingFindFirst.mockResolvedValue({
      sessionId: "session-1",
      userId: "user-1",
      operation: {
        operationId,
        status: "completed",
        outcomeCode: "ok",
        outcomeSnapshot: {
          operationId,
          kind: "account_appearance",
          code: "ok",
          appearanceMode: "dark",
          appearanceRevision: 5
        }
      }
    });

    await expect(getAccountBrowserOperationStatus(operationId)).resolves.toMatchObject({
      status: "completed",
      operationId,
      outcome: { appearanceMode: "dark", appearanceRevision: 5 }
    });
  });

  it("returns operation_abandoned for the current user's reservation tombstone", async () => {
    mocks.reservationTombstoneFindUnique.mockResolvedValue({ sessionId: "session-1", userId: "user-1", terminalCode: "operation_abandoned" });
    await expect(getAccountBrowserOperationStatus(operationId)).resolves.toEqual({
      status: "expired", operationId, code: "operation_abandoned"
    });
  });

  it("returns operation_result_expired for the current user's expiry reservation tombstone", async () => {
    mocks.reservationTombstoneFindUnique.mockResolvedValue({ sessionId: "session-1", userId: "user-1", terminalCode: "operation_result_expired" });
    await expect(getAccountBrowserOperationStatus(operationId)).resolves.toEqual({
      status: "expired", operationId, code: "operation_result_expired"
    });
  });

  it("returns an expired result for the current user's compacted identity", async () => {
    mocks.tombstoneFindUnique.mockResolvedValue({ userId: "user-1" });
    await expect(getAccountBrowserOperationStatus(operationId)).resolves.toEqual({
      status: "expired",
      operationId,
      code: "operation_result_expired"
    });
  });

  it("is existence-neutral for another session, another user, missing rows, or stale authentication", async () => {
    mocks.bindingFindFirst.mockResolvedValue({
      sessionId: "other-session",
      userId: "user-1",
      operation: { operationId, status: "unknown", outcomeCode: null, outcomeSnapshot: null }
    });
    await expect(getAccountBrowserOperationStatus(operationId)).rejects.toThrow("not_found");

    mocks.bindingFindFirst.mockResolvedValue(null);
    mocks.tombstoneFindUnique.mockResolvedValue({ userId: "other-user" });
    await expect(getAccountBrowserOperationStatus(operationId)).rejects.toThrow("not_found");

    mocks.sessionFindFirst.mockResolvedValue(null);
    await expect(getAccountBrowserOperationStatus(operationId)).rejects.toThrow("unauthenticated");
  });

  it("is existence-neutral for a reservation tombstone issued by another current session", async () => {
    mocks.reservationTombstoneFindUnique.mockResolvedValue({
      sessionId: "other-session",
      userId: "user-1",
      terminalCode: "operation_abandoned"
    });

    await expect(getAccountBrowserOperationStatus(operationId)).rejects.toThrow("not_found");
  });
});
