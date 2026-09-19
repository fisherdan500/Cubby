import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  transaction: vi.fn(),
  queryRaw: vi.fn(),
  executeRaw: vi.fn(),
  auditCreate: vi.fn()
}));

vi.mock("@/lib/db/prisma", () => ({ prisma: { $transaction: mocks.transaction } }));
vi.mock("@/server/auth/session", () => ({ requireUser: mocks.requireUser }));

import { claimPlatformSetup, normalizePlatformSetupCode } from "@/server/services/platform-setup";

const code = "7F3K92QDXB4M0ZHT";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireUser.mockResolvedValue({ id: "user-1", email: "owner@example.test" });
  mocks.transaction.mockImplementation((operation) =>
    operation({ $queryRaw: mocks.queryRaw, $executeRaw: mocks.executeRaw, platformAuditEvent: { create: mocks.auditCreate } })
  );
  mocks.queryRaw.mockResolvedValue([{ id: "platform", ownerUserId: "user-1" }]);
  mocks.executeRaw.mockResolvedValue(1);
  mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
});

describe("normalizePlatformSetupCode", () => {
  it("accepts the displayed grouping, spaces and lower case", () => {
    expect(normalizePlatformSetupCode("7f3k-92qd-xb4m-0zht")).toBe(code);
    expect(normalizePlatformSetupCode(" 7F3K 92QD XB4M 0ZHT ")).toBe(code);
  });
});

describe("claimPlatformSetup", () => {
  it("claims through the guarded database function for the signed-in account and audits it", async () => {
    await expect(claimPlatformSetup({ code: "7f3k-92qd-xb4m-0zht" })).resolves.toEqual({ ownerUserId: "user-1" });

    const [strings, ...values] = mocks.queryRaw.mock.calls[0] ?? [];
    expect((strings as string[]).join(" ")).toContain('public."claim_platform_setup"(');
    // The account is always the session's own, and the code reaches the database normalized.
    expect(values).toEqual(["user-1", code]);
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "platform.owner.setup_claim", actorUserId: "user-1", source: "setup_code" })
    });
    expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ isolationLevel: "Serializable" }));
  });

  it("rejects a malformed code before touching the database", async () => {
    for (const bad of ["", "SHORT", `${code}X`, "7F3K-92QD-XB4M-0ZHI", "7F3K-92QD-XB4M-0ZH!"]) {
      await expect(claimPlatformSetup({ code: bad })).rejects.toThrow("platform_setup_code_invalid");
    }
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("rejects extra fields instead of letting a caller name another account", async () => {
    await expect(claimPlatformSetup({ code, userId: "someone-else" })).rejects.toThrow();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("requires a signed-in user", async () => {
    mocks.requireUser.mockRejectedValue(new Error("unauthenticated"));
    await expect(claimPlatformSetup({ code })).rejects.toThrow("unauthenticated");
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it.each(["platform_setup_code_invalid", "platform_owner_already_bound", "platform_setup_account_ineligible"])(
    "surfaces the database's %s outcome and writes no audit event",
    async (outcome) => {
      mocks.queryRaw.mockRejectedValue(new Error(`Raw query failed. Code: \`P0001\`. Message: \`ERROR: ${outcome}\``));
      await expect(claimPlatformSetup({ code })).rejects.toThrow(outcome);
      expect(mocks.auditCreate).not.toHaveBeenCalled();
    }
  );

  it("treats a result bound to any other account as a failed claim", async () => {
    mocks.queryRaw.mockResolvedValue([{ id: "platform", ownerUserId: "someone-else" }]);
    await expect(claimPlatformSetup({ code })).rejects.toThrow("platform_setup_code_invalid");
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("reports a serialization conflict as retryable", async () => {
    mocks.transaction.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("conflict", { code: "P2034", clientVersion: "test" })
    );
    await expect(claimPlatformSetup({ code })).rejects.toThrow("platform_setup_retry");
  });
});
