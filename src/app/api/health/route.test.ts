import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ verifyInfrastructure: vi.fn() }));
vi.mock("@/server/services/browser-operation-integrity", () => ({
  verifyBrowserOperationInfrastructure: mocks.verifyInfrastructure
}));

import { dynamic, GET } from "./route";

describe("GET /api/health", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns the bounded ready response only after operation infrastructure verification succeeds", async () => {
    mocks.verifyInfrastructure.mockResolvedValue({ status: "ready" });
    const response = await GET();
    expect(mocks.verifyInfrastructure).toHaveBeenCalledOnce();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ready" });
  });

  it("returns a sanitized unavailable response when readiness verification fails", async () => {
    const secret = "postgresql://user:***@private-db:5432/cubby";
    mocks.verifyInfrastructure.mockRejectedValue(Object.assign(new Error(`connection failed for ${secret}`), {
      stack: `Error: ${secret}\n at private-db.internal`
    }));
    const response = await GET();
    const body = await response.text();
    expect(response.status).toBe(503);
    expect(JSON.parse(body)).toEqual({ status: "unavailable" });
    expect(body).not.toContain(secret);
    expect(body).not.toContain("private-db");
    expect(body).not.toContain("connection failed");
    expect(body).not.toContain("stack");
  });

  it("is dynamic and prohibits caching for every readiness response", async () => {
    mocks.verifyInfrastructure.mockResolvedValue({ status: "ready" });
    const ready = await GET();
    mocks.verifyInfrastructure.mockRejectedValue(new Error("database unavailable"));
    const unavailable = await GET();
    expect(dynamic).toBe("force-dynamic");
    expect(ready.headers.get("cache-control")).toBe("no-store");
    expect(unavailable.headers.get("cache-control")).toBe("no-store");
  });
});
