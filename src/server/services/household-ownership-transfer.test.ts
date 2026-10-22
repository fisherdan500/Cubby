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
 *
 * These tests pin the QUERY SHAPES as well as the outcomes. An earlier version asserted only
 * results, and an independent review proved fourteen deliberate mutations survived it -- including
 * dropping the household scope from the settle lookup and writing "accepted" on a decline. Tenancy,
 * liveness and freshness live in those filters, so the filters are what must be asserted.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireFreshSession: vi.fn(),
  memberFindFirst: vi.fn(),
  memberFindMany: vi.fn(),
  txMemberFindFirst: vi.fn(),
  txMemberFindMany: vi.fn(),
  txMemberUpdate: vi.fn(),
  prismaTransferFindFirst: vi.fn(),
  transferFindFirst: vi.fn(),
  transferCreate: vi.fn(),
  transferUpdate: vi.fn(),
  auditCreate: vi.fn(),
  policyLock: vi.fn(),
  queryRaw: vi.fn(),
  transaction: vi.fn()
}));

vi.mock("@/server/auth/session", () => ({
  requireUser: mocks.requireUser,
  requireFreshSession: mocks.requireFreshSession
}));

vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    householdMember: { findFirst: mocks.memberFindFirst, findMany: mocks.memberFindMany },
    householdOwnershipTransfer: { findFirst: mocks.prismaTransferFindFirst },
    $transaction: mocks.transaction
  }
}));

vi.mock("@/server/services/audit", () => ({ writeAudit: mocks.auditCreate }));

import {
  acceptOwnershipTransfer,
  cancelOwnershipTransfer,
  declineOwnershipTransfer,
  getOwnershipTransferRecipients,
  getOwnershipTransferView,
  initiateOwnershipTransfer
} from "@/server/services/household-ownership-transfer";

const now = new Date("2026-10-21T23:30:00.000Z");
const initiateOperationId = "11111111-1111-4111-8111-111111111111";
const settleOperationId = "22222222-2222-4222-8222-222222222222";
const otherOperationId = "33333333-3333-4333-8333-333333333333";

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

const freshSessionRow = {
  id: "session-1",
  userId: "user-owner",
  createdAt: new Date("2026-10-21T23:25:00.000Z"),
  expiresAt: new Date("2026-11-21T23:25:00.000Z")
};

function rawSql(template: unknown) {
  if (Array.isArray(template)) return template.join(" ? ");
  const sql = (template as { strings?: string[]; sql?: string } | null) ?? {};
  return sql.strings ? sql.strings.join(" ? ") : String(sql.sql ?? template);
}

/**
 * Answer each distinct raw query by its SQL.
 *
 * One shared mock for all of them is what let a review delete the advisory lock and the member row
 * locks with no test noticing, so each is answered -- and therefore countable -- separately.
 */
function queryRawDispatch(sessionRow: Record<string, unknown> | null = freshSessionRow) {
  return async (template: unknown) => {
    const sql = rawSql(template);
    if (sql.includes("clock_timestamp")) return [{ now: new Date() }];
    if (sql.includes("lock_actor_session_for_operation")) return sessionRow ? [sessionRow] : [];
    if (sql.includes("FOR UPDATE")) return [];
    throw new Error(`unexpected raw query: ${sql}`);
  };
}

/** Every member row-lock query the service issued. */
function memberLockCalls() {
  return mocks.queryRaw.mock.calls
    .map(([template]) => rawSql(template))
    .filter((sql) => sql.includes("FOR UPDATE") && sql.includes("HouseholdMember"));
}

function txClient() {
  return {
    $executeRaw: mocks.policyLock,
    $queryRaw: mocks.queryRaw,
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
  mocks.queryRaw.mockImplementation(queryRawDispatch());
  mocks.policyLock.mockResolvedValue(1);
  mocks.transferFindFirst.mockResolvedValue(null);
  mocks.prismaTransferFindFirst.mockResolvedValue(null);
  mocks.transferCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ ...pendingTransfer(), ...data }));
  mocks.transferUpdate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ ...pendingTransfer(), ...data }));
  mocks.txMemberUpdate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ ...recipient(), ...data }));
  mocks.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(txClient()));
});

describe("choosing who may receive a household", () => {
  it("offers only active verified members who are not already the owner", async () => {
    mocks.memberFindFirst.mockResolvedValue(owner());
    mocks.memberFindMany.mockResolvedValue([
      owner(),
      recipient(),
      recipient({ id: "member-disabled", userId: "user-disabled", disabledAt: now }),
      recipient({ id: "member-unverified", userId: "user-unverified", user: { id: "user-unverified", email: "x@example.test", emailVerified: false } })
    ]);

    const options = await getOwnershipTransferRecipients("household-1");
    const ids = options.map((option) => option.memberId);

    // DEC-PROD-016: an active member with a verified account, and nobody else.
    expect(ids).toEqual(["member-recipient"]);
  });

  it("refuses to list recipients for anyone but the owner", async () => {
    mocks.memberFindFirst.mockResolvedValue(recipient());
    await expect(getOwnershipTransferRecipients("household-1")).rejects.toThrow("forbidden");
    expect(mocks.memberFindMany).not.toHaveBeenCalled();
  });
});

