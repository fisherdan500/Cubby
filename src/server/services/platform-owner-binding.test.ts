import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  userCount: vi.fn(),
  userUpdate: vi.fn(),
  credentialFindFirst: vi.fn(),
  authorityFindUnique: vi.fn(),
  authorityCreate: vi.fn(),
  authorityUpdateMany: vi.fn(),
  auditCreate: vi.fn(),
  executeRaw: vi.fn(),
  queryRaw: vi.fn(),
  transaction: vi.fn()
}));

vi.mock("@/lib/db/prisma", () => ({
  prisma: { $transaction: mocks.transaction }
}));

import {
  BOOTSTRAP_VERIFICATION_ACKNOWLEDGEMENT,
  SUCCESSOR_VERIFICATION_ACKNOWLEDGEMENT,
  attestPlatformOwnerSuccessor,
  bindInitialPlatformOwner,
  recoverPlatformOwner,
  verifyBootstrapPlatformOwnerCandidate
} from "@/server/services/platform-owner-binding";

function transactionClient() {
  return {
    $executeRaw: mocks.executeRaw,
    $queryRaw: mocks.queryRaw,
    user: {
      findUnique: mocks.userFindUnique,
      count: mocks.userCount,
      update: mocks.userUpdate
    },
    account: { findFirst: mocks.credentialFindFirst },
    platformAuthority: {
      findUnique: mocks.authorityFindUnique,
      create: mocks.authorityCreate,
      updateMany: mocks.authorityUpdateMany
    },
    platformAuditEvent: { create: mocks.auditCreate }
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.transaction.mockImplementation((operation) => operation(transactionClient()));
  mocks.userFindUnique.mockResolvedValue({
    id: "user-explicit",
    email: "owner@example.test",
    emailVerified: true
  });
  mocks.authorityFindUnique.mockResolvedValue(null);
  mocks.userCount.mockResolvedValue(1);
  mocks.userUpdate.mockResolvedValue({ id: "user-explicit", emailVerified: true });
  mocks.credentialFindFirst.mockResolvedValue({ id: "credential-account" });
  mocks.authorityCreate.mockResolvedValue({ id: "platform", ownerUserId: "user-explicit" });
  mocks.authorityUpdateMany.mockResolvedValue({ count: 1 });
  mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
  mocks.executeRaw.mockResolvedValue(1);
  mocks.queryRaw.mockResolvedValue([{ id: "platform" }]);
});

