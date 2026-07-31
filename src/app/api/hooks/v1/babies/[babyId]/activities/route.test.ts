import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requireApiKey: vi.fn(), hookCreateActivity: vi.fn() }));
vi.mock("@/server/services/hooks", () => ({
  requireApiKey: mocks.requireApiKey,
  hookCreateActivity: mocks.hookCreateActivity,
  hookActivities: vi.fn(),
  withApiKey: vi.fn()
}));

import { POST } from "./route";

describe("POST /api/hooks/v1/babies/[babyId]/activities", () => {
  it("keeps v1 callers without a client mutation ID compatible", async () => {
    const ctx = { householdId: "household-1", scopes: ["write"] };
    mocks.requireApiKey.mockResolvedValue(ctx);
    mocks.hookCreateActivity.mockResolvedValue({ id: "activity-1" });

    const response = await POST(
      new Request("https://example.test/api/hooks/v1/babies/baby-1/activities", {
        method: "POST",
        body: JSON.stringify({ type: "note", text: "legacy" })
      }),
      { params: { babyId: "baby-1" } }
    );

    expect(response.status).toBe(201);
    expect(mocks.hookCreateActivity).toHaveBeenCalledWith(ctx, "baby-1", { type: "note", text: "legacy" });
  });
});
