import { describe, expect, it, vi } from "vitest";
import { acknowledgeRecoveryCodeSetSaved, beginRecoveryReset, finalizeRecoveryPasswordReset, getRecoveryEnrollmentStatus, getRecoveryResetStatus, issueRecoveryCodeSet, rehearseRecoveryCodeSet } from "@/server/services/recovery-lifecycle";

const operationId = "gso_0123456789abcdefghjkmnpqrs";
const context = { userId: "user-1", sessionId: "session-1", credentialVersion: 3, sessionSecurityVersion: 4 };

function transactionHarness() {
  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(1),
    $queryRaw: vi.fn(async (query) => {
      const sql = query.join(" ");
      if (sql.includes('FROM "User"')) return [{ id: "user-1" }];
      if (sql.includes('> clock_timestamp()') || sql.includes('authorize_global_session_security')) return [{ authorized: true }];
      return [{ id: "session-1", userId: "user-1" }];
    }),
    accountSecurityState: { upsert: vi.fn().mockResolvedValue({ userId: "user-1", credentialVersion: 3, sessionSecurityVersion: 4 }) },
    globalSecurityOperationBinding: {
      findFirst: vi.fn().mockResolvedValue({ id: "binding-1", sessionId: "session-1", recoverySessionId: null, operationKey: "recoveryEnrollment", securityVersion: 3, sessionSecurityVersion: 4, openingFingerprint: "opening-1", state: "submitted", expiresAt: new Date("2030-01-01") }),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 0 })
    },
    globalSecurityOperation: {
      findFirst: vi.fn().mockResolvedValue({ intentFingerprint: "intent-1", status: "pending" }),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 0 })
    },
    freshAuthGrant: {
      findFirst: vi.fn().mockResolvedValue({ id: "grant-1" }),
      update: vi.fn().mockResolvedValue({})
    },
    recoveryCodeSet: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),

      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      update: vi.fn().mockResolvedValue({}),
      create: vi.fn().mockResolvedValue({ setVersion: 1 })
    },
    recoveryCode: {
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(9),
      findFirst: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      createMany: vi.fn().mockResolvedValue({ count: 10 })
    },
    recoverySession: { findMany: vi.fn().mockResolvedValue([]), update: vi.fn().mockResolvedValue({}) },
    globalSecurityEvent: { create: vi.fn().mockResolvedValue({}) }
  };
  const database = { $transaction: vi.fn(async (callback) => callback(tx)) };
  return { tx, database };
}

