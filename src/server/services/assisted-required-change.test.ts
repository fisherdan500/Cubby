import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assistedFindUnique: vi.fn(),
  memberFindFirst: vi.fn(),
  accountFindFirst: vi.fn(),
  getSession: vi.fn(),
  verify: vi.fn(),
  hash: vi.fn(),
  changePassword: vi.fn(),
  captureContext: vi.fn()
}));

vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    assistedAccountState: { findUnique: mocks.assistedFindUnique },
    householdMember: { findFirst: mocks.memberFindFirst },
    account: { findFirst: mocks.accountFindFirst }
  }
}));
vi.mock("@/lib/auth/auth", () => ({
  auth: { $context: Promise.resolve({ password: { verify: mocks.verify, hash: mocks.hash } }) },
  SESSION_FRESH_AGE_SECONDS: 600
}));
vi.mock("@/server/auth/session", () => ({ getSession: mocks.getSession }));
vi.mock("better-auth/crypto", () => ({ verifyPassword: mocks.verify }));
vi.mock("@/server/services/global-security", () => ({
  changePasswordWithCurrentPassword: mocks.changePassword,
  captureGlobalSecurityContext: mocks.captureContext
}));

import {
  REQUIRED_PASSWORD_CHANGE_PATH,
  assistedHomeBridgeTarget,
  classifyCurrentIdentity,
  completeRequiredPasswordChange,
  hasOutstandingRequiredChange
} from "@/server/services/assisted-required-change";

const userId = "user-1";
const sessionId = "session-1";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSession.mockResolvedValue({ user: { id: userId }, session: { id: sessionId } });
  mocks.assistedFindUnique.mockResolvedValue(null);
  mocks.memberFindFirst.mockResolvedValue(null);
  mocks.accountFindFirst.mockResolvedValue({ password: "scrypthash:abcdef" });
  mocks.verify.mockResolvedValue(false);
  mocks.changePassword.mockResolvedValue({ operationId: "gso_x", status: "signed_out" });
  mocks.captureContext.mockResolvedValue({ userId, sessionId, credentialVersion: 1, sessionSecurityVersion: 1 });
});

describe("outstanding requirement detection", () => {
  it("treats any nonnull required version as outstanding, including a mismatched one", async () => {
    for (const requiredChangeCredentialVersion of [1, 2, 99]) {
      mocks.assistedFindUnique.mockResolvedValue({ userId, requiredChangeCredentialVersion });
      await expect(hasOutstandingRequiredChange(userId)).resolves.toBe(true);
    }
  });

  it("treats an absent row or a cleared obligation as ordinary", async () => {
    mocks.assistedFindUnique.mockResolvedValue(null);
    await expect(hasOutstandingRequiredChange(userId)).resolves.toBe(false);

    mocks.assistedFindUnique.mockResolvedValue({ userId, requiredChangeCredentialVersion: null });
    await expect(hasOutstandingRequiredChange(userId)).resolves.toBe(false);
  });
});

describe("identity classification", () => {
  it("classifies an unauthenticated visitor without reading assisted state", async () => {
    mocks.getSession.mockResolvedValue(null);

    await expect(classifyCurrentIdentity()).resolves.toEqual({
      classification: "unauthenticated", userId: null, sessionId: null
    });
    expect(mocks.assistedFindUnique).not.toHaveBeenCalled();
  });

  it("classifies an ordinary signed-in user", async () => {
    await expect(classifyCurrentIdentity()).resolves.toEqual({
      classification: "ordinary", userId, sessionId
    });
  });

  it("classifies a user with an outstanding obligation as restricted rather than anonymous", async () => {
    mocks.assistedFindUnique.mockResolvedValue({ userId, requiredChangeCredentialVersion: 1 });

    await expect(classifyCurrentIdentity()).resolves.toEqual({
      classification: "restricted", userId, sessionId
    });
  });

  it("routes restricted identity to the protocol corridor path", () => {
    expect(REQUIRED_PASSWORD_CHANGE_PATH).toBe("/account/required-password-change");
  });
});

