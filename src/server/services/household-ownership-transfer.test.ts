/**
 * Handing a household to someone else.
 *
 * A household has exactly one owner and must never have zero or two. Ownership therefore does not
 * "change" so much as move, atomically, between two named people who each agreed to it:
 *
 *   DEC-PROD-016  the recipient must already be an active member with a verified account.
 *                 A stranger cannot be made owner; they accept a normal invitation first.
 *   DEC-PROD-017  the owner authenticates freshly and names the recipient, and the RECIPIENT
 *                 must then accept in-app before anything moves.
 *   DEC-PROD-018  the former owner becomes an administrator -- not removed, not demoted to
 *                 nothing -- and the confirmation says so before the owner commits.
 *
 * The two-step shape is the point. A single-step transfer would let one person remove their own
 * authority and hand a household to someone who never agreed to hold it; a pending row that grants
 * nothing until accepted means neither party is surprised.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireFreshSession: vi.fn(),
  memberFindFirst: vi.fn(),
  memberFindMany: vi.fn(),
  memberUpdate: vi.fn(),
  txMemberFindFirst: vi.fn(),
  txMemberFindMany: vi.fn(),
  txMemberUpdate: vi.fn(),
  transferFindFirst: vi.fn(),
  transferFindMany: vi.fn(),
  transferCreate: vi.fn(),
  transferUpdate: vi.fn(),
  auditCreate: vi.fn(),
  policyLock: vi.fn(),
  memberLock: vi.fn(),
  sessionLock: vi.fn(),
  transaction: vi.fn()
}));

vi.mock("@/server/auth/session", () => ({
  requireUser: mocks.requireUser,
  requireFreshSession: mocks.requireFreshSession
}));

vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    householdMember: { findFirst: mocks.memberFindFirst, findMany: mocks.memberFindMany },
    householdOwnershipTransfer: { findFirst: mocks.transferFindFirst, findMany: mocks.transferFindMany },
    $transaction: mocks.transaction
  }
}));

vi.mock("@/server/services/audit", () => ({ writeAudit: mocks.auditCreate }));

import {
  acceptOwnershipTransfer,
  declineOwnershipTransfer,
  getOwnershipTransferRecipients,
  initiateOwnershipTransfer
} from "@/server/services/household-ownership-transfer";

const now = new Date("2026-10-21T23:30:00.000Z");
const initiateOperationId = "11111111-1111-4111-8111-111111111111";
const settleOperationId = "22222222-2222-4222-8222-222222222222";

function owner(overrides: Record<string, unknown> = {}) {
  return {
    id: "member-owner",
    householdId: "household-1",
    userId: "user-owner",
    role: "owner",
    displayName: "Dana",
    disabledAt: null,
    deletedAt: null,
    user: { id: "user-owner", email: "owner@example.test", emailVerified: true },
    household: { id: "household-1", name: "River House", deletedAt: null },
    ...overrides
  };
}

function recipient(overrides: Record<string, unknown> = {}) {
  return {
    id: "member-recipient",
    householdId: "household-1",
    userId: "user-recipient",
    role: "parent",
    displayName: "Sam",
    disabledAt: null,
    deletedAt: null,
    user: { id: "user-recipient", email: "sam@example.test", emailVerified: true },
    household: { id: "household-1", name: "River House", deletedAt: null },
    ...overrides
  };
}

function pendingTransfer(overrides: Record<string, unknown> = {}) {
  return {
    id: "transfer-1",
    householdId: "household-1",
    fromMemberId: "member-owner",
    toMemberId: "member-recipient",
    status: null,
    settledAt: null,
    expiresAt: new Date("2026-10-28T23:30:00.000Z"),
    initiateOperationId,
    settleOperationId: null,
    ...overrides
  };
}

/** A transaction client whose shape mirrors the real one closely enough to catch misuse. */
function txClient() {
  return {
    $executeRaw: mocks.policyLock,
    $queryRaw: mocks.memberLock,
    householdMember: {
      findFirst: mocks.txMemberFindFirst,
      findMany: mocks.txMemberFindMany,
      update: mocks.txMemberUpdate
    },
    householdOwnershipTransfer: {
      findFirst: mocks.transferFindFirst,
      create: mocks.transferCreate,
      update: mocks.transferUpdate
    }
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(now);
  mocks.requireUser.mockResolvedValue({ id: "user-owner", email: "owner@example.test" });
  mocks.requireFreshSession.mockResolvedValue({
    user: { id: "user-owner", email: "owner@example.test" },
    session: { id: "session-1", createdAt: new Date("2026-10-21T23:25:00.000Z") }
  });
  mocks.memberLock.mockResolvedValue([
    { id: "session-1", userId: "user-owner", createdAt: new Date("2026-10-21T23:25:00.000Z"), expiresAt: new Date("2026-11-21T23:25:00.000Z") }
  ]);
  mocks.policyLock.mockResolvedValue(1);
  mocks.transferCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ ...pendingTransfer(), ...data }));
  mocks.transferUpdate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ ...pendingTransfer(), ...data }));
  mocks.txMemberUpdate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ ...recipient(), ...data }));
  mocks.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(txClient()));
});

