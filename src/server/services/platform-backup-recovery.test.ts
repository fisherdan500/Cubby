import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  platformAuthorityFindUnique: vi.fn(),
  backupRecordFindUnique: vi.fn(),
  transaction: vi.fn(),
  readLocalBackup: vi.fn(),
  lockHouseholdCreation: vi.fn(),
  queryRaw: vi.fn(),
  txPlatformAuthorityFindUnique: vi.fn(),
  platformSettingsFindUnique: vi.fn(),
  householdCount: vi.fn(),
  householdFindFirst: vi.fn(),
  householdCreate: vi.fn(),
  userFindUnique: vi.fn(),
  accountFindFirst: vi.fn(),
  txBackupRecordFindUnique: vi.fn(),
  backupRecordCreate: vi.fn(),
  platformAuditEventCreate: vi.fn(),
  auditEventCreate: vi.fn()
}));

vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    platformAuthority: { findUnique: mocks.platformAuthorityFindUnique },
    backupRecord: { findUnique: mocks.backupRecordFindUnique },
    $transaction: mocks.transaction
  }
}));

vi.mock("@/lib/env", () => ({
  automatedBackupConfig: { directory: "/var/lib/cubby/backups" }
}));

vi.mock("@/server/services/local-backup-storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/services/local-backup-storage")>()),
  readLocalBackup: mocks.readLocalBackup
}));

vi.mock("@/server/services/mutation-locks", () => ({
  lockHouseholdCreation: mocks.lockHouseholdCreation
}));

import {
  BACKUP_RECOVERY_ACKNOWLEDGEMENT,
  BACKUP_RECOVERY_TARGET_ACKNOWLEDGEMENT,
  authorizeBackupRecovery,
  inspectBackupRecoveryCandidate,
  provisionBackupRecoveryTarget
} from "@/server/services/platform-backup-recovery";

const filename = "cubby-backup-v2-20260715T215013Z-aaaaaaaaaaaa.json";
const checksum = "a".repeat(64);
const file = {
  filename,
  absolutePath: "C:/private/cubby/backups/candidate.json",
  exportedAt: "2026-07-15T21:50:13.000Z",
  householdName: "Previous Home",
  checksum,
  size: 1234,
  itemCount: 17
};

const authority = {
  id: "platform",
  ownerUserId: "platform-owner-1"
};

const authorizeInput = {
  currentOwnerUserId: "platform-owner-1",
  targetHouseholdId: "target-household-1",
  targetOwnerUserId: "target-owner-1",
  confirmTargetOwnerEmail: "owner@example.com",
  filename,
  confirmChecksum: checksum,
  confirmSourceHouseholdName: "Previous Home",
  acknowledgement: BACKUP_RECOVERY_ACKNOWLEDGEMENT
};

const tx = {
  $queryRaw: mocks.queryRaw,
  platformAuthority: { findUnique: mocks.txPlatformAuthorityFindUnique },
  platformSettings: { findUnique: mocks.platformSettingsFindUnique },
  household: {
    count: mocks.householdCount,
    findFirst: mocks.householdFindFirst,
    create: mocks.householdCreate
  },
  user: { findUnique: mocks.userFindUnique },
  account: { findFirst: mocks.accountFindFirst },
  backupRecord: {
    findUnique: mocks.txBackupRecordFindUnique,
    create: mocks.backupRecordCreate
  },
  platformAuditEvent: { create: mocks.platformAuditEventCreate },
  auditEvent: { create: mocks.auditEventCreate }
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.platformAuthorityFindUnique.mockResolvedValue(authority);
  mocks.backupRecordFindUnique.mockResolvedValue(null);
  mocks.readLocalBackup.mockResolvedValue(file);
  mocks.queryRaw.mockResolvedValue([{ actorIsSoleOwner: true, operationalCount: 0n }]);
  mocks.txPlatformAuthorityFindUnique.mockResolvedValue(authority);
  mocks.platformSettingsFindUnique.mockResolvedValue({
    id: "platform",
    householdCreationMode: "closed",
    allowPublicRegistration: false
  });
  mocks.householdCount.mockResolvedValue(1);
  mocks.householdFindFirst.mockResolvedValue({ id: "target-household-1", name: "New Home" });
  mocks.householdCreate.mockResolvedValue({ id: "target-household-1", name: "Recovered Home" });
  mocks.userFindUnique.mockResolvedValue({
    id: "target-owner-1",
    name: "Target Owner",
    email: "owner@example.com"
  });
  mocks.accountFindFirst.mockResolvedValue({ id: "credential-1" });
  mocks.txBackupRecordFindUnique.mockResolvedValue(null);
  mocks.backupRecordCreate.mockResolvedValue({ id: "recovery-record-1" });
  mocks.platformAuditEventCreate.mockResolvedValue({ id: "platform-audit-1" });
  mocks.auditEventCreate.mockResolvedValue({ id: "household-audit-1" });
  mocks.transaction.mockImplementation(async (operation) => operation(tx));
});