describe("what each side of a transfer is shown", () => {
  it("tells the named recipient the offer is theirs to answer", async () => {
    mocks.requireUser.mockResolvedValue({ id: "user-recipient" });
    mocks.memberFindFirst.mockResolvedValue(recipient());
    mocks.prismaTransferFindFirst.mockResolvedValue({
      ...pendingTransfer(),
      fromMember: { id: "member-owner", displayName: "Dana" },
      toMember: { id: "member-recipient", displayName: "Sam" }
    });

    const view = await getOwnershipTransferView("household-1");

    expect(view.pending?.awaitingMe).toBe(true);
    expect(view.pending?.offeredBy).toBe("Dana");
    expect(view.isOwner).toBe(false);
    // The candidate list is the owner's business, not the recipient's.
    expect(view.recipients).toEqual([]);
  });

  it("tells an uninvolved member nothing at all about the offer", async () => {
    // Who was asked to take the household is not information a bystander needs.
    mocks.requireUser.mockResolvedValue({ id: "user-other" });
    mocks.memberFindFirst.mockResolvedValue(recipient({ id: "member-other", userId: "user-other", role: "read_only" }));
    mocks.prismaTransferFindFirst.mockResolvedValue({
      ...pendingTransfer(),
      fromMember: { id: "member-owner", displayName: "Dana" },
      toMember: { id: "member-recipient", displayName: "Sam" }
    });

    const view = await getOwnershipTransferView("household-1");

    expect(view.pending).toBeNull();
  });

  it("asks only for a live offer in this household", async () => {
    mocks.requireUser.mockResolvedValue({ id: "user-recipient" });
    mocks.memberFindFirst.mockResolvedValue(recipient());

    await getOwnershipTransferView("household-1");

    // An expired offer must not be rendered as answerable, and the filter belongs in the query.
    const where = mocks.prismaTransferFindFirst.mock.calls[0][0].where;
    expect(where.householdId).toBe("household-1");
    expect(where.status).toBeNull();
    expect(where.expiresAt.gt).toBeInstanceOf(Date);
  });
});

