import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  keyLock: vi.fn(),
  apiKeyFindUnique: vi.fn(),
  apiKeyUpdate: vi.fn(),
  memberFindFirst: vi.fn(),
  protectedRead: vi.fn()
}));

vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    $transaction: mocks.transaction
  }
}));

import { withApiKey } from "@/server/services/hooks";

const request = new Request("https://example.test/api/hooks/v1/babies", {
  headers: { authorization: "Bearer cubby_test" }
});

const issuedKey = {
  id: "key-1",
  householdId: "household-1",
  delegatedByMemberId: "member-delegator",
  scopes: ["read"],
  babyId: null,
  revokedAt: null,
  expiresAt: null,
  household: { deletedAt: null },
  legacyUnattributed: false,
  delegatedByMember: {
    id: "member-delegator",
    userId: "delegator-user",
    householdId: "household-1",
    role: "parent",
    disabledAt: null,
    deletedAt: null
  }
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.keyLock.mockResolvedValue([{ id: "key-1" }]);
  mocks.apiKeyFindUnique.mockResolvedValue(issuedKey);
  mocks.apiKeyUpdate.mockResolvedValue({ id: "key-1" });
  mocks.memberFindFirst.mockResolvedValue({
    id: "member-1",
    userId: "user-1",
    role: "owner"
  });
  mocks.protectedRead.mockResolvedValue({ babies: [] });
  mocks.transaction.mockImplementation((callback) => callback({
    $queryRaw: mocks.keyLock,
    apiKey: { findUnique: mocks.apiKeyFindUnique, update: mocks.apiKeyUpdate },
    householdMember: { findFirst: mocks.memberFindFirst }
  }));
});

describe("hook API-key capability boundary", () => {
  it("uses the active issuing membership episode rather than a remaining household member", async () => {
    await withApiKey(request, "read", mocks.protectedRead);

    expect(mocks.protectedRead).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKeyId: "key-1",
        memberId: "member-delegator",
        userId: "delegator-user",
        role: "parent"
      }),
      expect.anything()
    );
  });

  it("rejects an episode-owned key after its issuing membership closes", async () => {
    mocks.apiKeyFindUnique
      .mockResolvedValueOnce({
        id: "key-1",
        householdId: "household-1",
        delegatedByMemberId: "member-delegator",
        legacyUnattributed: false
      })
      .mockResolvedValueOnce({
        ...issuedKey,
        delegatedByMember: { ...issuedKey.delegatedByMember, deletedAt: new Date("2026-07-30T08:00:00.000Z") }
      });

    await expect(withApiKey(request, "read", mocks.protectedRead)).rejects.toThrow("unauthenticated");
    expect(mocks.protectedRead).not.toHaveBeenCalled();
  });

  it("rejects a legacy-unattributed key instead of adopting a remaining household member", async () => {
    mocks.apiKeyFindUnique.mockResolvedValueOnce({
      id: "key-legacy",
      householdId: "household-1",
      legacyUnattributed: true,
      delegatedByMemberId: null
    });

    await expect(withApiKey(request, "read", mocks.protectedRead)).rejects.toThrow("unauthenticated");
    expect(mocks.memberFindFirst).not.toHaveBeenCalled();
    expect(mocks.protectedRead).not.toHaveBeenCalled();
    expect(mocks.apiKeyUpdate).not.toHaveBeenCalled();
  });

  it("locks the active issuing membership before locking the API key and invoking a protected read", async () => {
    mocks.keyLock.mockImplementation((query: TemplateStringsArray) =>
      String(query).includes('FROM "HouseholdMember"') ? [{ id: "member-delegator" }] : [{ id: "key-1" }]
    );

    await withApiKey(request, "read", mocks.protectedRead);

    const membershipLockIndex = mocks.keyLock.mock.calls.findIndex(([query]) => String(query).includes('FROM "HouseholdMember"'));
    const keyLockIndex = mocks.keyLock.mock.calls.findIndex(([query]) => String(query).includes('FROM "ApiKey"'));
    expect(membershipLockIndex).toBeGreaterThanOrEqual(0);
    expect(keyLockIndex).toBeGreaterThan(membershipLockIndex);
    expect(mocks.protectedRead).toHaveBeenCalledOnce();
  });

  it("locks and rechecks the key before invoking a protected read", async () => {
    await expect(withApiKey(request, "read", mocks.protectedRead)).resolves.toEqual({ babies: [] });

    expect(mocks.keyLock).toHaveBeenCalledTimes(2);
    expect(mocks.apiKeyFindUnique).toHaveBeenCalledWith({
      where: { id: "key-1" },
      include: { household: true, delegatedByMember: true }
    });
    expect(mocks.protectedRead).toHaveBeenCalledWith(
      expect.objectContaining({ apiKeyId: "key-1", householdId: "household-1" }),
      expect.objectContaining({ apiKey: expect.anything() })
    );
  });

  it("rejects a key revoked before the locked transaction re-read and never invokes the protected read", async () => {
    mocks.apiKeyFindUnique
      .mockResolvedValueOnce({
        id: "key-1",
        householdId: "household-1",
        delegatedByMemberId: "member-delegator",
        legacyUnattributed: false
      })
      .mockResolvedValueOnce({ ...issuedKey, revokedAt: new Date("2026-07-26T22:00:00.000Z") });

    await expect(withApiKey(request, "read", mocks.protectedRead)).rejects.toThrow("unauthenticated");
    expect(mocks.protectedRead).not.toHaveBeenCalled();
    expect(mocks.apiKeyUpdate).not.toHaveBeenCalled();
  });
});
