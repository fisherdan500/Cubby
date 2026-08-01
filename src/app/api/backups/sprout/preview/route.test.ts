import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ previewSproutBackup: vi.fn() }));

vi.mock("@/server/services/sprout-import", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/services/sprout-import")>()),
  previewSproutBackup: mocks.previewSproutBackup
}));

import { POST } from "./route";

describe("POST /api/backups/sprout/preview", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("returns only sprout_import_failed without logging an unknown parser or staging marker", async () => {
    const marker = "SPROUT-SENSITIVE-MARKER-8c2af84b";
    mocks.previewSproutBackup.mockRejectedValue(new Error(`parser staging failure: ${marker}`));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await POST(request());
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body).toEqual({
      ok: false,
      error: {
        code: "sprout_import_failed",
        message: "The Sprout import could not be processed."
      }
    });
    expect(JSON.stringify(body)).not.toContain(marker);
    expect(error).not.toHaveBeenCalled();
  });
});

function request() {
  const form = new FormData();
  form.append("file", new Blob(["{}"], { type: "application/json" }), "data.json");
  return new Request("http://localhost/api/backups/sprout/preview", { method: "POST", body: form });
}
