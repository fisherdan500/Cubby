import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  authorityFind: vi.fn(),
  txAuthorityFind: vi.fn(),
  settingsFind: vi.fn(),
  settingsUpdate: vi.fn(),
  auditCreate: vi.fn(),
  transaction: vi.fn(),
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
  getPlatformOwnerContext,
  isPlatformOwner,
  updatePlatformRegistrationSettings
} from "@/server/services/platform-authority";

const currentSettings = {
  id: "platform",
  householdCreationMode: "closed",
  allowPublicRegistration: false,
  createdAt: new Date("2026-07-22T12:00:00.000Z"),
  updatedAt: new Date("2026-07-22T12:00:00.000Z")
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
  mocks.settingsUpdate.mockResolvedValue({
    ...currentSettings,
    householdCreationMode: "open",
    allowPublicRegistration: true
  });
  mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
  mocks.queryRaw.mockResolvedValue([{ id: "platform" }]);
  mocks.transaction.mockImplementation((operation) =>
    operation({
      $queryRaw: mocks.queryRaw,
      platformAuthority: { findFirst: mocks.txAuthorityFind },
      platformSettings: {
        findUnique: mocks.settingsFind,
        update: mocks.settingsUpdate
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

describe("platform registration policy mutation", () => {
  it("reauthorizes and audits the bounded change inside one transaction", async () => {
    await expect(
      updatePlatformRegistrationSettings({
        householdCreationMode: "open",
        allowPublicRegistration: true
      })
    ).resolves.toMatchObject({
      householdCreationMode: "open",
      allowPublicRegistration: true
    });

    expect(mocks.txAuthorityFind).toHaveBeenCalledWith({
      where: { id: "platform", ownerUserId: "platform-owner" },
      select: { id: true, ownerUserId: true }
    });
    expect(mocks.queryRaw).toHaveBeenCalledTimes(2);
    expect(mocks.queryRaw.mock.calls[0]?.[0].join(" ")).toContain('FROM "PlatformAuthority"');
    expect(mocks.queryRaw.mock.calls[0]?.[0].join(" ")).toContain("FOR UPDATE");
    expect(mocks.queryRaw.mock.calls[1]?.[0].join(" ")).toContain('FROM "PlatformSettings"');
    expect(mocks.queryRaw.mock.calls[1]?.[0].join(" ")).toContain("FOR UPDATE");
    expect(mocks.queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.txAuthorityFind.mock.invocationCallOrder[0]
    );
    expect(mocks.txAuthorityFind.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.queryRaw.mock.invocationCallOrder[1]
    );
    expect(mocks.queryRaw.mock.invocationCallOrder[1]).toBeLessThan(
      mocks.settingsFind.mock.invocationCallOrder[0]
    );
    expect(mocks.settingsUpdate).toHaveBeenCalledWith({
      where: { id: "platform" },
      data: { householdCreationMode: "open", allowPublicRegistration: true }
    });
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: {
        actorUserId: "platform-owner",
        action: "platform.registration.update",
        entityType: "platform_settings",
        entityId: "platform",
        source: "application",
        before: {
          householdCreationMode: "closed",
          allowPublicRegistration: false
        },
        after: {
          householdCreationMode: "open",
          allowPublicRegistration: true
        }
      }
    });
    expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "Serializable" });
  });

  it("fails closed if platform ownership is stale at transaction time", async () => {
    mocks.txAuthorityFind.mockResolvedValue(null);

    await expect(
      updatePlatformRegistrationSettings({
        householdCreationMode: "open",
        allowPublicRegistration: true
      })
    ).rejects.toThrow("forbidden");

    expect(mocks.settingsUpdate).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("rejects unknown policy modes before opening a transaction", async () => {
    await expect(
      updatePlatformRegistrationSettings({
        householdCreationMode: "friends_only",
        allowPublicRegistration: false
      })
    ).rejects.toThrow();

    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
