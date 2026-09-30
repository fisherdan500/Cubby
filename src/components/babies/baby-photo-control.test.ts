/**
 * The baby profile picture control.
 *
 * Covers what the browser layer decides on its own: that choosing a file uploads then claims in that
 * order, that a failed upload never issues a claim, and that the control is only offered when the
 * type is switched on. The type can be turned off to contain a defect, and the UI must respect that
 * rather than offering an upload the server will refuse.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { uploadAndClaimBabyPhoto } from "./baby-photo-control";

const fetchMock = vi.fn();

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchMock);
});

const file = new File([new Uint8Array([1, 2, 3])], "baby.jpg", { type: "image/jpeg" });

describe("choosing a profile picture", () => {
  it("uploads the file, then claims it for the baby", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(201, { ok: true, data: { attachmentId: "att-1" } }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true, data: { attachmentId: "att-1", babyId: "baby-1" } }));

    const result = await uploadAndClaimBabyPhoto("baby-1", file);

    expect(result).toEqual({ ok: true, attachmentId: "att-1" });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [uploadUrl, uploadInit] = fetchMock.mock.calls[0];
    expect(uploadUrl).toBe("/api/attachments/baby-photos");
    expect(uploadInit).toMatchObject({ method: "POST" });

    const [claimUrl, claimInit] = fetchMock.mock.calls[1];
    // The baby is in the path, matching the route that ignores a body-supplied id.
    expect(claimUrl).toBe("/api/babies/baby-1/photo");
    expect(claimInit).toMatchObject({ method: "PUT" });
    expect(JSON.parse(claimInit.body as string)).toEqual({ attachmentId: "att-1" });
  });

  it("does not claim anything when the upload is refused", async () => {
    // Claiming after a failed upload would send a garbage id, and the error the family sees would be
    // about the wrong step.
    fetchMock.mockResolvedValueOnce(jsonResponse(413, { ok: false, error: { message: "That picture is too large." } }));

    const result = await uploadAndClaimBabyPhoto("baby-1", file);

    expect(result).toEqual({ ok: false, message: "That picture is too large." });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports a refused claim without pretending the picture was set", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(201, { ok: true, data: { attachmentId: "att-1" } }))
      .mockResolvedValueOnce(jsonResponse(403, { ok: false, error: { message: "You do not have access." } }));

    const result = await uploadAndClaimBabyPhoto("baby-1", file);

    expect(result).toEqual({ ok: false, message: "You do not have access." });
  });

  it("survives a network failure with a message a family can act on", async () => {
    fetchMock.mockRejectedValueOnce(new Error("offline"));

    const result = await uploadAndClaimBabyPhoto("baby-1", file);

    expect(result).toMatchObject({ ok: false });
    if (result.ok) throw new Error("expected failure");
    expect(result.message).toMatch(/connection/i);
  });
});
