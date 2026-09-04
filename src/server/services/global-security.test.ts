import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ queryRaw: vi.fn(), executeRaw: vi.fn(), stateUpsert: vi.fn(), stateUpdate: vi.fn(), transaction: vi.fn(), accountFindFirst: vi.fn(), accountUpdate: vi.fn(), passwordVerify: vi.fn(), passwordHash: vi.fn(), bindingFindFirst: vi.fn(), bindingCreate: vi.fn(), bindingUpdate: vi.fn(), operationFindFirst: vi.fn(), operationCreate: vi.fn(), operationUpdate: vi.fn(), grantCreate: vi.fn(), grantFindFirst: vi.fn(), grantUpdate: vi.fn(), grantUpdateMany: vi.fn(), sessionDeleteMany: vi.fn(), activityUpdateMany: vi.fn(), eventCreate: vi.fn() }));

import { assertGlobalSecurityOperationId, captureGlobalSecurityContext, consumeFreshAuthGrantForCurrentContext, finalizePasswordChange, finalizeStalePasswordChange, getFreshAuthGrantStatus, getPasswordChangeStatus, issueFreshAuthGrant, issueFreshAuthGrantForCurrentPassword, lockGlobalSecurityContext, preauthorizeFreshAuthThrottle, reauthorizeGlobalSecurityContext, verifyCurrentPassword, withGlobalSecurityTransaction } from "@/server/services/global-security";

mocks.queryRaw.mockImplementation(async (query) => query.join(" ").includes('AS "createdAt"')
  ? [{ createdAt: new Date("2026-08-24T16:00:00.000Z"), expiresAt: new Date("2026-08-24T16:10:00.000Z") }]
  : [{ authorized: true }]);

describe("global security transaction boundary", () => {
  it("locks the user session and creates/reads non-resettable security state before a protected action", async () => {
    mocks.queryRaw.mockResolvedValueOnce([{ id: "user-1" }]).mockResolvedValueOnce([{ id: "session-1", userId: "user-1" }]).mockResolvedValueOnce([{ authorized: true }]);
    mocks.stateUpsert.mockResolvedValue({ userId: "user-1", credentialVersion: 1, sessionSecurityVersion: 1 });
    const tx = { $queryRaw: mocks.queryRaw, accountSecurityState: { upsert: mocks.stateUpsert } } as never;
    await expect(lockGlobalSecurityContext(tx, { userId: "user-1", sessionId: "session-1" })).resolves.toEqual({ userId: "user-1", sessionId: "session-1", credentialVersion: 1, sessionSecurityVersion: 1 });
    const queries = mocks.queryRaw.mock.calls.map(([query]) => query.join(" "));
    expect(queries[0]).toContain('FROM "User"');
    expect(queries[0]).toContain("FOR NO KEY UPDATE");
    expect(queries[1]).toContain('FROM "Session"');
    expect(queries[2]).toContain('authorize_global_session_security');
    expect(mocks.stateUpsert.mock.invocationCallOrder[0]).toBeLessThan(mocks.queryRaw.mock.invocationCallOrder[1]);
  });

  it("rejects a protected action when either revalidated security-version component changed after its original lock", async () => {
    mocks.queryRaw.mockResolvedValueOnce([{ id: "user-1" }]).mockResolvedValueOnce([{ id: "session-1", userId: "user-1" }]).mockResolvedValueOnce([{ authorized: true }]);
    mocks.stateUpsert.mockResolvedValue({ userId: "user-1", credentialVersion: 2, sessionSecurityVersion: 1 });
    const tx = { $queryRaw: mocks.queryRaw, accountSecurityState: { upsert: mocks.stateUpsert } } as never;

    await expect(reauthorizeGlobalSecurityContext(tx, { userId: "user-1", sessionId: "session-1", credentialVersion: 1, sessionSecurityVersion: 1 })).rejects.toThrow("stale_security_version");
  });

  it("runs a protected action only after serializable in-transaction security reauthorization", async () => {
    mocks.queryRaw.mockResolvedValueOnce([{ id: "user-1" }]).mockResolvedValueOnce([{ id: "session-1", userId: "user-1" }]).mockResolvedValueOnce([{ authorized: true }]);
    mocks.executeRaw.mockResolvedValue(1);
    mocks.stateUpsert.mockResolvedValue({ userId: "user-1", credentialVersion: 1, sessionSecurityVersion: 1 });
    const tx = { $queryRaw: mocks.queryRaw, $executeRaw: mocks.executeRaw, accountSecurityState: { upsert: mocks.stateUpsert } } as never;
    mocks.transaction.mockImplementation(async (callback) => callback(tx));

    await expect(withGlobalSecurityTransaction({ $transaction: mocks.transaction }, { userId: "user-1", sessionId: "session-1", credentialVersion: 1, sessionSecurityVersion: 1 }, async (context) => context.sessionId)).resolves.toBe("session-1");
    expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "Serializable" });
    const transitionLockCall = mocks.executeRaw.mock.invocationCallOrder.at(-1);
    const reauthorizationCall = mocks.queryRaw.mock.invocationCallOrder.at(-1);
    expect(transitionLockCall).toBeDefined();
    expect(reauthorizationCall).toBeDefined();
    expect(transitionLockCall!).toBeLessThan(reauthorizationCall!);
  });

  it("does not enter the protected callback when serializable reauthorization observes a stale vector", async () => {
    mocks.queryRaw.mockResolvedValueOnce([{ id: "user-1" }]).mockResolvedValueOnce([{ id: "session-1", userId: "user-1" }]).mockResolvedValueOnce([{ authorized: true }]);
    mocks.executeRaw.mockResolvedValue(1);
    mocks.stateUpsert.mockResolvedValue({ userId: "user-1", credentialVersion: 1, sessionSecurityVersion: 2 });
    const tx = { $queryRaw: mocks.queryRaw, $executeRaw: mocks.executeRaw, accountSecurityState: { upsert: mocks.stateUpsert } } as never;
    mocks.transaction.mockImplementation(async (callback) => callback(tx));
    const protectedAction = vi.fn();

    await expect(withGlobalSecurityTransaction({ $transaction: mocks.transaction }, { userId: "user-1", sessionId: "session-1", credentialVersion: 1, sessionSecurityVersion: 1 }, protectedAction)).rejects.toThrow("stale_security_version");
    expect(protectedAction).not.toHaveBeenCalled();
  });

  it("captures an immutable user/session version vector inside a serializable transaction", async () => {
    mocks.executeRaw.mockResolvedValue(1);
    mocks.queryRaw.mockResolvedValueOnce([{ id: "user-1" }]).mockResolvedValueOnce([{ id: "session-1", userId: "user-1" }]).mockResolvedValueOnce([{ authorized: true }]);
    mocks.stateUpsert.mockResolvedValue({ userId: "user-1", credentialVersion: 3, sessionSecurityVersion: 4 });
    const tx = { $queryRaw: mocks.queryRaw, $executeRaw: mocks.executeRaw, accountSecurityState: { upsert: mocks.stateUpsert } } as never;
    mocks.transaction.mockImplementation(async (callback) => callback(tx));

    await expect(captureGlobalSecurityContext({ $transaction: mocks.transaction }, { userId: "user-1", sessionId: "session-1" })).resolves.toEqual({ userId: "user-1", sessionId: "session-1", credentialVersion: 3, sessionSecurityVersion: 4 });
    expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "Serializable" });
  });

  it("takes the shared transition lock before capture reads or locks user security state", async () => {
    mocks.executeRaw.mockClear();
    mocks.queryRaw.mockClear();
    mocks.stateUpsert.mockClear();
    mocks.executeRaw.mockResolvedValue(1);
    mocks.queryRaw.mockResolvedValueOnce([{ id: "user-1" }]).mockResolvedValueOnce([{ id: "session-1", userId: "user-1" }]).mockResolvedValueOnce([{ authorized: true }]);
    mocks.stateUpsert.mockResolvedValue({ userId: "user-1", credentialVersion: 3, sessionSecurityVersion: 4 });
    const tx = { $queryRaw: mocks.queryRaw, $executeRaw: mocks.executeRaw, accountSecurityState: { upsert: mocks.stateUpsert } } as never;
    mocks.transaction.mockImplementation(async (callback) => callback(tx));

    await captureGlobalSecurityContext({ $transaction: mocks.transaction }, { userId: "user-1", sessionId: "session-1" });

    expect(mocks.executeRaw.mock.calls.some(([query]) => query.join(" ").includes("global-security-transition:v1"))).toBe(true);
    expect(mocks.executeRaw.mock.invocationCallOrder.at(-1)!).toBeLessThan(mocks.queryRaw.mock.invocationCallOrder.at(-3)!);
  });
});

