import { execSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

type PackagedCommand = {
  parsePlatformOwnerCommand: (args: readonly string[]) => unknown;
  writePlatformOwnerCommandResult: (
    result: { exitCode: 0 | 1; line: string },
    streams: { stdout: { write: (value: string) => unknown }; stderr: { write: (value: string) => unknown } }
  ) => void;
  runPlatformOwnerCommand: (
    args: readonly string[],
    loadOperations: () => Promise<{
      verifyBootstrapPlatformOwnerCandidate: ReturnType<typeof vi.fn>;
      attestPlatformOwnerSuccessor: ReturnType<typeof vi.fn>;
      bindInitialPlatformOwner: ReturnType<typeof vi.fn>;
      recoverPlatformOwner: ReturnType<typeof vi.fn>;
      provisionBackupRecoveryTarget: ReturnType<typeof vi.fn>;
      inspectBackupRecoveryCandidate: ReturnType<typeof vi.fn>;
      authorizeBackupRecovery: ReturnType<typeof vi.fn>;
    }>
  ) => Promise<{ exitCode: 0 | 1; line: string }>;
};

const args = [
  "attest-successor",
  "--current-owner-user-id",
  "current-owner",
  "--successor-user-id",
  "successor-user",
  "--confirm-successor-email",
  "successor@example.test",
  "--acknowledgement",
  "I_ACCEPT_LOCAL_SUCCESSOR_EMAIL_VERIFICATION"
] as const;

const whitespaceEmailArgs = args.map((value, index) =>
  index === 6 ? " successor@example.test " : value
);

const whitespaceAcknowledgementArgs = args.map((value, index) =>
  index === 8 ? " I_ACCEPT_LOCAL_SUCCESSOR_EMAIL_VERIFICATION " : value
);

const whitespaceBootstrapAcknowledgementArgs = [
  "verify-bootstrap",
  "--user-id",
  "bootstrap-user",
  "--confirm-email",
  "bootstrap@example.test",
  "--acknowledgement",
  " I_ACCEPT_LOCAL_BOOTSTRAP_EMAIL_VERIFICATION "
] as const;

describe("packaged platform-owner CLI", () => {
  let packaged: PackagedCommand;

  beforeAll(async () => {
    execSync("npm run build:platform-owner", { cwd: process.cwd(), stdio: "pipe" });
    packaged = (await import(`${pathToFileURL(resolve("dist/platform-owner.mjs")).href}?test=${Date.now()}`)) as PackagedCommand;
  });

  it("retains the exact successor-attestation contract in the distributable artifact", () => {
    expect(packaged.parsePlatformOwnerCommand(args)).toEqual({
      kind: "attest-successor",
      input: {
        currentOwnerUserId: "current-owner",
        successorUserId: "successor-user",
        confirmSuccessorEmail: "successor@example.test",
        acknowledgement: "I_ACCEPT_LOCAL_SUCCESSOR_EMAIL_VERIFICATION"
      }
    });
  });

  it("preserves and rejects whitespace-different email confirmation in the artifact", async () => {
    expect(packaged.parsePlatformOwnerCommand(whitespaceEmailArgs)).toMatchObject({
      input: { confirmSuccessorEmail: " successor@example.test " }
    });

    const attest = vi.fn().mockRejectedValue(new Error("platform_owner_email_confirmation_mismatch"));
    await expect(
      packaged.runPlatformOwnerCommand(whitespaceEmailArgs, async () => ({
        verifyBootstrapPlatformOwnerCandidate: vi.fn(),
        attestPlatformOwnerSuccessor: attest,
        bindInitialPlatformOwner: vi.fn(),
        recoverPlatformOwner: vi.fn(),
        provisionBackupRecoveryTarget: vi.fn(),
        inspectBackupRecoveryCandidate: vi.fn(),
        authorizeBackupRecovery: vi.fn()
      }))
    ).resolves.toEqual({
      exitCode: 1,
      line: "Platform owner operation failed: platform_owner_email_confirmation_mismatch"
    });
    expect(attest).toHaveBeenCalledWith(
      expect.objectContaining({ confirmSuccessorEmail: " successor@example.test " })
    );
  });

  it("preserves and rejects whitespace-different bootstrap acknowledgement in the artifact", async () => {
    expect(
      packaged.parsePlatformOwnerCommand(whitespaceBootstrapAcknowledgementArgs)
    ).toMatchObject({
      input: { acknowledgement: " I_ACCEPT_LOCAL_BOOTSTRAP_EMAIL_VERIFICATION " }
    });

    const verify = vi.fn().mockRejectedValue(
      new Error("platform_owner_bootstrap_acknowledgement_required")
    );
    const result = await packaged.runPlatformOwnerCommand(
      whitespaceBootstrapAcknowledgementArgs,
      async () => ({
        verifyBootstrapPlatformOwnerCandidate: verify,
        attestPlatformOwnerSuccessor: vi.fn(),
        bindInitialPlatformOwner: vi.fn(),
        recoverPlatformOwner: vi.fn(),
        provisionBackupRecoveryTarget: vi.fn(),
        inspectBackupRecoveryCandidate: vi.fn(),
        authorizeBackupRecovery: vi.fn()
      })
    );

    expect(result).toEqual({
      exitCode: 1,
      line: "Platform owner operation failed: platform_owner_bootstrap_acknowledgement_required"
    });
    expect(verify).toHaveBeenCalledWith(
      expect.objectContaining({
        acknowledgement: " I_ACCEPT_LOCAL_BOOTSTRAP_EMAIL_VERIFICATION "
      })
    );
  });

  it("preserves and rejects whitespace-different successor acknowledgement in the artifact", async () => {
    expect(packaged.parsePlatformOwnerCommand(whitespaceAcknowledgementArgs)).toMatchObject({
      input: { acknowledgement: " I_ACCEPT_LOCAL_SUCCESSOR_EMAIL_VERIFICATION " }
    });

    const attest = vi.fn().mockRejectedValue(
      new Error("platform_owner_successor_acknowledgement_required")
    );
    const result = await packaged.runPlatformOwnerCommand(
      whitespaceAcknowledgementArgs,
      async () => ({
        verifyBootstrapPlatformOwnerCandidate: vi.fn(),
        attestPlatformOwnerSuccessor: attest,
        bindInitialPlatformOwner: vi.fn(),
        recoverPlatformOwner: vi.fn(),
        provisionBackupRecoveryTarget: vi.fn(),
        inspectBackupRecoveryCandidate: vi.fn(),
        authorizeBackupRecovery: vi.fn()
      })
    );

    expect(result).toEqual({
      exitCode: 1,
      line: "Platform owner operation failed: platform_owner_successor_acknowledgement_required"
    });
    expect(attest).toHaveBeenCalledWith(
      expect.objectContaining({
        acknowledgement: " I_ACCEPT_LOCAL_SUCCESSOR_EMAIL_VERIFICATION "
      })
    );
  });

  it("sanitizes unexpected errors in the distributable artifact", async () => {
    const internalSentinel = "INTERNAL_DATABASE_ERROR_DETAIL_SENTINEL";
    const result = await packaged.runPlatformOwnerCommand(args, async () => ({
      verifyBootstrapPlatformOwnerCandidate: vi.fn(),
      attestPlatformOwnerSuccessor: vi.fn().mockRejectedValue(new Error(internalSentinel)),
      bindInitialPlatformOwner: vi.fn(),
      recoverPlatformOwner: vi.fn(),
      provisionBackupRecoveryTarget: vi.fn(),
      inspectBackupRecoveryCandidate: vi.fn(),
      authorizeBackupRecovery: vi.fn()
    }));

    expect(result).toEqual({
      exitCode: 1,
      line: "Platform owner operation failed: platform_owner_operation_failed"
    });
    expect(result.line).not.toContain(internalSentinel);
  });

  it("dispatches successor attestation from the distributable artifact without falling through to recovery", async () => {
    const attest = vi.fn().mockResolvedValue({ id: "successor-user", emailVerified: true });
    const recover = vi.fn();
    await expect(
      packaged.runPlatformOwnerCommand(args, async () => ({
        verifyBootstrapPlatformOwnerCandidate: vi.fn(),
        attestPlatformOwnerSuccessor: attest,
        bindInitialPlatformOwner: vi.fn(),
        recoverPlatformOwner: recover,
        provisionBackupRecoveryTarget: vi.fn(),
        inspectBackupRecoveryCandidate: vi.fn(),
        authorizeBackupRecovery: vi.fn()
      }))
    ).resolves.toEqual({ exitCode: 0, line: "Successor account attestation completed." });
    expect(attest).toHaveBeenCalledWith({
      currentOwnerUserId: "current-owner",
      successorUserId: "successor-user",
      confirmSuccessorEmail: "successor@example.test",
      acknowledgement: "I_ACCEPT_LOCAL_SUCCESSOR_EMAIL_VERIFICATION"
    });
    expect(recover).not.toHaveBeenCalled();
  });

  it("dispatches recovery-target provisioning from the distributable artifact", async () => {
    const provision = vi.fn().mockResolvedValue({
      targetHouseholdId: "target-household",
      targetOwnerUserId: "target-owner"
    });
    const targetArgs = [
      "provision-backup-recovery-target",
      "--current-owner-user-id", "current-owner",
      "--target-owner-user-id", "target-owner",
      "--confirm-target-owner-email", "owner@example.test",
      "--target-household-name", "Recovered Home",
      "--acknowledgement", "I_PROVISION_EMPTY_BACKUP_RECOVERY_TARGET"
    ];

    await expect(
      packaged.runPlatformOwnerCommand(targetArgs, async () => ({
        verifyBootstrapPlatformOwnerCandidate: vi.fn(),
        attestPlatformOwnerSuccessor: vi.fn(),
        bindInitialPlatformOwner: vi.fn(),
        recoverPlatformOwner: vi.fn(),
        provisionBackupRecoveryTarget: provision,
        inspectBackupRecoveryCandidate: vi.fn(),
        authorizeBackupRecovery: vi.fn()
      }))
    ).resolves.toEqual({
      exitCode: 0,
      line: "Backup recovery target provisioned: target-household"
    });
    expect(provision).toHaveBeenCalledWith({
      currentOwnerUserId: "current-owner",
      targetOwnerUserId: "target-owner",
      confirmTargetOwnerEmail: "owner@example.test",
      targetHouseholdName: "Recovered Home",
      acknowledgement: "I_PROVISION_EMPTY_BACKUP_RECOVERY_TARGET"
    });
  });

  it("dispatches explicit backup recovery authorization from the distributable artifact", async () => {
    const authorize = vi.fn().mockResolvedValue({ backupRecordId: "record-1" });
    const recoveryArgs = [
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

    await expect(
      packaged.runPlatformOwnerCommand(recoveryArgs, async () => ({
        verifyBootstrapPlatformOwnerCandidate: vi.fn(),
        attestPlatformOwnerSuccessor: vi.fn(),
        bindInitialPlatformOwner: vi.fn(),
        recoverPlatformOwner: vi.fn(),
        provisionBackupRecoveryTarget: vi.fn(),
        inspectBackupRecoveryCandidate: vi.fn(),
        authorizeBackupRecovery: authorize
      }))
    ).resolves.toEqual({
      exitCode: 0,
      line: "Backup recovery authorization completed: record-1"
    });
    expect(authorize).toHaveBeenCalledWith({
      currentOwnerUserId: "current-owner",
      targetHouseholdId: "target-household",
      targetOwnerUserId: "target-owner",
      confirmTargetOwnerEmail: "owner@example.test",
      filename: "backup.json",
      confirmChecksum: "a".repeat(64),
      confirmSourceHouseholdName: "Previous Home",
      acknowledgement: "I_AUTHORIZE_EXPLICIT_BACKUP_RECOVERY"
    });
  });

  it("writes packaged command success to stdout and failures to stderr", () => {
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };

    packaged.writePlatformOwnerCommandResult({ exitCode: 0, line: "completed" }, { stdout, stderr });
    expect(stdout.write).toHaveBeenCalledWith("completed\n");
    expect(stderr.write).not.toHaveBeenCalled();

    vi.clearAllMocks();
    packaged.writePlatformOwnerCommandResult({ exitCode: 1, line: "failed" }, { stdout, stderr });
    expect(stderr.write).toHaveBeenCalledWith("failed\n");
    expect(stdout.write).not.toHaveBeenCalled();
  });
});
