import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  downloadLocalBackupFile: vi.fn()
}));

vi.mock("@/server/services/backups", () => ({
  downloadLocalBackupFile: mocks.downloadLocalBackupFile
}));


import { GET } from "@/app/api/backups/local/[filename]/route";

describe("/api/backups/local/[filename]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.downloadLocalBackupFile.mockResolvedValue({
      filename: "cubby-backup-v2-20260715T215013Z-aaaaaaaaaaaa.json",
      body: Buffer.from('{"version":2}')
    });
  });

  it("downloads an existing immutable local backup with safe no-store headers", async () => {
    const response = await GET(new Request("http://localhost/api/backups/local/file"), {
      params: { filename: "cubby-backup-v2-20260715T215013Z-aaaaaaaaaaaa.json" }
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"version":2}');
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="cubby-backup-v2-20260715T215013Z-aaaaaaaaaaaa.json"'
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.downloadLocalBackupFile).toHaveBeenCalledWith("cubby-backup-v2-20260715T215013Z-aaaaaaaaaaaa.json");
  });

  it("fails closed for malformed or missing candidates without exposing host paths", async () => {
    mocks.downloadLocalBackupFile.mockRejectedValue(new Error("backup_invalid"));

    const response = await GET(new Request("http://localhost/api/backups/local/file"), {
      params: { filename: "../escape.json" }
    });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "backup_invalid" }
    });
  });
});
