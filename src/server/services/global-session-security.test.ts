import { describe, expect, it, vi } from "vitest";
import { authorizeGlobalSessionSecurity, createGlobalSessionHandle, createSessionRevokeIntentFingerprint, getGlobalSessionRevokeStatus, initializeGlobalSessionSecurityActivity, listGlobalSessionSecurity, recordQualifyingGlobalSessionUseAfterSuccess, revokeGlobalSessionSecurityWithCurrentPassword } from "@/server/services/global-session-security";

describe("global session security issuance", () => {
  it("initializes an ordinary Better Auth session through the database-clock guarded procedure", async () => {
    const queryRaw = vi.fn().mockResolvedValue([{ initialized: true }]);

    await expect(
      initializeGlobalSessionSecurityActivity(
        { $queryRaw: queryRaw } as never,
        { userId: "user-1", sessionId: "session-1" }
      )
    ).resolves.toBeUndefined();

    expect(queryRaw).toHaveBeenCalledOnce();
    expect(queryRaw.mock.calls[0]?.[0].join(" ")).toContain("initialize_global_session_security_activity");
  });
});

describe("global session security authorization", () => {
  it("uses the database procedure as the protected-session lifetime authority", async () => {
    const expiresAt = new Date("2026-09-01T12:00:00.000Z");
    const queryRaw = vi.fn().mockResolvedValue([{ authorized: true, expiresAt, lastQualifyingAt: new Date("2026-08-29T12:00:00.000Z"), idleWarningAt: null }]);

    await expect(
      authorizeGlobalSessionSecurity(
        { $queryRaw: queryRaw } as never,
        { userId: "user-1", sessionId: "session-1" }
      )
    ).resolves.toEqual({ expiresAt, lastQualifyingAt: new Date("2026-08-29T12:00:00.000Z"), idleWarningAt: null });

    expect(queryRaw.mock.calls[0]?.[0].join(" ")).toContain("authorize_global_session_security");
  });

  it("denies an expired or missing database session without exposing session internals", async () => {
    const queryRaw = vi.fn().mockResolvedValue([{ authorized: false, expiresAt: null, lastQualifyingAt: null, idleWarningAt: null }]);

    await expect(
      authorizeGlobalSessionSecurity(
        { $queryRaw: queryRaw } as never,
        { userId: "user-1", sessionId: "session-1" }
      )
    ).rejects.toThrow("unauthenticated");
  });
});

describe("global session security private projection", () => {
  it("lists only the current user's safe fields and replaces raw session identity with a server HMAC handle", async () => {
    const createdAt = new Date("2026-08-01T12:00:00.000Z");
    const expiresAt = new Date("2026-09-01T12:00:00.000Z");
    const queryRaw = vi.fn()
      .mockResolvedValueOnce([{
        sessionId: "session-1",
        userAgent: "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/131.0 Safari/537.36",
        createdAt,
        lastQualifyingAt: createdAt,
        idleWarningAt: null,
        expiresAt
      }]);

    const sessions = await listGlobalSessionSecurity(
      { $queryRaw: queryRaw } as never,
      { userId: "user-1", sessionId: "session-1" }
    );

    expect(sessions).toEqual([{
      handle: expect.stringMatching(/^[A-Za-z0-9_-]{30}$/),
      isCurrent: true,
      deviceLabel: "Chrome on Windows",
      createdAt,
      lastQualifyingAt: createdAt,
      idleWarningAt: null,
      expiresAt
    }]);
    expect(JSON.stringify(sessions)).not.toMatch(/session-1|Mozilla|ipAddress|token/i);
    expect(queryRaw.mock.calls[0]?.[0].join(" ")).toContain('list_global_session_security');
  });
});

