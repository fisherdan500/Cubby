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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.keyLock.mockResolvedValue([{ id: "key-1" }]);
  mocks.apiKeyFindUnique.mockResolvedValue({
    id: "key-1",
    householdId: "household-1",
    scopes: ["read"],
    babyId: null,
    revokedAt: null,
    expiresAt: null,
    household: { deletedAt: null }
  });
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
  it("locks and rechecks the key before invoking a protected read", async () => {
    await expect(withApiKey(request, "read", mocks.protectedRead)).resolves.toEqual({ babies: [] });

    expect(mocks.keyLock).toHaveBeenCalledOnce();
    expect(mocks.apiKeyFindUnique).toHaveBeenCalledWith({ where: { id: "key-1" }, include: { household: true } });
    expect(mocks.protectedRead).toHaveBeenCalledWith(
      expect.objectContaining({ apiKeyId: "key-1", householdId: "household-1" }),
      expect.objectContaining({ apiKey: expect.anything() })
    );
  });

  it("rejects a key revoked before the locked transaction re-read and never invokes the protected read", async () => {
    mocks.apiKeyFindUnique.mockResolvedValueOnce({
      id: "key-1",
      householdId: "household-1",
      scopes: ["read"],
      babyId: null,
      revokedAt: new Date("2026-07-26T22:00:00.000Z"),
      expiresAt: null,
      household: { deletedAt: null }
    });

    await expect(withApiKey(request, "read", mocks.protectedRead)).rejects.toThrow("unauthenticated");
    expect(mocks.protectedRead).not.toHaveBeenCalled();
    expect(mocks.apiKeyUpdate).not.toHaveBeenCalled();
  });
});
