import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  memberFindMany: vi.fn(),
  householdCreate: vi.fn(),
  getAppRegistrationPolicy: vi.fn(),
  transaction: vi.fn(),
  executeRaw: vi.fn(),
  queryRaw: vi.fn(),
  lockHouseholdCreation: vi.fn(),
  writeAudit: vi.fn()
}));

vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    householdMember: { findMany: mocks.memberFindMany },
    household: { create: mocks.householdCreate },
    $transaction: mocks.transaction
  }
}));
vi.mock("@/lib/env", () => ({ env: { APP_TIMEZONE: "America/New_York" } }));
vi.mock("@/server/auth/session", () => ({ requireUser: mocks.requireUser }));
vi.mock("@/server/auth/context", () => ({ getEffectiveHouseholdContext: vi.fn(), requirePermission: vi.fn() }));
vi.mock("@/server/services/audit", () => ({ writeAudit: mocks.writeAudit }));
vi.mock("@/server/services/mutation-locks", () => ({
  lockActorAndBabyForWrite: vi.fn(),
  lockHouseholdCreation: mocks.lockHouseholdCreation
}));
vi.mock("@/server/services/registration", () => ({
  getAppRegistrationPolicy: mocks.getAppRegistrationPolicy
}));

import { createOnboardingHousehold } from "@/server/services/households";

const input = { householdName: "River Home", babyName: "Avery" };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.transaction.mockImplementation(async (operation: (tx: unknown) => unknown) =>
    operation({
      $executeRaw: mocks.executeRaw,
      $queryRaw: mocks.queryRaw,
      householdMember: { findMany: mocks.memberFindMany },
      household: { create: mocks.householdCreate }
    })
  );
  mocks.executeRaw.mockResolvedValue(1);
  mocks.queryRaw.mockResolvedValue([{ id: "platform" }]);
  mocks.requireUser.mockResolvedValue({
    id: "user-without-household",
    name: "Parent",
    email: "parent@example.test",
    emailVerified: true
  });
  mocks.memberFindMany.mockResolvedValue([]);
  mocks.getAppRegistrationPolicy.mockResolvedValue({
    platformOwnerBound: true,
    householdCreationMode: "open",
    newHouseholdCreationAllowed: true
  });
  mocks.householdCreate.mockResolvedValue({
    id: "household-new",
    name: "River Home",
    members: [{ id: "member-new" }],
    babies: [{ id: "baby-new" }]
  });
});

