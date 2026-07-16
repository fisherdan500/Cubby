import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ restoreBackupJson: vi.fn() }));
vi.mock("@/server/services/backups", () => ({ restoreBackupJson: mocks.restoreBackupJson }));

import { POST } from "@/app/api/backups/restore/route";

describe("POST /api/backups/restore", () => {
  beforeEach(() => vi.clearAllMocks());

  it("passes the raw backup with exact household confirmation and preview checksum", async () => {
    mocks.restoreBackupJson.mockResolvedValue({ restored: 0 });

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(mocks.restoreBackupJson).toHaveBeenCalledWith(
      { version: 1, babies: [], activities: [] },
      { confirmation: "Fresh Home", previewChecksum: "legacy-v1" }
    );
  });

  it("decodes a Unicode household confirmation from its header-safe representation", async () => {
    mocks.restoreBackupJson.mockResolvedValue({ restored: 0 });

    const response = await POST(request("家族 🍼"));

    expect(response.status).toBe(200);
    expect(mocks.restoreBackupJson).toHaveBeenCalledWith(
      { version: 1, babies: [], activities: [] },
      { confirmation: "家族 🍼", previewChecksum: "legacy-v1" }
    );
  });

  it("requires confirmation headers before reading or restoring", async () => {
    const response = await POST(new Request("http://localhost/api/backups/restore", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}"
    }));
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "backup_confirmation_mismatch" } });
    expect(mocks.restoreBackupJson).not.toHaveBeenCalled();
  });

  it("returns an actionable conflict for a backup containing a live timer", async () => {
    mocks.restoreBackupJson.mockRejectedValue(new Error("backup_active_timer"));

    const response = await POST(request());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: {
        code: "backup_active_timer",
        message: "This backup contains a running or paused timer. Stop it before exporting a new backup."
      }
    });
  });

  it("returns a validation error for malformed stopped timer metadata", async () => {
    mocks.restoreBackupJson.mockRejectedValue(new Error("backup_invalid_timer"));

    const response = await POST(request());

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "backup_invalid_timer" }
    });
  });
});

function request(confirmation = "Fresh Home") {
  return new Request("http://localhost/api/backups/restore", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-cubby-restore-confirmation": encodeURIComponent(confirmation),
      "x-cubby-backup-checksum": "legacy-v1"
    },
    body: JSON.stringify({ version: 1, babies: [], activities: [] })
  });
}
