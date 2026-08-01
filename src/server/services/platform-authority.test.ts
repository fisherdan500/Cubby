import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  authorityFind: vi.fn(),
  txAuthorityFind: vi.fn(),
  settingsFind: vi.fn(),
  settingsUpdateMany: vi.fn(),
  operationCreate: vi.fn(),
  operationFind: vi.fn(),
  operationUpdate: vi.fn(),
  auditCreate: vi.fn(),
  transaction: vi.fn(),
  executeRaw: vi.fn(),
  queryRaw: vi.fn()
}));

vi.mock("@/server/auth/session", () => ({ requireUser: mocks.requireUser }));
vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    platformAuthority: { findFirst: mocks.authorityFind },
    $transaction: mocks.transaction
  }
}));

import {
  allocatePlatformRegistrationOperation,
  completePlatformRegistrationOperation,
  getPlatformOwnerContext,
  getPlatformRegistrationOperationStatus,
  isPlatformOwner
} from "@/server/services/platform-authority";

const currentSettings = {
  id: "platform",
  householdCreationMode: "closed",
  allowPublicRegistration: false,
  revision: 7,
  createdAt: new Date("2026-07-22T12:00:00.000Z"),
  updatedAt: new Date("2026-07-22T12:00:00.000Z")
};

const pendingOperation = {
  id: "op_server_opaque_123",
  actorUserId: "platform-owner",
  intentFingerprint: createHash("sha256")
    .update(JSON.stringify({ householdCreationMode: "open", allowPublicRegistration: true }))
    .digest("hex"),
  expectedRevision: 7,
  householdCreationMode: "open",
  allowPublicRegistration: true,
  status: "pending",
  result: null
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireUser.mockResolvedValue({
    id: "platform-owner",
    email: "owner@example.test",
    emailVerified: true,
    name: "Owner"
  });
  mocks.authorityFind.mockResolvedValue({ id: "platform", ownerUserId: "platform-owner" });
  mocks.txAuthorityFind.mockResolvedValue({ id: "platform", ownerUserId: "platform-owner" });
  mocks.settingsFind.mockResolvedValue(currentSettings);
  mocks.settingsUpdateMany.mockResolvedValue({ count: 1 });
  mocks.operationCreate.mockResolvedValue(pendingOperation);
  mocks.operationFind.mockResolvedValue(pendingOperation);
  mocks.operationUpdate.mockResolvedValue({
    ...pendingOperation,
    status: "completed",
    result: {
      operationId: pendingOperation.id,
      status: "completed",
      settings: { householdCreationMode: "open", allowPublicRegistration: true, revision: 8 }
    }
  });
  mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
  mocks.executeRaw.mockResolvedValue(1);
  mocks.queryRaw.mockResolvedValue([{ id: "platform" }]);
  mocks.transaction.mockImplementation((operation) =>
    operation({
      $executeRaw: mocks.executeRaw,
      $queryRaw: mocks.queryRaw,
      platformAuthority: { findFirst: mocks.txAuthorityFind },
      platformSettings: {
        findUnique: mocks.settingsFind,
        updateMany: mocks.settingsUpdateMany
      },
      platformRegistrationOperation: {
        create: mocks.operationCreate,
        findFirst: mocks.operationFind,
        update: mocks.operationUpdate
      },
      platformAuditEvent: { create: mocks.auditCreate }
    })
  );
});

describe("platform owner authorization", () => {
  it("reports authority independently of household context", async () => {
    await expect(isPlatformOwner("platform-owner")).resolves.toBe(true);
    mocks.authorityFind.mockResolvedValue(null);
    await expect(isPlatformOwner("household-owner")).resolves.toBe(false);
  });

  it("authorizes by platform authority without consulting household membership or roles", async () => {
    await expect(getPlatformOwnerContext()).resolves.toEqual({
      userId: "platform-owner",
      authorityId: "platform"
    });
    expect(mocks.authorityFind).toHaveBeenCalledWith({
      where: { id: "platform", ownerUserId: "platform-owner" },
      select: { id: true, ownerUserId: true }
    });
  });

  it("rejects a household owner or admin who is not the platform owner", async () => {
    mocks.authorityFind.mockResolvedValue(null);

    await expect(getPlatformOwnerContext()).rejects.toThrow("forbidden");
  });
});