describe("recovery-code lifecycle", () => {
  it("persists only ten hashes and returns plaintext exactly once after consuming the enrollment grant", async () => {
    const { tx, database } = transactionHarness();
    const codes = Array.from({ length: 10 }, (_, index) => `0000-0000-0000-0000-0000-${String(index).padStart(4, "0")}`);
    const hash = vi.fn(async (_code: string, ordinal: number) => ({ salt: Buffer.alloc(16, ordinal), derivedKey: Buffer.alloc(32, ordinal), kdfVersion: 1 as const }));

    await expect(issueRecoveryCodeSet(database as never, context, { operationId, openingFingerprint: "opening-1", intentFingerprint: "intent-1" }, { generate: () => codes, hash })).resolves.toEqual({ operationId, setVersion: 1, codes });

    expect(hash).toHaveBeenCalledTimes(10);
    expect(tx.recoveryCode.createMany).toHaveBeenCalledWith({ data: expect.arrayContaining([
      expect.objectContaining({ userId: "user-1", setVersion: 1, ordinal: 1, salt: expect.any(Buffer), derivedKey: expect.any(Buffer), kdfVersion: 1, state: "active" })
    ]) });
    expect(JSON.stringify(tx.recoveryCode.createMany.mock.calls)).not.toContain(codes[0]);
    expect(tx.freshAuthGrant.update).toHaveBeenCalledWith({ where: { id: "grant-1" }, data: { state: "consumed", consumedAt: expect.any(Date) } });
    expect(tx.$queryRaw.mock.calls.some(([query]) => query.join(" ").includes('FROM "FreshAuthGrant"') && query.join(" ").includes('"expiresAt" > clock_timestamp()'))).toBe(true);
    expect(tx.globalSecurityOperation.update).not.toHaveBeenCalled();
    expect(tx.globalSecurityOperationBinding.update).not.toHaveBeenCalled();
  });


  it("does not redisplay plaintext when the issuance operation is pending but its set already committed", async () => {
    const { tx, database } = transactionHarness();
    tx.recoveryCodeSet.findFirst.mockResolvedValue({ setVersion: 1 });
    const generate = vi.fn(() => []);
    await expect(issueRecoveryCodeSet(database as never, context, { operationId, openingFingerprint: "opening-1", intentFingerprint: "intent-1" }, { generate, hash: vi.fn() })).rejects.toThrow("recovery_codes_already_generated");
    expect(generate).not.toHaveBeenCalled();
  });

  it("regeneration closes every restricted carrier derived from superseded sets", async () => {
    const { tx, database } = transactionHarness();
    tx.recoveryCodeSet.findMany.mockResolvedValue([{ setVersion: 1 }]);
    tx.recoveryCode.findMany.mockResolvedValue([{ id: "old-consumed-code" }]);
    tx.recoverySession.findMany.mockResolvedValue([{ id: "old-recovery-session", operationId: "gso_11111111111111111111111111" }]);

    const codes = Array.from({ length: 10 }, (_, index) => `0000-0000-0000-0000-0000-${String(index).padStart(4, "0")}`);
    await issueRecoveryCodeSet(database as never, context, { operationId, openingFingerprint: "opening-1", intentFingerprint: "intent-1" }, { generate: () => codes, hash: async (_code, ordinal) => ({ salt: Buffer.alloc(16, ordinal), derivedKey: Buffer.alloc(32, ordinal), kdfVersion: 1 }) });
    expect(tx.globalSecurityOperation.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "rejected", outcomeCode: "recovery_set_regenerated" }) }));
    expect(tx.globalSecurityOperationBinding.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { state: "terminal" } }));
    expect(tx.recoverySession.update).toHaveBeenCalledWith({ where: { id: "old-recovery-session" }, data: { state: "closed", closedAt: expect.any(Date) } });
  });

  it("requires the exact current generated set and advances it through save acknowledgement to rehearsal-required", async () => {
    const { tx, database } = transactionHarness();
    tx.recoveryCodeSet.findFirst.mockResolvedValue({ userId: "user-1", setVersion: 1, issuanceOperationId: operationId, state: "generated" });
    await expect(acknowledgeRecoveryCodeSetSaved(database as never, context, { operationId, setVersion: 1 })).resolves.toEqual({ operationId, setVersion: 1, state: "rehearsal_required" });
    expect(tx.recoveryCodeSet.update).toHaveBeenNthCalledWith(1, { where: { userId_setVersion: { userId: "user-1", setVersion: 1 } }, data: { state: "saveAcknowledged", saveAcknowledgedAt: expect.any(Date) } });
    expect(tx.recoveryCodeSet.update).toHaveBeenNthCalledWith(2, { where: { userId_setVersion: { userId: "user-1", setVersion: 1 } }, data: { state: "rehearsalRequired" } });
  });

  it("replays save acknowledgement as metadata without repeating set transitions", async () => {
    const { tx, database } = transactionHarness();
    tx.recoveryCodeSet.findFirst.mockResolvedValue({ userId: "user-1", setVersion: 1, issuanceOperationId: operationId, state: "rehearsalRequired" });
    await expect(acknowledgeRecoveryCodeSetSaved(database as never, context, { operationId, setVersion: 1 })).resolves.toEqual({ operationId, setVersion: 1, state: "rehearsal_required" });
    expect(tx.recoveryCodeSet.update).not.toHaveBeenCalled();
  });

  it("returns enrollment metadata without any recovery code material", async () => {
    const { tx, database } = transactionHarness();
    tx.globalSecurityOperationBinding.findFirst.mockResolvedValue({ id: "binding-1", sessionId: "session-1", recoverySessionId: null, operationKey: "recoveryEnrollment", securityVersion: 3, sessionSecurityVersion: 4, openingFingerprint: "opening-1", state: "terminal", expiresAt: new Date("2030-01-01") });
    tx.recoveryCodeSet.findFirst.mockResolvedValue({ setVersion: 1, state: "rehearsed", expectedCodeCount: 10, saveAcknowledgedAt: new Date("2026-08-27"), rehearsedAt: new Date("2026-08-27") });
    tx.globalSecurityOperation.findFirst.mockResolvedValue({ intentFingerprint: "intent-1", status: "completed", outcomeCode: "rehearsal_completed", terminalAt: new Date("2026-08-27") });
    const result = await getRecoveryEnrollmentStatus(database as never, context, { operationId, openingFingerprint: "opening-1", intentFingerprint: "intent-1" });
    expect(result).toEqual({ operationId, setVersion: 1, state: "rehearsed", status: "completed", outcomeCode: "rehearsal_completed", remainingCodes: 9, terminalAt: new Date("2026-08-27") });
    expect(JSON.stringify(result)).not.toMatch(/password|hash|salt|derived|[0-9A-HJKMNPQRSTVWXYZ]{4}(?:-[0-9A-HJKMNPQRSTVWXYZ]{4}){5}/i);
  });

  it("reports zero remaining codes for a previously rehearsed set invalidated by regeneration", async () => {
    const { tx, database } = transactionHarness();
    tx.globalSecurityOperationBinding.findFirst.mockResolvedValue({ id: "binding-1", sessionId: "session-1", recoverySessionId: null, operationKey: "recoveryEnrollment", securityVersion: 3, sessionSecurityVersion: 4, openingFingerprint: "opening-1", state: "terminal" });
    tx.recoveryCodeSet.findFirst.mockResolvedValue({ setVersion: 1, state: "invalidated" });
    tx.recoveryCode.count.mockResolvedValue(0);
    tx.globalSecurityOperation.findFirst.mockResolvedValue({ intentFingerprint: "intent-1", status: "completed", outcomeCode: "rehearsal_completed", terminalAt: new Date("2026-08-27") });
    await expect(getRecoveryEnrollmentStatus(database as never, context, { operationId, openingFingerprint: "opening-1", intentFingerprint: "intent-1" })).resolves.toMatchObject({ state: "invalidated", remainingCodes: 0, outcomeCode: "rehearsal_completed" });
  });

  it("consumes exactly one matching code for mandatory rehearsal and leaves nine active", async () => {
    const { tx, database } = transactionHarness();
    const records = Array.from({ length: 10 }, (_, index) => ({ id: `code-${index + 1}`, salt: Buffer.alloc(16, index + 1), derivedKey: Buffer.alloc(32, index + 1), kdfVersion: 1, state: "active" }));
    tx.recoveryCodeSet.findFirst.mockResolvedValue({ userId: "user-1", setVersion: 1, issuanceOperationId: operationId, state: "rehearsalRequired" });
    tx.recoveryCode.findMany.mockResolvedValue(records);
    tx.recoveryCode.findFirst.mockResolvedValue(records[3]);
    const verify = vi.fn(async (_code, record) => record.derivedKey[0] === 4);

    await expect(rehearseRecoveryCodeSet(database as never, context, { operationId, openingFingerprint: "opening-1", intentFingerprint: "intent-1", setVersion: 1, code: "0000-0000-0000-0000-0000-0003" }, { verify })).resolves.toEqual({ operationId, setVersion: 1, state: "rehearsed", remainingCodes: 9 });
    expect(tx.recoveryCode.update).toHaveBeenCalledWith({ where: { id: "code-4" }, data: { state: "consumed", consumedPurpose: "enrollmentRehearsal", consumedOperationId: operationId, consumedAt: expect.any(Date) } });
    expect(tx.recoveryCodeSet.update).toHaveBeenCalledWith({ where: { userId_setVersion: { userId: "user-1", setVersion: 1 } }, data: { state: "rehearsed", rehearsedAt: expect.any(Date) } });
    expect(tx.globalSecurityOperation.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "completed", outcomeCode: "rehearsal_completed", outcomeSnapshot: { setVersion: 1, remainingCodes: 9 } }) }));
  });

  it("terminalizes a wrong rehearsal code without consuming any code or marking readiness", async () => {
    const { tx, database } = transactionHarness();
    const records = [{ id: "code-1", salt: Buffer.alloc(16, 1), derivedKey: Buffer.alloc(32, 1), kdfVersion: 1, state: "active" }];
    tx.recoveryCodeSet.findFirst.mockResolvedValue({ userId: "user-1", setVersion: 1, issuanceOperationId: operationId, state: "rehearsalRequired" });
    tx.recoveryCode.findMany.mockResolvedValue(records);

    await expect(rehearseRecoveryCodeSet(database as never, context, { operationId, openingFingerprint: "opening-1", intentFingerprint: "intent-1", setVersion: 1, code: "0000-0000-0000-0000-0000-0003" }, { verify: vi.fn(async () => false) })).rejects.toThrow("recovery_code_invalid");
    expect(tx.recoveryCode.update).not.toHaveBeenCalled();
    expect(tx.recoveryCodeSet.update).not.toHaveBeenCalled();
    expect(tx.globalSecurityOperation.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "rejected", outcomeCode: "rehearsal_failed", outcomeSnapshot: {} }) }));
    expect(tx.globalSecurityOperationBinding.update).toHaveBeenCalledWith({ where: { id: "binding-1" }, data: { state: "terminal" } });
  });

  it("consumes one rehearsed active code into a ten-minute recovery-session-only reset operation", async () => {
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      $queryRaw: vi.fn()
        .mockResolvedValueOnce([{ id: "user-1" }]).mockResolvedValueOnce([{ credentialVersion: 7, sessionSecurityVersion: 8 }])
        .mockResolvedValueOnce([{ id: "user-1" }]).mockResolvedValueOnce([{ credentialVersion: 7, sessionSecurityVersion: 8 }])
        .mockResolvedValueOnce([{ createdAt: new Date("2026-08-28T12:00:00Z"), expiresAt: new Date("2026-08-28T12:10:00Z") }]),
      recoveryCodeSet: { findFirst: vi.fn().mockResolvedValue({ setVersion: 2, state: "rehearsed" }) },
      recoveryCode: {
        findMany: vi.fn().mockResolvedValue([{ id: "code-9", salt: Buffer.alloc(16, 9), derivedKey: Buffer.alloc(32, 9), kdfVersion: 1 }]),
        findFirst: vi.fn().mockResolvedValue({ id: "code-9", salt: Buffer.alloc(16, 9), derivedKey: Buffer.alloc(32, 9), kdfVersion: 1 }),
        update: vi.fn().mockResolvedValue({})
      },
      recoverySession: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ id: "recovery-session-1" }) },
      globalSecurityOperationBinding: { create: vi.fn().mockResolvedValue({ id: "binding-reset-1" }), update: vi.fn().mockResolvedValue({}) },
      globalSecurityOperation: { create: vi.fn().mockResolvedValue({}) }
    };
    const database = { $transaction: vi.fn(async (callback) => callback(tx)) };
    const verify = vi.fn(async () => true);

    await expect(beginRecoveryReset(database as never, { userId: "user-1", operationId, openingFingerprint: "reset-opening", intentFingerprint: "reset-intent", code: "0000-0000-0000-0000-0000-0009" }, { verify })).resolves.toEqual({ operationId, recoverySessionId: "recovery-session-1", expiresAt: expect.any(Date) });
    expect(tx.recoverySession.create).toHaveBeenCalledWith({ data: expect.objectContaining({ userId: "user-1", recoveryCodeId: "code-9", operationId, purpose: "recovery_reset", state: "restricted", createdAt: expect.any(Date), expiresAt: expect.any(Date) }) });
    expect(tx.globalSecurityOperationBinding.create).toHaveBeenCalledWith({ data: expect.objectContaining({ userId: "user-1", sessionId: null, recoverySessionId: "recovery-session-1", operationId, operationKey: "recoveryReset", securityVersion: 7, sessionSecurityVersion: 8, state: "open" }) });
    expect(tx.recoveryCode.update).toHaveBeenCalledWith({ where: { id: "code-9" }, data: { state: "consumed", consumedPurpose: "recoveryReset", consumedOperationId: operationId, consumedAt: expect.any(Date) } });
  });

  it("replays an already-open matching restricted reset without rechecking or redisplaying the consumed code", async () => {
    const existing = { id: "recovery-session-1", recoveryCodeId: "code-9", operationId, state: "restricted", expiresAt: new Date("2030-01-01") };
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      $queryRaw: vi.fn().mockResolvedValueOnce([{ id: "user-1" }]).mockResolvedValueOnce([{ credentialVersion: 7, sessionSecurityVersion: 8 }]).mockResolvedValueOnce([{ authorized: true }]),
      recoverySession: { findFirst: vi.fn().mockResolvedValue(existing) },
      globalSecurityOperationBinding: { findFirst: vi.fn().mockResolvedValue({ id: "binding-reset-1", recoverySessionId: existing.id, sessionId: null, operationKey: "recoveryReset", securityVersion: 7, sessionSecurityVersion: 8, openingFingerprint: "reset-opening", state: "submitted" }) },
      globalSecurityOperation: { findFirst: vi.fn().mockResolvedValue({ intentFingerprint: "reset-intent", status: "pending" }) },
      recoveryCodeSet: { findFirst: vi.fn().mockResolvedValue({ state: "rehearsed" }), count: vi.fn().mockResolvedValue(0) }, recoveryCode: { findMany: vi.fn(), findFirst: vi.fn().mockResolvedValue({ setVersion: 2 }) }
    };
    const database = { $transaction: vi.fn(async (callback) => callback(tx)) };
    const verify = vi.fn();
    await expect(beginRecoveryReset(database as never, { userId: "user-1", operationId, openingFingerprint: "reset-opening", intentFingerprint: "reset-intent", code: "different-or-consumed" }, { verify })).resolves.toEqual({ operationId, recoverySessionId: existing.id, expiresAt: existing.expiresAt });
    expect(verify).not.toHaveBeenCalled();
    expect(tx.recoveryCode.findMany).not.toHaveBeenCalled();
  });

  it("stale-terminalizes an existing reset carrier whose bound version no longer matches current state", async () => {
    const existing = { id: "recovery-session-1", recoveryCodeId: "code-9", operationId, state: "restricted", expiresAt: new Date("2030-01-01") };
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      $queryRaw: vi.fn().mockResolvedValueOnce([{ id: "user-1" }]).mockResolvedValueOnce([{ credentialVersion: 8, sessionSecurityVersion: 8 }]).mockResolvedValueOnce([{ authorized: true }]),
      recoverySession: { findFirst: vi.fn().mockResolvedValue(existing), update: vi.fn().mockResolvedValue({}) },
      globalSecurityOperationBinding: { findFirst: vi.fn().mockResolvedValue({ id: "binding-reset-1", recoverySessionId: existing.id, sessionId: null, operationKey: "recoveryReset", securityVersion: 7, sessionSecurityVersion: 8, openingFingerprint: "reset-opening", state: "submitted" }), update: vi.fn().mockResolvedValue({}) },
      globalSecurityOperation: { findFirst: vi.fn().mockResolvedValue({ intentFingerprint: "reset-intent", status: "pending" }), update: vi.fn().mockResolvedValue({}) },
      globalSecurityEvent: { create: vi.fn().mockResolvedValue({}) },
      recoveryCodeSet: { findFirst: vi.fn().mockResolvedValue({ state: "rehearsed" }), count: vi.fn().mockResolvedValue(0) }, recoveryCode: { findMany: vi.fn(), findFirst: vi.fn().mockResolvedValue({ setVersion: 2 }) }
    };
    const database = { $transaction: vi.fn(async (callback) => callback(tx)) };
    await expect(beginRecoveryReset(database as never, { userId: "user-1", operationId, openingFingerprint: "reset-opening", intentFingerprint: "reset-intent", code: "consumed" }, { verify: vi.fn() })).rejects.toThrow("stale_security_version");
    expect(tx.globalSecurityOperation.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "stale", outcomeCode: "stale_security_version" }) }));
    expect(tx.recoverySession.update).toHaveBeenCalledWith({ where: { id: existing.id }, data: { state: "closed", closedAt: expect.any(Date) } });
  });

  it("atomically resets the credential from only the restricted carrier and requires normal sign-in", async () => {
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      $queryRaw: vi.fn().mockResolvedValueOnce([{ id: "user-1" }]).mockResolvedValueOnce([{ credentialVersion: 7, sessionSecurityVersion: 8 }]).mockResolvedValueOnce([{ authorized: true }]),
      recoverySession: { findFirst: vi.fn().mockResolvedValue({ id: "recovery-session-1", recoveryCodeId: "code-9", operationId, purpose: "recovery_reset", state: "restricted", expiresAt: new Date("2030-01-01") }), update: vi.fn().mockResolvedValue({}) },
      globalSecurityOperationBinding: { findFirst: vi.fn().mockResolvedValue({ id: "binding-reset-1", recoverySessionId: "recovery-session-1", sessionId: null, operationKey: "recoveryReset", securityVersion: 7, sessionSecurityVersion: 8, openingFingerprint: "reset-opening", state: "submitted" }), update: vi.fn().mockResolvedValue({}) },
      globalSecurityOperation: { findFirst: vi.fn().mockResolvedValue({ intentFingerprint: "reset-intent", status: "pending" }), update: vi.fn().mockResolvedValue({}) },
      account: { findFirst: vi.fn().mockResolvedValue({ id: "credential-account-1" }) },
      accountSecurityState: { update: vi.fn().mockResolvedValue({}) },
      freshAuthGrant: { updateMany: vi.fn().mockResolvedValue({ count: 2 }) },
      session: { deleteMany: vi.fn().mockResolvedValue({ count: 2 }) },
      sessionSecurityActivity: { updateMany: vi.fn().mockResolvedValue({ count: 2 }) },
      globalSecurityEvent: { create: vi.fn().mockResolvedValue({}) }
    };
    const database = { $transaction: vi.fn(async (callback) => callback(tx)) };
    const hash = vi.fn(async () => "replacement-hash");

    await expect(finalizeRecoveryPasswordReset(database as never, { userId: "user-1", recoverySessionId: "recovery-session-1", operationId, credentialVersion: 7, sessionSecurityVersion: 8 }, { openingFingerprint: "reset-opening", intentFingerprint: "reset-intent" }, "new-password", { hash })).resolves.toEqual({ operationId, status: "signed_out" });
    expect(hash.mock.invocationCallOrder[0]).toBeLessThan(database.$transaction.mock.invocationCallOrder[0]);
    expect(tx.accountSecurityState.update).toHaveBeenCalledWith({ where: { userId: "user-1" }, data: { credentialVersion: { increment: 1 }, sessionSecurityVersion: { increment: 1 }, lastCredentialOperationId: operationId, lastSessionSecurityOperationId: operationId } });
    expect(tx.freshAuthGrant.updateMany).toHaveBeenCalledWith({ where: { userId: "user-1", state: "issued" }, data: { state: "revoked", revokedAt: expect.any(Date) } });
    expect(tx.recoverySession.update).toHaveBeenCalledWith({ where: { id: "recovery-session-1" }, data: { state: "closed", closedAt: expect.any(Date) } });
    expect(tx.$executeRaw.mock.calls.some(([query]) => query.strings?.join(" ").includes("apply_recovery_reset_credential_mutation") || query.join?.(" ").includes("apply_recovery_reset_credential_mutation"))).toBe(true);
  });

  it("returns only authoritative metadata for the exact closed recovery carrier after reset", async () => {
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      recoverySession: { findFirst: vi.fn().mockResolvedValue({ id: "recovery-session-1", userId: "user-1", operationId, purpose: "recovery_reset", state: "closed", expiresAt: new Date("2030-01-01"), closedAt: new Date("2026-08-27") }) },
      globalSecurityOperationBinding: { findFirst: vi.fn().mockResolvedValue({ id: "binding-reset-1", recoverySessionId: "recovery-session-1", sessionId: null, operationKey: "recoveryReset", openingFingerprint: "reset-opening", state: "terminal" }) },
      globalSecurityOperation: { findFirst: vi.fn().mockResolvedValue({ intentFingerprint: "reset-intent", status: "completed", outcomeCode: "reset_completed", outcomeSnapshot: {}, terminalAt: new Date("2026-08-27") }) }
    };
    const database = { $transaction: vi.fn(async (callback) => callback(tx)) };
    const result = await getRecoveryResetStatus(database as never, { userId: "user-1", recoverySessionId: "recovery-session-1", operationId, openingFingerprint: "reset-opening", intentFingerprint: "reset-intent" });
    expect(result).toEqual({ operationId, state: "closed", status: "completed", outcomeCode: "reset_completed", terminalAt: new Date("2026-08-27") });
    expect(JSON.stringify(result)).not.toMatch(/password|hash|salt|derived|[0-9A-HJKMNPQRSTVWXYZ]{4}(?:-[0-9A-HJKMNPQRSTVWXYZ]{4}){5}/i);
  });

  it("terminalizes a reset as stale without changing the credential when either security version drifted", async () => {
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      $queryRaw: vi.fn().mockResolvedValueOnce([{ id: "user-1" }]).mockResolvedValueOnce([{ credentialVersion: 8, sessionSecurityVersion: 8 }]),
      recoverySession: { findFirst: vi.fn().mockResolvedValue({ id: "recovery-session-1", userId: "user-1", operationId, purpose: "recovery_reset", state: "restricted", expiresAt: new Date("2030-01-01") }), update: vi.fn().mockResolvedValue({}) },
      globalSecurityOperationBinding: { findFirst: vi.fn().mockResolvedValue({ id: "binding-reset-1", recoverySessionId: "recovery-session-1", sessionId: null, operationKey: "recoveryReset", securityVersion: 7, sessionSecurityVersion: 8, openingFingerprint: "reset-opening", state: "submitted" }), update: vi.fn().mockResolvedValue({}) },
      globalSecurityOperation: { findFirst: vi.fn().mockResolvedValue({ intentFingerprint: "reset-intent", status: "pending" }), update: vi.fn().mockResolvedValue({}) },
      globalSecurityEvent: { create: vi.fn().mockResolvedValue({}) }
    };
    const database = { $transaction: vi.fn(async (callback) => callback(tx)) };
    await expect(finalizeRecoveryPasswordReset(database as never, { userId: "user-1", recoverySessionId: "recovery-session-1", operationId, credentialVersion: 7, sessionSecurityVersion: 8 }, { openingFingerprint: "reset-opening", intentFingerprint: "reset-intent" }, "new-password", { hash: vi.fn(async () => "replacement-hash") })).rejects.toThrow("stale_security_version");
    expect(tx.globalSecurityOperation.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "stale", outcomeCode: "stale_security_version" }) }));
    expect(tx.recoverySession.update).toHaveBeenCalledWith({ where: { id: "recovery-session-1" }, data: { state: "closed", closedAt: expect.any(Date) } });
  });
});
