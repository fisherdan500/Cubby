import { beforeEach, describe, expect, it, vi } from "vitest";
import { hasPermission } from "@/domain/roles";

const mocks = vi.hoisted(() => ({ context: vi.fn(), stage: vi.fn(), service: vi.fn() }));
vi.mock("@/server/auth/context", () => ({
  getEffectiveHouseholdContext: mocks.context,
  requirePermission: (ctx: { role: Parameters<typeof hasPermission>[0] }, permission: Parameters<typeof hasPermission>[1]) => {
    if (!hasPermission(ctx.role, permission)) throw new Error("forbidden");
  }
}));
vi.mock("@/server/services/backup-upload", () => ({ withBackupUploadAdmission: (work: () => Promise<unknown>) => work(), withUploadedBackupArchive: mocks.stage }));
vi.mock("@/server/services/backups", () => ({ previewBackupJson: mocks.service, previewBackupArchive: mocks.service, restoreBackupJson: mocks.service, restoreBackupArchive: mocks.service }));
vi.mock("@/server/services/attachments", () => ({ stageFeedPhoto: mocks.service }));
vi.mock("@/server/services/sprout-import", () => ({ previewSproutBackup: mocks.service, importSproutBackup: mocks.service, normalizeSproutError: (error: unknown) => error }));
import { POST as preview } from "./restore/preview/route";
import { POST as restore } from "./restore/route";
import { POST as photo } from "../attachments/feed-photos/route";
import { POST as sproutPreview } from "./sprout/preview/route";
import { POST as sproutImport } from "./sprout/import/route";

beforeEach(() => vi.resetAllMocks());
describe("upload authorization precedes all body access", () => {
  for (const [name, post, contentType] of [
    ["preview JSON", preview, "application/json"], ["preview ZIP", preview, "application/zip"],
    ["restore JSON", restore, "application/json"], ["restore ZIP", restore, "application/x-zip-compressed"],
    ["photo", photo, "image/jpeg"], ["Sprout preview", sproutPreview, "multipart/form-data"],
    ["Sprout import", sproutImport, "multipart/form-data"]
  ] as const) {
    it.each([["unauthenticated", 401], ["forbidden", 403], ["household_selection_stale", 409]] as const)(`${name} rejects %s without touching bytes`, async (code, status) => {
      if (code === "forbidden") mocks.context.mockResolvedValue({ role: "read_only" });
      else mocks.context.mockRejectedValue(new Error(code));
      const request = new Request("https://cubby.test/upload", { method: "POST", body: "{}", headers: {
        "content-type": contentType, "x-cubby-restore-confirmation": "Home", "x-cubby-backup-checksum": "checksum"
      } });
      const reader = vi.spyOn(request.body!, "getReader");
      const form = vi.spyOn(request, "formData").mockResolvedValue(new FormData());
      const response = await post(request);
      expect({ status: response.status, readers: reader.mock.calls.length, forms: form.mock.calls.length,
        staging: mocks.stage.mock.calls.length, service: mocks.service.mock.calls.length })
        .toEqual({ status, readers: 0, forms: 0, staging: 0, service: 0 });
    });
  }
});
