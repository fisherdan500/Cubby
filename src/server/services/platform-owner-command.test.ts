import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  verify: vi.fn(),
  attest: vi.fn(),
  bind: vi.fn(),
  recover: vi.fn()
}));

vi.mock("../../../src/server/services/platform-owner-binding", () => ({
  BOOTSTRAP_VERIFICATION_ACKNOWLEDGEMENT: "I_ACCEPT_LOCAL_BOOTSTRAP_EMAIL_VERIFICATION",
  verifyBootstrapPlatformOwnerCandidate: mocks.verify,
  attestPlatformOwnerSuccessor: mocks.attest,
  bindInitialPlatformOwner: mocks.bind,
  recoverPlatformOwner: mocks.recover
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
