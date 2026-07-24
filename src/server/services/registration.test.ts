import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  platformAuthorityFind: vi.fn(),
  platformSettingsFind: vi.fn(),
  userCount: vi.fn(),
  householdCount: vi.fn(),
  platformAuditEventCount: vi.fn(),
  inviteFind: vi.fn(),
  hashInviteToken: vi.fn((token: string) => `hashed:${token}`),
  env: {
    ENABLE_REGISTRATION: "false"
  }
}));

vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    platformAuthority: { findUnique: mocks.platformAuthorityFind },
    platformSettings: { findUnique: mocks.platformSettingsFind },
    user: { count: mocks.userCount },
    household: { count: mocks.householdCount },
    platformAuditEvent: { count: mocks.platformAuditEventCount },
    invite: { findUnique: mocks.inviteFind }
  }
}));

vi.mock("@/lib/env", () => ({ env: mocks.env, trustedOrigins: () => [] }));
vi.mock("@/server/services/invites", () => ({ hashInviteToken: mocks.hashInviteToken }));
vi.mock("@/server/auth/context", () => ({ getHouseholdContext: vi.fn(), requirePermission: vi.fn() }));
vi.mock("@/server/services/audit", () => ({ writeAudit: vi.fn() }));

import {
  extractInviteToken,
  getAppRegistrationPolicy,
  signupPolicyForRequest
} from "@/server/services/registration";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.env.ENABLE_REGISTRATION = "false";
  mocks.platformAuthorityFind.mockResolvedValue(null);
  mocks.platformSettingsFind.mockResolvedValue(null);
  mocks.userCount.mockResolvedValue(1);
  mocks.householdCount.mockResolvedValue(0);
  mocks.platformAuditEventCount.mockResolvedValue(0);
  mocks.inviteFind.mockResolvedValue(null);
});

describe("platform registration policy", () => {
  it("fails closed when platform authority has not been explicitly bound", async () => {
    mocks.env.ENABLE_REGISTRATION = "true";

    await expect(getAppRegistrationPolicy()).resolves.toEqual({
      platformOwnerBound: false,
      bootstrapAccountAllowed: false,
      publicRegistrationAllowed: false,
      householdCreationMode: "closed",
      newHouseholdCreationAllowed: false
    });
  });

  it("allows one operator-enabled bootstrap account only while the user table is empty", async () => {
    mocks.env.ENABLE_REGISTRATION = "true";
    mocks.userCount.mockResolvedValue(0);

    await expect(getAppRegistrationPolicy()).resolves.toMatchObject({
      platformOwnerBound: false,
      bootstrapAccountAllowed: true,
      publicRegistrationAllowed: false,
      householdCreationMode: "closed",
      newHouseholdCreationAllowed: false
    });
  });

  it.each([
    ["household data", () => mocks.householdCount.mockResolvedValue(1)],
    ["platform audit history", () => mocks.platformAuditEventCount.mockResolvedValue(1)]
  ])("keeps bootstrap closed when userless deployment state still contains %s", async (_label, arrange) => {
    mocks.env.ENABLE_REGISTRATION = "true";
    mocks.userCount.mockResolvedValue(0);
    arrange();

    await expect(getAppRegistrationPolicy()).resolves.toMatchObject({
      platformOwnerBound: false,
      bootstrapAccountAllowed: false
    });
  });

  it("reads public signup and household creation only from bound platform settings", async () => {
    mocks.platformAuthorityFind.mockResolvedValue({ id: "platform", ownerUserId: "platform-owner" });
    mocks.platformSettingsFind.mockResolvedValue({
      id: "platform",
      allowPublicRegistration: true,
      householdCreationMode: "open"
    });

    await expect(getAppRegistrationPolicy()).resolves.toEqual({
      platformOwnerBound: true,
      bootstrapAccountAllowed: false,
      publicRegistrationAllowed: true,
      householdCreationMode: "open",
      newHouseholdCreationAllowed: true
    });
  });

  it("fails closed when authority exists but its settings row is incomplete", async () => {
    mocks.platformAuthorityFind.mockResolvedValue({ id: "platform", ownerUserId: "platform-owner" });

    await expect(getAppRegistrationPolicy()).resolves.toMatchObject({
      platformOwnerBound: true,
      publicRegistrationAllowed: false,
      householdCreationMode: "closed",
      newHouseholdCreationAllowed: false
    });
  });

  it("does not treat invitation-only mode as direct household-creation permission", async () => {
    mocks.platformAuthorityFind.mockResolvedValue({ id: "platform", ownerUserId: "platform-owner" });
    mocks.platformSettingsFind.mockResolvedValue({
      id: "platform",
      allowPublicRegistration: false,
      householdCreationMode: "invitation_only"
    });

    await expect(getAppRegistrationPolicy()).resolves.toMatchObject({
      householdCreationMode: "invitation_only",
      newHouseholdCreationAllowed: false
    });
  });

  it("continues to allow a valid household-membership invitation while public signup is closed", async () => {
    mocks.inviteFind.mockResolvedValue({
      id: "invite-1",
      email: "invited@example.test",
      status: "pending",
      expiresAt: new Date(Date.now() + 60_000)
    });
    const request = new Request("http://localhost/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "Invited@Example.Test", callbackURL: "/invite/token-123" })
    });

    await expect(signupPolicyForRequest(request)).resolves.toEqual({ allowed: true, reason: "invite" });
    expect(mocks.hashInviteToken).toHaveBeenCalledWith("token-123");
  });

  it("rejects a valid invite token when the signup email does not match the invite recipient", async () => {
    mocks.inviteFind.mockResolvedValue({
      id: "invite-1",
      email: "invited@example.test",
      status: "pending",
      expiresAt: new Date(Date.now() + 60_000)
    });
    const request = new Request("http://localhost/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "other@example.test", callbackURL: "/invite/token-123" })
    });

    await expect(signupPolicyForRequest(request)).resolves.toEqual({
      allowed: false,
      reason: "invite_email_mismatch"
    });
  });
});

describe("registration helpers", () => {
  it("extracts invite tokens from callback paths", () => {
    expect(extractInviteToken("/invite/token-123")).toBe("token-123");
    expect(extractInviteToken("http://localhost:3002/invite/abc?next=1")).toBe("abc");
    expect(extractInviteToken("/onboarding")).toBeUndefined();
  });
});
