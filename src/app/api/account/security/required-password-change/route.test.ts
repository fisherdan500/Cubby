import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ complete: vi.fn(), clearCookies: vi.fn() }));

vi.mock("@/server/services/assisted-required-change", () => ({
  completeRequiredPasswordChange: mocks.complete
}));
vi.mock("@/server/auth/session", () => ({ clearBetterAuthSessionCookies: mocks.clearCookies }));

import { POST } from "@/app/api/account/security/required-password-change/route";
import { operation } from "@/app/api/account/security/required-password-change/route.operation";

const body = {
  operationId: "gso_0123456789abcdefghjkmnpqrs",
  openingFingerprint: "a".repeat(64),
  intentFingerprint: "b".repeat(64),
  currentPassword: "temporary-secret",
  newPassword: "a brand new secret",
  newPasswordConfirmation: "a brand new secret"
};

const request = (value: unknown) => new Request("http://localhost/api/account/security/required-password-change", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(value)
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.complete.mockResolvedValue({ operationId: body.operationId, status: "signed_out", signInRequired: true });
});

describe("POST /api/account/security/required-password-change", () => {
  it("completes the corridor and clears the session cookies", async () => {
    const response = await POST(request(body));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true, data: { operationId: body.operationId, status: "signed_out", signInRequired: true }
    });
    expect(mocks.complete).toHaveBeenCalledWith(body);
    expect(mocks.clearCookies).toHaveBeenCalledOnce();
  });

  it("rejects a non-JSON content type without calling the service", async () => {
    const response = await POST(new Request("http://localhost/api/account/security/required-password-change", {
      method: "POST", headers: { "content-type": "text/plain" }, body: "{}"
    }));

    expect(response.status).toBe(422);
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("reports an invalid submission as 422 and keeps the session", async () => {
    mocks.complete.mockRejectedValue(new Error("required_password_change_request_invalid"));

    const response = await POST(request({ ...body, newPasswordConfirmation: "different" }));
    expect(response.status).toBe(422);
    expect(mocks.clearCookies).not.toHaveBeenCalled();
  });

  it("reports a reused temporary password as 422 without clearing the session", async () => {
    mocks.complete.mockRejectedValue(new Error("required_password_change_reuse"));

    const response = await POST(request(body));
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      ok: false, error: { code: "required_password_change_reuse" }
    });
    expect(mocks.clearCookies).not.toHaveBeenCalled();
  });

  it("reports a wrong current password as 422 and preserves the requirement", async () => {
    mocks.complete.mockRejectedValue(new Error("current_password_invalid"));

    expect((await POST(request(body))).status).toBe(422);
    expect(mocks.clearCookies).not.toHaveBeenCalled();
  });

  it("reports an unauthenticated caller as 401", async () => {
    mocks.complete.mockRejectedValue(new Error("unauthenticated"));

    expect((await POST(request(body))).status).toBe(401);
  });

  it("declares the observed corridor route operation", () => {
    expect(operation).toMatchObject({
      schemaVersion: 1,
      id: "api_route:src/app/api/account/security/required-password-change/route.ts",
      ownerKind: "api_route",
      disposition: "observed"
    });
  });
});
