import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireFreshSession: vi.fn(),
  getSession: vi.fn(),
  transaction: vi.fn(),
  queryRaw: vi.fn(),
  sessionFindFirst: vi.fn(),
  userFindUnique: vi.fn(),
  userFindFirst: vi.fn(),
  userUpdateMany: vi.fn(),
  bindingFindFirst: vi.fn(),
  bindingCreate: vi.fn(),
  bindingUpdate: vi.fn(),
  bindingDelete: vi.fn(),
  reservationTombstoneCreate: vi.fn(),
  reservationTombstoneFindUnique: vi.fn(),
  operationCreate: vi.fn(),
  operationUpdate: vi.fn(),
  tombstoneFindUnique: vi.fn()
}));

vi.mock("@/server/auth/session", () => ({
  requireFreshSession: mocks.requireFreshSession,
  getSession: mocks.getSession
}));
vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    user: { findUnique: mocks.userFindUnique },
    $transaction: mocks.transaction
  }
}));

import {
  getAccountAppearance,
  getCurrentAuthenticatedAppearanceMode,
  issueAccountAppearanceBrowserOperation,
  abandonAccountAppearanceBrowserOperation,
  submitAccountAppearanceBrowserOperation
} from "@/server/services/account-appearance";

const operationId = "bmo_0123456789abcdefghjkmnpqrs";
const session = {
  user: { id: "user-1" },
  session: { id: "session-1", createdAt: new Date("2026-08-17T12:00:00Z") }
};

function tx() {
  return {
    $queryRaw: mocks.queryRaw,
    $executeRaw: mocks.queryRaw,
    session: { findFirst: mocks.sessionFindFirst },
    user: { findFirst: mocks.userFindFirst, updateMany: mocks.userUpdateMany },
    accountOperationBinding: {
      findFirst: mocks.bindingFindFirst,
      create: mocks.bindingCreate,
      update: mocks.bindingUpdate,
      delete: mocks.bindingDelete
    },
    accountMutationOperation: {
      create: mocks.operationCreate,
      update: mocks.operationUpdate
    },
    accountMutationOperationTombstone: { findUnique: mocks.tombstoneFindUnique },
    accountOperationReservationTombstone: {
      create: mocks.reservationTombstoneCreate,
      findUnique: mocks.reservationTombstoneFindUnique
    }
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireFreshSession.mockResolvedValue(session);
  mocks.getSession.mockResolvedValue(session);
  mocks.queryRaw.mockResolvedValue([]);
  mocks.sessionFindFirst.mockResolvedValue({ id: "session-1", userId: "user-1" });
  mocks.userFindFirst.mockResolvedValue({ id: "user-1", appearanceMode: "system", appearanceRevision: 4 });
  mocks.userFindUnique.mockResolvedValue({ appearanceMode: "system", appearanceRevision: 4 });
  mocks.bindingFindFirst.mockResolvedValue(null);
  mocks.tombstoneFindUnique.mockResolvedValue(null);
  mocks.bindingCreate.mockResolvedValue({ id: "binding-1" });
  mocks.bindingDelete.mockResolvedValue({ id: "binding-1" });
  mocks.reservationTombstoneCreate.mockResolvedValue({ operationId });
  mocks.reservationTombstoneFindUnique.mockResolvedValue(null);
  mocks.transaction.mockImplementation((callback) => callback(tx()));
});

