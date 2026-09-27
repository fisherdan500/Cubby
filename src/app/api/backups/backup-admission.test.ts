import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ service: vi.fn() }));
vi.mock("@/lib/env", () => ({ attachmentConfig: { directory: "unused" } }));
vi.mock("@/server/auth/context", () => ({ getEffectiveHouseholdContext: async () => ({ role: "owner" }), requirePermission: vi.fn() }));
vi.mock("@/server/services/backups", () => ({ previewBackupJson: mocks.service, previewBackupArchive: mocks.service, restoreBackupJson: mocks.service, restoreBackupArchive: mocks.service }));
import { withBackupUploadAdmission } from "@/server/services/backup-upload";
import { POST as preview } from "./restore/preview/route";
import { POST as restore } from "./restore/route";
beforeEach(() => vi.resetAllMocks());
afterEach(() => vi.useRealTimers());
function request() {
  return new Request("https://cubby.test/backup", { method: "POST", body: "{}", headers: { "content-type": "application/json", "x-cubby-restore-confirmation": "Home", "x-cubby-backup-checksum": "checksum" } });
}
it.each([preview, restore])("refuses JSON before reading while the archive reservation is held", async (post) => {
  await withBackupUploadAdmission(async () => {
    const input = request();
    const reader = vi.spyOn(input.body!, "getReader");
    const response = await post(input);
    expect({ status: response.status, reads: reader.mock.calls.length, work: mocks.service.mock.calls.length })
      .toEqual({ status: 429, reads: 0, work: 0 });
  });
});
it.each([preview, restore])("cancels a slow JSON upload rather than orphaning its read", async (post) => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const cancelled = vi.fn();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; }, cancel: cancelled });
  const input = new Request(request(), { body, duplex: "half" } as RequestInit);
  const pending = post(input);
  try {
    await vi.advanceTimersByTimeAsync(120_001);
    expect(cancelled).toHaveBeenCalledOnce();
    expect((await pending).status).toBe(408);
    expect(mocks.service).not.toHaveBeenCalled();
    expect(input.body!.locked).toBe(false);
  } finally {
    if (!cancelled.mock.calls.length) { controller.enqueue(new TextEncoder().encode("{}")); controller.close(); }
    await pending;
  }
  expect((await post(request())).status).toBe(200);
});
