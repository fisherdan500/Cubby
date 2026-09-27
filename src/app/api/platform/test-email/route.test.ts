import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ sendPlatformTestEmail: vi.fn() }));

vi.mock("@/server/services/platform-test-email", () => ({ sendPlatformTestEmail: mocks.sendPlatformTestEmail }));

import { POST } from "@/app/api/platform/test-email/route";

beforeEach(() => {
  vi.resetAllMocks();
});

describe("POST /api/platform/test-email", () => {
  it("returns the send result to the platform owner", async () => {
    mocks.sendPlatformTestEmail.mockResolvedValue({ status: "sent", recipient: "owner@example.test" });

    const response = await POST();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, data: { status: "sent", recipient: "owner@example.test" } });
  });

  it("returns a stable throttled response and retry hint", async () => {
    mocks.sendPlatformTestEmail.mockResolvedValue({ status: "throttled", retryAfterSeconds: 60 });
    const response = await POST();
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    await expect(response.json()).resolves.toEqual({ ok: true, data: { status: "throttled", retryAfterSeconds: 60 } });
  });

  it("refuses anyone else", async () => {
    mocks.sendPlatformTestEmail.mockRejectedValue(new Error("forbidden"));

    const response = await POST();

    expect(response.status).toBe(403);
  });
});
