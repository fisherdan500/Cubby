import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  verify: vi.fn(),
  attest: vi.fn(),
  bind: vi.fn(),
  recover: vi.fn(),
  provisionBackupTarget: vi.fn(),
  inspectBackup: vi.fn(),
  authorizeBackup: vi.fn()
}));

vi.mock("../../../src/server/services/platform-owner-binding", () => ({
  BOOTSTRAP_VERIFICATION_ACKNOWLEDGEMENT: "I_ACCEPT_LOCAL_BOOTSTRAP_EMAIL_VERIFICATION",
  verifyBootstrapPlatformOwnerCandidate: mocks.verify,
  attestPlatformOwnerSuccessor: mocks.attest,
  bindInitialPlatformOwner: mocks.bind,
  recoverPlatformOwner: mocks.recover
}));

vi.mock("../../../src/server/services/platform-backup-recovery", () => ({
  provisionBackupRecoveryTarget: mocks.provisionBackupTarget,
  inspectBackupRecoveryCandidate: mocks.inspectBackup,
  authorizeBackupRecovery: mocks.authorizeBackup
}));

import {
  parsePlatformOwnerCommand,
  runPlatformOwnerCommand
} from "../../../scripts/platform-owner";

beforeEach(() => {
  vi.resetAllMocks();
});

