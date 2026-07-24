import { fileURLToPath } from "node:url";

type PlatformOwnerCommand =
  | {
      kind: "verify-bootstrap";
      input: { userId: string; confirmEmail: string; acknowledgement: string };
    }
  | {
      kind: "attest-successor";
      input: {
        currentOwnerUserId: string;
        successorUserId: string;
        confirmSuccessorEmail: string;
        acknowledgement: string;
      };
    }
  | { kind: "bind"; input: { userId: string; confirmEmail: string } }
  | {
      kind: "recover";
      input: {
        currentOwnerUserId: string;
        successorUserId: string;
        confirmSuccessorEmail: string;
      };
    }
  | {
      kind: "inspect-backup-recovery";
      input: { currentOwnerUserId: string; filename: string };
    }
  | {
      kind: "provision-backup-recovery-target";
      input: {
        currentOwnerUserId: string;
        targetOwnerUserId: string;
        confirmTargetOwnerEmail: string;
        targetHouseholdName: string;
        acknowledgement: string;
      };
    }
  | {
      kind: "authorize-backup-recovery";
      input: {
        currentOwnerUserId: string;
        targetHouseholdId: string;
        targetOwnerUserId: string;
        confirmTargetOwnerEmail: string;
        filename: string;
        confirmChecksum: string;
        confirmSourceHouseholdName: string;
        acknowledgement: string;
      };
    };

type PlatformOwnerOperations = Pick<
  typeof import("../src/server/services/platform-owner-binding"),
  | "bindInitialPlatformOwner"
  | "attestPlatformOwnerSuccessor"
  | "recoverPlatformOwner"
  | "verifyBootstrapPlatformOwnerCandidate"
> & Pick<
  typeof import("../src/server/services/platform-backup-recovery"),
  | "provisionBackupRecoveryTarget"
  | "inspectBackupRecoveryCandidate"
  | "authorizeBackupRecovery"
>;

type LoadPlatformOwnerOperations = () => Promise<PlatformOwnerOperations>;

const loadPlatformOwnerOperations: LoadPlatformOwnerOperations = async () => {
  const [ownerOperations, backupRecoveryOperations] = await Promise.all([
    import("../src/server/services/platform-owner-binding"),
    import("../src/server/services/platform-backup-recovery")
  ]);
  return { ...ownerOperations, ...backupRecoveryOperations };
};

function exactArguments(
  args: readonly string[],
  expected: readonly string[],
  preserveRaw: readonly string[] = []
) {
  if (args.length !== expected.length * 2) throw new Error("platform_owner_command_usage");
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag || !expected.includes(flag) || !value?.trim() || values.has(flag)) {
      throw new Error("platform_owner_command_usage");
    }
    values.set(flag, preserveRaw.includes(flag) ? value : value.trim());
  }
  if (values.size !== expected.length) throw new Error("platform_owner_command_usage");
  return values;
}

