import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ exportBackupJson: vi.fn() }));
vi.mock("@/server/services/backups", () => ({ exportBackupJson: mocks.exportBackupJson }));

import { GET, POST } from "@/app/api/backups/export/route";

describe("/api/backups/export", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.exportBackupJson.mockResolvedValue('{"version":2}');
  });

  it("exports only after an explicit POST with no-store attachment headers", async () => {
    const response = await POST();
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"version":2}');
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("content-disposition")).toMatch(/^attachment; filename="cubby-backup-\d{4}-\d{2}-\d{2}\.json"$/);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.exportBackupJson).toHaveBeenCalledOnce();
  });

  it("rejects GET without exporting", async () => {
    const response = await GET();
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    expect(mocks.exportBackupJson).not.toHaveBeenCalled();
  });
});