describe("platform owner host-local command", () => {
  it("requires an explicit account and high-friction acknowledgement for bootstrap verification", () => {
    expect(
      parsePlatformOwnerCommand([
        "verify-bootstrap",
        "--user-id",
        "user-explicit",
        "--confirm-email",
        "owner@example.test",
        "--acknowledgement",
        "I_ACCEPT_LOCAL_BOOTSTRAP_EMAIL_VERIFICATION"
      ])
    ).toEqual({
      kind: "verify-bootstrap",
      input: {
        userId: "user-explicit",
        confirmEmail: "owner@example.test",
        acknowledgement: "I_ACCEPT_LOCAL_BOOTSTRAP_EMAIL_VERIFICATION"
      }
    });
  });

  it("preserves the bootstrap acknowledgement for byte-exact service validation", () => {
    expect(
      parsePlatformOwnerCommand([
        "verify-bootstrap",
        "--user-id",
        "user-explicit",
        "--confirm-email",
        "owner@example.test",
        "--acknowledgement",
        " I_ACCEPT_LOCAL_BOOTSTRAP_EMAIL_VERIFICATION "
      ])
    ).toMatchObject({
      input: { acknowledgement: " I_ACCEPT_LOCAL_BOOTSTRAP_EMAIL_VERIFICATION " }
    });
  });

  it("preserves raw email confirmations for bootstrap, binding, and recovery", () => {
    expect(
      parsePlatformOwnerCommand([
        "verify-bootstrap",
        "--user-id",
        "user-explicit",
        "--confirm-email",
        " owner@example.test ",
        "--acknowledgement",
        "I_ACCEPT_LOCAL_BOOTSTRAP_EMAIL_VERIFICATION"
      ])
    ).toMatchObject({ input: { confirmEmail: " owner@example.test " } });

    expect(
      parsePlatformOwnerCommand([
        "bind",
        "--user-id",
        "user-explicit",
        "--confirm-email",
        " owner@example.test "
      ])
    ).toMatchObject({ input: { confirmEmail: " owner@example.test " } });

    expect(
      parsePlatformOwnerCommand([
        "recover",
        "--current-owner-user-id",
        "current-owner",
        "--successor-user-id",
        "successor-user",
        "--confirm-successor-email",
        " successor@example.test "
      ])
    ).toMatchObject({ input: { confirmSuccessorEmail: " successor@example.test " } });
  });

  it("requires an explicit user ID and confirming email for initial binding", () => {
    expect(
      parsePlatformOwnerCommand([
        "bind",
        "--user-id",
        "user-explicit",
        "--confirm-email",
        "owner@example.test"
      ])
    ).toEqual({
      kind: "bind",
      input: { userId: "user-explicit", confirmEmail: "owner@example.test" }
    });
    expect(() => parsePlatformOwnerCommand(["bind", "--confirm-email", "owner@example.test"])).toThrow(
      "platform_owner_command_usage"
    );
  });

  it("requires explicit current owner, successor, email, and acknowledgement for successor attestation", () => {
    expect(
      parsePlatformOwnerCommand([
        "attest-successor",
        "--current-owner-user-id",
        "current-owner",
        "--successor-user-id",
        "successor-user",
        "--confirm-successor-email",
        "successor@example.test",
        "--acknowledgement",
        "I_ACCEPT_LOCAL_SUCCESSOR_EMAIL_VERIFICATION"
      ])
    ).toEqual({
      kind: "attest-successor",
      input: {
        currentOwnerUserId: "current-owner",
        successorUserId: "successor-user",
        confirmSuccessorEmail: "successor@example.test",
        acknowledgement: "I_ACCEPT_LOCAL_SUCCESSOR_EMAIL_VERIFICATION"
      }
    });
  });

  it("preserves whitespace in the successor attestation email confirmation", () => {
    expect(
      parsePlatformOwnerCommand([
        "attest-successor",
        "--current-owner-user-id",
        "current-owner",
        "--successor-user-id",
        "successor-user",
        "--confirm-successor-email",
        " successor@example.test ",
        "--acknowledgement",
        "I_ACCEPT_LOCAL_SUCCESSOR_EMAIL_VERIFICATION"
      ])
    ).toMatchObject({
      input: { confirmSuccessorEmail: " successor@example.test " }
    });
  });

  it("preserves the successor acknowledgement for byte-exact service validation", () => {
    expect(
      parsePlatformOwnerCommand([
        "attest-successor",
        "--current-owner-user-id",
        "current-owner",
        "--successor-user-id",
        "successor-user",
        "--confirm-successor-email",
        "successor@example.test",
        "--acknowledgement",
        " I_ACCEPT_LOCAL_SUCCESSOR_EMAIL_VERIFICATION "
      ])
    ).toMatchObject({
      input: { acknowledgement: " I_ACCEPT_LOCAL_SUCCESSOR_EMAIL_VERIFICATION " }
    });
  });

  it("requires current owner, successor, and email confirmation for recovery", () => {
    expect(
      parsePlatformOwnerCommand([
        "recover",
        "--current-owner-user-id",
        "current-owner",
        "--successor-user-id",
        "successor-user",
        "--confirm-successor-email",
        "successor@example.test"
      ])
    ).toEqual({
      kind: "recover",
      input: {
        currentOwnerUserId: "current-owner",
        successorUserId: "successor-user",
        confirmSuccessorEmail: "successor@example.test"
      }
    });
  });

  it("requires an explicit current platform owner and filename for backup inspection", () => {
    expect(parsePlatformOwnerCommand([
      "inspect-backup-recovery",
      "--current-owner-user-id", "current-owner",
      "--filename", "cubby-backup-v2-20260715T215013Z-aaaaaaaaaaaa.json"
    ])).toEqual({
      kind: "inspect-backup-recovery",
      input: {
        currentOwnerUserId: "current-owner",
        filename: "cubby-backup-v2-20260715T215013Z-aaaaaaaaaaaa.json"
      }
    });
  });

  it("preserves surrounding whitespace in exact backup filenames for rejection by the service", () => {
    expect(parsePlatformOwnerCommand([
      "inspect-backup-recovery",
      "--current-owner-user-id", "current-owner",
      "--filename", " cubby-backup-v2-20260715T215013Z-aaaaaaaaaaaa.json "
    ])).toMatchObject({
      input: { filename: " cubby-backup-v2-20260715T215013Z-aaaaaaaaaaaa.json " }
    });
  });

  it("requires every explicit recovery authorization confirmation without inference", () => {
    const args = [
      "authorize-backup-recovery",
      "--current-owner-user-id", "current-owner",
      "--target-household-id", "target-household",
      "--target-owner-user-id", "target-owner",
      "--confirm-target-owner-email", " owner@example.test ",
      "--filename", "cubby-backup-v2-20260715T215013Z-aaaaaaaaaaaa.json",
      "--confirm-checksum", ` ${"a".repeat(64)}`,
      "--confirm-source-household-name", " Previous Home ",
      "--acknowledgement", " I_AUTHORIZE_EXPLICIT_BACKUP_RECOVERY"
    ];

    expect(parsePlatformOwnerCommand(args)).toEqual({
      kind: "authorize-backup-recovery",
      input: {
        currentOwnerUserId: "current-owner",
        targetHouseholdId: "target-household",
        targetOwnerUserId: "target-owner",
        confirmTargetOwnerEmail: " owner@example.test ",
        filename: "cubby-backup-v2-20260715T215013Z-aaaaaaaaaaaa.json",
        confirmChecksum: ` ${"a".repeat(64)}`,
        confirmSourceHouseholdName: " Previous Home ",
        acknowledgement: " I_AUTHORIZE_EXPLICIT_BACKUP_RECOVERY"
      }
    });
    expect(() => parsePlatformOwnerCommand(args.slice(0, -2))).toThrow("platform_owner_command_usage");
  });

  it("rejects unknown, duplicate, and inferred arguments", () => {
    expect(() => parsePlatformOwnerCommand([])).toThrow("platform_owner_command_usage");
    expect(() => parsePlatformOwnerCommand(["bind", "--email", "owner@example.test"])).toThrow(
      "platform_owner_command_usage"
    );
    expect(() =>
      parsePlatformOwnerCommand([
        "bind",
        "--user-id",
        "one",
        "--user-id",
        "two",
        "--confirm-email",
        "owner@example.test"
      ])
    ).toThrow("platform_owner_command_usage");
  });

  it("dispatches only the fully parsed explicit operation", async () => {
    mocks.bind.mockResolvedValue({ id: "platform", ownerUserId: "user-explicit" });

    await expect(
      runPlatformOwnerCommand([
        "bind",
        "--user-id",
        "user-explicit",
        "--confirm-email",
        "owner@example.test"
      ])
    ).resolves.toEqual({ exitCode: 0, line: "Platform owner binding completed." });
    expect(mocks.bind).toHaveBeenCalledWith({
      userId: "user-explicit",
      confirmEmail: "owner@example.test"
    });
    expect(mocks.recover).not.toHaveBeenCalled();
  });

  it("dispatches bootstrap verification separately from owner binding", async () => {
    mocks.verify.mockResolvedValue({ id: "user-explicit", emailVerified: true });
    await expect(
      runPlatformOwnerCommand([
        "verify-bootstrap",
        "--user-id",
        "user-explicit",
        "--confirm-email",
        "owner@example.test",
        "--acknowledgement",
        "I_ACCEPT_LOCAL_BOOTSTRAP_EMAIL_VERIFICATION"
      ])
    ).resolves.toEqual({ exitCode: 0, line: "Bootstrap account verification completed." });
    expect(mocks.verify).toHaveBeenCalledWith({
      userId: "user-explicit",
      confirmEmail: "owner@example.test",
      acknowledgement: "I_ACCEPT_LOCAL_BOOTSTRAP_EMAIL_VERIFICATION"
    });
    expect(mocks.bind).not.toHaveBeenCalled();
  });

  it("dispatches successor attestation separately from owner recovery", async () => {
    mocks.attest.mockResolvedValue({ id: "successor-user", emailVerified: true });
    await expect(
      runPlatformOwnerCommand([
        "attest-successor",
        "--current-owner-user-id",
        "current-owner",
        "--successor-user-id",
        "successor-user",
        "--confirm-successor-email",
        "successor@example.test",
        "--acknowledgement",
        "I_ACCEPT_LOCAL_SUCCESSOR_EMAIL_VERIFICATION"
      ])
    ).resolves.toEqual({ exitCode: 0, line: "Successor account attestation completed." });
    expect(mocks.attest).toHaveBeenCalledWith({
      currentOwnerUserId: "current-owner",
      successorUserId: "successor-user",
      confirmSuccessorEmail: "successor@example.test",
      acknowledgement: "I_ACCEPT_LOCAL_SUCCESSOR_EMAIL_VERIFICATION"
    });
    expect(mocks.recover).not.toHaveBeenCalled();
  });

  it("dispatches backup inspection and returns the exact candidate identity", async () => {
    const candidate = {
      filename: "backup.json",
      exportedAt: "2026-07-15T21:50:13.000Z",
      householdName: "Previous Home",
      checksum: "a".repeat(64),
      size: 1234,
      itemCount: 17
    };
    mocks.inspectBackup.mockResolvedValue(candidate);

    await expect(runPlatformOwnerCommand([
      "inspect-backup-recovery",
      "--current-owner-user-id", "current-owner",
      "--filename", "backup.json"
    ])).resolves.toEqual({
      exitCode: 0,
      line: `Backup recovery candidate: ${JSON.stringify(candidate)}`
    });
    expect(mocks.inspectBackup).toHaveBeenCalledWith({
      currentOwnerUserId: "current-owner",
      filename: "backup.json"
    });
    expect(mocks.authorizeBackup).not.toHaveBeenCalled();
  });

  it("dispatches empty recovery-target provisioning with exact confirmations", async () => {
    mocks.provisionBackupTarget.mockResolvedValue({
      targetHouseholdId: "target-household",
      targetOwnerUserId: "target-owner"
    });

    await expect(runPlatformOwnerCommand([
      "provision-backup-recovery-target",
      "--current-owner-user-id", "current-owner",
      "--target-owner-user-id", "target-owner",
      "--confirm-target-owner-email", " owner@example.test",
      "--target-household-name", "Recovered Home",
      "--acknowledgement", " I_PROVISION_EMPTY_BACKUP_RECOVERY_TARGET"
    ])).resolves.toEqual({
      exitCode: 0,
      line: "Backup recovery target provisioned: target-household"
    });
    expect(mocks.provisionBackupTarget).toHaveBeenCalledWith({
      currentOwnerUserId: "current-owner",
      targetOwnerUserId: "target-owner",
      confirmTargetOwnerEmail: " owner@example.test",
      targetHouseholdName: "Recovered Home",
      acknowledgement: " I_PROVISION_EMPTY_BACKUP_RECOVERY_TARGET"
    });
    expect(mocks.inspectBackup).not.toHaveBeenCalled();
    expect(mocks.authorizeBackup).not.toHaveBeenCalled();
  });

  it("dispatches backup authorization separately from platform-owner recovery", async () => {
    mocks.authorizeBackup.mockResolvedValue({ backupRecordId: "record-1" });
    const args = [
      "authorize-backup-recovery",
      "--current-owner-user-id", "current-owner",
      "--target-household-id", "target-household",
      "--target-owner-user-id", "target-owner",
      "--confirm-target-owner-email", "owner@example.test",
      "--filename", "backup.json",
      "--confirm-checksum", "a".repeat(64),
      "--confirm-source-household-name", "Previous Home",
      "--acknowledgement", "I_AUTHORIZE_EXPLICIT_BACKUP_RECOVERY"
    ];

    await expect(runPlatformOwnerCommand(args)).resolves.toEqual({
      exitCode: 0,
      line: "Backup recovery authorization completed: record-1"
    });
    expect(mocks.authorizeBackup).toHaveBeenCalledWith({
      currentOwnerUserId: "current-owner",
      targetHouseholdId: "target-household",
      targetOwnerUserId: "target-owner",
      confirmTargetOwnerEmail: "owner@example.test",
      filename: "backup.json",
      confirmChecksum: "a".repeat(64),
      confirmSourceHouseholdName: "Previous Home",
      acknowledgement: "I_AUTHORIZE_EXPLICIT_BACKUP_RECOVERY"
    });
    expect(mocks.recover).not.toHaveBeenCalled();
  });

  it("sanitizes unexpected operation failures without exposing internal details", async () => {
    const internalSentinel = "INTERNAL_DATABASE_ERROR_DETAIL_SENTINEL";
    mocks.bind.mockRejectedValue(new Error(internalSentinel));

    const result = await runPlatformOwnerCommand([
      "bind",
      "--user-id",
      "user-explicit",
      "--confirm-email",
      "owner@example.test"
    ]);

    expect(result).toEqual({
      exitCode: 1,
      line: "Platform owner operation failed: platform_owner_operation_failed"
    });
    expect(result.line).not.toContain(internalSentinel);
  });

  it("loads database operations only after command parsing succeeds", async () => {
    const bind = vi.fn().mockResolvedValue({ id: "platform", ownerUserId: "user-explicit" });
    const loadOperations = vi.fn().mockResolvedValue({
      verifyBootstrapPlatformOwnerCandidate: vi.fn(),
      bindInitialPlatformOwner: bind,
      recoverPlatformOwner: vi.fn()
    });

    await expect(runPlatformOwnerCommand([], loadOperations)).resolves.toEqual({
      exitCode: 1,
      line: "Platform owner operation failed: platform_owner_command_usage"
    });
    expect(loadOperations).not.toHaveBeenCalled();

    await runPlatformOwnerCommand(
      ["bind", "--user-id", "user-explicit", "--confirm-email", "owner@example.test"],
      loadOperations
    );
    expect(loadOperations).toHaveBeenCalledOnce();
    expect(bind).toHaveBeenCalledOnce();
  });
});