describe("fresh-auth grants", () => {
  it("accepts only the namespaced canonical global-security operation identity", () => {
    expect(assertGlobalSecurityOperationId("gso_0123456789abcdefghjkmnpqrs")).toBe("gso_0123456789abcdefghjkmnpqrs");
    expect(() => assertGlobalSecurityOperationId("gso-1")).toThrow();
    expect(() => assertGlobalSecurityOperationId("bmo_0123456789abcdefghjkmnpqrs")).toThrow();
  });

  it("verifies the credential account password only for the reauthorized global-security user", async () => {
    mocks.accountFindFirst.mockResolvedValue({ password: "stored-hash" });
    mocks.passwordVerify.mockResolvedValue(true);
    const tx = { account: { findFirst: mocks.accountFindFirst } } as never;

    await expect(verifyCurrentPassword(tx, { userId: "user-1", sessionId: "session-1", credentialVersion: 1, sessionSecurityVersion: 1 }, "current-password", { verify: mocks.passwordVerify })).resolves.toBe(true);
    expect(mocks.accountFindFirst).toHaveBeenCalledWith({ where: { userId: "user-1", providerId: "credential" }, select: { password: true } });
    expect(mocks.passwordVerify).toHaveBeenCalledWith({ hash: "stored-hash", password: "current-password" });
  });

  it("does not verify against an absent credential account", async () => {
    mocks.passwordVerify.mockClear();
    mocks.accountFindFirst.mockResolvedValue(null);
    const tx = { account: { findFirst: mocks.accountFindFirst } } as never;

    await expect(verifyCurrentPassword(tx, { userId: "user-1", sessionId: "session-1", credentialVersion: 1, sessionSecurityVersion: 1 }, "current-password", { verify: mocks.passwordVerify })).resolves.toBe(false);
    expect(mocks.passwordVerify).not.toHaveBeenCalled();
  });

  it("commits a wrong-password proof failure before its caller can reject", async () => {
    const key = Buffer.alloc(32, 9).toString("base64url");
    let throttleCalls = 0;
    const queryRaw = vi.fn(async (query) => {
      const sql = query.strings?.join(" ") ?? query.join(" ");
      if (sql.includes('FROM "User"')) return [{ id: "user-1" }];
      if (sql.includes('FROM "Session"')) return [{ id: "session-1", userId: "user-1" }];
      if (sql.includes("authorize_global_session_security")) return [{ authorized: true }];
      if (sql.includes('SELECT "quiet", "deadline"')) return [{ quiet: throttleCalls++ > 0 ? false : false, deadline: null }];
      throw new Error(`unexpected query: ${sql}`);
    });
    const executeRaw = vi.fn().mockResolvedValue(1);
    const tx = {
      $queryRaw: queryRaw,
      $executeRaw: executeRaw,
      accountSecurityState: { upsert: vi.fn().mockResolvedValue({ credentialVersion: 1, sessionSecurityVersion: 1 }) },
      globalSecurityOperationBinding: { findFirst: vi.fn().mockResolvedValue(null) },
      user: { findUnique: vi.fn().mockResolvedValue({ email: "casey@example.test" }) },
      account: { findFirst: vi.fn().mockResolvedValue({ password: "stored-hash" }) }
    };
    const database = { $transaction: vi.fn(async (action) => action(tx)) };
    const verify = vi.fn().mockResolvedValue(false);

    await expect(preauthorizeFreshAuthThrottle(database as never, { userId: "user-1", sessionId: "session-1", credentialVersion: 1, sessionSecurityVersion: 1 }, { operationId: "gso_00000000000000000000000000", purpose: "email_change", openingFingerprint: "open", intentFingerprint: "intent" }, "wrong", { verify }, { key, client: "unknown_client" })).resolves.toMatchObject({ valid: false });
    expect(throttleCalls).toBe(2);
    expect(executeRaw.mock.calls.some(([query]) => (query.strings?.join(" ") ?? query.join(" ")).includes("write_global_security_event"))).toBe(true);
  });

  it("uses one dummy verification and no real-password attempt while quiet", async () => {
    const key = Buffer.alloc(32, 10).toString("base64url");
    let throttleCalls = 0;
    const queryRaw = vi.fn(async (query) => {
      const sql = query.strings?.join(" ") ?? query.join(" ");
      if (sql.includes('FROM "User"')) return [{ id: "user-1" }];
      if (sql.includes('FROM "Session"')) return [{ id: "session-1", userId: "user-1" }];
      if (sql.includes("authorize_global_session_security")) return [{ authorized: true }];
      if (sql.includes('SELECT "quiet", "deadline"')) return [{ quiet: throttleCalls++ === 0, deadline: new Date("2030-01-01") }];
      throw new Error(`unexpected query: ${sql}`);
    });
    const verify = vi.fn().mockResolvedValue(false);
    const tx = { $queryRaw: queryRaw, $executeRaw: vi.fn().mockResolvedValue(1), accountSecurityState: { upsert: vi.fn().mockResolvedValue({ credentialVersion: 1, sessionSecurityVersion: 1 }) }, globalSecurityOperationBinding: { findFirst: vi.fn().mockResolvedValue(null) }, user: { findUnique: vi.fn().mockResolvedValue({ email: "casey@example.test" }) }, account: { findFirst: vi.fn().mockResolvedValue({ password: "stored-hash" }) } };

    await preauthorizeFreshAuthThrottle({ $transaction: vi.fn(async (action) => action(tx)) } as never, { userId: "user-1", sessionId: "session-1", credentialVersion: 1, sessionSecurityVersion: 1 }, { operationId: "gso_00000000000000000000000000", purpose: "email_change", openingFingerprint: "open", intentFingerprint: "intent" }, "real-password-must-not-be-used", { verify }, { key, client: "unknown_client" });
    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledWith({ hash: "stored-hash", password: "cubby-fixed-dummy-password-proof-v1" });
  });

  it("issues one password-change grant only after current-password verification and operation binding submission", async () => {
    mocks.executeRaw.mockResolvedValue(1);
    mocks.queryRaw.mockResolvedValueOnce([{ id: "user-1" }]).mockResolvedValueOnce([{ id: "session-1", userId: "user-1" }]).mockResolvedValueOnce([{ authorized: true }]);
    mocks.stateUpsert.mockResolvedValue({ userId: "user-1", credentialVersion: 1, sessionSecurityVersion: 1 });
    mocks.accountFindFirst.mockResolvedValue({ password: "stored-hash" });
    mocks.passwordVerify.mockResolvedValue(true);
    mocks.bindingCreate.mockResolvedValue({ id: "binding-1" });
    mocks.operationCreate.mockResolvedValue({ operationId: "gso_00000000000000000000000000" });
    mocks.grantCreate.mockResolvedValue({ id: "grant-1" });
    mocks.bindingUpdate.mockResolvedValue({ id: "binding-1" });
    const tx = {
      $queryRaw: mocks.queryRaw,
      $executeRaw: mocks.executeRaw,
      accountSecurityState: { upsert: mocks.stateUpsert },
      account: { findFirst: mocks.accountFindFirst },
      globalSecurityOperationBinding: { findFirst: mocks.bindingFindFirst, create: mocks.bindingCreate, update: mocks.bindingUpdate },
      globalSecurityOperation: { create: mocks.operationCreate },
      freshAuthGrant: { create: mocks.grantCreate }
    } as never;
    mocks.transaction.mockImplementation(async (callback) => callback(tx));

    await expect(issueFreshAuthGrantForCurrentPassword({ $transaction: mocks.transaction }, { userId: "user-1", sessionId: "session-1", credentialVersion: 1, sessionSecurityVersion: 1 }, { operationId: "gso_00000000000000000000000000", purpose: "password_change", openingFingerprint: "open-1", intentFingerprint: "intent-1" }, "current-password", { verify: mocks.passwordVerify }, { replacementPasswordHash: "new-hash", signer: { digestReplacementPasswordHash: vi.fn(() => Buffer.alloc(32, 7)), sign: vi.fn(() => ({ keyVersion: 1, nonce: "A".repeat(43), mac: Buffer.alloc(32, 8) })), signRecoveryReset: vi.fn(), signSessionRevoke: vi.fn() } })).resolves.toEqual({ operationId: "gso_00000000000000000000000000", grantId: "grant-1" });
    expect(mocks.bindingCreate.mock.invocationCallOrder[0]).toBeLessThan(mocks.operationCreate.mock.invocationCallOrder[0]);
    expect(mocks.operationCreate.mock.invocationCallOrder[0]).toBeLessThan(mocks.grantCreate.mock.invocationCallOrder[0]);
    expect(mocks.grantCreate.mock.invocationCallOrder[0]).toBeLessThan(mocks.bindingUpdate.mock.invocationCallOrder[0]);
  });

  it("rejects an invalid current password before creating a binding, operation, or grant", async () => {
    mocks.executeRaw.mockResolvedValue(1);
    mocks.queryRaw.mockResolvedValueOnce([{ id: "user-1" }]).mockResolvedValueOnce([{ id: "session-1", userId: "user-1" }]).mockResolvedValueOnce([{ authorized: true }]);
    mocks.stateUpsert.mockResolvedValue({ userId: "user-1", credentialVersion: 1, sessionSecurityVersion: 1 });
    mocks.accountFindFirst.mockResolvedValue({ password: "stored-hash" });
    mocks.passwordVerify.mockResolvedValue(false);
    const tx = {
      $queryRaw: mocks.queryRaw,
      $executeRaw: mocks.executeRaw,
      accountSecurityState: { upsert: mocks.stateUpsert },
      account: { findFirst: mocks.accountFindFirst },
      globalSecurityOperationBinding: { findFirst: mocks.bindingFindFirst, create: mocks.bindingCreate, update: mocks.bindingUpdate },
      globalSecurityOperation: { create: mocks.operationCreate },
      freshAuthGrant: { create: mocks.grantCreate }
    } as never;
    mocks.transaction.mockImplementation(async (callback) => callback(tx));
    mocks.bindingCreate.mockClear();
    mocks.operationCreate.mockClear();
    mocks.grantCreate.mockClear();

    await expect(issueFreshAuthGrantForCurrentPassword({ $transaction: mocks.transaction }, { userId: "user-1", sessionId: "session-1", credentialVersion: 1, sessionSecurityVersion: 1 }, { operationId: "gso_11111111111111111111111111", purpose: "password_change", openingFingerprint: "open-invalid", intentFingerprint: "intent-invalid" }, "wrong-password", { verify: mocks.passwordVerify })).rejects.toThrow("current_password_invalid");
    expect(mocks.bindingCreate).not.toHaveBeenCalled();
    expect(mocks.operationCreate).not.toHaveBeenCalled();
    expect(mocks.grantCreate).not.toHaveBeenCalled();
  });

  it("replays a matching issued grant without re-verifying or duplicating its operation", async () => {
    mocks.executeRaw.mockResolvedValue(1);
    mocks.queryRaw.mockResolvedValueOnce([{ id: "user-1" }]).mockResolvedValueOnce([{ id: "session-1", userId: "user-1" }]).mockResolvedValueOnce([{ authorized: true }]);
    mocks.stateUpsert.mockResolvedValue({ userId: "user-1", credentialVersion: 1, sessionSecurityVersion: 1 });
    mocks.bindingFindFirst.mockResolvedValue({ id: "binding-1", userId: "user-1", sessionId: "session-1", operationId: "gso_00000000000000000000000000", operationKey: "passwordChange", securityVersion: 1, sessionSecurityVersion: 1, openingFingerprint: "open-1", state: "submitted" });
    mocks.operationFindFirst.mockResolvedValue({ intentFingerprint: "intent-1", status: "pending" });
    mocks.grantFindFirst.mockResolvedValue({ id: "grant-1" });
    const tx = { $queryRaw: mocks.queryRaw, $executeRaw: mocks.executeRaw, accountSecurityState: { upsert: mocks.stateUpsert }, account: { findFirst: mocks.accountFindFirst }, globalSecurityOperationBinding: { findFirst: mocks.bindingFindFirst, create: mocks.bindingCreate, update: mocks.bindingUpdate }, globalSecurityOperation: { findFirst: mocks.operationFindFirst, create: mocks.operationCreate }, freshAuthGrant: { findFirst: mocks.grantFindFirst, create: mocks.grantCreate } } as never;
    mocks.transaction.mockImplementation(async (callback) => callback(tx));
    mocks.passwordVerify.mockClear();
    mocks.bindingCreate.mockClear();
    mocks.operationCreate.mockClear();
    mocks.grantCreate.mockClear();

    await expect(issueFreshAuthGrantForCurrentPassword({ $transaction: mocks.transaction }, { userId: "user-1", sessionId: "session-1", credentialVersion: 1, sessionSecurityVersion: 1 }, { operationId: "gso_00000000000000000000000000", purpose: "password_change", openingFingerprint: "open-1", intentFingerprint: "intent-1" }, "not-reverified", { verify: mocks.passwordVerify })).resolves.toEqual({ operationId: "gso_00000000000000000000000000", grantId: "grant-1" });
    expect(mocks.passwordVerify).not.toHaveBeenCalled();
    expect(mocks.bindingCreate).not.toHaveBeenCalled();
    expect(mocks.operationCreate).not.toHaveBeenCalled();
    expect(mocks.grantCreate).not.toHaveBeenCalled();
    expect(mocks.grantFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ state: "issued" }) }));
  });

  it("rejects a replay whose retained binding belongs to a different purpose or opening fingerprint", async () => {
    mocks.executeRaw.mockResolvedValue(1);
    mocks.queryRaw.mockResolvedValueOnce([{ id: "user-1" }]).mockResolvedValueOnce([{ id: "session-1", userId: "user-1" }]).mockResolvedValueOnce([{ authorized: true }]);
    mocks.stateUpsert.mockResolvedValue({ userId: "user-1", credentialVersion: 1, sessionSecurityVersion: 1 });
    mocks.bindingFindFirst.mockResolvedValue({ id: "binding-1", userId: "user-1", sessionId: "session-1", operationId: "gso_00000000000000000000000000", operationKey: "emailChange", securityVersion: 1, sessionSecurityVersion: 1, openingFingerprint: "other-opening", state: "submitted" });
    const tx = { $queryRaw: mocks.queryRaw, $executeRaw: mocks.executeRaw, accountSecurityState: { upsert: mocks.stateUpsert }, account: { findFirst: mocks.accountFindFirst }, globalSecurityOperationBinding: { findFirst: mocks.bindingFindFirst, create: mocks.bindingCreate, update: mocks.bindingUpdate }, globalSecurityOperation: { create: mocks.operationCreate }, freshAuthGrant: { findFirst: mocks.grantFindFirst, create: mocks.grantCreate } } as never;
    mocks.transaction.mockImplementation(async (callback) => callback(tx));

    await expect(issueFreshAuthGrantForCurrentPassword({ $transaction: mocks.transaction }, { userId: "user-1", sessionId: "session-1", credentialVersion: 1, sessionSecurityVersion: 1 }, { operationId: "gso_00000000000000000000000000", purpose: "password_change", openingFingerprint: "open-1", intentFingerprint: "intent-1" }, "not-reverified", { verify: mocks.passwordVerify })).rejects.toThrow("idempotency_conflict");
  });

  it("rejects a replay whose matching binding has a different persisted intent fingerprint", async () => {
    mocks.executeRaw.mockResolvedValue(1);
    mocks.queryRaw.mockResolvedValueOnce([{ id: "user-1" }]).mockResolvedValueOnce([{ id: "session-1", userId: "user-1" }]).mockResolvedValueOnce([{ authorized: true }]);
    mocks.stateUpsert.mockResolvedValue({ userId: "user-1", credentialVersion: 1, sessionSecurityVersion: 1 });
    mocks.bindingFindFirst.mockResolvedValue({ id: "binding-1", sessionId: "session-1", operationKey: "passwordChange", securityVersion: 1, sessionSecurityVersion: 1, openingFingerprint: "open-1", state: "submitted" });
    mocks.operationFindFirst.mockResolvedValue({ intentFingerprint: "original-intent", status: "pending" });
    const tx = { $queryRaw: mocks.queryRaw, $executeRaw: mocks.executeRaw, accountSecurityState: { upsert: mocks.stateUpsert }, account: { findFirst: mocks.accountFindFirst }, globalSecurityOperationBinding: { findFirst: mocks.bindingFindFirst, create: mocks.bindingCreate, update: mocks.bindingUpdate }, globalSecurityOperation: { findFirst: mocks.operationFindFirst, create: mocks.operationCreate }, freshAuthGrant: { findFirst: mocks.grantFindFirst, create: mocks.grantCreate } } as never;
    mocks.transaction.mockImplementation(async (callback) => callback(tx));
    mocks.passwordVerify.mockClear();
    mocks.grantFindFirst.mockClear();

    await expect(issueFreshAuthGrantForCurrentPassword({ $transaction: mocks.transaction }, { userId: "user-1", sessionId: "session-1", credentialVersion: 1, sessionSecurityVersion: 1 }, { operationId: "gso_00000000000000000000000000", purpose: "password_change", openingFingerprint: "open-1", intentFingerprint: "different-intent" }, "not-reverified", { verify: mocks.passwordVerify })).rejects.toThrow("idempotency_conflict");
    expect(mocks.passwordVerify).not.toHaveBeenCalled();
    expect(mocks.grantFindFirst).not.toHaveBeenCalled();
  });

  it("returns grant status only for the reauthorized caller's matching session, purpose, vector, and opening fingerprint", async () => {
    mocks.executeRaw.mockResolvedValue(1);
    mocks.queryRaw.mockResolvedValueOnce([{ id: "user-1" }]).mockResolvedValueOnce([{ id: "session-1", userId: "user-1" }]).mockResolvedValueOnce([{ authorized: true }]);
    mocks.stateUpsert.mockResolvedValue({ userId: "user-1", credentialVersion: 1, sessionSecurityVersion: 1 });
    mocks.bindingFindFirst.mockResolvedValue({ id: "binding-1", sessionId: "session-1", operationKey: "passwordChange", securityVersion: 1, sessionSecurityVersion: 1, openingFingerprint: "open-1", state: "submitted" });
    mocks.grantFindFirst.mockResolvedValue({ id: "grant-1", state: "issued", expiresAt: new Date("2030-08-26T12:10:00.000Z") });
    const tx = { $queryRaw: mocks.queryRaw, $executeRaw: mocks.executeRaw, accountSecurityState: { upsert: mocks.stateUpsert }, globalSecurityOperationBinding: { findFirst: mocks.bindingFindFirst }, freshAuthGrant: { findFirst: mocks.grantFindFirst } } as never;
    mocks.transaction.mockImplementation(async (callback) => callback(tx));

    await expect(getFreshAuthGrantStatus({ $transaction: mocks.transaction }, { userId: "user-1", sessionId: "session-1", credentialVersion: 1, sessionSecurityVersion: 1 }, { operationId: "gso_00000000000000000000000000", purpose: "password_change", openingFingerprint: "open-1" })).resolves.toEqual({ operationId: "gso_00000000000000000000000000", grantId: "grant-1", state: "issued", expiresAt: new Date("2030-08-26T12:10:00.000Z") });
  });

  it("does not disclose a grant status when the retained binding purpose or opening identity differs", async () => {
    mocks.executeRaw.mockResolvedValue(1);
    mocks.queryRaw.mockResolvedValueOnce([{ id: "user-1" }]).mockResolvedValueOnce([{ id: "session-1", userId: "user-1" }]).mockResolvedValueOnce([{ authorized: true }]);
    mocks.stateUpsert.mockResolvedValue({ userId: "user-1", credentialVersion: 1, sessionSecurityVersion: 1 });
    mocks.bindingFindFirst.mockResolvedValue({ id: "binding-1", sessionId: "session-1", operationKey: "emailChange", securityVersion: 1, sessionSecurityVersion: 1, openingFingerprint: "other-opening" });
    const tx = { $queryRaw: mocks.queryRaw, $executeRaw: mocks.executeRaw, accountSecurityState: { upsert: mocks.stateUpsert }, globalSecurityOperationBinding: { findFirst: mocks.bindingFindFirst }, freshAuthGrant: { findFirst: mocks.grantFindFirst } } as never;
    mocks.transaction.mockImplementation(async (callback) => callback(tx));
    mocks.grantFindFirst.mockClear();

    await expect(getFreshAuthGrantStatus({ $transaction: mocks.transaction }, { userId: "user-1", sessionId: "session-1", credentialVersion: 1, sessionSecurityVersion: 1 }, { operationId: "gso_00000000000000000000000000", purpose: "password_change", openingFingerprint: "open-1" })).rejects.toThrow("not_found");
    expect(mocks.grantFindFirst).not.toHaveBeenCalled();
  });

  it("does not disclose grant status before the matching binding is submitted", async () => {
    mocks.executeRaw.mockResolvedValue(1);
    mocks.queryRaw.mockResolvedValueOnce([{ id: "user-1" }]).mockResolvedValueOnce([{ id: "session-1", userId: "user-1" }]).mockResolvedValueOnce([{ authorized: true }]);
    mocks.stateUpsert.mockResolvedValue({ userId: "user-1", credentialVersion: 1, sessionSecurityVersion: 1 });
    mocks.bindingFindFirst.mockResolvedValue({ id: "binding-1", sessionId: "session-1", operationKey: "passwordChange", securityVersion: 1, sessionSecurityVersion: 1, openingFingerprint: "open-1", state: "open" });
    const tx = { $queryRaw: mocks.queryRaw, $executeRaw: mocks.executeRaw, accountSecurityState: { upsert: mocks.stateUpsert }, globalSecurityOperationBinding: { findFirst: mocks.bindingFindFirst }, freshAuthGrant: { findFirst: mocks.grantFindFirst } } as never;
    mocks.transaction.mockImplementation(async (callback) => callback(tx));
    mocks.grantFindFirst.mockClear();

    await expect(getFreshAuthGrantStatus({ $transaction: mocks.transaction }, { userId: "user-1", sessionId: "session-1", credentialVersion: 1, sessionSecurityVersion: 1 }, { operationId: "gso_00000000000000000000000000", purpose: "password_change", openingFingerprint: "open-1" })).rejects.toThrow("not_found");
    expect(mocks.grantFindFirst).not.toHaveBeenCalled();
  });

  it("durably terminalizes a matching issued grant as expired before reporting its status", async () => {
    mocks.executeRaw.mockResolvedValue(1);
    mocks.queryRaw.mockResolvedValueOnce([{ id: "user-1" }]).mockResolvedValueOnce([{ id: "session-1", userId: "user-1" }]).mockResolvedValueOnce([{ authorized: true }]).mockResolvedValueOnce([{ authorized: false }]);
    mocks.stateUpsert.mockResolvedValue({ userId: "user-1", credentialVersion: 1, sessionSecurityVersion: 1 });
    mocks.bindingFindFirst.mockResolvedValue({ id: "binding-1", sessionId: "session-1", operationKey: "passwordChange", securityVersion: 1, sessionSecurityVersion: 1, openingFingerprint: "open-1", state: "submitted" });
    mocks.grantFindFirst.mockResolvedValue({ id: "grant-expired", state: "issued", expiresAt: new Date("2020-01-01T00:00:00.000Z") });
    mocks.grantUpdate.mockResolvedValue({ id: "grant-expired" });
    const tx = { $queryRaw: mocks.queryRaw, $executeRaw: mocks.executeRaw, accountSecurityState: { upsert: mocks.stateUpsert }, globalSecurityOperationBinding: { findFirst: mocks.bindingFindFirst }, freshAuthGrant: { findFirst: mocks.grantFindFirst, update: mocks.grantUpdate } } as never;
    mocks.transaction.mockImplementation(async (callback) => callback(tx));

    await expect(getFreshAuthGrantStatus({ $transaction: mocks.transaction }, { userId: "user-1", sessionId: "session-1", credentialVersion: 1, sessionSecurityVersion: 1 }, { operationId: "gso_00000000000000000000000000", purpose: "password_change", openingFingerprint: "open-1" })).resolves.toMatchObject({ grantId: "grant-expired", state: "expired" });
    expect(mocks.grantUpdate).toHaveBeenCalledWith({ where: { id: "grant-expired" }, data: { state: "expired" } });
  });

  it("creates a user/session/version-bound ten-minute password-change grant", async () => {
    mocks.grantCreate.mockResolvedValue({ id: "grant-1" });
    const tx = { freshAuthGrant: { create: mocks.grantCreate } } as never;
    const now = new Date("2026-08-24T16:00:00.000Z");
    await expect(issueFreshAuthGrant(tx, { userId: "user-1", sessionId: "session-1", credentialVersion: 2, operationId: "gso_1" }, { createdAt: now, expiresAt: new Date("2026-08-24T16:10:00.000Z") })).resolves.toEqual({ id: "grant-1" });
    expect(mocks.grantCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ userId: "user-1", sessionId: "session-1", operationId: "gso_1", purpose: "password_change", credentialVersion: 2, state: "issued", createdAt: now, expiresAt: new Date("2026-08-24T16:10:00.000Z") }) });
  });

  it("issues an email-change grant with its distinct closed purpose", async () => {
    mocks.grantCreate.mockResolvedValue({ id: "grant-email" });
    const tx = { freshAuthGrant: { create: mocks.grantCreate } } as never;
    const now = new Date("2026-08-24T16:00:00.000Z");
    await issueFreshAuthGrant(tx, { userId: "user-1", sessionId: "session-1", credentialVersion: 2, operationId: "gso_email", purpose: "email_change" }, { createdAt: now, expiresAt: new Date("2026-08-24T16:10:00.000Z") });
    expect(mocks.grantCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ operationId: "gso_email", purpose: "email_change" }) });
  });

  it("consumes only an unexpired matching submitted-operation grant", async () => {
    const now = new Date("2026-08-24T16:00:00.000Z");
    mocks.executeRaw.mockResolvedValue(1);
    mocks.queryRaw.mockResolvedValueOnce([{ id: "user-1" }]).mockResolvedValueOnce([{ id: "session-1", userId: "user-1" }]).mockResolvedValueOnce([{ authorized: true }]);
    mocks.stateUpsert.mockResolvedValue({ userId: "user-1", credentialVersion: 2, sessionSecurityVersion: 3 });
    mocks.bindingFindFirst.mockResolvedValue({ id: "binding-1", sessionId: "session-1", operationKey: "passwordChange", securityVersion: 2, sessionSecurityVersion: 3, openingFingerprint: "open-1", state: "submitted" });
    mocks.operationFindFirst.mockResolvedValue({ status: "pending" });
    mocks.grantFindFirst.mockResolvedValue({ id: "grant-1", userId: "user-1", sessionId: "session-1", operationId: "gso_00000000000000000000000000", credentialVersion: 2, state: "issued", expiresAt: new Date("2026-08-24T16:10:00.000Z") });
    mocks.grantUpdate.mockResolvedValue({ id: "grant-1" });
    const tx = { $queryRaw: mocks.queryRaw, $executeRaw: mocks.executeRaw, accountSecurityState: { upsert: mocks.stateUpsert }, globalSecurityOperationBinding: { findFirst: mocks.bindingFindFirst }, globalSecurityOperation: { findFirst: mocks.operationFindFirst }, freshAuthGrant: { findFirst: mocks.grantFindFirst, update: mocks.grantUpdate } } as never;
    mocks.transaction.mockImplementation(async (callback) => callback(tx));
    await expect(consumeFreshAuthGrantForCurrentContext({ $transaction: mocks.transaction }, { userId: "user-1", sessionId: "session-1", credentialVersion: 2, sessionSecurityVersion: 3 }, { operationId: "gso_00000000000000000000000000", purpose: "password_change", openingFingerprint: "open-1" }, now)).resolves.toEqual({ id: "grant-1" });
    expect(mocks.grantUpdate).toHaveBeenCalledWith({ where: { id: "grant-1" }, data: { state: "consumed", consumedAt: now } });
  });

  it("does not consume a grant when the matching operation is in an unknown outcome state", async () => {
    mocks.executeRaw.mockResolvedValue(1);
    mocks.queryRaw.mockResolvedValueOnce([{ id: "user-1" }]).mockResolvedValueOnce([{ id: "session-1", userId: "user-1" }]).mockResolvedValueOnce([{ authorized: true }]);
    mocks.stateUpsert.mockResolvedValue({ userId: "user-1", credentialVersion: 2, sessionSecurityVersion: 3 });
    mocks.bindingFindFirst.mockResolvedValue({ id: "binding-1", sessionId: "session-1", operationKey: "passwordChange", securityVersion: 2, sessionSecurityVersion: 3, openingFingerprint: "open-1", state: "submitted" });
    mocks.operationFindFirst.mockResolvedValue({ status: "unknown" });
    const tx = { $queryRaw: mocks.queryRaw, $executeRaw: mocks.executeRaw, accountSecurityState: { upsert: mocks.stateUpsert }, globalSecurityOperationBinding: { findFirst: mocks.bindingFindFirst }, globalSecurityOperation: { findFirst: mocks.operationFindFirst }, freshAuthGrant: { findFirst: mocks.grantFindFirst, update: mocks.grantUpdate } } as never;
    mocks.transaction.mockImplementation(async (callback) => callback(tx));
    mocks.grantFindFirst.mockClear();
    mocks.grantUpdate.mockClear();

    await expect(consumeFreshAuthGrantForCurrentContext({ $transaction: mocks.transaction }, { userId: "user-1", sessionId: "session-1", credentialVersion: 2, sessionSecurityVersion: 3 }, { operationId: "gso_00000000000000000000000000", purpose: "password_change", openingFingerprint: "open-1" })).rejects.toThrow("operation_outcome_unknown");
    expect(mocks.grantFindFirst).not.toHaveBeenCalled();
    expect(mocks.grantUpdate).not.toHaveBeenCalled();
  });

  it("atomically consumes the exact password-change grant, updates the credential, advances both vectors, and signs out every session", async () => {
    mocks.passwordHash.mockResolvedValue("new-hash");
    mocks.executeRaw.mockResolvedValue(1);
    mocks.queryRaw.mockResolvedValueOnce([{ id: "user-1" }]).mockResolvedValueOnce([{ id: "session-1", userId: "user-1" }]).mockResolvedValueOnce([{ authorized: true }]);
    mocks.stateUpsert.mockResolvedValue({ userId: "user-1", credentialVersion: 2, sessionSecurityVersion: 3 });
    mocks.bindingFindFirst.mockResolvedValue({ id: "binding-1", sessionId: "session-1", operationKey: "passwordChange", securityVersion: 2, sessionSecurityVersion: 3, openingFingerprint: "open-1", state: "submitted" });
    mocks.operationFindFirst.mockResolvedValue({ intentFingerprint: "intent-1", status: "pending" });
    mocks.grantFindFirst.mockResolvedValue({ id: "grant-1" });
    mocks.accountFindFirst.mockResolvedValue({ id: "credential-account-1" });
    const tx = { $queryRaw: mocks.queryRaw, $executeRaw: mocks.executeRaw, accountSecurityState: { upsert: mocks.stateUpsert, update: mocks.stateUpdate }, account: { findFirst: mocks.accountFindFirst, update: mocks.accountUpdate }, globalSecurityOperationBinding: { findFirst: mocks.bindingFindFirst, update: mocks.bindingUpdate }, globalSecurityOperation: { findFirst: mocks.operationFindFirst, update: mocks.operationUpdate }, freshAuthGrant: { findFirst: mocks.grantFindFirst, update: mocks.grantUpdate }, session: { deleteMany: mocks.sessionDeleteMany }, sessionSecurityActivity: { updateMany: mocks.activityUpdateMany }, globalSecurityEvent: { create: mocks.eventCreate } } as never;
    mocks.transaction.mockImplementation(async (callback) => callback(tx));

    await expect(finalizePasswordChange({ $transaction: mocks.transaction }, { userId: "user-1", sessionId: "session-1", credentialVersion: 2, sessionSecurityVersion: 3 }, { operationId: "gso_00000000000000000000000000", openingFingerprint: "open-1", intentFingerprint: "intent-1" }, "new-password", { hash: mocks.passwordHash })).resolves.toEqual({ operationId: "gso_00000000000000000000000000", status: "signed_out" });
    expect(mocks.executeRaw.mock.calls.some(([query]) => query.join(" ").includes('apply_password_change_credential_mutation'))).toBe(true);
    expect(mocks.executeRaw.mock.calls.some(([query]) => query.join(" ").includes('revoke_sessions_for_global_security_operation'))).toBe(true);
    expect(mocks.sessionDeleteMany).not.toHaveBeenCalled();
    expect(mocks.activityUpdateMany).not.toHaveBeenCalled();
    expect(mocks.operationUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "completed", outcomeCode: "changed" }) }));
  });

  it("does not mutate credential or session state when password-transition outcome is unknown", async () => {
    mocks.passwordHash.mockResolvedValue("new-hash");
    mocks.executeRaw.mockResolvedValue(1);
    mocks.queryRaw.mockResolvedValueOnce([{ id: "user-1" }]).mockResolvedValueOnce([{ id: "session-1", userId: "user-1" }]).mockResolvedValueOnce([{ authorized: true }]);
    mocks.stateUpsert.mockResolvedValue({ userId: "user-1", credentialVersion: 2, sessionSecurityVersion: 3 });
    mocks.bindingFindFirst.mockResolvedValue({ id: "binding-1", sessionId: "session-1", operationKey: "passwordChange", securityVersion: 2, sessionSecurityVersion: 3, openingFingerprint: "open-1", state: "submitted" });
    mocks.operationFindFirst.mockResolvedValue({ intentFingerprint: "intent-1", status: "unknown" });
    const tx = { $queryRaw: mocks.queryRaw, $executeRaw: mocks.executeRaw, accountSecurityState: { upsert: mocks.stateUpsert, update: mocks.stateUpdate }, account: { findFirst: mocks.accountFindFirst, update: mocks.accountUpdate }, globalSecurityOperationBinding: { findFirst: mocks.bindingFindFirst, update: mocks.bindingUpdate }, globalSecurityOperation: { findFirst: mocks.operationFindFirst, update: mocks.operationUpdate }, freshAuthGrant: { findFirst: mocks.grantFindFirst, update: mocks.grantUpdate }, session: { deleteMany: mocks.sessionDeleteMany }, sessionSecurityActivity: { updateMany: mocks.activityUpdateMany }, globalSecurityEvent: { create: mocks.eventCreate } } as never;
    mocks.transaction.mockImplementation(async (callback) => callback(tx));
    mocks.accountUpdate.mockClear();
    mocks.sessionDeleteMany.mockClear();
    mocks.grantUpdate.mockClear();

    await expect(finalizePasswordChange({ $transaction: mocks.transaction }, { userId: "user-1", sessionId: "session-1", credentialVersion: 2, sessionSecurityVersion: 3 }, { operationId: "gso_00000000000000000000000000", openingFingerprint: "open-1", intentFingerprint: "intent-1" }, "new-password", { hash: mocks.passwordHash })).rejects.toThrow("operation_outcome_unknown");
    expect(mocks.accountUpdate).not.toHaveBeenCalled();
    expect(mocks.sessionDeleteMany).not.toHaveBeenCalled();
    expect(mocks.grantUpdate).not.toHaveBeenCalled();
  });

  it("does not mutate credential or session state when password-transition reauthorization is stale", async () => {
    mocks.passwordHash.mockResolvedValue("new-hash");
    mocks.executeRaw.mockResolvedValue(1);
    mocks.queryRaw.mockResolvedValueOnce([{ id: "user-1" }]).mockResolvedValueOnce([{ id: "session-1", userId: "user-1" }]).mockResolvedValueOnce([{ authorized: true }]);
    mocks.stateUpsert.mockResolvedValue({ userId: "user-1", credentialVersion: 3, sessionSecurityVersion: 3 });
    const tx = { $queryRaw: mocks.queryRaw, $executeRaw: mocks.executeRaw, accountSecurityState: { upsert: mocks.stateUpsert, update: mocks.stateUpdate }, account: { findFirst: mocks.accountFindFirst, update: mocks.accountUpdate }, globalSecurityOperationBinding: { findFirst: mocks.bindingFindFirst, update: mocks.bindingUpdate }, globalSecurityOperation: { findFirst: mocks.operationFindFirst, update: mocks.operationUpdate }, freshAuthGrant: { findFirst: mocks.grantFindFirst, update: mocks.grantUpdate }, session: { deleteMany: mocks.sessionDeleteMany }, sessionSecurityActivity: { updateMany: mocks.activityUpdateMany }, globalSecurityEvent: { create: mocks.eventCreate } } as never;
    mocks.transaction.mockImplementation(async (callback) => callback(tx));
    mocks.accountUpdate.mockClear();
    mocks.sessionDeleteMany.mockClear();

    await expect(finalizePasswordChange({ $transaction: mocks.transaction }, { userId: "user-1", sessionId: "session-1", credentialVersion: 2, sessionSecurityVersion: 3 }, { operationId: "gso_00000000000000000000000000", openingFingerprint: "open-1", intentFingerprint: "intent-1" }, "new-password", { hash: mocks.passwordHash })).rejects.toThrow("stale_security_version");
    expect(mocks.accountUpdate).not.toHaveBeenCalled();
    expect(mocks.sessionDeleteMany).not.toHaveBeenCalled();
  });

  it("terminalizes only the exact stale password-change operation and revokes its issued grant", async () => {
    mocks.executeRaw.mockResolvedValue(1);
    mocks.bindingFindFirst.mockResolvedValue({ id: "binding-1", operationKey: "passwordChange", securityVersion: 2, sessionSecurityVersion: 3, openingFingerprint: "open-1", state: "submitted" });
    mocks.operationFindFirst.mockResolvedValue({ intentFingerprint: "intent-1", status: "pending" });
    const tx = { $executeRaw: mocks.executeRaw, globalSecurityOperationBinding: { findFirst: mocks.bindingFindFirst, update: mocks.bindingUpdate }, globalSecurityOperation: { findFirst: mocks.operationFindFirst, update: mocks.operationUpdate }, freshAuthGrant: { updateMany: mocks.grantUpdateMany } } as never;
    mocks.transaction.mockImplementation(async (callback) => callback(tx));

    await expect(finalizeStalePasswordChange({ $transaction: mocks.transaction }, { userId: "user-1", sessionId: "session-1", credentialVersion: 2, sessionSecurityVersion: 3 }, { operationId: "gso_00000000000000000000000000", openingFingerprint: "open-1", intentFingerprint: "intent-1" })).resolves.toBeUndefined();
    expect(mocks.grantUpdateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ operationId: "gso_00000000000000000000000000", state: "issued" }), data: expect.objectContaining({ state: "revoked" }) }));
    expect(mocks.operationUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "stale", outcomeCode: "stale_security_version" }) }));
    expect(mocks.bindingUpdate).toHaveBeenCalledWith({ where: { id: "binding-1" }, data: { state: "terminal" } });
    expect(mocks.executeRaw.mock.calls.map(([query]) => query.join(" ")).some((sql) => sql.includes("write_global_security_event"))).toBe(true);
  });
});