describe("platform backup recovery authority", () => {
  it("provisions one empty credential-backed sole-owner target under locked platform authority", async () => {
    mocks.householdCount.mockResolvedValue(0);

    await expect(provisionBackupRecoveryTarget({
      currentOwnerUserId: "platform-owner-1",
      targetOwnerUserId: "target-owner-1",
      confirmTargetOwnerEmail: "owner@example.com",
      targetHouseholdName: "Recovered Home",
      acknowledgement: BACKUP_RECOVERY_TARGET_ACKNOWLEDGEMENT
    })).resolves.toEqual({
      targetHouseholdId: "target-household-1",
      targetOwnerUserId: "target-owner-1"
    });

    expect(mocks.queryRaw.mock.calls[0]?.[0]?.join(" ")).toContain('FROM "PlatformAuthority"');
    expect(mocks.queryRaw.mock.calls[0]?.[0]?.join(" ")).toContain("FOR UPDATE");
    expect(mocks.lockHouseholdCreation).toHaveBeenCalledWith(tx);
    expect(mocks.lockHouseholdCreation.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.householdCount.mock.invocationCallOrder[0]
    );
    expect(mocks.householdCreate).toHaveBeenCalledWith({
      data: {
        name: "Recovered Home",
        createdByUserId: "target-owner-1",
        members: {
          create: {
            userId: "target-owner-1",
            role: "owner",
            displayName: "Target Owner"
          }
        },
        settings: {
          create: {
            allowPublicRegistration: false,
            allowNewHouseholdCreation: false
          }
        }
      },
      select: { id: true }
    });
    expect(mocks.platformAuditEventCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorUserId: null,
        action: "platform.backup_recovery.target.provision",
        entityType: "household",
        entityId: "target-household-1",
        source: "host_local_backup_recovery",
        after: {
          confirmedPlatformOwnerUserId: "platform-owner-1",
          targetHouseholdId: "target-household-1",
          targetOwnerUserId: "target-owner-1"
        }
      })
    });
    expect(mocks.auditEventCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        householdId: "target-household-1",
        actorUserId: null,
        actorMemberId: null,
        action: "backup.recovery.target.provision",
        entityType: "household",
        entityId: "target-household-1"
      })
    });
    expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "Serializable",
      maxWait: 5_000,
      timeout: 15_000
    });
  });

  it.each([
    ["nonempty deployment", () => mocks.householdCount.mockResolvedValue(1), "backup_recovery_target_count_mismatch"],
    ["open household creation", () => mocks.platformSettingsFindUnique.mockResolvedValue({ id: "platform", householdCreationMode: "open", allowPublicRegistration: true }), "backup_recovery_household_creation_not_closed"],
    ["changed authority", () => mocks.txPlatformAuthorityFindUnique.mockResolvedValue({ id: "platform", ownerUserId: "successor-owner" }), "platform_owner_current_confirmation_mismatch"],
    ["missing target owner", () => mocks.userFindUnique.mockResolvedValue(null), "backup_recovery_target_owner_not_found"],
    ["wrong target email", () => mocks.userFindUnique.mockResolvedValue({ id: "target-owner-1", name: "Target Owner", email: "other@example.com" }), "backup_recovery_target_owner_email_mismatch"],
    ["missing credential", () => mocks.accountFindFirst.mockResolvedValue(null), "backup_recovery_target_owner_credential_missing"]
  ])("does not provision an unsafe recovery target: %s", async (_label, arrange, error) => {
    mocks.householdCount.mockResolvedValue(0);
    mocks.userFindUnique.mockResolvedValue({ id: "target-owner-1", name: "Target Owner", email: "owner@example.com" });
    arrange();

    await expect(provisionBackupRecoveryTarget({
      currentOwnerUserId: "platform-owner-1",
      targetOwnerUserId: "target-owner-1",
      confirmTargetOwnerEmail: "owner@example.com",
      targetHouseholdName: "Recovered Home",
      acknowledgement: BACKUP_RECOVERY_TARGET_ACKNOWLEDGEMENT
    })).rejects.toThrow(error);
    expect(mocks.householdCreate).not.toHaveBeenCalled();
  });

  it.each([
    ["email", { confirmTargetOwnerEmail: " owner@example.com" }, "backup_recovery_target_owner_email_mismatch"],
    ["acknowledgement", { acknowledgement: ` ${BACKUP_RECOVERY_TARGET_ACKNOWLEDGEMENT}` }, "backup_recovery_target_acknowledgement_required"]
  ])("preserves exact recovery-target confirmation bytes for %s", async (_label, override, error) => {
    mocks.householdCount.mockResolvedValue(0);
    mocks.userFindUnique.mockResolvedValue({ id: "target-owner-1", name: "Target Owner", email: "owner@example.com" });

    await expect(provisionBackupRecoveryTarget({
      currentOwnerUserId: "platform-owner-1",
      targetOwnerUserId: "target-owner-1",
      confirmTargetOwnerEmail: "owner@example.com",
      targetHouseholdName: "Recovered Home",
      acknowledgement: BACKUP_RECOVERY_TARGET_ACKNOWLEDGEMENT,
      ...override
    })).rejects.toThrow(error);
    expect(mocks.householdCreate).not.toHaveBeenCalled();
  });

  it("normalizes a concurrent recovery-target provisioning transaction", async () => {
    mocks.transaction.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("serialization conflict", {
        code: "P2034",
        clientVersion: "test"
      })
    );

    await expect(provisionBackupRecoveryTarget({
      currentOwnerUserId: "platform-owner-1",
      targetOwnerUserId: "target-owner-1",
      confirmTargetOwnerEmail: "owner@example.com",
      targetHouseholdName: "Recovered Home",
      acknowledgement: BACKUP_RECOVERY_TARGET_ACKNOWLEDGEMENT
    })).rejects.toThrow("platform_owner_operation_retry");
  });

  it("inspects one explicitly named unassociated backup under current platform authority", async () => {
    await expect(inspectBackupRecoveryCandidate({
      currentOwnerUserId: "platform-owner-1",
      filename
    })).resolves.toEqual({
      filename,
      exportedAt: file.exportedAt,
      householdName: file.householdName,
      checksum,
      size: file.size,
      itemCount: file.itemCount
    });

    expect(mocks.platformAuthorityFindUnique).toHaveBeenCalledWith({
      where: { id: "platform" },
      select: { id: true, ownerUserId: true }
    });
    expect(mocks.readLocalBackup).toHaveBeenCalledWith("/var/lib/cubby/backups", filename);
    expect(mocks.backupRecordFindUnique).toHaveBeenCalledWith({
      where: { storageFilename: filename },
      select: { id: true }
    });
  });

  it("rejects surrounding whitespace in exact filenames before authority, database, or filesystem access", async () => {
    const nonExactFilename = ` ${filename} `;

    await expect(inspectBackupRecoveryCandidate({
      currentOwnerUserId: "platform-owner-1",
      filename: nonExactFilename
    })).rejects.toThrow();
    await expect(authorizeBackupRecovery({
      ...authorizeInput,
      filename: nonExactFilename
    })).rejects.toThrow();

    expect(mocks.platformAuthorityFindUnique).not.toHaveBeenCalled();
    expect(mocks.backupRecordFindUnique).not.toHaveBeenCalled();
    expect(mocks.readLocalBackup).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("rejects a stale platform-owner confirmation before reading the filesystem", async () => {
    await expect(inspectBackupRecoveryCandidate({
      currentOwnerUserId: "former-owner",
      filename
    })).rejects.toThrow("platform_owner_current_confirmation_mismatch");

    expect(mocks.readLocalBackup).not.toHaveBeenCalled();
  });

  it("does not treat platform ownership alone as recovery authority for an associated backup", async () => {
    mocks.backupRecordFindUnique.mockResolvedValue({ id: "existing-record" });

    await expect(inspectBackupRecoveryCandidate({
      currentOwnerUserId: "platform-owner-1",
      filename
    })).rejects.toThrow("backup_recovery_already_authorized");
  });

  it("rejects a stale platform-owner confirmation before authorization reads the filesystem", async () => {
    mocks.platformAuthorityFindUnique.mockResolvedValue({ id: "platform", ownerUserId: "successor-owner" });

    await expect(authorizeBackupRecovery(authorizeInput)).rejects.toThrow(
      "platform_owner_current_confirmation_mismatch"
    );
    expect(mocks.readLocalBackup).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("authorizes exactly one verified backup for one fresh target and writes both audit trails", async () => {
    await expect(authorizeBackupRecovery(authorizeInput)).resolves.toEqual({
      backupRecordId: "recovery-record-1",
      targetHouseholdId: "target-household-1",
      targetOwnerUserId: "target-owner-1",
      filename,
      checksum
    });

    expect(mocks.readLocalBackup).toHaveBeenCalledWith("/var/lib/cubby/backups", filename);
    expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "Serializable",
      maxWait: 5_000,
      timeout: 15_000
    });
    expect(mocks.queryRaw.mock.calls[0]?.[0]?.join(" ")).toContain('FROM "PlatformAuthority"');
    expect(mocks.queryRaw.mock.calls[0]?.[0]?.join(" ")).toContain("FOR UPDATE");
    expect(mocks.queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.txPlatformAuthorityFindUnique.mock.invocationCallOrder[0]!
    );
    expect(mocks.lockHouseholdCreation).toHaveBeenCalledWith(tx);
    expect(mocks.lockHouseholdCreation.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.householdCount.mock.invocationCallOrder[0]
    );
    expect(mocks.txBackupRecordFindUnique).toHaveBeenCalledWith({
      where: { storageFilename: filename },
      select: { id: true }
    });
    expect(mocks.backupRecordCreate).toHaveBeenCalledWith({
      data: {
        householdId: "target-household-1",
        actorUserId: null,
        kind: "recovery_authorized",
        status: "complete",
        checksum,
        itemCount: 17,
        storageFilename: filename,
        byteSize: 1234
      },
      select: { id: true }
    });
    expect(mocks.platformAuditEventCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorUserId: null,
        action: "platform.backup_recovery.authorize",
        entityType: "backup_record",
        entityId: "recovery-record-1",
        source: "host_local_backup_recovery",
        after: expect.objectContaining({
          confirmedPlatformOwnerUserId: "platform-owner-1",
          targetHouseholdId: "target-household-1",
          targetOwnerUserId: "target-owner-1",
          storageFilename: filename,
          checksum
        })
      })
    });
    expect(mocks.auditEventCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        householdId: "target-household-1",
        actorUserId: null,
        actorMemberId: null,
        action: "backup.recovery.authorize",
        entityType: "backup_record",
        entityId: "recovery-record-1"
      })
    });
  });

  it("rejects a candidate whose identity changes before durable authorization", async () => {
    mocks.readLocalBackup
      .mockResolvedValueOnce(file)
      .mockResolvedValueOnce({ ...file, checksum: "b".repeat(64) });

    await expect(authorizeBackupRecovery(authorizeInput)).rejects.toThrow(
      "backup_recovery_checksum_mismatch"
    );
    expect(mocks.readLocalBackup).toHaveBeenCalledTimes(2);
    expect(mocks.backupRecordCreate).not.toHaveBeenCalled();
    expect(mocks.platformAuditEventCreate).not.toHaveBeenCalled();
    expect(mocks.auditEventCreate).not.toHaveBeenCalled();
  });

  it.each([
    ["acknowledgement", { acknowledgement: "wrong" }, "backup_recovery_acknowledgement_required"],
    ["checksum", { confirmChecksum: "b".repeat(64) }, "backup_recovery_checksum_mismatch"],
    ["source name", { confirmSourceHouseholdName: "Different Home" }, "backup_recovery_source_confirmation_mismatch"]
  ])("fails closed on a mismatched %s confirmation before beginning a transaction", async (_label, override, error) => {
    await expect(authorizeBackupRecovery({ ...authorizeInput, ...override })).rejects.toThrow(error);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("rechecks current platform authority while holding the transaction lock", async () => {
    mocks.txPlatformAuthorityFindUnique.mockResolvedValue({
      id: "platform",
      ownerUserId: "successor-owner"
    });

    await expect(authorizeBackupRecovery(authorizeInput)).rejects.toThrow(
      "platform_owner_current_confirmation_mismatch"
    );
    expect(mocks.backupRecordCreate).not.toHaveBeenCalled();
  });

  it("requires exactly one active target household", async () => {
    mocks.householdCount.mockResolvedValue(2);

    await expect(authorizeBackupRecovery(authorizeInput)).rejects.toThrow(
      "backup_recovery_target_count_mismatch"
    );
    expect(mocks.backupRecordCreate).not.toHaveBeenCalled();
  });

  it("refuses authorization while deployment-wide household creation is open", async () => {
    mocks.platformSettingsFindUnique.mockResolvedValue({
      id: "platform",
      householdCreationMode: "open",
      allowPublicRegistration: false
    });

    await expect(authorizeBackupRecovery(authorizeInput)).rejects.toThrow(
      "backup_recovery_household_creation_not_closed"
    );
    expect(mocks.backupRecordCreate).not.toHaveBeenCalled();
  });

  it("rejects an already-associated filename before opening the candidate", async () => {
    mocks.backupRecordFindUnique.mockResolvedValue({ id: "existing-record" });

    await expect(authorizeBackupRecovery(authorizeInput)).rejects.toThrow("backup_recovery_already_authorized");
    expect(mocks.readLocalBackup).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("normalizes a uniqueness race to the replay-safe authorization error", async () => {
    mocks.backupRecordCreate.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("duplicate storage filename", {
        code: "P2002",
        clientVersion: "test"
      })
    );

    await expect(authorizeBackupRecovery(authorizeInput)).rejects.toThrow("backup_recovery_already_authorized");
  });

  it.each([
    ["target email", { confirmTargetOwnerEmail: " target@example.test" }, "backup_recovery_target_owner_email_mismatch"],
    ["checksum", { confirmChecksum: ` ${checksum}` }, "backup_recovery_checksum_mismatch"],
    ["acknowledgement", { acknowledgement: ` ${BACKUP_RECOVERY_ACKNOWLEDGEMENT}` }, "backup_recovery_acknowledgement_required"]
  ])("preserves exact operator confirmation bytes for %s", async (_label, override, error) => {
    await expect(authorizeBackupRecovery({ ...authorizeInput, ...override })).rejects.toThrow(error);
    expect(mocks.backupRecordCreate).not.toHaveBeenCalled();
  });

  it.each([
    ["missing target", () => mocks.householdFindFirst.mockResolvedValue(null), "backup_recovery_target_not_found"],
    ["non-sole owner", () => mocks.queryRaw.mockResolvedValue([{ actorIsSoleOwner: false, operationalCount: 0n }]), "backup_recovery_target_owner_not_sole"],
    ["occupied target", () => mocks.queryRaw.mockResolvedValue([{ actorIsSoleOwner: true, operationalCount: 1n }]), "backup_target_not_empty"],
    ["missing target owner", () => mocks.userFindUnique.mockResolvedValue(null), "backup_recovery_target_owner_not_found"],
    ["wrong target email", () => mocks.userFindUnique.mockResolvedValue({ id: "target-owner-1", email: "other@example.com" }), "backup_recovery_target_owner_email_mismatch"],
    ["missing credential", () => mocks.accountFindFirst.mockResolvedValue(null), "backup_recovery_target_owner_credential_missing"],
    ["replayed filename", () => mocks.txBackupRecordFindUnique.mockResolvedValue({ id: "existing-record" }), "backup_recovery_already_authorized"]
  ])("rejects an invalid or replayed target state: %s", async (_label, arrange, error) => {
    arrange();
    await expect(authorizeBackupRecovery(authorizeInput)).rejects.toThrow(error);
    expect(mocks.backupRecordCreate).not.toHaveBeenCalled();
  });
});