describe("platform registration operations", () => {
  it("allocates a server-issued opaque operation bound to normalized intent and current revision", async () => {
    await expect(
      allocatePlatformRegistrationOperation({ householdCreationMode: "open", allowPublicRegistration: true })
    ).resolves.toEqual({ operationId: "op_server_opaque_123", status: "pending" });

    expect(mocks.operationCreate).toHaveBeenCalledWith({
      data: {
        actorUserId: "platform-owner",
        intentFingerprint: pendingOperation.intentFingerprint,
        expectedRevision: 7,
        householdCreationMode: "open",
        allowPublicRegistration: true
      }
    });
    expect(mocks.executeRaw).toHaveBeenCalledOnce();
    expect(mocks.queryRaw.mock.calls[0]?.[0].join(" ")).toContain('FROM "PlatformAuthority"');
    expect(mocks.queryRaw.mock.calls[1]?.[0].join(" ")).toContain('FROM "PlatformSettings"');
    expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "Serializable" });
  });

  it("conditionally completes a pending operation with one atomic audit event", async () => {
    await expect(completePlatformRegistrationOperation({ operationId: pendingOperation.id })).resolves.toEqual({
      operationId: pendingOperation.id,
      status: "completed",
      settings: { householdCreationMode: "open", allowPublicRegistration: true, revision: 8 }
    });

    expect(mocks.settingsUpdateMany).toHaveBeenCalledWith({
      where: { id: "platform", revision: 7 },
      data: { householdCreationMode: "open", allowPublicRegistration: true, revision: { increment: 1 } }
    });
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: {
        actorUserId: "platform-owner",
        action: "platform.registration.update",
        entityType: "platform_settings",
        entityId: "platform",
        source: "application",
        before: { householdCreationMode: "closed", allowPublicRegistration: false, revision: 7 },
        after: { householdCreationMode: "open", allowPublicRegistration: true, revision: 8 }
      }
    });
    expect(mocks.auditCreate.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.operationUpdate.mock.invocationCallOrder[0]
    );
    expect(mocks.operationUpdate).toHaveBeenCalledWith({
      where: { id: pendingOperation.id },
      data: {
        status: "completed",
        result: {
          operationId: pendingOperation.id,
          status: "completed",
          settings: { householdCreationMode: "open", allowPublicRegistration: true, revision: 8 }
        },
        auditEventId: "audit-1"
      }
    });
  });

  it("replays a completed result without another policy write or audit", async () => {
    const completed = {
      ...pendingOperation,
      status: "completed",
      result: {
        operationId: pendingOperation.id,
        status: "completed",
        settings: { householdCreationMode: "open", allowPublicRegistration: true, revision: 8 }
      }
    };
    mocks.operationFind.mockResolvedValue(completed);

    await expect(completePlatformRegistrationOperation({ operationId: pendingOperation.id })).resolves.toEqual(completed.result);

    expect(mocks.settingsUpdateMany).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
    expect(mocks.operationUpdate).not.toHaveBeenCalled();
  });

  it("persists and replays a stale result when the revision claim loses", async () => {
    mocks.settingsUpdateMany.mockResolvedValue({ count: 0 });
    const stale = {
      operationId: pendingOperation.id,
      status: "stale",
      settings: { householdCreationMode: "closed", allowPublicRegistration: false, revision: 8 }
    };
    mocks.operationUpdate.mockResolvedValue({ ...pendingOperation, status: "stale", result: stale });
    mocks.settingsFind.mockResolvedValue({ ...currentSettings, revision: 8 });

    await expect(completePlatformRegistrationOperation({ operationId: pendingOperation.id })).resolves.toEqual(stale);

    expect(mocks.auditCreate).not.toHaveBeenCalled();
    expect(mocks.operationUpdate).toHaveBeenCalledWith({
      where: { id: pendingOperation.id },
      data: { status: "stale", result: stale }
    });
  });

  it("makes foreign and unknown operation status look identical to a current owner", async () => {
    mocks.operationFind.mockResolvedValueOnce({ ...pendingOperation, actorUserId: "another-owner" }).mockResolvedValueOnce(null);

    await expect(getPlatformRegistrationOperationStatus({ operationId: pendingOperation.id })).rejects.toThrow("not_found");
    await expect(getPlatformRegistrationOperationStatus({ operationId: "op_unknown_456" })).rejects.toThrow("not_found");
  });

  it("makes a non-owner status lookup existence-neutral", async () => {
    mocks.txAuthorityFind.mockResolvedValue(null);

    await expect(getPlatformRegistrationOperationStatus({ operationId: pendingOperation.id })).rejects.toThrow("not_found");
    expect(mocks.operationFind).not.toHaveBeenCalled();
  });

  it("fails closed if platform ownership is stale at transaction time", async () => {
    mocks.txAuthorityFind.mockResolvedValue(null);

    await expect(completePlatformRegistrationOperation({ operationId: pendingOperation.id })).rejects.toThrow("forbidden");

    expect(mocks.settingsUpdateMany).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });
});
