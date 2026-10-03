import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ updateOwnName: vi.fn() }));
vi.mock("@/server/services/own-profile", () => ({ updateOwnName: mocks.updateOwnName }));

import { PATCH } from "@/app/api/members/me/name/route";

const patch = (body: unknown) => new Request("http://localhost/api/members/me/name", {
  method: "PATCH",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body)
});

describe("the own-name route", () => {
  beforeEach(() => vi.resetAllMocks());

  it("saves the name and returns it", async () => {
    mocks.updateOwnName.mockResolvedValue({ name: "Daniel Fisher" });

    const response = await PATCH(patch({ name: "Daniel Fisher" }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, data: { name: "Daniel Fisher" } });
    expect(mocks.updateOwnName).toHaveBeenCalledWith({ name: "Daniel Fisher" });
  });

  it("never caches a name", async () => {
    mocks.updateOwnName.mockResolvedValue({ name: "Daniel Fisher" });

    const response = await PATCH(patch({ name: "Daniel Fisher" }));

    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("has no way to name a different account", async () => {
    // The service reads the identity from the session, so a userId in the body is ignored rather
    // than honoured. The route must not forward one as though it meant something.
    mocks.updateOwnName.mockResolvedValue({ name: "Daniel Fisher" });

    await PATCH(patch({ name: "Daniel Fisher", userId: "someone-else" }));

    expect(mocks.updateOwnName).toHaveBeenCalledWith({ name: "Daniel Fisher" });
  });

  it("passes a missing name through to the service rather than inventing one", async () => {
    mocks.updateOwnName.mockRejectedValue(new Error("validation_error"));

    const response = await PATCH(patch({}));

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(mocks.updateOwnName).toHaveBeenCalledWith({ name: undefined });
  });

  it("reports a refusal rather than appearing to succeed", async () => {
    mocks.updateOwnName.mockRejectedValue(new Error("unauthenticated"));

    const response = await PATCH(patch({ name: "Daniel Fisher" }));

    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it("survives a body that is not json at all", async () => {
    mocks.updateOwnName.mockRejectedValue(new Error("validation_error"));

    const response = await PATCH(new Request("http://localhost/api/members/me/name", {
      method: "PATCH",
      body: "not json"
    }));

    expect(response.status).toBeGreaterThanOrEqual(400);
  });
});
