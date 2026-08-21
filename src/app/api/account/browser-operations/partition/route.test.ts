import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getPartition: vi.fn() }));
vi.mock("@/server/services/browser-operation-partition", () => ({
  getAccountBrowserOperationPartition: mocks.getPartition
}));

import { GET } from "@/app/api/account/browser-operations/partition/route";

describe("GET /api/account/browser-operations/partition", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns only the current account's non-authorizing partition descriptor", async () => {
    mocks.getPartition.mockResolvedValue({ version: 1, scope: "account", partition: "b".repeat(64) });

    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, data: { version: 1, scope: "account", partition: "b".repeat(64) } });
    expect(mocks.getPartition).toHaveBeenCalledOnce();
  });
});
