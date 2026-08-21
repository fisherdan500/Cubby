import { AccountOperationKey, BrowserOperationKey, BrowserOperationProtocolVersion, BrowserOperationTargetKind, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({
  session: { user: { id: "dec-u1" }, session: { id: "dec-s1" } } as { user: { id: string }; session: { id: string } },
  inviteUser: { id: "dec-u2", name: "Hostile", email: "dec-hostile@acceptance.invalid" },
  context: { userId: "dec-u1", householdId: "dec-h1", memberId: "dec-m1", role: "owner" } as { userId: string; householdId: string; memberId: string; role: "owner" | "parent" }
}));

vi.mock("@/server/auth/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/auth/session")>()),
  getSession: vi.fn(async () => auth.session),
  requireFreshSession: vi.fn(async () => auth.session),
  requireUser: vi.fn(async () => auth.inviteUser)
}));
vi.mock("@/server/auth/context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/auth/context")>()),
  getEffectiveHouseholdContext: vi.fn(async () => auth.context)
}));

import { prisma } from "@/lib/db/prisma";
import { abandonAccountAppearanceBrowserOperation, issueAccountAppearanceBrowserOperation, submitAccountAppearanceBrowserOperation } from "@/server/services/account-appearance";
import { getAccountBrowserOperationStatus } from "@/server/services/account-browser-operation-status";
import { getHouseholdBrowserOperationStatus } from "@/server/services/browser-operation-status";
import { abandonHouseholdBrowserOperation } from "@/server/services/browser-operations";
import { leaveHousehold } from "@/server/services/household-leave";
import { acceptInvite, BULK_INVITE_REVOKE_ACKNOWLEDGEMENT, createInvite, hashInviteToken, revokeAllPendingInvites, revokeInvite, suspendMember } from "@/server/services/invites";
import { PLATFORM_SIGNUP_POLICY_LOCK_ID } from "@/server/services/platform-constants";
import { runBrowserOperationRetention } from "@/server/services/browser-operation-retention";

const householdOperationId = "bmo_00000000000000000000000011";
const accountOperationId = "bmo_00000000000000000000000012";
const fingerprint = "a".repeat(64);