describe("password-change terminal status", () => {
  it("takes the transition lock and reauthorizes the current session/version before reading a terminal outcome", async () => {
    mocks.executeRaw.mockClear();
    mocks.queryRaw.mockClear();
    mocks.stateUpsert.mockClear();
    mocks.bindingFindFirst.mockClear();
    mocks.operationFindFirst.mockClear();
    mocks.executeRaw.mockResolvedValue(1);
    mocks.queryRaw.mockResolvedValueOnce([{ id: "user-1" }]).mockResolvedValueOnce([{ id: "session-1", userId: "user-1" }]).mockResolvedValueOnce([{ authorized: true }]);
    mocks.stateUpsert.mockResolvedValue({ userId: "user-1", credentialVersion: 2, sessionSecurityVersion: 3 });
    mocks.bindingFindFirst.mockResolvedValue({ id: "binding-1", operationKey: "passwordChange", openingFingerprint: "open-1" });
    mocks.operationFindFirst.mockResolvedValue({ intentFingerprint: "intent-1", status: "completed", outcomeCode: "changed", terminalAt: new Date("2026-08-24T16:00:00.000Z") });
    const tx = { $queryRaw: mocks.queryRaw, $executeRaw: mocks.executeRaw, accountSecurityState: { upsert: mocks.stateUpsert }, globalSecurityOperationBinding: { findFirst: mocks.bindingFindFirst }, globalSecurityOperation: { findFirst: mocks.operationFindFirst } } as never;
    mocks.transaction.mockImplementation(async (callback) => callback(tx));
    const expected = { userId: "user-1", sessionId: "session-1", credentialVersion: 2, sessionSecurityVersion: 3 };

    await expect(getPasswordChangeStatus({ $transaction: mocks.transaction }, expected as never, { operationId: "gso_00000000000000000000000000", openingFingerprint: "open-1", intentFingerprint: "intent-1" })).resolves.toMatchObject({ status: "completed", outcomeCode: "changed" });

    expect(mocks.executeRaw.mock.calls.some(([query]) => query.join(" ").includes("global-security-transition:v1"))).toBe(true);
    expect(mocks.executeRaw.mock.invocationCallOrder.at(-1)!).toBeLessThan(mocks.queryRaw.mock.invocationCallOrder[0]!);
    expect(mocks.bindingFindFirst).toHaveBeenCalledWith({ where: { userId: "user-1", operationId: "gso_00000000000000000000000000" } });
  });
});
