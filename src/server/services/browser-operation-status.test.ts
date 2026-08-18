import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getContext: vi.fn(),
  getSession: vi.fn(),
  transaction: vi.fn(),
  queryRaw: vi.fn(),
  sessionFindFirst: vi.fn(),
  memberFindFirst: vi.fn(),
  bindingFindFirst: vi.fn(),
  tombstoneFindUnique: vi.fn()
}));

vi.mock("@/server/auth/context", () => ({
  getEffectiveHouseholdContext: mocks.getContext
}));
vi.mock("@/server/auth/session", () => ({ getSession: mocks.getSession }));
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
  mocks.queryRaw.mockResolvedValue([]);
  mocks.sessionFindFirst.mockResolvedValue({ id: "session-1" });
  mocks.memberFindFirst.mockResolvedValue({ id: "member-1" });
  mocks.bindingFindFirst.mockResolvedValue(null);
  mocks.tombstoneFindUnique.mockResolvedValue(null);
  mocks.transaction.mockImplementation((callback) => callback({
    $queryRaw: mocks.queryRaw,
    session: { findFirst: mocks.sessionFindFirst },
    householdMember: { findFirst: mocks.memberFindFirst },
    browserOperationBinding: { findFirst: mocks.bindingFindFirst },
    browserMutationOperationTombstone: { findUnique: mocks.tombstoneFindUnique }
  }));
});

describe("household browser operation status", () => {
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
});