describe("choosing who may receive a household", () => {
  it("offers only active members who are not already the owner", async () => {
    mocks.memberFindFirst.mockResolvedValue(owner());
    mocks.memberFindMany.mockResolvedValue([
      recipient(),
      recipient({ id: "member-disabled", userId: "user-disabled", disabledAt: now }),
      recipient({ id: "member-unverified", userId: "user-unverified", user: { id: "user-unverified", email: "x@example.test", emailVerified: false } })
    ]);

    const options = await getOwnershipTransferRecipients("household-1");
    const ids = options.map((option) => option.memberId);

    expect(ids).toContain("member-recipient");
    // DEC-PROD-016: an active member with a verified account, and nobody else.
    expect(ids).not.toContain("member-disabled");
    expect(ids).not.toContain("member-unverified");
    expect(ids).not.toContain("member-owner");
  });

  it("refuses to list recipients for anyone but the owner", async () => {
    mocks.memberFindFirst.mockResolvedValue(recipient());
    await expect(getOwnershipTransferRecipients("household-1")).rejects.toThrow("forbidden");
  });
});

describe("the owner naming a successor", () => {
  it("records a pending transfer that moves nothing yet", async () => {
    mocks.txMemberFindFirst.mockResolvedValueOnce(owner()).mockResolvedValueOnce(recipient());
    mocks.transferFindFirst.mockResolvedValue(null);

    const result = await initiateOwnershipTransfer({
      householdId: "household-1",
      toMemberId: "member-recipient",
      confirmation: "River House",
      operationId: initiateOperationId
    });

    expect(result.status).toBe("pending");
    expect(mocks.transferCreate).toHaveBeenCalledTimes(1);
    // Nothing about anyone's role may change until the recipient accepts.
    expect(mocks.txMemberUpdate).not.toHaveBeenCalled();
  });

  it("requires fresh authentication", async () => {
    mocks.requireFreshSession.mockRejectedValue(new Error("fresh_authentication_required"));
    await expect(initiateOwnershipTransfer({
      householdId: "household-1",
      toMemberId: "member-recipient",
      confirmation: "River House",
      operationId: initiateOperationId
    })).rejects.toThrow("fresh_authentication_required");
  });

  it("requires the household name typed exactly", async () => {
    mocks.txMemberFindFirst.mockResolvedValueOnce(owner()).mockResolvedValueOnce(recipient());
    mocks.transferFindFirst.mockResolvedValue(null);

    await expect(initiateOwnershipTransfer({
      householdId: "household-1",
      toMemberId: "member-recipient",
      confirmation: "river house",
      operationId: initiateOperationId
    })).rejects.toThrow("household_ownership_transfer_confirmation_mismatch");
    expect(mocks.transferCreate).not.toHaveBeenCalled();
  });

  it("refuses when the caller is not the owner", async () => {
    mocks.txMemberFindFirst.mockResolvedValueOnce(recipient());
    await expect(initiateOwnershipTransfer({
      householdId: "household-1",
      toMemberId: "member-owner",
      confirmation: "River House",
      operationId: initiateOperationId
    })).rejects.toThrow("forbidden");
  });

  it("refuses a recipient who is not an active verified member", async () => {
    mocks.txMemberFindFirst.mockResolvedValueOnce(owner()).mockResolvedValueOnce(null);
    mocks.transferFindFirst.mockResolvedValue(null);

    await expect(initiateOwnershipTransfer({
      householdId: "household-1",
      toMemberId: "member-ghost",
      confirmation: "River House",
      operationId: initiateOperationId
    })).rejects.toThrow("household_ownership_transfer_recipient_invalid");
  });

  it("refuses a second pending transfer while one is outstanding", async () => {
    mocks.txMemberFindFirst.mockResolvedValueOnce(owner()).mockResolvedValueOnce(recipient());
    mocks.transferFindFirst.mockResolvedValue(pendingTransfer());

    await expect(initiateOwnershipTransfer({
      householdId: "household-1",
      toMemberId: "member-recipient",
      confirmation: "River House",
      operationId: initiateOperationId
    })).rejects.toThrow("household_ownership_transfer_already_pending");
  });
});