export function parsePlatformOwnerCommand(args: readonly string[]): PlatformOwnerCommand {
  const [operation, ...rest] = args;
  if (operation === "verify-bootstrap") {
    const values = exactArguments(rest, ["--user-id", "--confirm-email", "--acknowledgement"]);
    return {
      kind: "verify-bootstrap",
      input: {
        userId: values.get("--user-id")!,
        confirmEmail: values.get("--confirm-email")!,
        acknowledgement: values.get("--acknowledgement")!
      }
    };
  }
  if (operation === "attest-successor") {
    const values = exactArguments(
      rest,
      [
        "--current-owner-user-id",
        "--successor-user-id",
        "--confirm-successor-email",
        "--acknowledgement"
      ],
      ["--confirm-successor-email"]
    );
    return {
      kind: "attest-successor",
      input: {
        currentOwnerUserId: values.get("--current-owner-user-id")!,
        successorUserId: values.get("--successor-user-id")!,
        confirmSuccessorEmail: values.get("--confirm-successor-email")!,
        acknowledgement: values.get("--acknowledgement")!
      }
    };
  }
  if (operation === "bind") {
    const values = exactArguments(rest, ["--user-id", "--confirm-email"]);
    return {
      kind: "bind",
      input: {
        userId: values.get("--user-id")!,
        confirmEmail: values.get("--confirm-email")!
      }
    };
  }
  if (operation === "recover") {
    const values = exactArguments(rest, [
      "--current-owner-user-id",
      "--successor-user-id",
      "--confirm-successor-email"
    ]);
    return {
      kind: "recover",
      input: {
        currentOwnerUserId: values.get("--current-owner-user-id")!,
        successorUserId: values.get("--successor-user-id")!,
        confirmSuccessorEmail: values.get("--confirm-successor-email")!
      }
    };
  }
  if (operation === "inspect-backup-recovery") {
    const values = exactArguments(
      rest,
      ["--current-owner-user-id", "--filename"],
      ["--filename"]
    );
    return {
      kind: "inspect-backup-recovery",
      input: {
        currentOwnerUserId: values.get("--current-owner-user-id")!,
        filename: values.get("--filename")!
      }
    };
  }
  if (operation === "provision-backup-recovery-target") {
    const values = exactArguments(
      rest,
      [
        "--current-owner-user-id",
        "--target-owner-user-id",
        "--confirm-target-owner-email",
        "--target-household-name",
        "--acknowledgement"
      ],
      ["--confirm-target-owner-email", "--acknowledgement"]
    );
    return {
      kind: "provision-backup-recovery-target",
      input: {
        currentOwnerUserId: values.get("--current-owner-user-id")!,
        targetOwnerUserId: values.get("--target-owner-user-id")!,
        confirmTargetOwnerEmail: values.get("--confirm-target-owner-email")!,
        targetHouseholdName: values.get("--target-household-name")!,
        acknowledgement: values.get("--acknowledgement")!
      }
    };
  }
  if (operation === "authorize-backup-recovery") {
    const values = exactArguments(
      rest,
      [
        "--current-owner-user-id",
        "--target-household-id",
        "--target-owner-user-id",
        "--confirm-target-owner-email",
        "--filename",
        "--confirm-checksum",
        "--confirm-source-household-name",
        "--acknowledgement"
      ],
      [
        "--confirm-target-owner-email",
        "--filename",
        "--confirm-checksum",
        "--confirm-source-household-name",
        "--acknowledgement"
      ]
    );
    return {
      kind: "authorize-backup-recovery",
      input: {
        currentOwnerUserId: values.get("--current-owner-user-id")!,
        targetHouseholdId: values.get("--target-household-id")!,
        targetOwnerUserId: values.get("--target-owner-user-id")!,
        confirmTargetOwnerEmail: values.get("--confirm-target-owner-email")!,
        filename: values.get("--filename")!,
        confirmChecksum: values.get("--confirm-checksum")!,
        confirmSourceHouseholdName: values.get("--confirm-source-household-name")!,
        acknowledgement: values.get("--acknowledgement")!
      }
    };
  }
  throw new Error("platform_owner_command_usage");
}

export async function runPlatformOwnerCommand(
  args: readonly string[],
  loadOperations: LoadPlatformOwnerOperations = loadPlatformOwnerOperations
) {
  try {
    const command = parsePlatformOwnerCommand(args);
    const operations = await loadOperations();
    if (command.kind === "verify-bootstrap") {
      await operations.verifyBootstrapPlatformOwnerCandidate(command.input);
      return { exitCode: 0 as const, line: "Bootstrap account verification completed." };
    }
    if (command.kind === "attest-successor") {
      await operations.attestPlatformOwnerSuccessor(command.input);
      return { exitCode: 0 as const, line: "Successor account attestation completed." };
    }
    if (command.kind === "bind") {
      await operations.bindInitialPlatformOwner(command.input);
      return { exitCode: 0 as const, line: "Platform owner binding completed." };
    }
    if (command.kind === "recover") {
      await operations.recoverPlatformOwner(command.input);
      return { exitCode: 0 as const, line: "Platform owner recovery completed." };
    }
    if (command.kind === "inspect-backup-recovery") {
      const candidate = await operations.inspectBackupRecoveryCandidate(command.input);
      return { exitCode: 0 as const, line: `Backup recovery candidate: ${JSON.stringify(candidate)}` };
    }
    if (command.kind === "provision-backup-recovery-target") {
      const target = await operations.provisionBackupRecoveryTarget(command.input);
      return {
        exitCode: 0 as const,
        line: `Backup recovery target provisioned: ${target.targetHouseholdId}`
      };
    }
    const authorized = await operations.authorizeBackupRecovery(command.input);
    return {
      exitCode: 0 as const,
      line: `Backup recovery authorization completed: ${authorized.backupRecordId}`
    };
  } catch (error) {
    const code = error instanceof Error ? error.message : "platform_owner_command_failed";
    return { exitCode: 1 as const, line: `Platform owner operation failed: ${code}` };
  }
}

export function writePlatformOwnerCommandResult(
  result: { exitCode: 0 | 1; line: string },
  streams: Pick<typeof process, "stdout" | "stderr"> = process
) {
  const stream = result.exitCode === 0 ? streams.stdout : streams.stderr;
  stream.write(`${result.line}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void runPlatformOwnerCommand(process.argv.slice(2)).then((result) => {
    writePlatformOwnerCommandResult(result);
    process.exitCode = result.exitCode;
  });
}