async function waitForLockWaiters(observer: PrismaClient, minimum: number) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const rows = await observer.$queryRaw<Array<{ count: bigint }>>`SELECT COUNT(*)::bigint AS count FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    if ((rows[0]?.count ?? 0n) >= BigInt(minimum)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("dec407_lock_waiters_not_observed");
}

beforeAll(async () => {
  await prisma.user.createMany({
    data: [
      { id: "dec-u1", name: "Owner", email: "dec-owner@acceptance.invalid", emailVerified: true },
      { id: "dec-u2", name: "Hostile", email: "dec-hostile@acceptance.invalid", emailVerified: true }
    ]
  });
  await prisma.household.create({ data: { id: "dec-h1", name: "DEC407 Synthetic Household", createdByUserId: "dec-u1" } });
  await prisma.householdMember.createMany({
    data: [
      { id: "dec-m1", householdId: "dec-h1", userId: "dec-u1", role: "owner" },
      { id: "dec-m2", householdId: "dec-h1", userId: "dec-u2", role: "parent" }
    ]
  });
  await prisma.session.createMany({
    data: [
      { id: "dec-s1", token: "dec-session-owner", userId: "dec-u1", expiresAt: new Date("2030-01-01T00:00:00Z") },
      { id: "dec-s1-other", token: "dec-session-owner-other", userId: "dec-u1", expiresAt: new Date("2030-01-01T00:00:00Z") },
      { id: "dec-s2", token: "dec-session-hostile", userId: "dec-u2", expiresAt: new Date("2030-01-01T00:00:00Z") }
    ]
  });
  await prisma.browserOperationBinding.create({
    data: {
      id: "dec-hb1", sessionId: "dec-s1", actorUserId: "dec-u1", actorMemberId: "dec-m1", householdId: "dec-h1",
      operationId: householdOperationId, operationKey: "settingsUnitsUpdate", openingFingerprint: fingerprint,
      persistenceVersion: 2, targetKind: "settings", targetSnapshot: {}, protocolVersion: "browserV2",
      expiresAt: new Date("2027-01-01T00:00:00Z")
    }
  });
  await prisma.accountOperationBinding.create({
    data: {
      id: "dec-ab1", sessionId: "dec-s1", userId: "dec-u1", operationId: accountOperationId,
      operationKey: "accountAppearanceUpdate", openingFingerprint: fingerprint, persistenceVersion: 2,
      targetSnapshot: {}, protocolVersion: "browserV2", expiresAt: new Date("2027-01-01T00:00:00Z")
    }
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("DEC-PROD-407 real PostgreSQL service acceptance", () => {
  it("makes an abandoned household reservation owner-visible and hostile-member neutral through real transactions", async () => {
    auth.session = { user: { id: "dec-u1" }, session: { id: "dec-s1" } };
    auth.context = { userId: "dec-u1", householdId: "dec-h1", memberId: "dec-m1", role: "owner" };

    await expect(abandonHouseholdBrowserOperation({
      ctx: { ...auth.context, sessionId: "dec-s1" }, operationId: householdOperationId
    })).resolves.toEqual({ status: "expired", operationId: householdOperationId, code: "operation_abandoned" });
    await expect(getHouseholdBrowserOperationStatus(householdOperationId)).resolves.toEqual({
      status: "expired", operationId: householdOperationId, code: "operation_abandoned"
    });
    expect(await prisma.browserOperationBinding.count({ where: { householdId: "dec-h1", operationId: householdOperationId } })).toBe(0);
    expect(await prisma.browserOperationReservationTombstone.count({ where: { householdId: "dec-h1", operationId: householdOperationId, terminalCode: "operation_abandoned" } })).toBe(1);

    auth.session = { user: { id: "dec-u1" }, session: { id: "dec-s1-other" } };
    await expect(getHouseholdBrowserOperationStatus(householdOperationId)).rejects.toThrow("not_found");

    auth.session = { user: { id: "dec-u2" }, session: { id: "dec-s2" } };
    auth.context = { userId: "dec-u2", householdId: "dec-h1", memberId: "dec-m2", role: "parent" };
    await expect(getHouseholdBrowserOperationStatus(householdOperationId)).rejects.toThrow("not_found");
  });

  it("persists a completed account appearance operation through the real PostgreSQL terminal constraint", async () => {
    auth.session = { user: { id: "dec-u1" }, session: { id: "dec-s1" } };
    const issued = await issueAccountAppearanceBrowserOperation({});
    expect(issued.status).toBe("open");
    const result = await submitAccountAppearanceBrowserOperation({ operationId: issued.operationId, appearanceMode: "dark" });
    expect(result).toMatchObject({ status: "completed", operationId: issued.operationId, outcome: { appearanceMode: "dark" } });
    expect(await prisma.accountMutationOperation.findUniqueOrThrow({
      where: { userId_operationId: { userId: "dec-u1", operationId: issued.operationId } },
      select: { status: true, outcomeVersion: true, outcomeKind: true, outcomeCode: true, terminalAt: true }
    })).toMatchObject({ status: "completed", outcomeVersion: 2, outcomeKind: "account_appearance", outcomeCode: "ok", terminalAt: expect.any(Date) });
  });

  it("retries concurrent account submits across Serializable User contention", async () => {
    auth.session = { user: { id: "dec-u1" }, session: { id: "dec-s1" } };
    const first = await issueAccountAppearanceBrowserOperation({});
    const second = await issueAccountAppearanceBrowserOperation({});
    const observer = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
    let releaseBarrier: (() => void) | undefined;
    const release = new Promise<void>((resolve) => { releaseBarrier = resolve; });
    let readyBarrier: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => { readyBarrier = resolve; });
    const barrier = observer.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${"dec-u1"} FOR UPDATE`;
      readyBarrier?.();
      await release;
    }, { isolationLevel: "Serializable" });
    await ready;
    const firstSubmit = submitAccountAppearanceBrowserOperation({ operationId: first.operationId, appearanceMode: "light" });
    const secondSubmit = submitAccountAppearanceBrowserOperation({ operationId: second.operationId, appearanceMode: "system" });
    try {
      await waitForLockWaiters(observer, 2);
    } finally {
      releaseBarrier?.();
    }
    await barrier;
    const results = await Promise.all([firstSubmit, secondSubmit]);
    await observer.$disconnect();
    expect(results.map((result) => result.status).sort()).toEqual(["completed", "stale"]);
  });

  it("rejects terminal binding state while the linked operation is still non-terminal", async () => {
    const householdId = "bind-terminal-pending-household";
    const householdOp = "bmo_00000000000000000000000023";
    const accountId = "bind-terminal-pending-account";
    const accountOp = "bmo_00000000000000000000000024";
    const fingerprint = "b".repeat(64);
    await prisma.browserOperationBinding.create({ data: {
      id: householdId, sessionId: "dec-s1", actorUserId: "dec-u1", actorMemberId: "dec-m1", householdId: "dec-h1",
      operationId: householdOp, operationKey: BrowserOperationKey.settingsUnitsUpdate, openingFingerprint: fingerprint,
      persistenceVersion: 2, targetKind: BrowserOperationTargetKind.settings, targetSnapshot: {},
      protocolVersion: BrowserOperationProtocolVersion.browserV2, expiresAt: new Date("2030-01-01T00:00:00Z")
    } });
    await prisma.browserMutationOperation.create({ data: {
      bindingId: householdId, householdId: "dec-h1", operationId: householdOp,
      operationKey: BrowserOperationKey.settingsUnitsUpdate, actorUserId: "dec-u1", actorMemberId: "dec-m1", openingFingerprint: fingerprint,
      intentFingerprint: "c".repeat(64), persistenceVersion: 2, targetKind: BrowserOperationTargetKind.settings
    } });
    await prisma.browserOperationBinding.update({ where: { id: householdId }, data: { state: "submitted" } });
    await expect(prisma.$executeRaw`UPDATE "BrowserOperationBinding" SET "state" = 'terminal' WHERE "id" = ${householdId}`).rejects.toThrow(/browser_operation_terminal_without_terminal_operation/);

    await prisma.accountOperationBinding.create({ data: {
      id: accountId, sessionId: "dec-s1", userId: "dec-u1", operationId: accountOp,
      operationKey: AccountOperationKey.accountAppearanceUpdate, openingFingerprint: fingerprint,
      persistenceVersion: 2, targetSnapshot: {}, protocolVersion: BrowserOperationProtocolVersion.browserV2,
      expiresAt: new Date("2030-01-01T00:00:00Z")
    } });
    await prisma.accountMutationOperation.create({ data: {
      bindingId: accountId, userId: "dec-u1", operationId: accountOp,
      operationKey: AccountOperationKey.accountAppearanceUpdate, openingFingerprint: fingerprint,
      intentFingerprint: "d".repeat(64), persistenceVersion: 2
    } });
    await prisma.accountOperationBinding.update({ where: { id: accountId }, data: { state: "submitted" } });
    await expect(prisma.$executeRaw`UPDATE "AccountOperationBinding" SET "state" = 'terminal' WHERE "id" = ${accountId}`).rejects.toThrow(/account_operation_terminal_without_terminal_operation/);
  });

  it("makes an abandoned account reservation owner-visible and hostile-account neutral through real transactions", async () => {
    auth.session = { user: { id: "dec-u1" }, session: { id: "dec-s1" } };
    await expect(abandonAccountAppearanceBrowserOperation({ operationId: accountOperationId })).resolves.toEqual({
      status: "expired", operationId: accountOperationId, code: "operation_abandoned"
    });
    await expect(getAccountBrowserOperationStatus(accountOperationId)).resolves.toEqual({
      status: "expired", operationId: accountOperationId, code: "operation_abandoned"
    });
    expect(await prisma.accountOperationBinding.count({ where: { userId: "dec-u1", operationId: accountOperationId } })).toBe(0);
    expect(await prisma.accountOperationReservationTombstone.count({ where: { userId: "dec-u1", operationId: accountOperationId, terminalCode: "operation_abandoned" } })).toBe(1);

    auth.session = { user: { id: "dec-u1" }, session: { id: "dec-s1-other" } };
    await expect(getAccountBrowserOperationStatus(accountOperationId)).rejects.toThrow("not_found");

    auth.session = { user: { id: "dec-u2" }, session: { id: "dec-s2" } };
    await expect(getAccountBrowserOperationStatus(accountOperationId)).rejects.toThrow("not_found");
  });

  it("serializes real abandon, retention, and status work behind identity locks", async () => {
    const abandonedId = "bmo_00000000000000000000000015";
    const retainedId = "bmo_00000000000000000000000016";
    const now = new Date("2027-03-01T00:00:00Z");
    const observer = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
    let releaseBarrier: (() => void) | undefined;
    const release = new Promise<void>((resolve) => { releaseBarrier = resolve; });
    let barrierReady: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => { barrierReady = resolve; });
    auth.session = { user: { id: "dec-u1" }, session: { id: "dec-s1" } };
    auth.context = { userId: "dec-u1", householdId: "dec-h1", memberId: "dec-m1", role: "owner" };
    await prisma.browserOperationBinding.createMany({ data: [
      { id: "dec-hb-concurrent-a", sessionId: "dec-s1", actorUserId: "dec-u1", actorMemberId: "dec-m1", householdId: "dec-h1", operationId: abandonedId, operationKey: "settingsUnitsUpdate", openingFingerprint: fingerprint, persistenceVersion: 2, targetKind: "settings", targetSnapshot: {}, protocolVersion: "browserV2", expiresAt: new Date("2027-04-01T00:00:00Z") },
      { id: "dec-hb-concurrent-r", sessionId: "dec-s1", actorUserId: "dec-u1", actorMemberId: "dec-m1", householdId: "dec-h1", operationId: retainedId, operationKey: "settingsUnitsUpdate", openingFingerprint: fingerprint, persistenceVersion: 2, targetKind: "settings", targetSnapshot: {}, protocolVersion: "browserV2", expiresAt: new Date("2026-01-01T00:00:00Z") }
    ] });
    const barrier = observer.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT "lock_household_browser_operation_identity"(${"dec-h1"}, ${abandonedId})`;
      await tx.$executeRaw`SELECT "lock_household_browser_operation_identity"(${"dec-h1"}, ${retainedId})`;
      barrierReady?.();
      await release;
    }, { isolationLevel: "Serializable" });
    await ready;
    const abandon = abandonHouseholdBrowserOperation({ ctx: { ...auth.context, sessionId: "dec-s1" }, operationId: abandonedId });
    const retention = runBrowserOperationRetention({ now, batchSize: 10 });
    const status = getHouseholdBrowserOperationStatus(abandonedId);
    await waitForLockWaiters(observer, 3);
    releaseBarrier?.();
    await barrier;
    const [abandoned, retained, concurrentStatus] = await Promise.all([abandon, retention, status]);
    await observer.$disconnect();

    expect(abandoned).toEqual({ status: "expired", operationId: abandonedId, code: "operation_abandoned" });
    expect(retained.household.deletedBindingCount).toBe(1);
    expect(["prepared", "expired"]).toContain(concurrentStatus.status);
    await expect(getHouseholdBrowserOperationStatus(abandonedId)).resolves.toEqual({ status: "expired", operationId: abandonedId, code: "operation_abandoned" });
    expect(await prisma.browserOperationReservationTombstone.count({ where: { householdId: "dec-h1", operationId: abandonedId, terminalCode: "operation_abandoned" } })).toBe(1);
    expect(await prisma.browserOperationReservationTombstone.count({ where: { householdId: "dec-h1", operationId: retainedId, terminalCode: "operation_result_expired" } })).toBe(1);
  });

  it("rejects hostile direct-SQL reservation tombstones unless every binding authority field matches", async () => {
    const householdId = "bmo_00000000000000000000000017";
    const accountId = "bmo_00000000000000000000000018";
    const issuedAt = new Date("2026-08-19T12:00:00Z");
    await prisma.browserOperationBinding.create({ data: {
      id: "dec-hb-forgery", sessionId: "dec-s1", actorUserId: "dec-u1", actorMemberId: "dec-m1", householdId: "dec-h1",
      operationId: householdId, operationKey: "settingsUnitsUpdate", openingFingerprint: fingerprint, persistenceVersion: 2,
      targetKind: "settings", targetSnapshot: {}, protocolVersion: "browserV2", expiresAt: new Date("2030-01-01T00:00:00Z"), issuedAt
    } });
    await prisma.accountOperationBinding.create({ data: {
      id: "dec-ab-forgery", sessionId: "dec-s1", userId: "dec-u1", operationId: accountId,
      operationKey: "accountAppearanceUpdate", openingFingerprint: fingerprint, persistenceVersion: 2,
      targetSnapshot: {}, protocolVersion: "browserV2", expiresAt: new Date("2030-01-01T00:00:00Z"), issuedAt
    } });

    const householdForgeries = [
      { householdId: "dec-foreign-household", operationKey: "settings.units.update", sessionId: "dec-s1", actorUserId: "dec-u1", actorMemberId: "dec-m1", openingFingerprint: fingerprint, createdAt: issuedAt },
      { householdId: "dec-h1", operationKey: "household.accent.update", sessionId: "dec-s1", actorUserId: "dec-u1", actorMemberId: "dec-m1", openingFingerprint: fingerprint, createdAt: issuedAt },
      { householdId: "dec-h1", operationKey: "settings.units.update", sessionId: "dec-s1-other", actorUserId: "dec-u1", actorMemberId: "dec-m1", openingFingerprint: fingerprint, createdAt: issuedAt },
      { householdId: "dec-h1", operationKey: "settings.units.update", sessionId: "dec-s1", actorUserId: "dec-u2", actorMemberId: "dec-m1", openingFingerprint: fingerprint, createdAt: issuedAt },
      { householdId: "dec-h1", operationKey: "settings.units.update", sessionId: "dec-s1", actorUserId: "dec-u1", actorMemberId: "dec-m2", openingFingerprint: fingerprint, createdAt: issuedAt },
      { householdId: "dec-h1", operationKey: "settings.units.update", sessionId: "dec-s1", actorUserId: "dec-u1", actorMemberId: "dec-m1", openingFingerprint: "b".repeat(64), createdAt: issuedAt },
      { householdId: "dec-h1", operationKey: "settings.units.update", sessionId: "dec-s1", actorUserId: "dec-u1", actorMemberId: "dec-m1", openingFingerprint: fingerprint, createdAt: new Date(issuedAt.getTime() + 1) }
    ];
    for (const forged of householdForgeries) {
      await expect(prisma.$executeRaw`
        INSERT INTO "BrowserOperationReservationTombstone"
          ("householdId", "operationId", "operationKey", "sessionId", "actorUserId", "actorMemberId", "openingFingerprint", "terminalCode", "createdAt", "terminalAt")
        VALUES
          (${forged.householdId}, ${householdId}, ${forged.operationKey}::"BrowserOperationKey", ${forged.sessionId}, ${forged.actorUserId}, ${forged.actorMemberId}, ${forged.openingFingerprint}, 'operation_abandoned', ${forged.createdAt}, NOW())
      `).rejects.toThrow("browser_operation_reservation_tombstone_binding_mismatch");
    }

    const accountForgeries = [
      { userId: "dec-u2", operationKey: "account.appearance.update", sessionId: "dec-s1", openingFingerprint: fingerprint, createdAt: issuedAt },
      { userId: "dec-u1", operationKey: "account.appearance.update", sessionId: "dec-s1-other", openingFingerprint: fingerprint, createdAt: issuedAt },
      { userId: "dec-u1", operationKey: "account.appearance.update", sessionId: "dec-s1", openingFingerprint: "b".repeat(64), createdAt: issuedAt },
      { userId: "dec-u1", operationKey: "account.appearance.update", sessionId: "dec-s1", openingFingerprint: fingerprint, createdAt: new Date(issuedAt.getTime() + 1) }
    ];
    for (const forged of accountForgeries) {
      await expect(prisma.$executeRaw`
        INSERT INTO "AccountOperationReservationTombstone"
          ("userId", "operationId", "operationKey", "sessionId", "openingFingerprint", "terminalCode", "createdAt", "terminalAt")
        VALUES
          (${forged.userId}, ${accountId}, ${forged.operationKey}::"AccountOperationKey", ${forged.sessionId}, ${forged.openingFingerprint}, 'operation_abandoned', ${forged.createdAt}, NOW())
      `).rejects.toThrow("account_operation_reservation_tombstone_binding_mismatch");
    }
  });

  it("serializes invite acceptance and revocation at the shared platform boundary", async () => {
    const observer = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
    const rawToken = "dec407-invite-token";
    await prisma.invite.create({ data: {
      id: "dec-invite-race", householdId: "dec-h1", email: "dec-hostile@acceptance.invalid", role: "parent",
      tokenHash: hashInviteToken(rawToken), invitedByUserId: "dec-u1", expiresAt: new Date("2030-01-01T00:00:00Z")
    } });
    auth.context = { userId: "dec-u1", householdId: "dec-h1", memberId: "dec-m1", role: "owner" };
    let releaseBarrier: (() => void) | undefined;
    const release = new Promise<void>((resolve) => { releaseBarrier = resolve; });
    let readyBarrier: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => { readyBarrier = resolve; });
    const barrier = observer.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PLATFORM_SIGNUP_POLICY_LOCK_ID})`;
      readyBarrier?.();
      await release;
    });
    await ready;
    const acceptance = acceptInvite(rawToken);
    const revocation = revokeInvite("dec-invite-race");
    await waitForLockWaiters(observer, 2);
    releaseBarrier?.();
    await barrier;
    const outcomes = await Promise.allSettled([acceptance, revocation]);
    await observer.$disconnect();
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(["accepted", "revoked"]).toContain((await prisma.invite.findUniqueOrThrow({ where: { id: "dec-invite-race" } })).status);
    expect(await prisma.auditEvent.count({ where: { householdId: "dec-h1", entityType: "invite", entityId: "dec-invite-race", action: { in: ["invite.accept", "invite.revoke"] } } })).toBe(1);
  });

  it("serializes status polling with fresh-auth admin invite creation and revoke-all", async () => {
    auth.session = { user: { id: "dec-u1" }, session: { id: "dec-s1" } };
    auth.context = { userId: "dec-u1", householdId: "dec-h1", memberId: "dec-m1", role: "owner" };

    async function contend(operationId: string, mutation: () => Promise<unknown>) {
      await prisma.browserOperationBinding.create({ data: {
        id: `dec-hb-${operationId.slice(-4)}`, sessionId: "dec-s1", actorUserId: "dec-u1", actorMemberId: "dec-m1", householdId: "dec-h1",
        operationId, operationKey: BrowserOperationKey.settingsUnitsUpdate, openingFingerprint: fingerprint, persistenceVersion: 2,
        targetKind: BrowserOperationTargetKind.settings, targetSnapshot: {}, protocolVersion: BrowserOperationProtocolVersion.browserV2,
        expiresAt: new Date("2030-01-01T00:00:00Z")
      } });
      const observer = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
      let releaseBarrier: (() => void) | undefined;
      const release = new Promise<void>((resolve) => { releaseBarrier = resolve; });
      let readyBarrier: (() => void) | undefined;
      const ready = new Promise<void>((resolve) => { readyBarrier = resolve; });
      const barrier = observer.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Session" WHERE "id" = ${"dec-s1"} FOR UPDATE`;
        readyBarrier?.();
        await release;
      });
      await ready;
      const status = getHouseholdBrowserOperationStatus(operationId);
      await waitForLockWaiters(observer, 1);
      const mutationResult = mutation();
      try {
        await waitForLockWaiters(observer, 2);
      } finally {
        releaseBarrier?.();
      }
      await barrier;
      const outcomes = await Promise.allSettled([status, mutationResult]);
      await observer.$disconnect();
      for (const outcome of outcomes) {
        if (outcome.status === "rejected") expect(String(outcome.reason)).not.toMatch(/40P01|deadlock detected/i);
      }
      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(2);
    }

    await contend("bmo_00000000000000000000000028", () => createInvite({
      email: "dec-admin-invite@acceptance.invalid", role: "admin"
    }));
    await contend("bmo_00000000000000000000000029", () => revokeAllPendingInvites({
      acknowledgement: BULK_INVITE_REVOKE_ACKNOWLEDGEMENT
    }));
  });

  it("writes scope-owned expiry tombstones before real retention deletes expired reservations", async () => {
    const householdExpiryId = "bmo_00000000000000000000000013";
    const accountExpiryId = "bmo_00000000000000000000000014";
    const now = new Date("2027-01-01T00:00:00Z");
    auth.session = { user: { id: "dec-u1" }, session: { id: "dec-s1" } };
    auth.context = { userId: "dec-u1", householdId: "dec-h1", memberId: "dec-m1", role: "owner" };
    await prisma.browserOperationBinding.create({ data: {
      id: "dec-hb-retention", sessionId: "dec-s1", actorUserId: "dec-u1", actorMemberId: "dec-m1", householdId: "dec-h1",
      operationId: householdExpiryId, operationKey: "settingsUnitsUpdate", openingFingerprint: fingerprint, persistenceVersion: 2,
      targetKind: "settings", targetSnapshot: {}, protocolVersion: "browserV2", expiresAt: new Date("2026-01-01T00:00:00Z")
    } });
    await prisma.accountOperationBinding.create({ data: {
      id: "dec-ab-retention", sessionId: "dec-s1", userId: "dec-u1", operationId: accountExpiryId,
      operationKey: "accountAppearanceUpdate", openingFingerprint: fingerprint, persistenceVersion: 2,
      targetSnapshot: {}, protocolVersion: "browserV2", expiresAt: new Date("2026-01-01T00:00:00Z")
    } });
    const legacyOperationId = "bmo_00000000000000000000000025";
    await prisma.browserOperationBinding.create({ data: {
      id: "dec-hb-retention-v1", sessionId: "dec-s1", actorUserId: "dec-u1", actorMemberId: "dec-m1", householdId: "dec-h1",
      operationId: legacyOperationId, operationKey: "calendarEventCreate", legacyIntentFingerprint: "e".repeat(64),
      persistenceVersion: 1, protocolVersion: "browserV1", expiresAt: new Date("2026-01-01T00:00:00Z")
    } });

    await expect(runBrowserOperationRetention({ now, batchSize: 10 })).resolves.toMatchObject({
      household: { deletedBindingCount: 1 }, account: { deletedBindingCount: 1 }
    });
    await expect(getHouseholdBrowserOperationStatus(householdExpiryId)).resolves.toEqual({
      status: "expired", operationId: householdExpiryId, code: "operation_result_expired"
    });
    await expect(getAccountBrowserOperationStatus(accountExpiryId)).resolves.toEqual({
      status: "expired", operationId: accountExpiryId, code: "operation_result_expired"
    });
    expect(await prisma.browserOperationReservationTombstone.count({ where: { householdId: "dec-h1", operationId: householdExpiryId, terminalCode: "operation_result_expired" } })).toBe(1);
    expect(await prisma.accountOperationReservationTombstone.count({ where: { userId: "dec-u1", operationId: accountExpiryId, terminalCode: "operation_result_expired" } })).toBe(1);
    await expect(prisma.browserOperationBinding.findUnique({ where: { id: "dec-hb-retention-v1" } })).resolves.toMatchObject({
      operationId: legacyOperationId, persistenceVersion: 1, openingFingerprint: null, state: "open"
    });
  });

  it("serializes forced suspension and target browser status without a session-member deadlock", async () => {
    const operationId = "bmo_00000000000000000000000027";
    await prisma.user.create({ data: { id: "dec-u3", name: "Target", email: "dec-target@acceptance.invalid", emailVerified: true } });
    await prisma.householdMember.create({ data: { id: "dec-m3", householdId: "dec-h1", userId: "dec-u3", role: "parent" } });
    await prisma.session.create({ data: { id: "dec-s3", token: "dec-session-target", userId: "dec-u3", expiresAt: new Date("2030-01-01T00:00:00Z") } });
    await prisma.browserOperationBinding.create({ data: {
      id: "dec-hb-suspend-order", sessionId: "dec-s3", actorUserId: "dec-u3", actorMemberId: "dec-m3", householdId: "dec-h1",
      operationId, operationKey: BrowserOperationKey.settingsUnitsUpdate, openingFingerprint: fingerprint, persistenceVersion: 2,
      targetKind: BrowserOperationTargetKind.settings, targetSnapshot: {}, protocolVersion: BrowserOperationProtocolVersion.browserV2,
      expiresAt: new Date("2030-01-01T00:00:00Z")
    } });
    const observer = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
    let releaseBarrier: (() => void) | undefined;
    const release = new Promise<void>((resolve) => { releaseBarrier = resolve; });
    let readyBarrier: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => { readyBarrier = resolve; });
    const barrier = observer.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Session" WHERE "id" = ${"dec-s3"} FOR UPDATE`;
      readyBarrier?.();
      await release;
    });
    await ready;
    auth.session = { user: { id: "dec-u3" }, session: { id: "dec-s3" } };
    auth.context = { userId: "dec-u3", householdId: "dec-h1", memberId: "dec-m3", role: "parent" };
    const status = getHouseholdBrowserOperationStatus(operationId);
    await waitForLockWaiters(observer, 1);
    auth.session = { user: { id: "dec-u1" }, session: { id: "dec-s1" } };
    auth.context = { userId: "dec-u1", householdId: "dec-h1", memberId: "dec-m1", role: "owner" };
    const suspension = suspendMember("dec-m3");
    try {
      await waitForLockWaiters(observer, 2);
    } finally {
      releaseBarrier?.();
    }
    await barrier;
    const outcomes = await Promise.allSettled([status, suspension]);
    await observer.$disconnect();
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") expect(String(outcome.reason)).not.toMatch(/40P01|deadlock detected/i);
    }
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(2);
  });

  it("serializes household leave and browser status in canonical Session-before-member order", async () => {
    const operationId = "bmo_00000000000000000000000026";
    auth.session = { user: { id: "dec-u2" }, session: { id: "dec-s2" } };
    auth.context = { userId: "dec-u2", householdId: "dec-h1", memberId: "dec-m2", role: "parent" };
    await prisma.browserOperationBinding.create({ data: {
      id: "dec-hb-leave-order", sessionId: "dec-s2", actorUserId: "dec-u2", actorMemberId: "dec-m2", householdId: "dec-h1",
      operationId, operationKey: BrowserOperationKey.settingsUnitsUpdate, openingFingerprint: fingerprint, persistenceVersion: 2,
      targetKind: BrowserOperationTargetKind.settings, targetSnapshot: {}, protocolVersion: BrowserOperationProtocolVersion.browserV2,
      expiresAt: new Date("2030-01-01T00:00:00Z")
    } });
    const observer = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
    let releaseBarrier: (() => void) | undefined;
    const release = new Promise<void>((resolve) => { releaseBarrier = resolve; });
    let readyBarrier: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => { readyBarrier = resolve; });
    const barrier = observer.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Session" WHERE "id" = ${"dec-s2"} FOR UPDATE`;
      readyBarrier?.();
      await release;
    });
    await ready;
    const status = getHouseholdBrowserOperationStatus(operationId);
    const leave = leaveHousehold({
      householdId: "dec-h1", confirmation: "DEC407 Synthetic Household", operationId: "99999999-9999-4999-8999-999999999999"
    });
    try {
      await waitForLockWaiters(observer, 2);
    } finally {
      releaseBarrier?.();
    }
    await barrier;
    const outcomes = await Promise.allSettled([status, leave]);
    await observer.$disconnect();
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") {
        const text = String(outcome.reason);
        expect(text).not.toMatch(/40P01|deadlock detected/i);
      }
    }
    expect(outcomes.some((outcome) => outcome.status === "fulfilled")).toBe(true);
  });
});
