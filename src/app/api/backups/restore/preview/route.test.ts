import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_BACKUP_BYTES } from "@/server/services/backup-format";

const mocks = vi.hoisted(() => ({ previewBackupJson: vi.fn(), previewBackupArchive: vi.fn(), withUpload: vi.fn() }));
vi.mock("@/server/services/backups", () => ({ previewBackupJson: mocks.previewBackupJson, previewBackupArchive: mocks.previewBackupArchive }));
vi.mock("@/server/services/backup-upload", () => ({ withUploadedBackupArchive: mocks.withUpload }));

import { POST } from "@/app/api/backups/restore/preview/route";

describe("POST /api/backups/restore/preview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.previewBackupJson.mockResolvedValue({ householdName: "Home", counts: { babies: 1 } });
  });

  it("reads and previews a raw JSON body without mutation", async () => {
    const response = await POST(request('{"version":1,"babies":[],"activities":[]}'));
    expect(response.status).toBe(200);
    expect(mocks.previewBackupJson).toHaveBeenCalledWith({ version: 1, babies: [], activities: [] });
  });

  it("previews an uploaded archive from its staged copy", async () => {
    mocks.withUpload.mockImplementation(async (_request, work) => work("/staging/upload.zip"));
    mocks.previewBackupArchive.mockResolvedValue({ householdName: "Home", counts: { feedPhotos: 3 } });

    const response = await POST(request("PK", "application/zip"));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ data: { counts: { feedPhotos: 3 } } });
    expect(mocks.previewBackupArchive).toHaveBeenCalledWith("/staging/upload.zip");
  });

  it("says which file to choose when a JSON backup lists photos it cannot carry", async () => {
    mocks.previewBackupJson.mockRejectedValue(new Error("backup_photos_missing"));
    const response = await POST(request('{"version":2}'));
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "backup_photos_missing", message: expect.stringMatching(/\.zip backup/) } });
  });

  it.each([
    ["text/plain", "{}", 415, "backup_invalid_content_type"],
    ["application/json", "not-json", 422, "backup_invalid_json"]
  ])("rejects invalid input", async (contentType, body, status, code) => {
    const response = await POST(request(body, contentType));
    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: { code } });
    expect(mocks.previewBackupJson).not.toHaveBeenCalled();
  });

  it("maps malformed backup schemas to a backup-specific response", async () => {
    mocks.previewBackupJson.mockRejectedValue(new Error("backup_invalid"));

    const response = await POST(request('{"version":2}'));

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "backup_invalid" }
    });
  });

  it("rejects a declared over-limit body before parsing", async () => {
    const response = await POST(new Request("http://localhost/api/backups/restore/preview", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(MAX_BACKUP_BYTES + 1) },
      body: "{}"
    }));
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "backup_too_large" } });
  });
});

function request(body: string, contentType = "application/json") {
  return new Request("http://localhost/api/backups/restore/preview", { method: "POST", headers: { "content-type": contentType }, body });
}
