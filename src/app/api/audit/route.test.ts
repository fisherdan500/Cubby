import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listHouseholdAuditEvents: vi.fn(),
  listBabySafetyHistory: vi.fn(),
  exportHouseholdAuditCsv: vi.fn(),
  ok: vi.fn((data) => Response.json({ ok: true, data })),
  handleError: vi.fn((error) => Response.json({ ok: false, error: String(error) }, { status: 500 }))
}));

vi.mock("@/server/services/audit-reader", () => ({
  listHouseholdAuditEvents: mocks.listHouseholdAuditEvents,
  listBabySafetyHistory: mocks.listBabySafetyHistory,
  exportHouseholdAuditCsv: mocks.exportHouseholdAuditCsv
}));
vi.mock("@/server/http", () => ({ ok: mocks.ok, handleError: mocks.handleError }));

import { GET } from "./route";

describe("GET /api/audit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the restricted household audit reader result", async () => {
    mocks.listHouseholdAuditEvents.mockResolvedValue({ events: [{ id: "audit-1" }], nextCursor: null });

    await expect(GET(new Request("http://cubby.test/api/audit?limit=25&cursor=cursor-1"))).resolves.toBeInstanceOf(Response);
    expect(mocks.listHouseholdAuditEvents).toHaveBeenCalledWith({ limit: 25, cursor: "cursor-1" });
    expect(mocks.ok).toHaveBeenCalledWith({ events: [{ id: "audit-1" }], nextCursor: null });
  });

  it("returns only the selected baby safety-history projection when babyId is present", async () => {
    mocks.listBabySafetyHistory.mockResolvedValue([{ action: "activity.create", type: "medicine" }]);

    await expect(GET(new Request("http://cubby.test/api/audit?babyId=baby-1"))).resolves.toBeInstanceOf(Response);

    expect(mocks.listBabySafetyHistory).toHaveBeenCalledWith("baby-1");
    expect(mocks.listHouseholdAuditEvents).not.toHaveBeenCalled();
  });

  it("returns a minimized owner/admin audit CSV only when explicitly requested", async () => {
    mocks.exportHouseholdAuditCsv.mockResolvedValue('"action"\n"audit.view"');

    const response = await GET(new Request("http://cubby.test/api/audit?format=csv"));

    expect(mocks.exportHouseholdAuditCsv).toHaveBeenCalledOnce();
    expect(response.headers.get("content-type")).toContain("text/csv");
    await expect(response.text()).resolves.toContain('"audit.view"');
  });
});
