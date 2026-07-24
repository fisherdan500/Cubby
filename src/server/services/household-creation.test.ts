import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  memberFindMany: vi.fn(),
  householdCreate: vi.fn(),
  getAppRegistrationPolicy: vi.fn(),
  transaction: vi.fn(),
  executeRaw: vi.fn(),
  queryRaw: vi.fn(),
  lockHouseholdCreation: vi.fn()
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
vi.mock("@/server/auth/context", () => ({ getHouseholdContext: vi.fn(), requirePermission: vi.fn() }));
vi.mock("@/server/services/audit", () => ({ writeAudit: vi.fn() }));
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
  mocks.householdCreate.mockResolvedValue({ id: "household-new", name: "River Home" });
});

describe("platform-governed household creation", () => {
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

  it("creates a first household only when the platform policy is open", async () => {
    await expect(createOnboardingHousehold(input)).resolves.toMatchObject({ id: "household-new" });

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
        settings: {
          create: {
            allowPublicRegistration: false,
            allowNewHouseholdCreation: false
          }
        }
      }),
      include: { settings: true }
    });
  });

  it("never uses open platform policy to create a second household for an existing member", async () => {
    mocks.memberFindMany.mockResolvedValue([
      { household: { id: "existing-household", name: "Existing Home" } }
    ]);

    await expect(createOnboardingHousehold(input)).resolves.toEqual({
      id: "existing-household",
      name: "Existing Home"
    });
    expect(mocks.getAppRegistrationPolicy).not.toHaveBeenCalled();
    expect(mocks.householdCreate).not.toHaveBeenCalled();
  });
});
