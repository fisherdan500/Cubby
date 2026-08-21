import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listHouseholdAuditEvents: vi.fn(),
  ok: vi.fn((data) => Response.json({ ok: true, data })),
  handleError: vi.fn((error) => Response.json({ ok: false, error: String(error) }, { status: 500 }))
}));

vi.mock("@/server/services/audit-reader", () => ({
  listHouseholdAuditEvents: mocks.listHouseholdAuditEvents
}));
vi.mock("@/server/http", () => ({ ok: mocks.ok, handleError: mocks.handleError }));

import { GET } from "./route";

describe("GET /api/audit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the restricted household audit reader result", async () => {
    mocks.listHouseholdAuditEvents.mockResolvedValue([{ id: "audit-1" }]);

    await expect(GET()).resolves.toBeInstanceOf(Response);
    expect(mocks.listHouseholdAuditEvents).toHaveBeenCalledOnce();
    expect(mocks.ok).toHaveBeenCalledWith([{ id: "audit-1" }]);
  });
});