describe("required password change completion", () => {
  const submission = {
    operationId: "gso_0123456789abcdefghjkmnpqrs",
    openingFingerprint: "a".repeat(64),
    intentFingerprint: "b".repeat(64),
    currentPassword: "temporary-secret",
    newPassword: "a brand new secret",
    newPasswordConfirmation: "a brand new secret"
  };

  it("completes through the canonical self password change engine", async () => {
    mocks.assistedFindUnique.mockResolvedValue({ userId, requiredChangeCredentialVersion: 1 });

    await expect(completeRequiredPasswordChange(submission)).resolves.toMatchObject({ signInRequired: true });
    expect(mocks.changePassword).toHaveBeenCalledTimes(1);
    const args = mocks.changePassword.mock.calls[0];
    expect(args[3]).toBe(submission.currentPassword);
    expect(args[4]).toBe(submission.newPassword);
  });

  it("rejects a confirmation mismatch and never calls the change engine", async () => {
    mocks.assistedFindUnique.mockResolvedValue({ userId, requiredChangeCredentialVersion: 1 });

    await expect(completeRequiredPasswordChange({ ...submission, newPasswordConfirmation: "different" }))
      .rejects.toThrow("required_password_change_request_invalid");
    expect(mocks.changePassword).not.toHaveBeenCalled();
  });

  it("rejects reusing the administrator-known temporary password by NFKC-equivalent verification", async () => {
    mocks.assistedFindUnique.mockResolvedValue({ userId, requiredChangeCredentialVersion: 1 });
    mocks.verify.mockResolvedValue(true);

    await expect(completeRequiredPasswordChange({
      ...submission, newPassword: "temporary-secret", newPasswordConfirmation: "temporary-secret"
    })).rejects.toThrow("required_password_change_reuse");
    expect(mocks.changePassword).not.toHaveBeenCalled();
  });

  it("refuses when the caller has no outstanding obligation", async () => {
    mocks.assistedFindUnique.mockResolvedValue({ userId, requiredChangeCredentialVersion: null });

    await expect(completeRequiredPasswordChange(submission)).rejects.toThrow("forbidden");
    expect(mocks.changePassword).not.toHaveBeenCalled();
  });

  it("refuses an unauthenticated caller", async () => {
    mocks.getSession.mockResolvedValue(null);

    await expect(completeRequiredPasswordChange(submission)).rejects.toThrow("unauthenticated");
  });
});

describe("assisted home bridge", () => {
  it("selects only the recorded assisted creation membership when still authorized", async () => {
    mocks.assistedFindUnique.mockResolvedValue({
      userId, requiredChangeCredentialVersion: null, assistedCreationMemberId: "member-1"
    });
    mocks.memberFindFirst.mockResolvedValue({ id: "member-1" });

    await expect(assistedHomeBridgeTarget(userId)).resolves.toEqual({ path: "/app", memberId: "member-1" });
    expect(mocks.memberFindFirst).toHaveBeenCalledWith({
      where: {
        id: "member-1",
        userId,
        disabledAt: null,
        deletedAt: null,
        household: { deletedAt: null }
      },
      select: { id: true }
    });
  });

  it("never falls back to an arbitrary first membership", async () => {
    mocks.assistedFindUnique.mockResolvedValue({
      userId, requiredChangeCredentialVersion: null, assistedCreationMemberId: null
    });

    await expect(assistedHomeBridgeTarget(userId)).resolves.toEqual({ path: "/", memberId: null });
    expect(mocks.memberFindFirst).not.toHaveBeenCalled();
  });

  it("does not select a revoked assisted membership", async () => {
    mocks.assistedFindUnique.mockResolvedValue({
      userId, requiredChangeCredentialVersion: null, assistedCreationMemberId: "member-1"
    });
    mocks.memberFindFirst.mockResolvedValue(null);

    await expect(assistedHomeBridgeTarget(userId)).resolves.toEqual({ path: "/", memberId: null });
  });

  it("refuses to bridge while the obligation is outstanding", async () => {
    mocks.assistedFindUnique.mockResolvedValue({
      userId, requiredChangeCredentialVersion: 1, assistedCreationMemberId: "member-1"
    });

    await expect(assistedHomeBridgeTarget(userId)).resolves.toEqual({
      path: REQUIRED_PASSWORD_CHANGE_PATH, memberId: null
    });
    expect(mocks.memberFindFirst).not.toHaveBeenCalled();
  });
});