describe("the recipient accepting", () => {
  beforeEach(() => {
    mocks.requireUser.mockResolvedValue({ id: "user-recipient", email: "sam@example.test" });
    mocks.requireFreshSession.mockResolvedValue({
      user: { id: "user-recipient", email: "sam@example.test" },
      session: { id: "session-2", createdAt: new Date("2026-10-21T23:25:00.000Z") }
    });
    mocks.memberLock.mockResolvedValue([
      { id: "session-2", userId: "user-recipient", createdAt: new Date("2026-10-21T23:25:00.000Z"), expiresAt: new Date("2026-11-21T23:25:00.000Z") }
    ]);
  });

  it("moves ownership and leaves the former owner an administrator", async () => {
    mocks.transferFindFirst.mockResolvedValue(pendingTransfer());
    mocks.txMemberFindFirst.mockResolvedValueOnce(recipient()).mockResolvedValueOnce(owner());

    const result = await acceptOwnershipTransfer({
      householdId: "household-1",
      transferId: "transfer-1",
      operationId: settleOperationId
    });

    expect(result.status).toBe("accepted");
    const roles = mocks.txMemberUpdate.mock.calls.map((call) => [call[0].where.id, call[0].data.role]);
    // DEC-PROD-018: the former owner becomes an admin, never nothing and never removed.
    expect(roles).toContainEqual(["member-owner", "admin"]);
    expect(roles).toContainEqual(["member-recipient", "owner"]);
  });

  it("refuses when the owner who started it is no longer the owner", async () => {
    // Sabotage found this gap. Between initiation and acceptance the owner may have left, been
    // removed, or already handed the household to someone else. Promoting the recipient anyway
    // would act on a stale intent and could leave the household with two owners.
    mocks.transferFindFirst.mockResolvedValue(pendingTransfer());
    mocks.txMemberFindFirst
      .mockResolvedValueOnce(recipient())
      .mockResolvedValueOnce(owner({ role: "admin" }));

    await expect(acceptOwnershipTransfer({
      householdId: "household-1",
      transferId: "transfer-1",
      operationId: settleOperationId
    })).rejects.toThrow("household_ownership_transfer_owner_changed");
    expect(mocks.txMemberUpdate).not.toHaveBeenCalled();
  });

  it("refuses when the former owner's membership is gone entirely", async () => {
    mocks.transferFindFirst.mockResolvedValue(pendingTransfer());
    mocks.txMemberFindFirst
      .mockResolvedValueOnce(recipient())
      .mockResolvedValueOnce(null);

    await expect(acceptOwnershipTransfer({
      householdId: "household-1",
      transferId: "transfer-1",
      operationId: settleOperationId
    })).rejects.toThrow("household_ownership_transfer_owner_changed");
    expect(mocks.txMemberUpdate).not.toHaveBeenCalled();
  });

  it("refuses anyone who is not the named recipient", async () => {
    mocks.transferFindFirst.mockResolvedValue(pendingTransfer({ toMemberId: "member-someone-else" }));
    mocks.txMemberFindFirst.mockResolvedValueOnce(recipient());

    await expect(acceptOwnershipTransfer({
      householdId: "household-1",
      transferId: "transfer-1",
      operationId: settleOperationId
    })).rejects.toThrow("forbidden");
    expect(mocks.txMemberUpdate).not.toHaveBeenCalled();
  });

  it("refuses an expired transfer", async () => {
    mocks.transferFindFirst.mockResolvedValue(pendingTransfer({ expiresAt: new Date("2026-10-20T00:00:00.000Z") }));
    mocks.txMemberFindFirst.mockResolvedValueOnce(recipient());

    await expect(acceptOwnershipTransfer({
      householdId: "household-1",
      transferId: "transfer-1",
      operationId: settleOperationId
    })).rejects.toThrow("household_ownership_transfer_expired");
    expect(mocks.txMemberUpdate).not.toHaveBeenCalled();
  });

  it("refuses a transfer that already settled", async () => {
    mocks.transferFindFirst.mockResolvedValue(null);
    mocks.txMemberFindFirst.mockResolvedValueOnce(recipient());

    await expect(acceptOwnershipTransfer({
      householdId: "household-1",
      transferId: "transfer-1",
      operationId: settleOperationId
    })).rejects.toThrow("not_found");
  });
});

describe("the recipient declining", () => {
  beforeEach(() => {
    mocks.requireUser.mockResolvedValue({ id: "user-recipient", email: "sam@example.test" });
    mocks.requireFreshSession.mockResolvedValue({
      user: { id: "user-recipient", email: "sam@example.test" },
      session: { id: "session-2", createdAt: new Date("2026-10-21T23:25:00.000Z") }
    });
    mocks.memberLock.mockResolvedValue([
      { id: "session-2", userId: "user-recipient", createdAt: new Date("2026-10-21T23:25:00.000Z"), expiresAt: new Date("2026-11-21T23:25:00.000Z") }
    ]);
  });

  it("settles the transfer without touching a single role", async () => {
    mocks.transferFindFirst.mockResolvedValue(pendingTransfer());
    mocks.txMemberFindFirst.mockResolvedValueOnce(recipient());

    const result = await declineOwnershipTransfer({
      householdId: "household-1",
      transferId: "transfer-1",
      operationId: settleOperationId
    });

    expect(result.status).toBe("declined");
    // Declining is not a mutation of anybody's authority: the owner stays the owner.
    expect(mocks.txMemberUpdate).not.toHaveBeenCalled();
  });
});
