import { execSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

type PackagedCommand = {
  parsePlatformOwnerCommand: (args: readonly string[]) => unknown;
  runPlatformOwnerCommand: (
    args: readonly string[],
    loadOperations: () => Promise<{
      verifyBootstrapPlatformOwnerCandidate: ReturnType<typeof vi.fn>;
      attestPlatformOwnerSuccessor: ReturnType<typeof vi.fn>;
      bindInitialPlatformOwner: ReturnType<typeof vi.fn>;
      recoverPlatformOwner: ReturnType<typeof vi.fn>;
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
        recoverPlatformOwner: vi.fn()
      }))
    ).resolves.toEqual({
      exitCode: 1,
      line: "Platform owner operation failed: platform_owner_email_confirmation_mismatch"
    });
    expect(attest).toHaveBeenCalledWith(
      expect.objectContaining({ confirmSuccessorEmail: " successor@example.test " })
    );
  });

  it("dispatches successor attestation from the distributable artifact without falling through to recovery", async () => {
    const attest = vi.fn().mockResolvedValue({ id: "successor-user", emailVerified: true });
    const recover = vi.fn();
    await expect(
      packaged.runPlatformOwnerCommand(args, async () => ({
        verifyBootstrapPlatformOwnerCandidate: vi.fn(),
        attestPlatformOwnerSuccessor: attest,
        bindInitialPlatformOwner: vi.fn(),
        recoverPlatformOwner: recover
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
});
