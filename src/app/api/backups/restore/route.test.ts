import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ restoreBackupJson: vi.fn() }));
vi.mock("@/server/services/backups", () => ({ restoreBackupJson: mocks.restoreBackupJson }));

import { POST } from "@/app/api/backups/restore/route";

describe("POST /api/backups/restore", () => {
  beforeEach(() => vi.clearAllMocks());

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

function request() {
  return new Request("http://localhost/api/backups/restore", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ version: 1, babies: [], activities: [] })
  });
}
