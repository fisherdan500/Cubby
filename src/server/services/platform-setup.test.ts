import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  transaction: vi.fn(),
  queryRaw: vi.fn(),
  executeRaw: vi.fn(),
  auditCreate: vi.fn(),
  hashPassword: vi.fn(),
  authorityFindUnique: vi.fn(),
  userFindFirst: vi.fn()
}));

vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    $transaction: mocks.transaction,
    platformAuthority: { findUnique: mocks.authorityFindUnique },
    user: { findFirst: mocks.userFindFirst }
  }
}));
vi.mock("@/server/auth/session", () => ({ requireUser: mocks.requireUser }));
vi.mock("better-auth/crypto", () => ({ hashPassword: mocks.hashPassword }));

import {
  claimPlatformSetup,
  createPlatformOwnerAccount,
  isFirstAccountSetupAvailable,
  normalizePlatformSetupCode
} from "@/server/services/platform-setup";

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

describe("isFirstAccountSetupAvailable", () => {
  it.each([
    [null, null, true],
    [{ id: "platform" }, null, false],
    [null, { id: "usr_existing" }, false],
    [{ id: "platform" }, { id: "usr_existing" }, false]
  ])("is available only with no owner and no account (owner %j, account %j)", async (authority, user, available) => {
    mocks.authorityFindUnique.mockResolvedValue(authority);
    mocks.userFindFirst.mockResolvedValue(user);

    await expect(isFirstAccountSetupAvailable()).resolves.toBe(available);
  });
});

describe("createPlatformOwnerAccount", () => {
  const firstAccount = {
    code: "7f3k-92qd-xb4m-0zht",
    name: "  Avery Parent  ",
    email: "  Owner@Example.TEST ",
    password: "correct horse battery"
  };

  beforeEach(() => {
    mocks.hashPassword.mockResolvedValue("scrypt:hashed-password");
    mocks.queryRaw.mockResolvedValue([{ id: "platform", ownerUserId: "usr_first" }]);
    mocks.authorityFindUnique.mockResolvedValue(null);
    mocks.userFindFirst.mockResolvedValue(null);
  });

  it.each([
    ["an owner is bound", { id: "platform" }, null, "platform_owner_already_bound"],
    ["an account exists", null, { id: "usr_existing" }, "platform_setup_install_not_empty"]
  ])("refuses before any password hashing once %s, so the open endpoint cannot be made to burn CPU", async (_label, authority, user, outcome) => {
    mocks.authorityFindUnique.mockResolvedValue(authority);
    mocks.userFindFirst.mockResolvedValue(user);

    await expect(createPlatformOwnerAccount(firstAccount)).rejects.toThrow(outcome);
    expect(mocks.hashPassword).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("creates and binds the first account in one guarded database call, without a session", async () => {
    await expect(createPlatformOwnerAccount(firstAccount)).resolves.toEqual({ ownerUserId: "usr_first" });

    expect(mocks.requireUser).not.toHaveBeenCalled();
    const [strings, ...values] = mocks.queryRaw.mock.calls[0] ?? [];
    expect((strings as string[]).join(" ")).toContain('public."create_platform_owner_account"(');
    // The database receives the normalized code, trimmed name and email, and only the password's hash.
    expect(values).toEqual([code, "Avery Parent", "owner@example.test", "scrypt:hashed-password"]);
    expect(values).not.toContain(firstAccount.password);
    expect(mocks.hashPassword).toHaveBeenCalledWith(firstAccount.password);
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "platform.owner.setup_claim",
        actorUserId: "usr_first",
        source: "setup_code_first_account"
      })
    });
    // The database function serializes with advisory locks; each statement after the lock has to see
    // what a concurrent setup committed, which a snapshot taken before the wait would not.
    expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ isolationLevel: "ReadCommitted" }));
  });

  it("rejects a malformed code before hashing or touching the database", async () => {
    await expect(createPlatformOwnerAccount({ ...firstAccount, code: "SHORT" })).rejects.toThrow("platform_setup_code_invalid");
    expect(mocks.hashPassword).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it.each([
    ["a blank name", { name: "   " }],
    ["a malformed email", { email: "not-an-email" }],
    ["a short password", { password: "seven77" }],
    ["an overlong password", { password: "p".repeat(129) }]
  ])("rejects %s before hashing or touching the database", async (_label, change) => {
    await expect(createPlatformOwnerAccount({ ...firstAccount, ...change })).rejects.toThrow("platform_setup_account_invalid");
    expect(mocks.hashPassword).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("rejects extra fields instead of letting a caller shape the account", async () => {
    await expect(createPlatformOwnerAccount({ ...firstAccount, emailVerified: false })).rejects.toThrow();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it.each([
    "platform_setup_code_invalid",
    "platform_owner_already_bound",
    "platform_setup_install_not_empty",
    "platform_setup_account_invalid"
  ])("surfaces the database's %s outcome and writes no audit event", async (outcome) => {
    mocks.queryRaw.mockRejectedValue(new Error(`Raw query failed. Code: \`P0001\`. Message: \`ERROR: ${outcome}\``));
    await expect(createPlatformOwnerAccount(firstAccount)).rejects.toThrow(outcome);
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("reports a serialization conflict with a concurrent setup as retryable", async () => {
    mocks.transaction.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("conflict", { code: "P2034", clientVersion: "test" })
    );
    await expect(createPlatformOwnerAccount(firstAccount)).rejects.toThrow("platform_setup_retry");
  });
});
