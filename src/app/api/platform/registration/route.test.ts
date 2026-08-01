import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  allocateOperation: vi.fn(),
  completeOperation: vi.fn(),
  getOperationStatus: vi.fn()
}));

vi.mock("@/server/services/platform-authority", () => ({
  getPlatformRegistrationSettings: mocks.getSettings,
  allocatePlatformRegistrationOperation: mocks.allocateOperation,
  completePlatformRegistrationOperation: mocks.completeOperation,
  getPlatformRegistrationOperationStatus: mocks.getOperationStatus
}));

import { GET, POST, PUT } from "@/app/api/platform/registration/route";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getSettings.mockResolvedValue({ householdCreationMode: "closed", allowPublicRegistration: false, revision: 7 });
  mocks.allocateOperation.mockResolvedValue({ operationId: "op_server_opaque_123", status: "pending" });
  mocks.completeOperation.mockResolvedValue({
    operationId: "op_server_opaque_123",
    status: "completed",
    settings: { householdCreationMode: "open", allowPublicRegistration: true, revision: 8 }
  });
  mocks.getOperationStatus.mockResolvedValue({ operationId: "op_server_opaque_123", status: "pending" });
});

describe("platform registration API", () => {
  it("reads settings only through the platform-owner service boundary", async () => {
    const response = await GET(new Request("http://localhost/api/platform/registration"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      data: { householdCreationMode: "closed", allowPublicRegistration: false, revision: 7 }
    });
  });

  it("allocates the normalized registration intent before any write", async () => {
    const response = await POST(
      new Request("http://localhost/api/platform/registration", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ householdCreationMode: "open", allowPublicRegistration: true })
      })
    );

    expect(response.status).toBe(200);
    expect(mocks.allocateOperation).toHaveBeenCalledWith({ householdCreationMode: "open", allowPublicRegistration: true });
    await expect(response.json()).resolves.toMatchObject({ ok: true, data: { operationId: "op_server_opaque_123", status: "pending" } });
  });

  it("accepts only a server-issued operationId on PUT", async () => {
    const response = await PUT(
      new Request("http://localhost/api/platform/registration", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operationId: "op_server_opaque_123" })
      })
    );

    expect(response.status).toBe(200);
    expect(mocks.completeOperation).toHaveBeenCalledWith({ operationId: "op_server_opaque_123" });
  });

  it("returns an authorized operation status only when an operationId is requested", async () => {
    const response = await GET(new Request("http://localhost/api/platform/registration?operationId=op_server_opaque_123"));

    expect(response.status).toBe(200);
    expect(mocks.getOperationStatus).toHaveBeenCalledWith({ operationId: "op_server_opaque_123" });
    expect(mocks.getSettings).not.toHaveBeenCalled();
  });

  it.each([
    ["unauthenticated", 401],
    ["forbidden", 403],
    ["platform_uninitialized", 409],
    ["not_found", 404]
  ])("maps %s to a fail-closed response", async (message, status) => {
    mocks.getSettings.mockRejectedValue(new Error(message));

    const response = await GET(new Request("http://localhost/api/platform/registration"));

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: { code: message } });
  });
});