describe("account appearance", () => {
  it("reads the current global preference without household selection and defaults signed-out surfaces to dark", async () => {
    await expect(getAccountAppearance()).resolves.toEqual({ appearanceMode: "system", appearanceRevision: 4 });
    expect(mocks.requireFreshSession).not.toHaveBeenCalled();

    mocks.getSession.mockResolvedValue(null);
    // A signed-out surface has no stored choice to honour, so it opens the way the app now opens.
    await expect(getCurrentAuthenticatedAppearanceMode()).resolves.toBe("dark");
    expect(mocks.userFindUnique).toHaveBeenCalledTimes(1);
  });

  it("honours a stored mode rather than the new default", async () => {
    for (const stored of ["system", "light", "dark"] as const) {
      mocks.userFindUnique.mockResolvedValue({ appearanceMode: stored, appearanceRevision: 4 });
      await expect(getCurrentAuthenticatedAppearanceMode()).resolves.toBe(stored);
    }
  });

  it("opens dark for an account with no stored mode at all", async () => {
    mocks.userFindUnique.mockResolvedValue(null);
    await expect(getCurrentAuthenticatedAppearanceMode()).resolves.toBe("dark");
  });

  it("records an account reservation tombstone before deleting an authorized unsubmitted binding", async () => {
    mocks.bindingFindFirst.mockResolvedValue({
      id: "binding-1",
      sessionId: "session-1",
      userId: "user-1",
      operationId,
      operationKey: "accountAppearanceUpdate",
      openingFingerprint: "a".repeat(64),
      state: "open",
      issuedAt: new Date("2026-08-19T00:00:00Z"),
      operation: null
    });

    await expect(abandonAccountAppearanceBrowserOperation({ operationId })).resolves.toEqual({
      status: "expired", operationId, code: "operation_abandoned"
    });
    expect(mocks.reservationTombstoneCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ userId: "user-1", operationId, sessionId: "session-1", terminalCode: "operation_abandoned" })
    }));
    expect(mocks.reservationTombstoneCreate.mock.invocationCallOrder[0]).toBeLessThan(mocks.bindingDelete.mock.invocationCallOrder[0]);
  });

  it.each(["operation_abandoned", "operation_result_expired"] as const)(
    "replays an authorized %s account reservation tombstone during issue",
    async (terminalCode) => {
      mocks.reservationTombstoneFindUnique.mockResolvedValue({
        userId: "user-1",
        operationId,
        operationKey: "accountAppearanceUpdate",
        sessionId: "session-1",
        terminalCode
      });

      await expect(issueAccountAppearanceBrowserOperation({ operationId })).resolves.toEqual({
        status: "expired", operationId, code: terminalCode
      });
      expect(mocks.bindingCreate).not.toHaveBeenCalled();
    }
  );

  it.each([
    { sessionId: "session-other", userId: "user-1", operationKey: "accountAppearanceUpdate" },
    { sessionId: "session-1", userId: "user-other", operationKey: "accountAppearanceUpdate" },
    { sessionId: "session-1", userId: "user-1", operationKey: "account.other.operation" }
  ])("keeps a mismatched account reservation tombstone existence-neutral during issue", async (mismatch) => {
    mocks.reservationTombstoneFindUnique.mockResolvedValue({
      ...mismatch,
      operationId,
      terminalCode: "operation_abandoned"
    });

    await expect(issueAccountAppearanceBrowserOperation({ operationId })).rejects.toThrow("not_found");
    expect(mocks.bindingCreate).not.toHaveBeenCalled();
  });

  it("recovers an authorized account reservation tombstone that wins the binding insert race", async () => {
    mocks.transaction.mockRejectedValueOnce({
      code: "P2004",
      meta: { database_error: "account_operation_reservation_identity_already_owned" }
    });
    mocks.reservationTombstoneFindUnique.mockResolvedValue({
      userId: "user-1",
      operationId,
      operationKey: "accountAppearanceUpdate",
      sessionId: "session-1",
      terminalCode: "operation_result_expired"
    });

    await expect(issueAccountAppearanceBrowserOperation({ operationId })).resolves.toEqual({
      status: "expired", operationId, code: "operation_result_expired"
    });
    expect(mocks.transaction).toHaveBeenCalledTimes(2);
    expect(mocks.bindingCreate).not.toHaveBeenCalled();
  });

  it("issues a server-generated reservation when the browser has no operation identity", async () => {
    await expect(issueAccountAppearanceBrowserOperation({})).resolves.toMatchObject({
      status: "open",
      operationId: expect.stringMatching(/^bmo_[0-9abcdefghjkmnpqrstvwxyz]{26}$/),
      bindingId: "binding-1"
    });
    const generated = mocks.bindingCreate.mock.calls[0][0].data.operationId;
    expect(generated).toMatch(/^bmo_[0-9abcdefghjkmnpqrstvwxyz]{26}$/);
  });

  it("retries a serialization conflict across the full account issue transaction", async () => {
    mocks.transaction.mockRejectedValueOnce(Object.assign(new Error("write conflict"), { code: "P2034" }));
    await expect(issueAccountAppearanceBrowserOperation({ operationId })).resolves.toEqual({ status: "open", operationId, bindingId: "binding-1" });
    expect(mocks.transaction).toHaveBeenCalledTimes(2);
  });

  it("issues a payload-free opening binding over the exact uncached session and User revision", async () => {
    await expect(issueAccountAppearanceBrowserOperation({ operationId })).resolves.toEqual({
      status: "open",
      operationId,
      bindingId: "binding-1"
    });

    const data = mocks.bindingCreate.mock.calls[0][0].data;
    expect(data).toMatchObject({
      sessionId: "session-1",
      userId: "user-1",
      operationId,
      operationKey: "accountAppearanceUpdate",
      state: "open",
      targetSnapshot: { appearanceMode: "system", appearanceRevision: 4, schemaVersion: 1 }
    });
    expect(data.openingFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(data)).not.toContain('"light"');
  });

  it("persists a submit-only mode with revision CAS and an allowlisted terminal replay", async () => {
    mocks.bindingFindFirst.mockResolvedValue({
      id: "binding-1",
      sessionId: "session-1",
      userId: "user-1",
      operationId,
      operationKey: "accountAppearanceUpdate",
      openingFingerprint: "a".repeat(64),
      persistenceVersion: 2,
      protocolVersion: "browserV2",
      expiresAt: new Date("2099-01-01T00:00:00Z"),
      state: "open",
      targetSnapshot: { appearanceMode: "system", appearanceRevision: 4, schemaVersion: 1 },
      operation: null
    });
    mocks.operationCreate.mockResolvedValue({ operationId, status: "pending", outcomeCode: null, outcomeSnapshot: null });
    mocks.userUpdateMany.mockResolvedValue({ count: 1 });
    mocks.operationUpdate.mockResolvedValue({
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
    });

    await expect(submitAccountAppearanceBrowserOperation({ operationId, appearanceMode: "dark" })).resolves.toMatchObject({
      status: "completed",
      outcome: { appearanceMode: "dark", appearanceRevision: 5 }
    });
    expect(mocks.userUpdateMany).toHaveBeenCalledWith({
      where: { id: "user-1", appearanceRevision: 4 },
      data: { appearanceMode: "dark", appearanceRevision: { increment: 1 } }
    });
    expect(mocks.operationCreate.mock.calls[0][0].data.intentFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("retries a serialization conflict across the full account submit transaction", async () => {
    mocks.transaction.mockRejectedValueOnce(Object.assign(new Error("could not serialize access"), { code: "P2010", meta: { code: "40001" } }));
    mocks.reservationTombstoneFindUnique.mockResolvedValue({
      userId: "user-1",
      operationId,
      operationKey: "accountAppearanceUpdate",
      sessionId: "session-1",
      terminalCode: "operation_result_expired"
    });
    await expect(submitAccountAppearanceBrowserOperation({ operationId, appearanceMode: "dark" })).resolves.toEqual({
      status: "expired", operationId, code: "operation_result_expired"
    });
    expect(mocks.transaction).toHaveBeenCalledTimes(2);
  });

  it.each(["operation_abandoned", "operation_result_expired"] as const)(
    "replays an authorized %s account reservation tombstone during submit",
    async (terminalCode) => {
      mocks.reservationTombstoneFindUnique.mockResolvedValue({
        userId: "user-1",
        operationId,
        operationKey: "accountAppearanceUpdate",
        sessionId: "session-1",
        terminalCode
      });

      await expect(submitAccountAppearanceBrowserOperation({ operationId, appearanceMode: "dark" })).resolves.toEqual({
        status: "expired", operationId, code: terminalCode
      });
      expect(mocks.operationCreate).not.toHaveBeenCalled();
      expect(mocks.userUpdateMany).not.toHaveBeenCalled();
    }
  );

  it.each([
    { sessionId: "session-other", userId: "user-1", operationKey: "accountAppearanceUpdate" },
    { sessionId: "session-1", userId: "user-1", operationKey: "account.other.operation" }
  ])("keeps a mismatched account reservation tombstone existence-neutral during submit", async (mismatch) => {
    mocks.reservationTombstoneFindUnique.mockResolvedValue({
      ...mismatch,
      operationId,
      terminalCode: "operation_result_expired"
    });

    await expect(submitAccountAppearanceBrowserOperation({ operationId, appearanceMode: "dark" })).rejects.toThrow("not_found");
    expect(mocks.operationCreate).not.toHaveBeenCalled();
    expect(mocks.userUpdateMany).not.toHaveBeenCalled();
  });

  it("records stale_revision instead of overwriting a newer tab", async () => {
    mocks.bindingFindFirst.mockResolvedValue({
      id: "binding-1",
      sessionId: "session-1",
      userId: "user-1",
      operationId,
      operationKey: "accountAppearanceUpdate",
      openingFingerprint: "a".repeat(64),
      persistenceVersion: 2,
      protocolVersion: "browserV2",
      expiresAt: new Date("2099-01-01T00:00:00Z"),
      state: "open",
      targetSnapshot: { appearanceMode: "system", appearanceRevision: 4, schemaVersion: 1 },
      operation: null
    });
    mocks.operationCreate.mockResolvedValue({ operationId, status: "pending", outcomeCode: null, outcomeSnapshot: null });
    mocks.userUpdateMany.mockResolvedValue({ count: 0 });
    mocks.operationUpdate.mockResolvedValue({ operationId, status: "stale", outcomeCode: "stale_revision", outcomeSnapshot: null });

    await expect(submitAccountAppearanceBrowserOperation({ operationId, appearanceMode: "light" })).resolves.toEqual({
      status: "stale",
      operationId,
      code: "stale_revision"
    });
    expect(mocks.bindingUpdate).toHaveBeenLastCalledWith({ where: { id: "binding-1" }, data: { state: "terminal" } });
  });

  it("fails closed when the exact session disappears before submit", async () => {
    mocks.sessionFindFirst.mockResolvedValue(null);
    await expect(issueAccountAppearanceBrowserOperation({ operationId })).rejects.toThrow("stale_context");
    expect(mocks.bindingCreate).not.toHaveBeenCalled();
  });
});
