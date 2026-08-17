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
    session: { findFirst: mocks.sessionFindFirst },
    user: { findFirst: mocks.userFindFirst, updateMany: mocks.userUpdateMany },
    accountOperationBinding: {
      findFirst: mocks.bindingFindFirst,
      create: mocks.bindingCreate,
      update: mocks.bindingUpdate
    },
    accountMutationOperation: {
      create: mocks.operationCreate,
      update: mocks.operationUpdate
    },
    accountMutationOperationTombstone: { findUnique: mocks.tombstoneFindUnique }
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
  mocks.transaction.mockImplementation((callback) => callback(tx()));
});

describe("account appearance", () => {
  it("reads the current global preference without household selection and defaults signed-out surfaces to system", async () => {
    await expect(getAccountAppearance()).resolves.toEqual({ appearanceMode: "system", appearanceRevision: 4 });
    expect(mocks.requireFreshSession).not.toHaveBeenCalled();

    mocks.getSession.mockResolvedValue(null);
    await expect(getCurrentAuthenticatedAppearanceMode()).resolves.toBe("system");
    expect(mocks.userFindUnique).toHaveBeenCalledTimes(1);
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
      operationKey: "account.appearance.update",
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
      operationKey: "account.appearance.update",
      openingFingerprint: "a".repeat(64),
      persistenceVersion: 2,
      protocolVersion: "browser_v2",
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

  it("records stale_revision instead of overwriting a newer tab", async () => {
    mocks.bindingFindFirst.mockResolvedValue({
      id: "binding-1",
      sessionId: "session-1",
      userId: "user-1",
      operationId,
      operationKey: "account.appearance.update",
      openingFingerprint: "a".repeat(64),
      persistenceVersion: 2,
      protocolVersion: "browser_v2",
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