describe("the owner naming a successor", () => {
  it("records a pending transfer that moves nothing yet", async () => {
    mocks.txMemberFindFirst.mockResolvedValueOnce(owner()).mockResolvedValueOnce(recipient());

    const result = await initiateOwnershipTransfer({
      householdId: "household-1",
      toMemberId: "member-recipient",
      confirmation: "River House",
      operationId: initiateOperationId
    });

    expect(result.status).toBe("pending");
    expect(mocks.transferCreate).toHaveBeenCalledTimes(1);
    expect(mocks.transferCreate.mock.calls[0][0].data.status).toBeNull();
    // Nothing about anyone's role may change until the recipient accepts.
    expect(mocks.txMemberUpdate).not.toHaveBeenCalled();
    expect(mocks.policyLock).toHaveBeenCalledTimes(1);
  });

  it("scopes both member lookups to live members of the named household", async () => {
    mocks.txMemberFindFirst.mockResolvedValueOnce(owner()).mockResolvedValueOnce(recipient());

    await initiateOwnershipTransfer({
      householdId: "household-1",
      toMemberId: "member-recipient",
      confirmation: "River House",
      operationId: initiateOperationId
    });

    const actorWhere = mocks.txMemberFindFirst.mock.calls[0][0].where;
    expect(actorWhere.householdId).toBe("household-1");
    expect(actorWhere.deletedAt).toBeNull();
    expect(actorWhere.disabledAt).toBeNull();
    expect(actorWhere.household).toEqual({ deletedAt: null });

    const recipientWhere = mocks.txMemberFindFirst.mock.calls[1][0].where;
    expect(recipientWhere.householdId).toBe("household-1");
    expect(recipientWhere.id).toBe("member-recipient");
    expect(recipientWhere.deletedAt).toBeNull();

    // The recipient row is locked before it is judged.
    expect(memberLockCalls().length).toBeGreaterThanOrEqual(1);
  });

  it("requires fresh authentication at the edge", async () => {
    mocks.requireFreshSession.mockRejectedValue(new Error("fresh_authentication_required"));
    await expect(initiateOwnershipTransfer({
      householdId: "household-1",
      toMemberId: "member-recipient",
      confirmation: "River House",
      operationId: initiateOperationId
    })).rejects.toThrow("fresh_authentication_required");
  });

  it("re-checks freshness inside the transaction, not just at the edge", async () => {
    mocks.queryRaw.mockImplementation(queryRawDispatch({
      ...freshSessionRow,
      createdAt: new Date("2026-10-19T00:00:00.000Z")
    }));
    mocks.txMemberFindFirst.mockResolvedValueOnce(owner()).mockResolvedValueOnce(recipient());

    await expect(initiateOwnershipTransfer({
      householdId: "household-1",
      toMemberId: "member-recipient",
      confirmation: "River House",
      operationId: initiateOperationId
    })).rejects.toThrow("fresh_authentication_required");

    expect(mocks.transferCreate).not.toHaveBeenCalled();
  });

  it("refuses when the session was revoked after the request arrived", async () => {
    mocks.queryRaw.mockImplementation(queryRawDispatch(null));
    mocks.txMemberFindFirst.mockResolvedValueOnce(owner()).mockResolvedValueOnce(recipient());

    await expect(initiateOwnershipTransfer({
      householdId: "household-1",
      toMemberId: "member-recipient",
      confirmation: "River House",
      operationId: initiateOperationId
    })).rejects.toThrow("unauthenticated");

    expect(mocks.transferCreate).not.toHaveBeenCalled();
  });

  it("requires the household name typed exactly", async () => {
    mocks.txMemberFindFirst.mockResolvedValueOnce(owner()).mockResolvedValueOnce(recipient());

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

  it.each([
    ["no longer a member", null],
    ["suspended", recipient({ disabledAt: now })],
    ["unverified", recipient({ user: { id: "u", email: "u@example.test", emailVerified: false } })],
    ["already an owner", recipient({ role: "owner" })]
  ])("refuses a recipient who is %s", async (_label, candidate) => {
    mocks.txMemberFindFirst.mockResolvedValueOnce(owner()).mockResolvedValueOnce(candidate);

    await expect(initiateOwnershipTransfer({
      householdId: "household-1",
      toMemberId: "member-recipient",
      confirmation: "River House",
      operationId: initiateOperationId
    })).rejects.toThrow("household_ownership_transfer_recipient_invalid");
    expect(mocks.transferCreate).not.toHaveBeenCalled();
  });

  it("refuses an owner naming themselves", async () => {
    mocks.txMemberFindFirst
      .mockResolvedValueOnce(owner())
      .mockResolvedValueOnce(owner({ role: "parent" }));

    await expect(initiateOwnershipTransfer({
      householdId: "household-1",
      toMemberId: "member-owner",
      confirmation: "River House",
      operationId: initiateOperationId
    })).rejects.toThrow("household_ownership_transfer_recipient_invalid");
  });

  it("refuses a second pending transfer while one is outstanding", async () => {
    mocks.txMemberFindFirst.mockResolvedValueOnce(owner()).mockResolvedValueOnce(recipient());
    mocks.transferFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(pendingTransfer());

    await expect(initiateOwnershipTransfer({
      householdId: "household-1",
      toMemberId: "member-recipient",
      confirmation: "River House",
      operationId: otherOperationId
    })).rejects.toThrow("household_ownership_transfer_already_pending");
    expect(mocks.transferCreate).not.toHaveBeenCalled();
  });

  it("clears an offer nobody answered in time and allows a fresh one", async () => {
    // One pending transfer per household is allowed, so a dead offer must not lock the household
    // out of ever changing owner again -- which would also trap the owner, who cannot leave.
    mocks.txMemberFindFirst.mockResolvedValueOnce(owner()).mockResolvedValueOnce(recipient());
    mocks.transferFindFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(pendingTransfer({ expiresAt: new Date("2026-10-01T00:00:00.000Z") }));

    const result = await initiateOwnershipTransfer({
      householdId: "household-1",
      toMemberId: "member-recipient",
      confirmation: "River House",
      operationId: otherOperationId
    });

    expect(mocks.transferUpdate.mock.calls[0][0].data.status).toBe("expired");
    expect(mocks.transferUpdate.mock.calls[0][0].data.settledAt).toBeInstanceOf(Date);
    expect(result.status).toBe("pending");
    expect(mocks.transferCreate).toHaveBeenCalledTimes(1);
  });

  it("reconciles a retried offer instead of creating a second one", async () => {
    mocks.transferFindFirst.mockResolvedValueOnce(pendingTransfer());

    const result = await initiateOwnershipTransfer({
      householdId: "household-1",
      toMemberId: "member-recipient",
      confirmation: "River House",
      operationId: initiateOperationId
    });

    expect(result.transferId).toBe("transfer-1");
    expect(mocks.transferCreate).not.toHaveBeenCalled();
  });

  it("refuses to spend a settled operation id on a new offer", async () => {
    mocks.transferFindFirst.mockResolvedValueOnce(pendingTransfer({ status: "declined", settledAt: now }));

    await expect(initiateOwnershipTransfer({
      householdId: "household-1",
      toMemberId: "member-recipient",
      confirmation: "River House",
      operationId: initiateOperationId
    })).rejects.toThrow("household_ownership_transfer_operation_reused");
  });

  it("gives the offer a seven-day window, not an open-ended one", async () => {
    // An offer that effectively never expires is not a deadline; the recipient's authority to
    // accept would linger for years after the owner stopped expecting it.
    mocks.txMemberFindFirst.mockResolvedValueOnce(owner()).mockResolvedValueOnce(recipient());

    const result = await initiateOwnershipTransfer({
      householdId: "household-1",
      toMemberId: "member-recipient",
      confirmation: "River House",
      operationId: initiateOperationId
    });

    const lifetimeMs = result.expiresAt.getTime() - now.getTime();
    expect(lifetimeMs).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("records the offer in the audit trail", async () => {
    mocks.txMemberFindFirst.mockResolvedValueOnce(owner()).mockResolvedValueOnce(recipient());

    await initiateOwnershipTransfer({
      householdId: "household-1",
      toMemberId: "member-recipient",
      confirmation: "River House",
      operationId: initiateOperationId
    });

    expect(mocks.auditCreate).toHaveBeenCalledTimes(1);
    expect(mocks.auditCreate.mock.calls[0][1].action).toBe("household.ownership_transfer_initiated");
  });
});

describe("the recipient accepting", () => {
  beforeEach(() => {
    mocks.requireUser.mockResolvedValue({ id: "user-recipient", email: "sam@example.test" });
    mocks.requireFreshSession.mockResolvedValue({
      user: { id: "user-recipient", email: "sam@example.test" },
      session: { id: "session-2", createdAt: new Date("2026-10-21T23:25:00.000Z") }
    });
    mocks.queryRaw.mockImplementation(queryRawDispatch({
      ...freshSessionRow,
      id: "session-2",
      userId: "user-recipient"
    }));
  });

  function liveAcceptance() {
    mocks.txMemberFindFirst
      .mockResolvedValueOnce(recipient())
      .mockResolvedValueOnce(owner())
      .mockResolvedValueOnce(recipient());
    mocks.transferFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(pendingTransfer());
  }

  it("moves ownership and leaves the former owner an administrator", async () => {
    liveAcceptance();

    const result = await acceptOwnershipTransfer({
      householdId: "household-1",
      transferId: "transfer-1",
      operationId: settleOperationId
    });

    expect(result.status).toBe("accepted");
    const roles = mocks.txMemberUpdate.mock.calls.map((call) => [call[0].where.id, call[0].data.role]);
    // DEC-PROD-018: the former owner becomes an admin, never nothing and never removed.
    expect(roles).toEqual([["member-owner", "admin"], ["member-recipient", "owner"]]);
    expect(mocks.transferUpdate.mock.calls[0][0].data.status).toBe("accepted");
    expect(mocks.transferUpdate.mock.calls[0][0].data.settledAt).toBeInstanceOf(Date);
  });

  it("locks the member rows before writing either role", async () => {
    // A member removal committing between the checks and the writes would otherwise promote a
    // soft-deleted member, leaving the household with no active owner and no way to appoint one.
    liveAcceptance();

    await acceptOwnershipTransfer({
      householdId: "household-1",
      transferId: "transfer-1",
      operationId: settleOperationId
    });

    expect(memberLockCalls().length).toBeGreaterThanOrEqual(1);
    const lockIndex = mocks.queryRaw.mock.calls.findIndex(([t]) => rawSql(t).includes("FOR UPDATE"));
    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(mocks.queryRaw.mock.invocationCallOrder[lockIndex])
      .toBeLessThan(mocks.txMemberUpdate.mock.invocationCallOrder[0]);
  });

  it("finds the transfer only inside its own household and only while pending", async () => {
    liveAcceptance();

    await acceptOwnershipTransfer({
      householdId: "household-1",
      transferId: "transfer-1",
      operationId: settleOperationId
    });

    const settleWhere = mocks.transferFindFirst.mock.calls[1][0].where;
    expect(settleWhere.id).toBe("transfer-1");
    expect(settleWhere.householdId).toBe("household-1");
    expect(settleWhere.status).toBeNull();
  });

  it("refuses when the owner who started it is no longer the owner", async () => {
    // Sabotage found this gap. Between initiation and acceptance the owner may have left, been
    // removed, or already handed the household to someone else. Promoting the recipient anyway
    // would act on a stale intent and could leave the household with two owners.
    mocks.txMemberFindFirst
      .mockResolvedValueOnce(recipient())
      .mockResolvedValueOnce(owner({ role: "admin" }));
    mocks.transferFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(pendingTransfer());

    await expect(acceptOwnershipTransfer({
      householdId: "household-1",
      transferId: "transfer-1",
      operationId: settleOperationId
    })).rejects.toThrow("household_ownership_transfer_owner_changed");
    expect(mocks.txMemberUpdate).not.toHaveBeenCalled();
  });

  it("refuses when the former owner's membership is gone entirely", async () => {
    mocks.txMemberFindFirst
      .mockResolvedValueOnce(recipient())
      .mockResolvedValueOnce(null);
    mocks.transferFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(pendingTransfer());

    await expect(acceptOwnershipTransfer({
      householdId: "household-1",
      transferId: "transfer-1",
      operationId: settleOperationId
    })).rejects.toThrow("household_ownership_transfer_owner_changed");
    expect(mocks.txMemberUpdate).not.toHaveBeenCalled();
  });

  it.each([
    ["removed from the household", null],
    ["suspended", recipient({ disabledAt: now })],
    ["no longer verified", recipient({ user: { id: "u", email: "u@example.test", emailVerified: false } })]
  ])("refuses to promote a recipient who was %s while the offer waited", async (_label, current) => {
    // Days can pass between offer and acceptance. A suspended owner can neither act nor be
    // demoted, so letting acceptance undo a suspension would strand the household for good.
    mocks.txMemberFindFirst
      .mockResolvedValueOnce(recipient())
      .mockResolvedValueOnce(owner())
      .mockResolvedValueOnce(current);
    mocks.transferFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(pendingTransfer());

    await expect(acceptOwnershipTransfer({
      householdId: "household-1",
      transferId: "transfer-1",
      operationId: settleOperationId
    })).rejects.toThrow("household_ownership_transfer_recipient_ineligible");
    expect(mocks.txMemberUpdate).not.toHaveBeenCalled();
  });

  it("refuses anyone who is not the named recipient", async () => {
    mocks.txMemberFindFirst.mockResolvedValueOnce(recipient());
    mocks.transferFindFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(pendingTransfer({ toMemberId: "member-someone-else" }));

    await expect(acceptOwnershipTransfer({
      householdId: "household-1",
      transferId: "transfer-1",
      operationId: settleOperationId
    })).rejects.toThrow("forbidden");
    expect(mocks.txMemberUpdate).not.toHaveBeenCalled();
  });

  it("refuses an expired transfer", async () => {
    mocks.txMemberFindFirst.mockResolvedValueOnce(recipient());
    mocks.transferFindFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(pendingTransfer({ expiresAt: new Date("2026-10-20T00:00:00.000Z") }));

    await expect(acceptOwnershipTransfer({
      householdId: "household-1",
      transferId: "transfer-1",
      operationId: settleOperationId
    })).rejects.toThrow("household_ownership_transfer_expired");
    expect(mocks.txMemberUpdate).not.toHaveBeenCalled();
  });

  it("refuses a transfer that already settled", async () => {
    mocks.txMemberFindFirst.mockResolvedValueOnce(recipient());
    mocks.transferFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(null);

    await expect(acceptOwnershipTransfer({
      householdId: "household-1",
      transferId: "transfer-1",
      operationId: settleOperationId
    })).rejects.toThrow("not_found");
  });

  it("returns the original outcome when an acceptance is retried", async () => {
    mocks.transferFindFirst.mockResolvedValueOnce(pendingTransfer({
      status: "accepted",
      settledAt: now,
      settleOperationId
    }));

    const result = await acceptOwnershipTransfer({
      householdId: "household-1",
      transferId: "transfer-1",
      operationId: settleOperationId
    });

    expect(result.status).toBe("accepted");
    // A replay must not move any role a second time.
    expect(mocks.txMemberUpdate).not.toHaveBeenCalled();
  });

  it("refuses an operation id already spent on a different answer", async () => {
    mocks.transferFindFirst.mockResolvedValueOnce(pendingTransfer({
      status: "declined",
      settledAt: now,
      settleOperationId
    }));

    await expect(acceptOwnershipTransfer({
      householdId: "household-1",
      transferId: "transfer-1",
      operationId: settleOperationId
    })).rejects.toThrow("household_ownership_transfer_operation_reused");
  });

  it("records the acceptance in the audit trail", async () => {
    liveAcceptance();

    await acceptOwnershipTransfer({
      householdId: "household-1",
      transferId: "transfer-1",
      operationId: settleOperationId
    });

    expect(mocks.auditCreate).toHaveBeenCalledTimes(1);
    expect(mocks.auditCreate.mock.calls[0][1].action).toBe("household.ownership_transfer_accepted");
  });

  it("serialises on the advisory lock", async () => {
    liveAcceptance();

    await acceptOwnershipTransfer({
      householdId: "household-1",
      transferId: "transfer-1",
      operationId: settleOperationId
    });

    expect(mocks.policyLock).toHaveBeenCalledTimes(1);
  });
});

describe("the recipient declining", () => {
  beforeEach(() => {
    mocks.requireUser.mockResolvedValue({ id: "user-recipient", email: "sam@example.test" });
    mocks.requireFreshSession.mockResolvedValue({
      user: { id: "user-recipient", email: "sam@example.test" },
      session: { id: "session-2", createdAt: new Date("2026-10-21T23:25:00.000Z") }
    });
    mocks.queryRaw.mockImplementation(queryRawDispatch({
      ...freshSessionRow,
      id: "session-2",
      userId: "user-recipient"
    }));
  });

  it("settles the transfer as declined without touching a single role", async () => {
    mocks.txMemberFindFirst.mockResolvedValueOnce(recipient());
    mocks.transferFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(pendingTransfer());

    const result = await declineOwnershipTransfer({
      householdId: "household-1",
      transferId: "transfer-1",
      operationId: settleOperationId
    });

    expect(result.status).toBe("declined");
    // The written status is what frees the pending slot; "accepted" here would move ownership.
    expect(mocks.transferUpdate.mock.calls[0][0].data.status).toBe("declined");
    // Declining is not a mutation of anybody's authority: the owner stays the owner.
    expect(mocks.txMemberUpdate).not.toHaveBeenCalled();
  });

  it("refuses a decline from anyone but the named recipient", async () => {
    mocks.txMemberFindFirst.mockResolvedValueOnce(recipient());
    mocks.transferFindFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(pendingTransfer({ toMemberId: "member-someone-else" }));

    await expect(declineOwnershipTransfer({
      householdId: "household-1",
      transferId: "transfer-1",
      operationId: settleOperationId
    })).rejects.toThrow("forbidden");
    expect(mocks.transferUpdate).not.toHaveBeenCalled();
  });

  it("records the decline in the audit trail", async () => {
    mocks.txMemberFindFirst.mockResolvedValueOnce(recipient());
    mocks.transferFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(pendingTransfer());

    await declineOwnershipTransfer({
      householdId: "household-1",
      transferId: "transfer-1",
      operationId: settleOperationId
    });

    expect(mocks.auditCreate.mock.calls[0][1].action).toBe("household.ownership_transfer_declined");
  });
});

describe("the owner withdrawing an offer", () => {
  it("scopes the withdrawal to a live offer in the owner's own household", async () => {
    // Without the household scope an owner could withdraw another household's offer, and without
    // the status filter they could re-settle a transfer that was already accepted.
    mocks.txMemberFindFirst.mockResolvedValueOnce(owner());
    mocks.transferFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(pendingTransfer());

    await cancelOwnershipTransfer({
      householdId: "household-1",
      transferId: "transfer-1",
      operationId: settleOperationId
    });

    const where = mocks.transferFindFirst.mock.calls[1][0].where;
    expect(where.id).toBe("transfer-1");
    expect(where.householdId).toBe("household-1");
    expect(where.status).toBeNull();
  });

  it("only lets a live, unsuspended owner withdraw", async () => {
    mocks.txMemberFindFirst.mockResolvedValueOnce(owner());
    mocks.transferFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(pendingTransfer());

    await cancelOwnershipTransfer({
      householdId: "household-1",
      transferId: "transfer-1",
      operationId: settleOperationId
    });

    const actorWhere = mocks.txMemberFindFirst.mock.calls[0][0].where;
    expect(actorWhere.householdId).toBe("household-1");
    expect(actorWhere.deletedAt).toBeNull();
    expect(actorWhere.disabledAt).toBeNull();
    expect(actorWhere.household).toEqual({ deletedAt: null });
  });

  it.each([
    ["an administrator", recipient({ role: "admin" })],
    ["a parent", recipient({ role: "parent" })],
    ["a read-only member", recipient({ role: "read_only" })]
  ])("refuses a withdrawal by %s", async (_label, actor) => {
    mocks.txMemberFindFirst.mockResolvedValueOnce(actor);

    await expect(cancelOwnershipTransfer({
      householdId: "household-1",
      transferId: "transfer-1",
      operationId: settleOperationId
    })).rejects.toThrow("forbidden");
    expect(mocks.transferUpdate).not.toHaveBeenCalled();
  });

  it("requires fresh authentication, re-checked inside the transaction", async () => {
    // DEC-PROD-017 applies to every step that changes who holds the household, withdrawal
    // included: a stale session must not be able to revoke an offer.
    mocks.requireFreshSession.mockRejectedValue(new Error("fresh_authentication_required"));
    await expect(cancelOwnershipTransfer({
      householdId: "household-1",
      transferId: "transfer-1",
      operationId: settleOperationId
    })).rejects.toThrow("fresh_authentication_required");

    mocks.requireFreshSession.mockResolvedValue({
      user: { id: "user-owner" },
      session: { id: "session-1", createdAt: new Date("2026-10-21T23:25:00.000Z") }
    });
    mocks.queryRaw.mockImplementation(queryRawDispatch(null));
    mocks.txMemberFindFirst.mockResolvedValueOnce(owner());
    await expect(cancelOwnershipTransfer({
      householdId: "household-1",
      transferId: "transfer-1",
      operationId: settleOperationId
    })).rejects.toThrow("unauthenticated");
  });

  it("serialises on the advisory lock", async () => {
    mocks.txMemberFindFirst.mockResolvedValueOnce(owner());
    mocks.transferFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(pendingTransfer());

    await cancelOwnershipTransfer({
      householdId: "household-1",
      transferId: "transfer-1",
      operationId: settleOperationId
    });

    expect(mocks.policyLock).toHaveBeenCalledTimes(1);
  });

  it("persists the idempotency key with the settlement", async () => {
    // Without settleOperationId on the row, replay detection can never match and a retried
    // withdrawal would be judged afresh.
    mocks.txMemberFindFirst.mockResolvedValueOnce(owner());
    mocks.transferFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(pendingTransfer());

    await cancelOwnershipTransfer({
      householdId: "household-1",
      transferId: "transfer-1",
      operationId: settleOperationId
    });

    const data = mocks.transferUpdate.mock.calls[0][0].data;
    expect(data.settleOperationId).toBe(settleOperationId);
    expect(data.settledAt).toBeInstanceOf(Date);
  });

  it("returns the original outcome when a withdrawal is retried", async () => {
    mocks.transferFindFirst.mockResolvedValueOnce(pendingTransfer({
      status: "cancelled",
      settledAt: now,
      settleOperationId
    }));

    const result = await cancelOwnershipTransfer({
      householdId: "household-1",
      transferId: "transfer-1",
      operationId: settleOperationId
    });

    expect(result.status).toBe("cancelled");
    expect(mocks.transferUpdate).not.toHaveBeenCalled();
  });

  it.each([
    ["accepted", "accepted"],
    ["declined", "declined"]
  ])("refuses an operation id already spent on a %s answer", async (_label, status) => {
    mocks.transferFindFirst.mockResolvedValueOnce(pendingTransfer({
      status,
      settledAt: now,
      settleOperationId
    }));

    await expect(cancelOwnershipTransfer({
      householdId: "household-1",
      transferId: "transfer-1",
      operationId: settleOperationId
    })).rejects.toThrow("household_ownership_transfer_operation_reused");
  });

  it("refuses a replayed operation id from another household", async () => {
    mocks.transferFindFirst.mockResolvedValueOnce(pendingTransfer({
      householdId: "household-other",
      status: "cancelled",
      settledAt: now,
      settleOperationId
    }));

    await expect(cancelOwnershipTransfer({
      householdId: "household-1",
      transferId: "transfer-1",
      operationId: settleOperationId
    })).rejects.toThrow("household_ownership_transfer_operation_reused");
  });

  it("takes back an offer nobody has answered", async () => {
    // Without this the owner is trapped: one pending transfer per household means an offer to the
    // wrong person would block every future transfer, and an owner cannot leave a household.
    mocks.txMemberFindFirst.mockResolvedValueOnce(owner());
    mocks.transferFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(pendingTransfer());

    const result = await cancelOwnershipTransfer({
      householdId: "household-1",
      transferId: "transfer-1",
      operationId: settleOperationId
    });

    expect(result.status).toBe("cancelled");
    expect(mocks.transferUpdate.mock.calls[0][0].data.status).toBe("cancelled");
    // Withdrawing changes nobody's authority.
    expect(mocks.txMemberUpdate).not.toHaveBeenCalled();
  });

  it("refuses a withdrawal from anyone but the owner", async () => {
    mocks.txMemberFindFirst.mockResolvedValueOnce(recipient());

    await expect(cancelOwnershipTransfer({
      householdId: "household-1",
      transferId: "transfer-1",
      operationId: settleOperationId
    })).rejects.toThrow("forbidden");
    expect(mocks.transferUpdate).not.toHaveBeenCalled();
  });

  it("refuses to withdraw a transfer belonging to another household", async () => {
    mocks.txMemberFindFirst.mockResolvedValueOnce(owner());
    mocks.transferFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(null);

    await expect(cancelOwnershipTransfer({
      householdId: "household-1",
      transferId: "transfer-elsewhere",
      operationId: settleOperationId
    })).rejects.toThrow("not_found");
  });

  it("records the withdrawal in the audit trail", async () => {
    mocks.txMemberFindFirst.mockResolvedValueOnce(owner());
    mocks.transferFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(pendingTransfer());

    await cancelOwnershipTransfer({
      householdId: "household-1",
      transferId: "transfer-1",
      operationId: settleOperationId
    });

    expect(mocks.auditCreate.mock.calls[0][1].action).toBe("household.ownership_transfer_cancelled");
  });
});

describe("invariants the rest of the suite leans on", () => {
  it("hides a household from a suspended viewer rather than offering dead buttons", async () => {
    // A suspended member cannot offer or accept, so showing them an offer would show a control
    // that always refuses. The reader must agree with the mutating paths.
    mocks.requireUser.mockResolvedValue({ id: "user-recipient" });
    mocks.memberFindFirst.mockResolvedValue(null);

    await expect(getOwnershipTransferView("household-1")).rejects.toThrow("forbidden");

    const where = mocks.memberFindFirst.mock.calls[0][0].where;
    expect(where.disabledAt).toBeNull();
    expect(where.deletedAt).toBeNull();
    expect(where.household).toEqual({ deletedAt: null });
  });

  it("judges time by the database clock, not this process's clock", async () => {
    // A transaction can wait a long time in the advisory-lock queue, so a timestamp taken before
    // the lock is not the time the decision is made. Expiry is a deadline and must use DB time.
    const seen: string[] = [];
    mocks.queryRaw.mockImplementation(async (template: unknown) => {
      const sql = rawSql(template);
      seen.push(sql);
      if (sql.includes("clock_timestamp")) return [{ now: new Date() }];
      if (sql.includes("lock_actor_session_for_operation")) return [freshSessionRow];
      if (sql.includes("FOR UPDATE")) return [];
      throw new Error(`unexpected raw query: ${sql}`);
    });
    mocks.txMemberFindFirst.mockResolvedValueOnce(owner()).mockResolvedValueOnce(recipient());

    await initiateOwnershipTransfer({
      householdId: "household-1",
      toMemberId: "member-recipient",
      confirmation: "River House",
      operationId: initiateOperationId
    });

    expect(seen.some((sql) => sql.includes("clock_timestamp"))).toBe(true);
  });

  it("locks member rows in a fixed ascending id order", async () => {
    // Two transactions that lock the same rows in different orders can wait on each other for
    // ever. removeMember locks ORDER BY "id", so this must too.
    mocks.requireUser.mockResolvedValue({ id: "user-recipient" });
    mocks.requireFreshSession.mockResolvedValue({
      user: { id: "user-recipient" },
      session: { id: "session-2", createdAt: new Date("2026-10-21T23:25:00.000Z") }
    });
    mocks.queryRaw.mockImplementation(queryRawDispatch({
      ...freshSessionRow,
      id: "session-2",
      userId: "user-recipient"
    }));
    mocks.txMemberFindFirst
      .mockResolvedValueOnce(recipient())
      .mockResolvedValueOnce(owner())
      .mockResolvedValueOnce(recipient());
    mocks.transferFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(pendingTransfer());

    await acceptOwnershipTransfer({
      householdId: "household-1",
      transferId: "transfer-1",
      operationId: settleOperationId
    });

    const lock = memberLockCalls()[0];
    expect(lock).toContain("FOR UPDATE");
    expect(lock).toContain('ORDER BY "id"');

    // The SQL text alone is not the invariant: the id list handed to it must be ascending too, or
    // two transactions can take the same two rows in opposite orders and wait on each other.
    const lockCall = mocks.queryRaw.mock.calls.find(([t]) => rawSql(t).includes("FOR UPDATE"));
    const ids = JSON.stringify(lockCall?.slice(1) ?? []).match(/member-[a-z]+/g) ?? [];
    expect(ids.length).toBeGreaterThanOrEqual(2);
    expect(ids).toEqual([...ids].sort());
  });

  it("locks BOTH parties before moving ownership, not just the recipient", async () => {
    mocks.requireUser.mockResolvedValue({ id: "user-recipient" });
    mocks.requireFreshSession.mockResolvedValue({
      user: { id: "user-recipient" },
      session: { id: "session-2", createdAt: new Date("2026-10-21T23:25:00.000Z") }
    });
    mocks.queryRaw.mockImplementation(queryRawDispatch({
      ...freshSessionRow,
      id: "session-2",
      userId: "user-recipient"
    }));
    mocks.txMemberFindFirst
      .mockResolvedValueOnce(recipient())
      .mockResolvedValueOnce(owner())
      .mockResolvedValueOnce(recipient());
    mocks.transferFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(pendingTransfer());

    await acceptOwnershipTransfer({
      householdId: "household-1",
      transferId: "transfer-1",
      operationId: settleOperationId
    });

    // Both ids must appear in the lock parameters: locking only the recipient leaves the outgoing
    // owner's row free to be mutated between the check and the write.
    const params = mocks.queryRaw.mock.calls
      .filter(([t]) => rawSql(t).includes("FOR UPDATE"))
      .flatMap(([, ...rest]) => rest.map((value) => JSON.stringify(value)))
      .join(" ");
    const lockedText = params + JSON.stringify(mocks.queryRaw.mock.calls.filter(([t]) => rawSql(t).includes("FOR UPDATE")));
    expect(lockedText).toContain("member-owner");
    expect(lockedText).toContain("member-recipient");
  });

  it("tells the recipient an offer was withdrawn rather than just 'not found'", async () => {
    mocks.requireUser.mockResolvedValue({ id: "user-recipient" });
    mocks.requireFreshSession.mockResolvedValue({
      user: { id: "user-recipient" },
      session: { id: "session-2", createdAt: new Date("2026-10-21T23:25:00.000Z") }
    });
    mocks.queryRaw.mockImplementation(queryRawDispatch({
      ...freshSessionRow,
      id: "session-2",
      userId: "user-recipient"
    }));
    mocks.txMemberFindFirst.mockResolvedValueOnce(recipient());
    mocks.transferFindFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(pendingTransfer({ status: "cancelled", settledAt: now }));

    await expect(acceptOwnershipTransfer({
      householdId: "household-1",
      transferId: "transfer-1",
      operationId: settleOperationId
    })).rejects.toThrow("household_ownership_transfer_withdrawn");
  });

  it("gives the accept-side recipient failure its own code", async () => {
    // The initiate-side sentence tells the owner to choose someone else; the person reading this
    // on accept is the recipient, who is choosing nobody.
    mocks.requireUser.mockResolvedValue({ id: "user-recipient" });
    mocks.requireFreshSession.mockResolvedValue({
      user: { id: "user-recipient" },
      session: { id: "session-2", createdAt: new Date("2026-10-21T23:25:00.000Z") }
    });
    mocks.queryRaw.mockImplementation(queryRawDispatch({
      ...freshSessionRow,
      id: "session-2",
      userId: "user-recipient"
    }));
    mocks.txMemberFindFirst
      .mockResolvedValueOnce(recipient())
      .mockResolvedValueOnce(owner())
      .mockResolvedValueOnce(recipient({ disabledAt: now }));
    mocks.transferFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(pendingTransfer());

    await expect(acceptOwnershipTransfer({
      householdId: "household-1",
      transferId: "transfer-1",
      operationId: settleOperationId
    })).rejects.toThrow("household_ownership_transfer_recipient_ineligible");
  });

  it("looks up an initiate replay by the caller's own operation id", async () => {
    // If the lookup keys on anything but the submitted id, replay detection never matches and the
    // retry hits the unique constraint as a 500 instead of returning the first outcome.
    mocks.transferFindFirst.mockResolvedValueOnce(null);
    mocks.txMemberFindFirst.mockResolvedValueOnce(owner()).mockResolvedValueOnce(recipient());

    await initiateOwnershipTransfer({
      householdId: "household-1",
      toMemberId: "member-recipient",
      confirmation: "River House",
      operationId: initiateOperationId
    });

    expect(mocks.transferFindFirst.mock.calls[0][0].where).toEqual({
      initiateOperationId: initiateOperationId
    });
  });

  it("keeps the initiate replay check scoped to the stated household", async () => {
    mocks.transferFindFirst.mockResolvedValueOnce(pendingTransfer({ householdId: "household-other" }));

    await expect(initiateOwnershipTransfer({
      householdId: "household-1",
      toMemberId: "member-recipient",
      confirmation: "River House",
      operationId: initiateOperationId
    })).rejects.toThrow("forbidden");
  });

  it("stores the initiating operation id so a retry can reconcile", async () => {
    mocks.txMemberFindFirst.mockResolvedValueOnce(owner()).mockResolvedValueOnce(recipient());

    await initiateOwnershipTransfer({
      householdId: "household-1",
      toMemberId: "member-recipient",
      confirmation: "River House",
      operationId: initiateOperationId
    });

    const created = mocks.transferCreate.mock.calls[0][0].data;
    expect(created.initiateOperationId).toBe(initiateOperationId);
    expect(created.initiateOperationId).not.toBeNull();
  });

  it("settles a lapsed offer with the transaction clock, not the epoch", async () => {
    mocks.txMemberFindFirst.mockResolvedValueOnce(owner()).mockResolvedValueOnce(recipient());
    mocks.transferFindFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(pendingTransfer({ expiresAt: new Date("2026-10-01T00:00:00.000Z") }));

    await initiateOwnershipTransfer({
      householdId: "household-1",
      toMemberId: "member-recipient",
      confirmation: "River House",
      operationId: otherOperationId
    });

    const settledAt = mocks.transferUpdate.mock.calls[0][0].data.settledAt as Date;
    expect(settledAt.getTime()).toBeGreaterThan(new Date("2026-01-01T00:00:00.000Z").getTime());
  });

  it("refuses a decline whose operation id was spent on an acceptance", async () => {
    mocks.requireUser.mockResolvedValue({ id: "user-recipient" });
    mocks.requireFreshSession.mockResolvedValue({
      user: { id: "user-recipient" },
      session: { id: "session-2", createdAt: new Date("2026-10-21T23:25:00.000Z") }
    });
    mocks.queryRaw.mockImplementation(queryRawDispatch({
      ...freshSessionRow,
      id: "session-2",
      userId: "user-recipient"
    }));
    mocks.transferFindFirst.mockResolvedValueOnce(pendingTransfer({
      status: "accepted",
      settledAt: now,
      settleOperationId
    }));

    await expect(declineOwnershipTransfer({
      householdId: "household-1",
      transferId: "transfer-1",
      operationId: settleOperationId
    })).rejects.toThrow("household_ownership_transfer_operation_reused");
  });

  it("persists the decline idempotency key", async () => {
    mocks.requireUser.mockResolvedValue({ id: "user-recipient" });
    mocks.requireFreshSession.mockResolvedValue({
      user: { id: "user-recipient" },
      session: { id: "session-2", createdAt: new Date("2026-10-21T23:25:00.000Z") }
    });
    mocks.queryRaw.mockImplementation(queryRawDispatch({
      ...freshSessionRow,
      id: "session-2",
      userId: "user-recipient"
    }));
    mocks.txMemberFindFirst.mockResolvedValueOnce(recipient());
    mocks.transferFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(pendingTransfer());

    await declineOwnershipTransfer({
      householdId: "household-1",
      transferId: "transfer-1",
      operationId: settleOperationId
    });

    expect(mocks.transferUpdate.mock.calls[0][0].data.settleOperationId).toBe(settleOperationId);
  });

  it("refuses an accept replay naming another household's transfer", async () => {
    // findSettledOperation must prove the replayed row is the one the caller named, or a spent
    // operation id from one household reports success against another.
    mocks.requireUser.mockResolvedValue({ id: "user-recipient" });
    mocks.requireFreshSession.mockResolvedValue({
      user: { id: "user-recipient" },
      session: { id: "session-2", createdAt: new Date("2026-10-21T23:25:00.000Z") }
    });
    mocks.queryRaw.mockImplementation(queryRawDispatch({
      ...freshSessionRow,
      id: "session-2",
      userId: "user-recipient"
    }));
    mocks.transferFindFirst.mockResolvedValueOnce(pendingTransfer({
      householdId: "household-other",
      status: "accepted",
      settledAt: now,
      settleOperationId
    }));

    await expect(acceptOwnershipTransfer({
      householdId: "household-1",
      transferId: "transfer-1",
      operationId: settleOperationId
    })).rejects.toThrow("forbidden");
    expect(mocks.txMemberUpdate).not.toHaveBeenCalled();
  });

  it("refuses an accept replay naming a different transfer id", async () => {
    mocks.requireUser.mockResolvedValue({ id: "user-recipient" });
    mocks.requireFreshSession.mockResolvedValue({
      user: { id: "user-recipient" },
      session: { id: "session-2", createdAt: new Date("2026-10-21T23:25:00.000Z") }
    });
    mocks.queryRaw.mockImplementation(queryRawDispatch({
      ...freshSessionRow,
      id: "session-2",
      userId: "user-recipient"
    }));
    mocks.transferFindFirst.mockResolvedValueOnce(pendingTransfer({
      id: "transfer-elsewhere",
      status: "accepted",
      settledAt: now,
      settleOperationId
    }));

    await expect(acceptOwnershipTransfer({
      householdId: "household-1",
      transferId: "transfer-1",
      operationId: settleOperationId
    })).rejects.toThrow("forbidden");
  });
});