describe("global session security qualifying use", () => {
  it("records only an explicit server-classified use through the same database authority after success", async () => {
    const queryRaw = vi.fn().mockResolvedValue([{
      authorized: true,
      expiresAt: new Date("2026-09-01T12:00:00.000Z"),
      lastQualifyingAt: new Date("2026-08-29T12:00:00.000Z"),
      idleWarningAt: null
    }]);

    await expect(recordQualifyingGlobalSessionUseAfterSuccess(
      { $queryRaw: queryRaw } as never,
      { userId: "user-1", sessionId: "session-1" },
      "cubby_owned_non_get_mutation"
    )).resolves.toEqual(expect.objectContaining({ expiresAt: expect.any(Date) }));

    expect(queryRaw.mock.calls[0]?.[0].join(" ")).toContain("authorize_global_session_security");
  });
});

describe("global session security revocation", () => {
  it("returns an authoritative pending status for same-session safe retry", async () => {
    const queryRaw = vi.fn().mockResolvedValue([{ status: "pending" }]);

    await expect(getGlobalSessionRevokeStatus(
      { $queryRaw: queryRaw } as never,
      { userId: "user-1", sessionId: "session-1" },
      { operationId: "gso_00000000000000000000000000", openingFingerprint: "a".repeat(64), intentFingerprint: "b".repeat(64) }
    )).resolves.toEqual({ operationId: "gso_00000000000000000000000000", status: "pending" });
  });

  it("exports the canonical server-only target and intent derivations for disposable acceptance", () => {
    const handle = createGlobalSessionHandle("user-1", "session-1");
    expect(handle).toMatch(/^[A-Za-z0-9_-]{30}$/);
    expect(createSessionRevokeIntentFingerprint("current", handle)).toMatch(/^[0-9a-f]{64}$/);
    expect(createSessionRevokeIntentFingerprint("others", "absent_target_handle")).not.toBe(createSessionRevokeIntentFingerprint("all", "absent_target_handle"));
  });

  it("requires an explicit confirmation before it can inspect, resolve, or revoke a session target", async () => {
    const queryRaw = vi.fn();
    const transaction = vi.fn();

    await expect(revokeGlobalSessionSecurityWithCurrentPassword(
      { $queryRaw: queryRaw, $transaction: transaction } as never,
      { userId: "user-1", sessionId: "session-1", credentialVersion: 2, sessionSecurityVersion: 3 },
      { operationId: "gso_00000000000000000000000000", openingFingerprint: "open", intentFingerprint: "intent", scope: "current", targetHandle: "opaque-current", confirmed: false },
      "current-password",
      { verify: vi.fn() }
    )).rejects.toThrow("session_revoke_confirmation_required");

    expect(queryRaw).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it("rejects a target handle for broad scopes before it resolves any session", async () => {
    const queryRaw = vi.fn();

    await expect(revokeGlobalSessionSecurityWithCurrentPassword(
      { $queryRaw: queryRaw, $transaction: vi.fn() } as never,
      { userId: "user-1", sessionId: "session-1", credentialVersion: 2, sessionSecurityVersion: 3 },
      { operationId: "gso_00000000000000000000000000", openingFingerprint: "open", intentFingerprint: "intent", scope: "others", targetHandle: "must-not-be-present", confirmed: true },
      "current-password",
      { verify: vi.fn() }
    )).rejects.toThrow("session_revoke_target_forbidden");

    expect(queryRaw).not.toHaveBeenCalled();
  });

  it("requires the submitted intent fingerprint to bind the resolved scope target", async () => {
    const queryRaw = vi.fn().mockResolvedValue([]);

    await expect(revokeGlobalSessionSecurityWithCurrentPassword(
      { $queryRaw: queryRaw, $transaction: vi.fn() } as never,
      { userId: "user-1", sessionId: "session-1", credentialVersion: 2, sessionSecurityVersion: 3 },
      { operationId: "gso_00000000000000000000000000", openingFingerprint: "open", intentFingerprint: "not-the-canonical-intent", scope: "others", confirmed: true },
      "current-password",
      { verify: vi.fn() }
    )).rejects.toThrow("session_revoke_intent_invalid");
  });
});
