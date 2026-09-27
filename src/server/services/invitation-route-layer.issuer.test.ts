import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireFreshSession: vi.fn(),
  getEffectiveHouseholdContext: vi.fn(),
  services: {
    manualCreate: { reserve: vi.fn(), submit: vi.fn(), status: vi.fn(), abandon: vi.fn() },
    manualReplace: { reserve: vi.fn(), submit: vi.fn(), status: vi.fn(), abandon: vi.fn() },
    revoke: vi.fn(),
    revokeAll: vi.fn()
  }
}));

vi.mock("next/headers", () => ({ cookies: () => ({ get: () => undefined }), headers: async () => new Headers() }));
vi.mock("@/lib/auth/auth", () => ({ auth: {} }));
vi.mock("@/lib/db/prisma", () => ({ prisma: {} }));
vi.mock("@/server/auth/session", () => ({ getSession: vi.fn(), requireFreshSession: mocks.requireFreshSession, requireGlobalSecurityContext: vi.fn() }));
vi.mock("@/server/auth/context", () => ({ getEffectiveHouseholdContext: mocks.getEffectiveHouseholdContext }));
vi.mock("@/server/services/invitation-attestation", () => ({ invitationFingerprint: vi.fn(), prepareRecoveryVerifierBatch: vi.fn() }));
vi.mock("@/server/services/invitation-service", () => ({ getInvitationServices: async () => mocks.services }));
vi.mock("@/server/services/global-security", () => ({ issueFreshAuthGrantForCurrentPassword: vi.fn() }));
vi.mock("@/server/services/invitation-setup-corridor", () => ({ assertInvitationSetupCorridorAccess: vi.fn(), classifyInvitationSetupCorridor: vi.fn() }));

import { handleInvitationRoute, type InvitationRoute } from "@/server/services/invitation-route-layer";

const operationId = "11111111-1111-4111-8111-111111111111";
const openingFingerprint = "a".repeat(64);
const intentFingerprint = "b".repeat(64);

function post(payload: Record<string, unknown>) {
  return new Request("https://cubby.test/api/invitations/manual/create", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
}

async function call(route: InvitationRoute, payload: Record<string, unknown>) {
  const result = await handleInvitationRoute(post(payload), route);
  return { http: result.status, body: await result.json() as { ok: boolean; data: Record<string, unknown> } };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireFreshSession.mockResolvedValue({ session: { id: "session-1" }, user: { id: "user-1" } });
  mocks.getEffectiveHouseholdContext.mockResolvedValue({ userId: "user-1", householdId: "household-1", memberId: "member-1", role: "owner" });
  mocks.services.manualCreate.reserve.mockResolvedValue({ operationId, status: "prepared" });
  mocks.services.manualReplace.reserve.mockResolvedValue({ operationId, status: "prepared" });
});

describe("issuer invitation routes", () => {
  it("reserves a manual invitation from the browser's reserve payload, which carries no intent yet", async () => {
    const result = await call("manual-create", { action: "reserve", operationId, recipientEmail: "member@example.test", role: "caretaker", expiresInHours: 168, openingFingerprint });
    expect(result.body.data.status).toBe("prepared");
    expect(mocks.services.manualCreate.reserve).toHaveBeenCalledTimes(1);
    const input = mocks.services.manualCreate.reserve.mock.calls[0]![0];
    expect(input).toMatchObject({ operationId, householdId: "household-1", role: "caretaker", expiresInHours: 168, recipientEmail: "member@example.test" });
    expect(input.request).toMatchObject({ ordinarySessionId: "session-1", subjectUserId: "user-1", issuerMembershipEpisodeId: "member-1", intentFingerprint: null });
    expect(input.request.openingFingerprint.toString("hex")).toBe(openingFingerprint);
  });

  it("reserves a manual replacement from the browser's reserve payload", async () => {
    const result = await call("manual-replace", { action: "reserve", operationId, inviteId: "invite-1", expiresInHours: 168, openingFingerprint });
    expect(result.body.data.status).toBe("prepared");
    expect(mocks.services.manualReplace.reserve).toHaveBeenCalledTimes(1);
    expect(mocks.services.manualReplace.reserve.mock.calls[0]![0].request.intentFingerprint).toBeNull();
  });

  it("still requires the intent fingerprint to submit", async () => {
    const missing = await call("manual-create", { action: "submit", operationId, openingFingerprint });
    expect(missing.body.data.status).toBe("unavailable");
    expect(mocks.services.manualCreate.submit).not.toHaveBeenCalled();
    mocks.services.manualCreate.submit.mockResolvedValue({ operationId, status: "created", inviteToken: "display-once" });
    const present = await call("manual-create", { action: "submit", operationId, openingFingerprint, intentFingerprint });
    expect(present.body.data.status).toBe("created");
    expect(mocks.services.manualCreate.submit.mock.calls[0]![0].request.intentFingerprint.toString("hex")).toBe(intentFingerprint);
  });

  it("tells the issuer to sign in again when the session is stale or absent, without reaching a procedure", async () => {
    for (const code of ["fresh_authentication_required", "unauthenticated"]) {
      mocks.requireFreshSession.mockRejectedValueOnce(new Error(code));
      const result = await call("manual-create", { action: "reserve", operationId, recipientEmail: "member@example.test", role: "caretaker", expiresInHours: 168, openingFingerprint });
      expect(result.body.data).toEqual({ status: "sign_in_required" });
    }
    expect(mocks.services.manualCreate.reserve).not.toHaveBeenCalled();
  });

  it("keeps procedure failures neutral and free of database detail", async () => {
    mocks.services.manualCreate.reserve.mockRejectedValue(new Error('permission denied for function reserve_manual_invite_create_v2 [REDACTED]'));
    const result = await call("manual-create", { action: "reserve", operationId, recipientEmail: "member@example.test", role: "caretaker", expiresInHours: 168, openingFingerprint });
    expect(result.body.data).toEqual({ status: "unavailable" });
  });

  it("reaches no invitation procedure when the household context belongs to another user", async () => {
    mocks.getEffectiveHouseholdContext.mockResolvedValue({ userId: "user-2", householdId: "household-2", memberId: "member-2", role: "owner" });
    const result = await call("manual-create", { action: "reserve", operationId, recipientEmail: "member@example.test", role: "caretaker", expiresInHours: 168, openingFingerprint });
    expect(result.body.data.status).not.toBe("prepared");
    expect(mocks.services.manualCreate.reserve).not.toHaveBeenCalled();
  });
});
