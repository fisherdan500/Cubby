import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  issue: vi.fn(), submit: vi.fn(), status: vi.fn(), abandon: vi.fn(), failure: vi.fn()
}));

vi.mock("@/server/services/admin-assisted-accounts-service", () => ({
  issueAssistedMemberPasswordReset: mocks.issue,
  submitAssistedMemberPasswordReset: mocks.submit,
  getAssistedMemberPasswordResetStatus: mocks.status,
  abandonAssistedMemberPasswordReset: mocks.abandon
}));
vi.mock("@/server/services/browser-operations", () => ({ browserOperationFailureResult: mocks.failure }));

import { POST } from "@/app/api/members/[id]/assisted-password/route";
import { operation } from "@/app/api/members/[id]/assisted-password/route.operation";

const operationId = "bmo_0123456789abcdefghjkmnpqrs";
const url = "http://localhost/api/members/member-1/assisted-password";
const context = { params: Promise.resolve({ id: "member-1" }) };
const body = {
  operationId,
  openingFingerprint: "a".repeat(64),
  targetUserId: "target-user",
  credentialVersion: 3,
  sessionSecurityVersion: 4,
  password: "replacement secret value",
  passwordConfirmation: "replacement secret value",
  requireFirstLoginPasswordChange: false
};
const jsonRequest = (suffix: string, payload: Record<string, unknown>) => new Request(`${url}${suffix}`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(payload)
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.issue.mockResolvedValue({ status: "open", operationId, bindingId: "binding-1" });
  mocks.submit.mockResolvedValue({
    status: "completed", operationId, outcome: { kind: "member_password", code: "reset", memberId: "member-1" }
  });
  mocks.status.mockResolvedValue({ status: "completed", operationId, outcome: { kind: "member_password", code: "reset", memberId: "member-1" } });
  mocks.abandon.mockResolvedValue({ status: "expired", operationId, code: "operation_abandoned" });
  mocks.failure.mockReturnValue(null);
});

describe("assisted password reset route", () => {
  it("issues a reservation bound to the path member", async () => {
    const response = await POST(jsonRequest("?issue=1", { operationId }), context);

    expect(response.status).toBe(200);
    expect(mocks.issue).toHaveBeenCalledWith("member-1", { operationId });
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("submits with the path member as the authoritative target", async () => {
    const response = await POST(jsonRequest("", { ...body, memberId: "spoofed" }), context);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true, data: { status: "completed", outcome: { kind: "member_password", code: "reset" } }
    });
    expect(mocks.submit).toHaveBeenCalledWith("member-1", { ...body, memberId: "spoofed" });
  });

  it("answers a status query without the password", async () => {
    const response = await POST(jsonRequest("?status=1", { operationId }), context);

    expect(response.status).toBe(200);
    expect(mocks.status).toHaveBeenCalledWith({ operationId });
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("answers an abandon query with 410", async () => {
    const response = await POST(jsonRequest("?abandon=1", { operationId }), context);

    expect(response.status).toBe(410);
    expect(mocks.abandon).toHaveBeenCalledWith({ operationId });
  });

  it("returns 202 while the outcome is unknown", async () => {
    mocks.submit.mockResolvedValue({ status: "pending", operationId, code: "operation_unknown" });

    expect((await POST(jsonRequest("", body), context)).status).toBe(202);
  });

  it("returns 200 for the truthful privacy rejection", async () => {
    mocks.submit.mockResolvedValue({ status: "rejected", operationId, code: "personal_recovery_unavailable" });

    const response = await POST(jsonRequest("", body), context);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ data: { code: "personal_recovery_unavailable" } });
  });

  it("maps a substrate failure to its browser operation result", async () => {
    mocks.submit.mockRejectedValue(new Error("not_found"));
    mocks.failure.mockReturnValue({ status: "stale", operationId, code: "stale_target" });

    const response = await POST(jsonRequest("", body), context);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ data: { status: "stale", code: "stale_target" } });
  });

  it("falls back to the shared error handler for unmapped failures", async () => {
    mocks.submit.mockRejectedValue(new Error("fresh_authentication_required"));

    const response = await POST(jsonRequest("", body), context);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: { code: "fresh_authentication_required" } });
  });

  it("declares the observed assisted reset route operation", () => {
    expect(operation).toMatchObject({
      schemaVersion: 1,
      id: "api_route:src/app/api/members/[id]/assisted-password/route.ts",
      ownerModule: "src/app/api/members/[id]/assisted-password/route.ts",
      ownerKind: "api_route",
      disposition: "observed",
      bindings: [{
        kind: "route_method", symbol: "POST",
        target: "src/app/api/members/[id]/assisted-password/route.ts#POST"
      }]
    });
    expect(operation.deferredGateIds).toEqual([
      "gate.carrier_authority_guard",
      "gate.caller_controlled_scope",
      "gate.service_operation_linkage",
      "gate.permission_commit_reauthorization",
      "gate.tenant_relationship_invariants",
      "gate.model_and_effects",
      "gate.variant_outcomes",
      "gate.worker_containment",
      "gate.browser_binding_staleness",
      "gate.executable_evidence"
    ]);
  });
});
