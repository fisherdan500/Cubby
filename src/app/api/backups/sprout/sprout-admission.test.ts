import { afterEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ preview: vi.fn(), commit: vi.fn() }));
vi.mock("@/server/auth/context", () => ({ getEffectiveHouseholdContext: async () => ({ role: "owner" }), requirePermission: vi.fn() }));
vi.mock("@/server/services/sprout-import", () => ({ previewSproutBackup: m.preview, importSproutBackup: m.commit, normalizeSproutError: (e: unknown) => e }));
vi.mock("@/lib/env", () => ({ attachmentConfig: { directory: "/unused" } }));
import { POST as preview } from "./preview/route";
import { POST as commit } from "./import/route";
import { withBackupUploadAdmission } from "@/server/services/backup-upload";
function multipart() { const data = new FormData(); data.set("previewId", "opaque"); return new Request("https://cubby.test/sprout", { method: "POST", body: data }); }
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });
it.each([preview, commit])("refuses before reading while the backup slot is held", async (route) => {
  await withBackupUploadAdmission(async () => {
    const request = multipart();
    const read = vi.spyOn(request, "formData");
    expect((await route(request)).status).toBe(429);
    expect(read).not.toHaveBeenCalled();
  });
});
it.each([preview, commit])("reads bounded actual bytes before multipart parsing", async (route) => {
  const request = multipart();
  const read = vi.spyOn(request.body!, "getReader");
  const original = vi.spyOn(request, "formData");
  expect((await route(request)).status).toBe(200);
  expect(read).toHaveBeenCalledOnce();
  expect(original).not.toHaveBeenCalled();
});
it("rejects an oversized commit body despite a misleading declared length", async () => {
  const request = new Request("https://cubby.test/sprout", { method: "POST", body: new Uint8Array(1024 * 1024 + 1), headers: { "content-type": "multipart/form-data; boundary=x", "content-length": "1" } });
  expect((await commit(request)).status).toBe(413);
  expect(m.commit).not.toHaveBeenCalled();
});
it("cancels a stalled authorized multipart body at its deadline", async () => {
  vi.useFakeTimers();
  const cancel = vi.fn();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const request = new Request("https://cubby.test/sprout", { method: "POST", body: new ReadableStream<Uint8Array>({ start(c) { controller = c; }, cancel }), headers: { "content-type": "multipart/form-data; boundary=x" }, duplex: "half" } as RequestInit);
  const pending = preview(request);
  try {
    await vi.advanceTimersByTimeAsync(120_001);
    expect(cancel).toHaveBeenCalledOnce();
    expect((await pending).status).toBe(408);
  } finally { if (!cancel.mock.calls.length) controller.close(); await pending; }
  expect(m.preview).not.toHaveBeenCalled();
});