describe("explicit host-local bootstrap verification", () => {
  beforeEach(() => {
    mocks.userFindUnique.mockResolvedValue({
      id: "user-explicit",
      email: "owner@example.test",
      emailVerified: false
    });
  });

  it("locally verifies only the sole explicit credential account and audits the attestation", async () => {
    await expect(
      verifyBootstrapPlatformOwnerCandidate({
        userId: "user-explicit",
        confirmEmail: "owner@example.test",
        acknowledgement: BOOTSTRAP_VERIFICATION_ACKNOWLEDGEMENT
      })
    ).resolves.toEqual({ id: "user-explicit", emailVerified: true });

    expect(mocks.executeRaw).toHaveBeenCalledOnce();
    expect(mocks.executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.userCount.mock.invocationCallOrder[0]
    );
    expect(mocks.userCount).toHaveBeenCalledWith();
    expect(mocks.userUpdate).toHaveBeenCalledWith({
      where: { id: "user-explicit" },
      data: { emailVerified: true },
      select: { id: true, emailVerified: true }
    });
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: {
        actorUserId: null,
        action: "platform.owner.bootstrap_user.verify",
        entityType: "user",
        entityId: "user-explicit",
        source: "host_local_bootstrap_verification",
        before: { emailVerified: false },
        after: { emailVerified: true }
      }
    });
  });

  it("requires the exact high-friction acknowledgement", async () => {
    await expect(
      verifyBootstrapPlatformOwnerCandidate({
        userId: "user-explicit",
        confirmEmail: "owner@example.test",
        acknowledgement: "yes"
      })
    ).rejects.toThrow("platform_owner_bootstrap_acknowledgement_required");
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it.each(["OWNER@example.test", " owner@example.test", "owner@example.test "])(
    "requires a byte-exact bootstrap email confirmation for %j",
    async (confirmEmail) => {
      await expect(
        verifyBootstrapPlatformOwnerCandidate({
          userId: "user-explicit",
          confirmEmail,
          acknowledgement: BOOTSTRAP_VERIFICATION_ACKNOWLEDGEMENT
        })
      ).rejects.toThrow("platform_owner_email_confirmation_mismatch");
      expect(mocks.userUpdate).not.toHaveBeenCalled();
      expect(mocks.auditCreate).not.toHaveBeenCalled();
    }
  );

  it("rejects surrounding whitespace in the bootstrap acknowledgement", async () => {
    await expect(
      verifyBootstrapPlatformOwnerCandidate({
        userId: "user-explicit",
        confirmEmail: "owner@example.test",
        acknowledgement: ` ${BOOTSTRAP_VERIFICATION_ACKNOWLEDGEMENT} `
      })
    ).rejects.toThrow("platform_owner_bootstrap_acknowledgement_required");
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.userUpdate).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("refuses local verification after another account or platform authority exists", async () => {
    mocks.userCount.mockResolvedValue(2);
    await expect(
      verifyBootstrapPlatformOwnerCandidate({
        userId: "user-explicit",
        confirmEmail: "owner@example.test",
        acknowledgement: BOOTSTRAP_VERIFICATION_ACKNOWLEDGEMENT
      })
    ).rejects.toThrow("platform_owner_bootstrap_user_count_mismatch");
    expect(mocks.userUpdate).not.toHaveBeenCalled();

    mocks.userCount.mockResolvedValue(1);
    mocks.authorityFindUnique.mockResolvedValue({ id: "platform", ownerUserId: "another-user" });
    await expect(
      verifyBootstrapPlatformOwnerCandidate({
        userId: "user-explicit",
        confirmEmail: "owner@example.test",
        acknowledgement: BOOTSTRAP_VERIFICATION_ACKNOWLEDGEMENT
      })
    ).rejects.toThrow("platform_owner_already_bound");
    expect(mocks.userUpdate).not.toHaveBeenCalled();
  });
});

describe("host-local successor attestation", () => {
  beforeEach(() => {
    mocks.authorityFindUnique.mockResolvedValue({ id: "platform", ownerUserId: "current-owner" });
    mocks.userFindUnique.mockResolvedValue({
      id: "successor-user",
      email: "successor@example.test",
      emailVerified: false
    });
    mocks.userUpdate.mockResolvedValue({ id: "successor-user", emailVerified: true });
  });

  it("attests the explicit credential successor and records a host-local audit event", async () => {
    await expect(
      attestPlatformOwnerSuccessor({
        currentOwnerUserId: "current-owner",
        successorUserId: "successor-user",
        confirmSuccessorEmail: "successor@example.test",
        acknowledgement: SUCCESSOR_VERIFICATION_ACKNOWLEDGEMENT
      })
    ).resolves.toEqual({ id: "successor-user", emailVerified: true });

    expect(mocks.credentialFindFirst).toHaveBeenCalledWith({
      where: {
        userId: "successor-user",
        providerId: "credential",
        password: { not: null }
      },
      select: { id: true }
    });
    expect(mocks.userUpdate).toHaveBeenCalledWith({
      where: { id: "successor-user" },
      data: { emailVerified: true },
      select: { id: true, emailVerified: true }
    });
    expect(mocks.queryRaw).toHaveBeenCalledTimes(1);
    expect(mocks.queryRaw.mock.calls[0]?.[0].join(" ")).toContain('FROM "PlatformAuthority"');
    expect(mocks.queryRaw.mock.calls[0]?.[0].join(" ")).toContain("FOR UPDATE");
    expect(mocks.queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.authorityFindUnique.mock.invocationCallOrder[0]
    );
    expect(mocks.authorityFindUnique.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.userUpdate.mock.invocationCallOrder[0]
    );
    expect(mocks.authorityCreate).not.toHaveBeenCalled();
    expect(mocks.authorityUpdateMany).not.toHaveBeenCalled();
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: {
        actorUserId: null,
        action: "platform.owner.successor_user.verify",
        entityType: "user",
        entityId: "successor-user",
        source: "host_local_successor_verification",
        before: { emailVerified: false, confirmedPlatformOwnerUserId: "current-owner" },
        after: { emailVerified: true, confirmedPlatformOwnerUserId: "current-owner" }
      }
    });
    expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "Serializable"
    });
  });

  it("requires the exact high-friction successor acknowledgement before opening a transaction", async () => {
    await expect(
      attestPlatformOwnerSuccessor({
        currentOwnerUserId: "current-owner",
        successorUserId: "successor-user",
        confirmSuccessorEmail: "successor@example.test",
        acknowledgement: "yes"
      })
    ).rejects.toThrow("platform_owner_successor_acknowledgement_required");
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("rejects surrounding whitespace in the successor acknowledgement", async () => {
    await expect(
      attestPlatformOwnerSuccessor({
        currentOwnerUserId: "current-owner",
        successorUserId: "successor-user",
        confirmSuccessorEmail: "successor@example.test",
        acknowledgement: ` ${SUCCESSOR_VERIFICATION_ACKNOWLEDGEMENT} `
      })
    ).rejects.toThrow("platform_owner_successor_acknowledgement_required");
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.userUpdate).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it.each([
    "SUCCESSOR@example.test",
    " successor@example.test",
    "successor@example.test "
  ])("requires a byte-exact successor email confirmation for %j", async (confirmSuccessorEmail) => {
    await expect(
      attestPlatformOwnerSuccessor({
        currentOwnerUserId: "current-owner",
        successorUserId: "successor-user",
        confirmSuccessorEmail,
        acknowledgement: SUCCESSOR_VERIFICATION_ACKNOWLEDGEMENT
      })
    ).rejects.toThrow("platform_owner_email_confirmation_mismatch");
    expect(mocks.userUpdate).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("fails closed when platform authority is absent", async () => {
    mocks.authorityFindUnique.mockResolvedValue(null);

    await expect(
      attestPlatformOwnerSuccessor({
        currentOwnerUserId: "current-owner",
        successorUserId: "successor-user",
        confirmSuccessorEmail: "successor@example.test",
        acknowledgement: SUCCESSOR_VERIFICATION_ACKNOWLEDGEMENT
      })
    ).rejects.toThrow("platform_owner_not_bound");
    expect(mocks.userFindUnique).not.toHaveBeenCalled();
    expect(mocks.userUpdate).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("fails closed when the explicit successor does not exist", async () => {
    mocks.userFindUnique.mockResolvedValue(null);

    await expect(
      attestPlatformOwnerSuccessor({
        currentOwnerUserId: "current-owner",
        successorUserId: "missing-successor",
        confirmSuccessorEmail: "successor@example.test",
        acknowledgement: SUCCESSOR_VERIFICATION_ACKNOWLEDGEMENT
      })
    ).rejects.toThrow("platform_owner_user_not_found");
    expect(mocks.credentialFindFirst).not.toHaveBeenCalled();
    expect(mocks.userUpdate).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("fails closed when the successor has no usable credential", async () => {
    mocks.credentialFindFirst.mockResolvedValue(null);

    await expect(
      attestPlatformOwnerSuccessor({
        currentOwnerUserId: "current-owner",
        successorUserId: "successor-user",
        confirmSuccessorEmail: "successor@example.test",
        acknowledgement: SUCCESSOR_VERIFICATION_ACKNOWLEDGEMENT
      })
    ).rejects.toThrow("platform_owner_credential_missing");
    expect(mocks.userUpdate).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("returns a stable retry code for an attestation serialization conflict", async () => {
    mocks.transaction.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("serialization failure", {
        code: "P2034",
        clientVersion: "6.19.3"
      })
    );

    await expect(
      attestPlatformOwnerSuccessor({
        currentOwnerUserId: "current-owner",
        successorUserId: "successor-user",
        confirmSuccessorEmail: "successor@example.test",
        acknowledgement: SUCCESSOR_VERIFICATION_ACKNOWLEDGEMENT
      })
    ).rejects.toThrow("platform_owner_operation_retry");
  });

  it("fails closed for a stale current-owner confirmation", async () => {
    await expect(
      attestPlatformOwnerSuccessor({
        currentOwnerUserId: "wrong-current-owner",
        successorUserId: "successor-user",
        confirmSuccessorEmail: "successor@example.test",
        acknowledgement: SUCCESSOR_VERIFICATION_ACKNOWLEDGEMENT
      })
    ).rejects.toThrow("platform_owner_current_confirmation_mismatch");
    expect(mocks.userUpdate).not.toHaveBeenCalled();
  });

  it("requires a successor distinct from the current owner", async () => {
    mocks.authorityFindUnique.mockResolvedValue({ id: "platform", ownerUserId: "same-user" });
    await expect(
      attestPlatformOwnerSuccessor({
        currentOwnerUserId: "same-user",
        successorUserId: "same-user",
        confirmSuccessorEmail: "successor@example.test",
        acknowledgement: SUCCESSOR_VERIFICATION_ACKNOWLEDGEMENT
      })
    ).rejects.toThrow("platform_owner_successor_must_differ");
    expect(mocks.userUpdate).not.toHaveBeenCalled();
  });

  it("refuses to misrepresent an already-verified account as a new attestation", async () => {
    mocks.userFindUnique.mockResolvedValue({
      id: "successor-user",
      email: "successor@example.test",
      emailVerified: true
    });
    await expect(
      attestPlatformOwnerSuccessor({
        currentOwnerUserId: "current-owner",
        successorUserId: "successor-user",
        confirmSuccessorEmail: "successor@example.test",
        acknowledgement: SUCCESSOR_VERIFICATION_ACKNOWLEDGEMENT
      })
    ).rejects.toThrow("platform_owner_email_already_verified");
    expect(mocks.userUpdate).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });
});

describe("explicit initial platform-owner binding", () => {
  it("binds only the exact verified user and creates closed settings transactionally", async () => {
    await expect(
      bindInitialPlatformOwner({
        userId: "user-explicit",
        confirmEmail: "owner@example.test"
      })
    ).resolves.toEqual({ id: "platform", ownerUserId: "user-explicit" });

    expect(mocks.userFindUnique).toHaveBeenCalledWith({
      where: { id: "user-explicit" },
      select: { id: true, email: true, emailVerified: true }
    });
    expect(mocks.credentialFindFirst).toHaveBeenCalledWith({
      where: {
        userId: "user-explicit",
        providerId: "credential",
        password: { not: null }
      },
      select: { id: true }
    });
    expect(mocks.authorityCreate).toHaveBeenCalledWith({
      data: {
        id: "platform",
        ownerUserId: "user-explicit",
        settings: {
          create: {
            householdCreationMode: "closed",
            allowPublicRegistration: false
          }
        }
      },
      select: { id: true, ownerUserId: true }
    });
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: {
        actorUserId: null,
        action: "platform.owner.bootstrap",
        entityType: "platform_authority",
        entityId: "platform",
        source: "host_local",
        after: { ownerUserId: "user-explicit" }
      }
    });
    expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "Serializable" });
  });

  it.each(["OWNER@example.test", " owner@example.test", "owner@example.test "])(
    "requires a byte-exact binding email confirmation for %j",
    async (confirmEmail) => {
      await expect(
        bindInitialPlatformOwner({ userId: "user-explicit", confirmEmail })
      ).rejects.toThrow("platform_owner_email_confirmation_mismatch");
      expect(mocks.authorityCreate).not.toHaveBeenCalled();
    }
  );

  it("fails instead of choosing a user when the explicit user ID does not exist", async () => {
    mocks.userFindUnique.mockResolvedValue(null);

    await expect(
      bindInitialPlatformOwner({ userId: "missing-user", confirmEmail: "owner@example.test" })
    ).rejects.toThrow("platform_owner_user_not_found");
    expect(mocks.authorityCreate).not.toHaveBeenCalled();
  });

  it("rejects an unverified user instead of silently changing identity state", async () => {
    mocks.userFindUnique.mockResolvedValue({
      id: "user-explicit",
      email: "owner@example.test",
      emailVerified: false
    });
    await expect(
      bindInitialPlatformOwner({ userId: "user-explicit", confirmEmail: "owner@example.test" })
    ).rejects.toThrow("platform_owner_email_not_verified");
    expect(mocks.authorityCreate).not.toHaveBeenCalled();
  });

  it("rejects an account that has no usable credential without reading credential material", async () => {
    mocks.credentialFindFirst.mockResolvedValue(null);

    await expect(
      bindInitialPlatformOwner({ userId: "user-explicit", confirmEmail: "owner@example.test" })
    ).rejects.toThrow("platform_owner_credential_missing");
    expect(mocks.credentialFindFirst).toHaveBeenCalledWith({
      where: {
        userId: "user-explicit",
        providerId: "credential",
        password: { not: null }
      },
      select: { id: true }
    });
    expect(mocks.authorityCreate).not.toHaveBeenCalled();
  });

  it("rejects an email confirmation mismatch", async () => {
    mocks.userFindUnique.mockResolvedValue({
      id: "user-explicit",
      email: "owner@example.test",
      emailVerified: true
    });
    await expect(
      bindInitialPlatformOwner({ userId: "user-explicit", confirmEmail: "different@example.test" })
    ).rejects.toThrow("platform_owner_email_confirmation_mismatch");
    expect(mocks.authorityCreate).not.toHaveBeenCalled();
  });

  it("fails every retry after authority exists, including the same explicit user", async () => {
    mocks.authorityFindUnique.mockResolvedValue({ id: "platform", ownerUserId: "user-explicit" });

    await expect(
      bindInitialPlatformOwner({ userId: "user-explicit", confirmEmail: "owner@example.test" })
    ).rejects.toThrow("platform_owner_already_bound");
    expect(mocks.authorityCreate).not.toHaveBeenCalled();
  });

  it("returns a stable retry code for a serialization conflict", async () => {
    mocks.transaction.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("serialization failure", {
        code: "P2034",
        clientVersion: "6.19.3"
      })
    );

    await expect(
      bindInitialPlatformOwner({ userId: "user-explicit", confirmEmail: "owner@example.test" })
    ).rejects.toThrow("platform_owner_operation_retry");
  });
});

describe("host-local platform-owner recovery", () => {
  beforeEach(() => {
    mocks.authorityFindUnique.mockResolvedValue({ id: "platform", ownerUserId: "current-owner" });
    mocks.userFindUnique.mockResolvedValue({
      id: "successor-user",
      email: "successor@example.test",
      emailVerified: true
    });
  });

  it("requires both current-owner and explicit verified-successor confirmation", async () => {
    await expect(
      recoverPlatformOwner({
        currentOwnerUserId: "current-owner",
        successorUserId: "successor-user",
        confirmSuccessorEmail: "successor@example.test"
      })
    ).resolves.toEqual({ id: "platform", ownerUserId: "successor-user" });

    expect(mocks.authorityUpdateMany).toHaveBeenCalledWith({
      where: { id: "platform", ownerUserId: "current-owner" },
      data: { ownerUserId: "successor-user" }
    });
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: {
        actorUserId: null,
        action: "platform.owner.recover",
        entityType: "platform_authority",
        entityId: "platform",
        source: "host_local_recovery",
        before: { ownerUserId: "current-owner" },
        after: { ownerUserId: "successor-user" }
      }
    });
  });

  it.each(["SUCCESSOR@example.test", " successor@example.test", "successor@example.test "])(
    "requires a byte-exact recovery successor email confirmation for %j",
    async (confirmSuccessorEmail) => {
      await expect(
        recoverPlatformOwner({
          currentOwnerUserId: "current-owner",
          successorUserId: "successor-user",
          confirmSuccessorEmail
        })
      ).rejects.toThrow("platform_owner_email_confirmation_mismatch");
      expect(mocks.authorityUpdateMany).not.toHaveBeenCalled();
      expect(mocks.auditCreate).not.toHaveBeenCalled();
    }
  );

  it("fails closed for a stale current-owner confirmation", async () => {
    await expect(
      recoverPlatformOwner({
        currentOwnerUserId: "wrong-current-owner",
        successorUserId: "successor-user",
        confirmSuccessorEmail: "successor@example.test"
      })
    ).rejects.toThrow("platform_owner_current_confirmation_mismatch");
    expect(mocks.authorityUpdateMany).not.toHaveBeenCalled();
  });

  it("fails closed if compare-and-swap loses a concurrent ownership race", async () => {
    mocks.authorityUpdateMany.mockResolvedValue({ count: 0 });

    await expect(
      recoverPlatformOwner({
        currentOwnerUserId: "current-owner",
        successorUserId: "successor-user",
        confirmSuccessorEmail: "successor@example.test"
      })
    ).rejects.toThrow("platform_owner_changed");
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });
});