describe("platform-governed household creation", () => {
  it("requires sign-in for restore before opening a transaction", async () => {
    mocks.requireUser.mockRejectedValue(new Error("unauthenticated"));
    await expect(createOnboardingHousehold({ mode: "restore", householdName: "Recovery" })).rejects.toThrow("unauthenticated");
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("writes exactly one real audit event and integrity checkpoint in the target creation transaction", async () => {
    const { writeAudit } = await vi.importActual<typeof import("@/server/services/audit")>("@/server/services/audit");
    mocks.writeAudit.mockImplementation(writeAudit);
    mocks.queryRaw.mockResolvedValue([{ ownerUserId: "user-without-household" }]);
    mocks.householdCreate.mockResolvedValue({ id: "household-new", members: [{ id: "member-new" }], babies: [] });
    const auditCreate = vi.fn().mockResolvedValue({});
    const checkpoint = vi.fn().mockResolvedValue({});
    const tx = {
      $executeRaw: mocks.executeRaw,
      $queryRaw: mocks.queryRaw,
      householdMember: { findMany: mocks.memberFindMany },
      household: { create: mocks.householdCreate },
      auditEvent: { create: auditCreate, count: vi.fn().mockResolvedValueOnce(0).mockResolvedValueOnce(1), findFirst: vi.fn().mockResolvedValue(null) },
      auditIntegrityCheckpoint: { upsert: checkpoint }
    };
    mocks.transaction.mockImplementation(async (operation) => operation(tx));
    await createOnboardingHousehold({ mode: "restore", householdName: "Recovery" });
    expect(auditCreate).toHaveBeenCalledOnce();
    expect(auditCreate).toHaveBeenCalledWith({ data: expect.objectContaining({
      action: "household.create", actorUserId: "user-without-household", actorMemberId: "member-new", chainOrder: 1
    }) });
    expect(checkpoint).toHaveBeenCalledOnce();
    expect(checkpoint).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ scope: "household:household-new", eventCount: 1, headHash: auditCreate.mock.calls[0][0].data.eventHash })
    }));
  });

  it.each([{ rows: [] }, { rows: [{ ownerUserId: "another-owner" }] }])("refuses missing or changed platform authority %j", async ({ rows }) => {
    mocks.queryRaw.mockResolvedValue(rows);
    await expect(createOnboardingHousehold({ mode: "restore", householdName: "Recovery" })).rejects.toThrow("forbidden");
    expect(mocks.queryRaw).toHaveBeenCalledOnce();
    expect(mocks.getAppRegistrationPolicy).not.toHaveBeenCalled();
    expect(mocks.householdCreate).not.toHaveBeenCalled();
  });

  it("requires verification for restore before opening a transaction", async () => {
    mocks.requireUser.mockResolvedValue({ id: "owner", emailVerified: false });
    await expect(createOnboardingHousehold({ mode: "restore", householdName: "Recovery" })).rejects.toThrow("email_not_verified");
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("refuses restore for every suspended membership, including a suspended owner", async () => {
    mocks.memberFindMany.mockResolvedValue([{ role: "owner", disabledAt: new Date(), household: { id: "other" } }]);
    await expect(createOnboardingHousehold({ mode: "restore", householdName: "Recovery" }))
      .rejects.toThrow("suspended_membership_must_leave");
    expect(mocks.householdCreate).not.toHaveBeenCalled();
  });

  it.each(["closed", "invitation_only"])("refuses restore when policy is %s", async (mode) => {
    mocks.queryRaw.mockResolvedValue([{ ownerUserId: "user-without-household" }]);
    mocks.getAppRegistrationPolicy.mockResolvedValue({ newHouseholdCreationAllowed: false, householdCreationMode: mode });
    await expect(createOnboardingHousehold({ mode: "restore", householdName: "Recovery" })).rejects.toThrow("forbidden");
    expect(mocks.householdCreate).not.toHaveBeenCalled();
  });

  it.each([
    { mode: "unknown", ...input },
    { mode: "restore", householdName: "Recovery", babyName: "Baby" },
    { mode: "restore", householdName: "Recovery", extra: true },
    { mode: "restore", householdName: " " },
    { mode: "restore", householdName: "a".repeat(81) }
  ])("rejects invalid restore requests before a transaction: %j", async (raw) => {
    await expect(createOnboardingHousehold(raw)).rejects.toThrow();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it.each([
    input,
    { mode: "restore" as const, householdName: "Recovery" }
  ])("serializes membership lifecycle changes before checking current memberships: %j", async (raw) => {
    mocks.queryRaw.mockResolvedValue([{ id: "platform", ownerUserId: "user-without-household" }]);
    if ("mode" in raw) {
      mocks.householdCreate.mockResolvedValue({ id: "household-new", members: [{ id: "member-new" }], babies: [] });
    }

    await createOnboardingHousehold(raw);

    expect(mocks.executeRaw).toHaveBeenCalledOnce();
    expect(mocks.executeRaw.mock.calls[0][0].join("?")).toMatch(/pg_advisory_xact_lock/);
    expect(mocks.lockHouseholdCreation.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.executeRaw.mock.invocationCallOrder[0]
    );
    expect(mocks.executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.memberFindMany.mock.invocationCallOrder[0]
    );
  });

  it("serializes racing restore requests before membership reads and creates at most one target", async () => {
    let release: () => void = () => {};
    let tail = Promise.resolve();
    let created = false;
    mocks.lockHouseholdCreation.mockImplementation(async () => {
      const previous = tail;
      tail = new Promise<void>((resolve) => { release = resolve; });
      const unlock = release;
      await previous;
      return unlock;
    });
    // Model a transaction-scoped advisory lock, released at commit or rollback.
    mocks.transaction.mockImplementation(async (operation) => {
      let unlock = () => {};
      const tx = {
        $executeRaw: mocks.executeRaw,
        $queryRaw: mocks.queryRaw,
        householdMember: { findMany: mocks.memberFindMany },
        household: { create: mocks.householdCreate }
      };
      const lock = mocks.lockHouseholdCreation.getMockImplementation()!;
      mocks.lockHouseholdCreation.mockImplementationOnce(async () => { unlock = await lock(); });
      try { return await operation(tx); } finally { unlock(); }
    });
    mocks.queryRaw.mockResolvedValue([{ ownerUserId: "user-without-household" }]);
    mocks.memberFindMany.mockImplementation(async () => created ? [{ disabledAt: null, household: { id: "household-new" } }] : []);
    mocks.householdCreate.mockImplementation(async () => {
      created = true;
      return { id: "household-new", members: [{ id: "member-new" }], babies: [] };
    });
    const results = await Promise.allSettled([
      createOnboardingHousehold({ mode: "restore", householdName: "First" }),
      createOnboardingHousehold({ mode: "restore", householdName: "Second" })
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(mocks.householdCreate).toHaveBeenCalledOnce();
    expect(mocks.writeAudit).toHaveBeenCalledOnce();
    expect(mocks.lockHouseholdCreation).toHaveBeenCalledTimes(2);
    expect(mocks.memberFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: "user-without-household", deletedAt: null, household: { deletedAt: null } }
    }));
  });

  it("refuses an active membership instead of returning an unrelated restore target", async () => {
    mocks.memberFindMany.mockResolvedValue([{ disabledAt: null, household: { id: "other-household" } }]);
    await expect(createOnboardingHousehold({ mode: "restore", householdName: "Recovery" })).rejects.toThrow("forbidden");
    expect(mocks.householdCreate).not.toHaveBeenCalled();
    expect(mocks.writeAudit).not.toHaveBeenCalled();
  });

  it("creates an empty restore target with one owner, settings, and one household audit", async () => {
    mocks.queryRaw.mockResolvedValue([{ id: "platform", ownerUserId: "user-without-household" }]);
    mocks.householdCreate.mockResolvedValue({ id: "household-new", members: [{ id: "member-new" }], babies: [] });

    await expect(createOnboardingHousehold({ mode: "restore", householdName: "Recovery Home" }))
      .resolves.toEqual({ household: { id: "household-new" }, memberId: "member-new" });

    expect(mocks.transaction).toHaveBeenCalledOnce();
    expect(mocks.householdCreate).toHaveBeenCalledOnce();
    const data = mocks.householdCreate.mock.calls[0][0].data;
    expect(data).toMatchObject({
      name: "Recovery Home",
      members: { create: { userId: "user-without-household", role: "owner" } },
      settings: { create: { allowPublicRegistration: false, allowNewHouseholdCreation: false } }
    });
    expect(data).not.toHaveProperty("babies");
    expect(mocks.writeAudit).toHaveBeenCalledOnce();
    expect(mocks.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ householdId: "household-new", memberId: "member-new" }),
      expect.objectContaining({ action: "household.create" }),
      expect.anything()
    );
    expect(mocks.queryRaw.mock.calls[0][0].join("?")).toMatch(/PlatformAuthority[\s\S]*FOR SHARE/);
    expect(mocks.queryRaw.mock.calls[1][0].join("?")).toMatch(/PlatformSettings[\s\S]*FOR SHARE/);
    expect(mocks.lockHouseholdCreation.mock.invocationCallOrder[0]).toBeLessThan(mocks.memberFindMany.mock.invocationCallOrder[0]);
    expect(mocks.queryRaw.mock.invocationCallOrder[1]).toBeLessThan(mocks.getAppRegistrationPolicy.mock.invocationCallOrder[0]);
    expect(mocks.getAppRegistrationPolicy).toHaveBeenCalledWith(expect.objectContaining({ household: expect.anything() }));
  });

  it("requires a verified account before consulting creation policy", async () => {
    mocks.requireUser.mockResolvedValue({
      id: "unverified-user",
      name: "Parent",
      email: "parent@example.test",
      emailVerified: false
    });

    await expect(createOnboardingHousehold(input)).rejects.toThrow("email_not_verified");
    expect(mocks.getAppRegistrationPolicy).not.toHaveBeenCalled();
    expect(mocks.householdCreate).not.toHaveBeenCalled();
  });

  it.each(["closed", "invitation_only"])("blocks direct creation in %s mode", async (mode) => {
    mocks.getAppRegistrationPolicy.mockResolvedValue({
      platformOwnerBound: true,
      householdCreationMode: mode,
      newHouseholdCreationAllowed: false
    });

    await expect(createOnboardingHousehold(input)).rejects.toThrow("forbidden");
    expect(mocks.householdCreate).not.toHaveBeenCalled();
  });

  it("creates a first household and its initial baby only with atomic classified audit evidence", async () => {
    await expect(createOnboardingHousehold(input)).resolves.toEqual({
      household: { id: "household-new", name: "River Home" },
      memberId: "member-new"
    });

    expect(mocks.transaction).toHaveBeenCalledOnce();
    expect(mocks.lockHouseholdCreation).toHaveBeenCalledWith(
      expect.objectContaining({ household: expect.any(Object) })
    );
    expect(mocks.queryRaw).toHaveBeenCalledOnce();
    expect(mocks.lockHouseholdCreation.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.memberFindMany.mock.invocationCallOrder[0]
    );
    expect(mocks.queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.getAppRegistrationPolicy.mock.invocationCallOrder[0]
    );
    expect(mocks.getAppRegistrationPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ householdMember: expect.any(Object), household: expect.any(Object) })
    );
    expect(mocks.householdCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        name: "River Home",
        createdByUserId: "user-without-household",
        babies: { create: { name: "Avery", timezone: "America/New_York" } },
        settings: {
          create: {
            allowPublicRegistration: false,
            allowNewHouseholdCreation: false
          }
        }
      }),
      include: expect.objectContaining({ settings: true })
    });
    expect(mocks.writeAudit).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ householdId: "household-new", userId: "user-without-household" }),
      expect.objectContaining({ action: "household.create", entityType: "household", entityId: "household-new" }),
      expect.anything()
    );
    expect(mocks.writeAudit).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ householdId: "household-new", userId: "user-without-household" }),
      expect.objectContaining({ action: "baby.create", entityType: "baby", entityId: "baby-new", babyId: "baby-new" }),
      expect.anything()
    );
  });

  it("never uses open platform policy to create a second household for an existing member", async () => {
    mocks.memberFindMany.mockResolvedValue([
      { id: "existing-member", household: { id: "existing-household", name: "Existing Home" } }
    ]);

    await expect(createOnboardingHousehold(input)).resolves.toEqual({
      household: { id: "existing-household", name: "Existing Home" },
      memberId: "existing-member"
    });
    expect(mocks.getAppRegistrationPolicy).not.toHaveBeenCalled();
    expect(mocks.householdCreate).not.toHaveBeenCalled();
  });

  it("fails closed rather than creating a household for a suspended-only member", async () => {
    mocks.memberFindMany.mockResolvedValue([
      { disabledAt: new Date("2026-07-30T00:00:00.000Z"), household: { id: "suspended-household", name: "Suspended Home" } }
    ]);

    await expect(createOnboardingHousehold(input)).rejects.toThrow("suspended_membership_must_leave");
    expect(mocks.householdCreate).not.toHaveBeenCalled();
  });
});
