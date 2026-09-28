import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  issue: vi.fn(), submit: vi.fn(), status: vi.fn(), abandon: vi.fn(), failure: vi.fn()
}));

vi.mock("@/server/services/admin-assisted-accounts-service", () => ({
  issueAssistedMemberAccountCreate: mocks.issue,
  submitAssistedMemberAccountCreate: mocks.submit,
  getAssistedMemberAccountCreateStatus: mocks.status,
  abandonAssistedMemberAccountCreate: mocks.abandon
}));
vi.mock("@/server/services/browser-operations", () => ({ browserOperationFailureResult: mocks.failure }));

import { POST } from "@/app/api/members/assisted-account/route";
import { operation } from "@/app/api/members/assisted-account/route.operation";

const operationId = "bmo_0123456789abcdefghjkmnpqrs";
const url = "http://localhost/api/members/assisted-account";
const body = {
  operationId,
  openingFingerprint: "a".repeat(64),
  name: "New Person",
  email: "new.person@example.com",
  role: "parent",
  password: "correct horse battery",
  passwordConfirmation: "correct horse battery",
  requireFirstLoginPasswordChange: true
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
    status: "completed", operationId, outcome: { kind: "member_account", code: "created", memberId: "created-member" }
  });
  mocks.status.mockResolvedValue({ status: "pending", operationId, code: "operation_unknown" });
  mocks.abandon.mockResolvedValue({ status: "expired", operationId, code: "operation_abandoned" });
  mocks.failure.mockReturnValue(null);
});

describe("assisted account create route", () => {
  it("issues a reservation for the issue query", async () => {
    const response = await POST(jsonRequest("?issue=1", { operationId }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, data: { status: "open", operationId } });
    expect(mocks.issue).toHaveBeenCalledWith({ operationId });
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("submits a bmo_ operation and returns the terminal outcome", async () => {
    const response = await POST(jsonRequest("", body));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true, data: { status: "completed", outcome: { kind: "member_account", code: "created" } }
    });
    expect(mocks.submit).toHaveBeenCalledWith(body);
  });

  it("answers a status query with 202 while the outcome is unknown", async () => {
    const response = await POST(jsonRequest("?status=1", { operationId }));

    expect(response.status).toBe(202);
    expect(mocks.status).toHaveBeenCalledWith({ operationId });
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("answers an abandon query with 410", async () => {
    const response = await POST(jsonRequest("?abandon=1", { operationId }));

    expect(response.status).toBe(410);
    await expect(response.json()).resolves.toMatchObject({ ok: true, data: { code: "operation_abandoned" } });
    expect(mocks.abandon).toHaveBeenCalledWith({ operationId });
  });

  it("returns 410 for an expired terminal result", async () => {
    mocks.submit.mockResolvedValue({ status: "expired", operationId, code: "operation_result_expired" });

    expect((await POST(jsonRequest("", body))).status).toBe(410);
  });

  it("returns 200 for a frozen rejection rather than a server error", async () => {
    mocks.submit.mockResolvedValue({ status: "rejected", operationId, code: "existing_account_invitation_required" });

    const response = await POST(jsonRequest("", body));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ data: { code: "existing_account_invitation_required" } });
  });

  it("maps a substrate failure to its browser operation result", async () => {
    mocks.submit.mockRejectedValue(new Error("forbidden"));
    mocks.failure.mockReturnValue({ status: "stale", operationId, code: "stale_context" });

    const response = await POST(jsonRequest("", body));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ data: { status: "stale", code: "stale_context" } });
    expect(mocks.failure).toHaveBeenCalledWith(operationId, expect.any(Error));
  });

  it("falls back to the shared error handler for unmapped failures", async () => {
    mocks.submit.mockRejectedValue(new Error("unauthenticated"));

    const response = await POST(jsonRequest("", body));
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: { code: "unauthenticated" } });
  });

  it("declares the observed assisted create route operation", () => {
    expect(operation).toMatchObject({
      schemaVersion: 1,
      id: "api_route:src/app/api/members/assisted-account/route.ts",
      ownerModule: "src/app/api/members/assisted-account/route.ts",
      ownerKind: "api_route",
      disposition: "observed",
      bindings: [{ kind: "route_method", symbol: "POST", target: "src/app/api/members/assisted-account/route.ts#POST" }]
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
