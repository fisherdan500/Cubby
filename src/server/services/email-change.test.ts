import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { cancelVerifiedEmailChange, completeVerifiedEmailChange, confirmEmailChangeRotationCookie, confirmEmailChangeSuccessorCookieForAuthenticatedSession, emitEmailChangeSuccessorCookie, expireUnconfirmedEmailChangeRotation, expireVerifiedEmailChange, failEmailChangeRotationCookie, getVerifiedEmailChangeStatus, initiateVerifiedEmailChange, verifyEmailChangeToken } from "@/server/services/email-change";

const operationId = "gso_00000000000000000000000000";
const context = { userId: "user-1", sessionId: "session-1", credentialVersion: 2, sessionSecurityVersion: 3 };

describe("verified email change", () => {
  it("delegates verification, one-time completion, and cookie confirmation to guarded database procedures", async () => {
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      $queryRaw: vi.fn(async (query) => {
        const sql = query.join(" ");
        if (sql.includes("email_change_cutover_invitation_candidates")) return [];
        if (sql.includes("verify_email_change_token")) return [{ state: "verified" }];
        if (sql.includes("complete_verified_email_change")) return [{ state: "completed" }];
        if (sql.includes("confirm_email_change_rotation_cookie")) return [{ state: "confirmed" }];
        return [];
      })
    };
    const database = { $transaction: vi.fn(async (callback) => callback(tx)) };
    await expect(verifyEmailChangeToken(database as never, { userId: "user-1", operationId, token: "token" })).resolves.toEqual({ operationId, status: "verified" });
    await expect(completeVerifiedEmailChange(database as never, { userId: "user-1", operationId, oldSessionId: "session-1", successorSessionId: "session-2", successorToken: "successor-token", successorExpiresAt: new Date("2030-01-02T00:00:00Z") })).resolves.toEqual({ operationId, status: "completed" });
    await expect(confirmEmailChangeRotationCookie(database as never, { userId: "user-1", operationId, successorSessionId: "session-2", successorToken: "successor-token" })).resolves.toEqual({ operationId, status: "confirmed" });
    expect(tx.$queryRaw).toHaveBeenCalledTimes(4);
  });

  it("prepares digest-only invitation replacements and encrypted notices before the guarded cutover", async () => {
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      $queryRaw: vi.fn(async (query) => {
        const sql = query.join(" ");
        if (sql.includes("email_change_cutover_invitation_candidates")) {
          return [{ oldInviteId: "invite-old", householdId: "household-1", role: "parent", invitedByUserId: "inviter-1", expiresAt: new Date("2030-01-03T00:00:00Z"), newEmail: "new@example.invalid", inviterEmail: "inviter@example.invalid" }];
        }
        if (sql.includes("complete_verified_email_change")) return [{ state: "completed" }];
        return [];
      })
    };
    const database = { $transaction: vi.fn(async (callback) => callback(tx)) };
    const encrypt = vi.fn(() => ({ keyVersion: 3, ciphertext: Buffer.from("ciphertext"), iv: Buffer.alloc(12, 1), authTag: Buffer.alloc(16, 2), aadDigest: Buffer.alloc(32, 3) }));

    await expect(completeVerifiedEmailChange(database as never, { userId: "user-1", operationId, oldSessionId: "session-1", successorSessionId: "session-2", successorToken: "successor-token", successorExpiresAt: new Date("2030-01-02T00:00:00Z") }, { generateInviteToken: () => "raw-replacement-invite-token", cipher: { encrypt } as never })).resolves.toEqual({ operationId, status: "completed" });

    expect(encrypt).toHaveBeenCalledTimes(2);
    const cutoverCall = tx.$queryRaw.mock.calls.find(([query]) => query.join(" ").includes("complete_verified_email_change"));
    expect(cutoverCall).toBeDefined();
    const retainedSqlInputs = JSON.stringify(cutoverCall);
    expect(retainedSqlInputs).toContain("sha256:");
    expect(retainedSqlInputs).not.toContain("raw-replacement-invite-token");
    expect(retainedSqlInputs).not.toContain("new@example.invalid");
    expect(retainedSqlInputs).not.toContain("inviter@example.invalid");
  });

  it("keeps cancellation, passive expiry, cookie failure, and status behind metadata-only procedures", async () => {
    const tx = { $queryRaw: vi.fn().mockResolvedValueOnce([{ state: "cancelled" }]).mockResolvedValueOnce([{ state: "expired" }]).mockResolvedValueOnce([{ state: "failed" }]).mockResolvedValueOnce([{ state: "failed" }]).mockResolvedValueOnce([{ state: "completed", old_address_notice_failed: true, cookie_state: "confirmed" }]) };
    const database = { $transaction: vi.fn(async (callback) => callback(tx)) };
    await expect(cancelVerifiedEmailChange(database as never, { userId: "user-1", operationId, sessionId: "session-1" })).resolves.toEqual({ operationId, status: "cancelled" });
    await expect(expireVerifiedEmailChange(database as never, { userId: "user-1", operationId })).resolves.toEqual({ operationId, status: "expired" });
    await expect(failEmailChangeRotationCookie(database as never, { userId: "user-1", operationId })).resolves.toEqual({ operationId, status: "failed" });
    await expect(expireUnconfirmedEmailChangeRotation(database as never, { userId: "user-1", operationId })).resolves.toEqual({ operationId, status: "failed" });
    await expect(getVerifiedEmailChangeStatus(database as never, { userId: "user-1", operationId, sessionId: "session-2" })).resolves.toEqual({ operationId, status: "completed", oldAddressNoticeFailed: true, cookieState: "confirmed" });
    expect(String(tx.$queryRaw.mock.calls)).not.toContain("old@example.invalid");
    expect(String(tx.$queryRaw.mock.calls)).toContain("session-1");
  });

  it("emits the Better Auth successor cookie post-commit and leaves confirmation to an authenticated successor request", async () => {
    const setCookie = vi.fn().mockResolvedValue(undefined);
    const database = { $transaction: vi.fn() };
    await expect(emitEmailChangeSuccessorCookie(database as never, { userId: "user-1", operationId, successorSessionId: "session-2", successorToken: "successor-token", cookieContext: {} as never, session: { id: "session-2", userId: "user-1", token: "successor-token" } as never, user: { id: "user-1" } as never }, { setCookie })).resolves.toEqual({ operationId, status: "issued" });
    expect(setCookie).toHaveBeenCalledTimes(1);
    expect(database.$transaction).not.toHaveBeenCalled();

    const tx = { $queryRaw: vi.fn().mockResolvedValue([{ state: "confirmed" }]) };
    const confirmDatabase = { $transaction: vi.fn(async (callback) => callback(tx)) };
    await expect(confirmEmailChangeSuccessorCookieForAuthenticatedSession(confirmDatabase as never, { userId: "user-1", sessionId: "session-2", sessionToken: "successor-token", credentialVersion: 3, sessionSecurityVersion: 4 }, { operationId })).resolves.toEqual({ operationId, status: "confirmed" });
    expect(String(tx.$queryRaw.mock.calls)).not.toContain("successor-token");
    const digest = tx.$queryRaw.mock.calls[0]!.at(-1);
    expect(Buffer.from(digest as Uint8Array)).toEqual(createHash("sha256").update("successor-token").digest());
  });

  it("revokes the successor and requires sign-in when cookie emission fails", async () => {
    const tx = { $queryRaw: vi.fn().mockResolvedValue([{ state: "failed" }]) };
    const database = { $transaction: vi.fn(async (callback) => callback(tx)) };
    await expect(emitEmailChangeSuccessorCookie(database as never, { userId: "user-1", operationId, successorSessionId: "session-2", successorToken: "successor-token", cookieContext: {} as never, session: { id: "session-2", userId: "user-1", token: "successor-token" } as never, user: { id: "user-1" } as never }, { setCookie: vi.fn().mockRejectedValue(new Error("blocked")) })).resolves.toEqual({ operationId, status: "signed_out" });
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it("creates fresh authorization, the bound operation, pending change, and four encrypted deliveries in one transaction", async () => {
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      $queryRaw: vi.fn(async (query) => {
        const sql = query.join(" ");
        if (sql.includes('AS normalized')) return [{ normalized: "new@example.invalid" }];
        if (sql.includes('AS "normalizedCurrentEmail"')) return [{ email: "old@example.invalid", normalizedCurrentEmail: "old@example.invalid" }];
        if (sql.includes('AS "authorized"') || sql.includes('authorize_global_session_security')) return [{ authorized: true }];
        if (sql.includes('FROM "User"') && sql.includes('FOR NO KEY UPDATE')) return [{ id: "user-1", email: "old@example.invalid" }];
        if (sql.includes('FROM "Session"')) return [{ id: "session-1", userId: "user-1" }];
        if (sql.includes('FROM "AccountSecurityState"')) return [{ credentialVersion: 2, sessionSecurityVersion: 3 }];
        if (sql.includes('collision')) return [{ collision: false }];
        if (sql.includes('clock_timestamp')) return [{ createdAt: new Date("2030-01-01T00:00:00Z"), expiresAt: new Date("2030-01-01T01:00:00Z") }];
        return [];
      }),
      accountSecurityState: { upsert: vi.fn().mockResolvedValue({ userId: "user-1", credentialVersion: 2, sessionSecurityVersion: 3 }) },
      account: { findFirst: vi.fn().mockResolvedValue({ password: "stored-hash" }) },
      globalSecurityOperationBinding: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ id: "binding-1" }), update: vi.fn().mockResolvedValue({}) },
      globalSecurityOperation: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({}) },
      freshAuthGrant: { create: vi.fn().mockResolvedValue({ id: "grant-1" }) },
      emailChange: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ id: "email-change-1" }) },
      emailChangeDelivery: { createMany: vi.fn().mockResolvedValue({ count: 4 }) }
    };
    const database = { $transaction: vi.fn(async (callback) => callback(tx)) };
    const encrypt = vi.fn((_binding, payload) => ({ keyVersion: 1, ciphertext: Buffer.from(JSON.stringify(payload)), iv: Buffer.alloc(12), authTag: Buffer.alloc(16), aadDigest: Buffer.alloc(32) }));
    const verify = vi.fn().mockResolvedValue(true);
    const result = await initiateVerifiedEmailChange(database as never, context, { operationId, openingFingerprint: "opening", intentFingerprint: "intent", newEmail: " New@Example.Invalid " }, "current-password", { verifier: { verify }, generateToken: () => "raw-verification-token", cipher: { encrypt } as never });
    expect(result).toEqual({ operationId, status: "pending" });
    expect(database.$transaction).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledWith({ hash: "stored-hash", password: "current-password" });
    expect(tx.globalSecurityOperationBinding.create).toHaveBeenCalledWith({ data: expect.objectContaining({ userId: "user-1", sessionId: "session-1", operationKey: "emailChange", securityVersion: 2, sessionSecurityVersion: 3, openingFingerprint: "opening" }) });
    expect(tx.globalSecurityOperation.create).toHaveBeenCalledWith({ data: expect.objectContaining({ userId: "user-1", operationId, operationKey: "emailChange", intentFingerprint: "intent" }) });
    expect(tx.freshAuthGrant.create).toHaveBeenCalledWith({ data: expect.objectContaining({ userId: "user-1", sessionId: "session-1", operationId, purpose: "email_change", credentialVersion: 2 }) });
    expect(tx.emailChange.create).toHaveBeenCalledWith({ data: expect.objectContaining({ userId: "user-1", operationId, freshAuthGrantId: "grant-1", normalizedNewEmail: "new@example.invalid", verificationDigest: expect.stringMatching(/^[0-9a-f]{64}$/), state: "pending" }) });
    expect(JSON.stringify(tx.emailChange.create.mock.calls)).not.toContain("raw-verification-token");
    expect(tx.emailChangeDelivery.createMany).toHaveBeenCalledWith({ data: expect.arrayContaining([expect.objectContaining({ kind: "newVerification", state: "queued", ciphertext: expect.any(Uint8Array) }), expect.objectContaining({ kind: "oldRequest", state: "queued", ciphertext: expect.any(Uint8Array) }), expect.objectContaining({ kind: "newCutover", state: "queued" }), expect.objectContaining({ kind: "oldCutover", state: "queued" })]) });
    expect(encrypt).toHaveBeenCalledTimes(4);
  });

  it("replays the exact persisted pending result before password verification, token generation, or encryption", async () => {
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      $queryRaw: vi.fn(async (query) => {
        const sql = query.join(" ");
        if (sql.includes('AS normalized')) return [{ normalized: "new@example.invalid" }];
        if (sql.includes('AS "normalizedCurrentEmail"')) return [{ email: "old@example.invalid", normalizedCurrentEmail: "old@example.invalid" }];
        if (sql.includes('AS "authorized"') || sql.includes('authorize_global_session_security')) return [{ authorized: true }];
        if (sql.includes('FROM "User"') && sql.includes('FOR NO KEY UPDATE')) return [{ id: "user-1", email: "old@example.invalid" }];
        if (sql.includes('FROM "Session"')) return [{ id: "session-1", userId: "user-1" }];
        if (sql.includes('FROM "AccountSecurityState"')) return [{ credentialVersion: 2, sessionSecurityVersion: 3 }];
        return [];
      }),
      accountSecurityState: { upsert: vi.fn().mockResolvedValue({ userId: "user-1", credentialVersion: 2, sessionSecurityVersion: 3 }) },
      globalSecurityOperationBinding: { findFirst: vi.fn().mockResolvedValue({ id: "binding-1", userId: "user-1", sessionId: "session-1", operationKey: "emailChange", securityVersion: 2, sessionSecurityVersion: 3, openingFingerprint: "opening", state: "submitted" }) },
      globalSecurityOperation: { findFirst: vi.fn().mockResolvedValue({ operationKey: "emailChange", intentFingerprint: "intent", status: "pending" }) },
      emailChange: { findFirst: vi.fn().mockResolvedValue({ normalizedNewEmail: "new@example.invalid", state: "pending" }) }
    };
    const database = { $transaction: vi.fn(async (callback) => callback(tx)) };
    const verify = vi.fn();
    const generateToken = vi.fn(() => "must-not-be-created");
    const encrypt = vi.fn();

    await expect(initiateVerifiedEmailChange(database as never, context, { operationId, openingFingerprint: "opening", intentFingerprint: "intent", newEmail: " New@Example.Invalid " }, "wrong-or-expired-password", { verifier: { verify }, generateToken, cipher: { encrypt } as never })).resolves.toEqual({ operationId, status: "pending" });
    expect(verify).not.toHaveBeenCalled();
    expect(generateToken).not.toHaveBeenCalled();
    expect(encrypt).not.toHaveBeenCalled();
  });

  it("rejects conflicting operation reuse and returns one replayable generic terminal result for a collision", async () => {
    const binding = { id: "binding-1", userId: "user-1", sessionId: "session-1", operationKey: "emailChange", securityVersion: 2, sessionSecurityVersion: 3, openingFingerprint: "opening", state: "submitted" };
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      $queryRaw: vi.fn(async (query) => {
        const sql = query.join(" ");
        if (sql.includes('AS normalized')) return [{ normalized: "new@example.invalid" }];
        if (sql.includes('AS "normalizedCurrentEmail"')) return [{ email: "old@example.invalid", normalizedCurrentEmail: "old@example.invalid" }];
        if (sql.includes('AS "authorized"') || sql.includes('authorize_global_session_security')) return [{ authorized: true }];
        if (sql.includes('FROM "User"') && sql.includes('FOR NO KEY UPDATE')) return [{ id: "user-1", email: "old@example.invalid" }];
        if (sql.includes('FROM "Session"')) return [{ id: "session-1", userId: "user-1" }];
        if (sql.includes('FROM "AccountSecurityState"')) return [{ credentialVersion: 2, sessionSecurityVersion: 3 }];
        return [];
      }),
      accountSecurityState: { upsert: vi.fn().mockResolvedValue({ userId: "user-1", credentialVersion: 2, sessionSecurityVersion: 3 }) },
      globalSecurityOperationBinding: { findFirst: vi.fn().mockResolvedValue(binding) },
      globalSecurityOperation: { findFirst: vi.fn().mockResolvedValue({ operationKey: "emailChange", intentFingerprint: "intent", status: "rejected", outcomeCode: "collision_rejected" }) },
      emailChange: { findFirst: vi.fn().mockResolvedValue(null) }
    };
    const database = { $transaction: vi.fn(async (callback) => callback(tx)) };

    await expect(initiateVerifiedEmailChange(database as never, context, { operationId, openingFingerprint: "opening", intentFingerprint: "intent", newEmail: "new@example.invalid" }, "not-rechecked", { verifier: { verify: vi.fn() } })).resolves.toEqual({ operationId, status: "rejected" });
    tx.globalSecurityOperation.findFirst.mockResolvedValueOnce({ operationKey: "emailChange", intentFingerprint: "different-intent", status: "pending" });
    await expect(initiateVerifiedEmailChange(database as never, context, { operationId, openingFingerprint: "opening", intentFingerprint: "intent", newEmail: "new@example.invalid" }, "not-rechecked", { verifier: { verify: vi.fn() } })).rejects.toThrow("idempotency_conflict");
  });

  it("takes the canonical target-email lock before locking user state and terminalizes a collision without throwing", async () => {
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      $queryRaw: vi.fn(async (query) => {
        const sql = query.join(" ");
        if (sql.includes('AS normalized')) return [{ normalized: "new@example.invalid" }];
        if (sql.includes('AS "normalizedCurrentEmail"')) return [{ email: " Old@Example.Invalid ", normalizedCurrentEmail: "old@example.invalid" }];
        if (sql.includes('AS "authorized"') || sql.includes('authorize_global_session_security')) return [{ authorized: true }];
        if (sql.includes('FROM "User"') && sql.includes('FOR NO KEY UPDATE')) return [{ id: "user-1", email: " Old@Example.Invalid " }];
        if (sql.includes('FROM "Session"')) return [{ id: "session-1", userId: "user-1" }];
        if (sql.includes('FROM "AccountSecurityState"')) return [{ credentialVersion: 2, sessionSecurityVersion: 3 }];
        if (sql.includes('collision')) return [{ collision: true }];
        if (sql.includes('clock_timestamp')) return [{ createdAt: new Date("2030-01-01T00:00:00Z"), expiresAt: new Date("2030-01-01T00:10:00Z") }];
        return [];
      }),
      accountSecurityState: { upsert: vi.fn().mockResolvedValue({ userId: "user-1", credentialVersion: 2, sessionSecurityVersion: 3 }) },
      account: { findFirst: vi.fn().mockResolvedValue({ password: "stored-hash" }) },
      globalSecurityOperationBinding: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ id: "binding-1" }), update: vi.fn().mockResolvedValue({}) },
      globalSecurityOperation: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({}) },
      freshAuthGrant: { create: vi.fn().mockResolvedValue({ id: "grant-1" }) },
      emailChange: { findFirst: vi.fn().mockResolvedValue(null) }
    };
    const database = { $transaction: vi.fn(async (callback) => callback(tx)) };

    await expect(initiateVerifiedEmailChange(database as never, context, { operationId, openingFingerprint: "opening", intentFingerprint: "intent", newEmail: " New@Example.Invalid " }, "current-password", { verifier: { verify: vi.fn().mockResolvedValue(true) } })).resolves.toEqual({ operationId, status: "rejected" });
    const targetLock = tx.$executeRaw.mock.calls.find(([query]) => query.join(" ").includes('email-identity:v1:'))!;
    const userLock = tx.$queryRaw.mock.calls.find(([query]) => query.join(" ").includes('FROM "User"') && query.join(" ").includes('FOR NO KEY UPDATE'))!;
    expect(tx.$executeRaw.mock.invocationCallOrder[tx.$executeRaw.mock.calls.indexOf(targetLock)]).toBeLessThan(tx.$queryRaw.mock.invocationCallOrder[tx.$queryRaw.mock.calls.indexOf(userLock)]);
    expect(tx.$executeRaw.mock.calls.some(([query]) => query.join(" ").includes('reject_email_change_collision'))).toBe(true);
  });

  it("terminalizes an already-issued email change when initiation replay observes a stale version", async () => {
    const staleTx = { $queryRaw: vi.fn().mockResolvedValue([{ state: "stale_security_version" }]) };
    const database = {
      $transaction: vi.fn()
        .mockRejectedValueOnce(new Error("stale_security_version"))
        .mockImplementationOnce(async (callback) => callback(staleTx))
    };
    await expect(initiateVerifiedEmailChange(database as never, context, { operationId, openingFingerprint: "opening", intentFingerprint: "intent", newEmail: "new@example.invalid" }, "not-rechecked", { verifier: { verify: vi.fn() } })).rejects.toThrow("stale_security_version");
    expect(String(staleTx.$queryRaw.mock.calls)).toContain("stale_email_change");
  });
});
