import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ exportBackupForDownload: vi.fn() }));
vi.mock("@/server/services/backups", () => ({ exportBackupForDownload: mocks.exportBackupForDownload }));

import { GET, POST } from "@/app/api/backups/export/route";

describe("/api/backups/export", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.exportBackupForDownload.mockResolvedValue({ kind: "json", filename: "cubby-backup-2026-09-30.json", body: '{"version":2}' });
  });

  it("exports only after an explicit POST with no-store attachment headers", async () => {
    const response = await POST();
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"version":2}');
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="cubby-backup-2026-09-30.json"');
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.exportBackupForDownload).toHaveBeenCalledOnce();
  });

  it("streams a household with photos as a zip archive", async () => {
    mocks.exportBackupForDownload.mockResolvedValue({
      kind: "archive", filename: "cubby-backup-2026-09-30.zip", stream: new Response("PK-archive").body
    });
    const response = await POST();
    expect(response.headers.get("content-type")).toBe("application/zip");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="cubby-backup-2026-09-30.zip"');
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("PK-archive");
  });

  it("rejects GET without exporting", async () => {
    const response = await GET();
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    expect(mocks.exportBackupForDownload).not.toHaveBeenCalled();
  });
});
