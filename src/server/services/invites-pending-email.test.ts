import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  householdFindUniqueOrThrow: vi.fn(),
  deliveryFindMany: vi.fn(),
  getEffectiveHouseholdContext: vi.fn(),
  requirePermission: vi.fn()
}));

vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    household: { findUniqueOrThrow: mocks.householdFindUniqueOrThrow },
    invitationEmailDelivery: { findMany: mocks.deliveryFindMany }
  }
}));
vi.mock("@/server/auth/context", () => ({ getEffectiveHouseholdContext: mocks.getEffectiveHouseholdContext, requirePermission: mocks.requirePermission }));
vi.mock("@/server/auth/session", () => ({ assertFreshSession: vi.fn(), requireFreshSession: vi.fn(), requireUser: vi.fn() }));
vi.mock("@/server/services/audit", () => ({ writeAudit: vi.fn() }));

import { listMembersAndInvites } from "@/server/services/invites";

const smtp = { SMTP_HOST: "smtp.example.invalid", SMTP_PORT: "587", SMTP_USER: "user", SMTP_PASSWORD: "[REDACTED]", EMAIL_FROM: "Cubby <noreply@example.invalid>", CUBBY_EMAIL_DELIVERY_KEYRING: "1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", CUBBY_EMAIL_DELIVERY_ACTIVE_KEY_VERSION: "1" };
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.clearAllMocks();
  saved = Object.fromEntries(Object.keys(smtp).map((key) => [key, process.env[key]]));
  mocks.getEffectiveHouseholdContext.mockResolvedValue({ userId: "user-1", householdId: "household-1", memberId: "member-1", role: "owner" });
  mocks.householdFindUniqueOrThrow.mockResolvedValue({ id: "household-1", name: "Home", members: [], invites: [{ id: "inv_1" }, { id: "inv_2" }, { id: "inv_3" }] });
  mocks.deliveryFindMany.mockResolvedValue([{ inviteId: "inv_1", state: "accepted" }, { inviteId: "inv_2", state: "retryable_failed" }]);
});
afterEach(() => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });

describe("pending invitation email status", () => {
  it("reports each pending invitation's email state from the non-secret delivery columns", async () => {
    Object.assign(process.env, smtp);
    const result = await listMembersAndInvites();
    expect(mocks.deliveryFindMany).toHaveBeenCalledWith({ where: { householdId: "household-1", inviteId: { in: ["inv_1", "inv_2", "inv_3"] } }, select: { inviteId: true, state: true } });
    expect(result.invites.map((invite) => invite.emailStatus)).toEqual(["sent", "queued", "not_sent"]);
    expect(result.emailAvailable).toBe(true);
  });

  it("says email is unavailable when SMTP is not configured", async () => {
    for (const key of Object.keys(smtp)) delete process.env[key];
    const result = await listMembersAndInvites();
    expect(result.emailAvailable).toBe(false);
  });
});
