import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ stageFeedPhoto: vi.fn(), openAttachment: vi.fn() }));
vi.mock("@/server/services/attachments", () => ({ stageFeedPhoto: mocks.stageFeedPhoto, openAttachment: mocks.openAttachment }));

import { GET } from "@/app/api/attachments/[id]/route";
import { POST } from "@/app/api/attachments/feed-photos/route";

beforeEach(() => vi.resetAllMocks());

// Shaped like the ids the database issues.
const photoId = "cmg4x2v9k0000ab12cd34ef56";

function upload(body: BodyInit, headers: Record<string, string> = {}) {
  return new Request("https://cubby.test/api/attachments/feed-photos", { method: "POST", body, headers: { "content-type": "image/jpeg", ...headers } });
}

describe("POST /api/attachments/feed-photos", () => {
  it("stages the uploaded bytes and answers with the new attachment", async () => {
    mocks.stageFeedPhoto.mockResolvedValue({ attachmentId: "att-1", width: 800, height: 600 });
    const response = await POST(upload(new Uint8Array([1, 2, 3])));

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ok: true, data: { attachmentId: "att-1", width: 800, height: 600 } });
    expect(mocks.stageFeedPhoto).toHaveBeenCalledWith(Buffer.from([1, 2, 3]));
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("refuses an upload declared or found to be over 25 MB without staging it", async () => {
    let response = await POST(upload(new Uint8Array([1]), { "content-length": String(25 * 1024 * 1024 + 1) }));
    expect(response.status).toBe(413);

    response = await POST(upload(new Uint8Array(25 * 1024 * 1024 + 1)));
    expect(response.status).toBe(413);
    expect(mocks.stageFeedPhoto).not.toHaveBeenCalled();
  });

  it("says plainly when photos are off, unsupported, or cannot be saved", async () => {
    mocks.stageFeedPhoto.mockRejectedValueOnce(new Error("attachment_type_unavailable"));
    expect((await POST(upload(new Uint8Array([1])))).status).toBe(404);
    mocks.stageFeedPhoto.mockRejectedValueOnce(new Error("attachment_unsupported_format"));
    const unsupported = await POST(upload(new Uint8Array([1])));
    expect(unsupported.status).toBe(415);
    expect((await unsupported.json()).error.message).toMatch(/JPEG, PNG or WebP/);
    mocks.stageFeedPhoto.mockRejectedValueOnce(new Error("attachment_store_unavailable"));
    expect((await POST(upload(new Uint8Array([1])))).status).toBe(503);
  });
});

describe("GET /api/attachments/[id]", () => {
  it("serves the photo privately, never cached, sniffed or run as a page", async () => {
    mocks.openAttachment.mockResolvedValue({ bytes: Buffer.from("jpeg"), mimeType: "image/jpeg" });
    const response = await GET(new Request(`https://cubby.test/api/attachments/${photoId}`), { params: { id: photoId } });

    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe("jpeg");
    expect(Object.fromEntries(response.headers)).toMatchObject({
      "content-type": "image/jpeg",
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "content-disposition": 'inline; filename="photo.jpg"',
      "cross-origin-resource-policy": "same-origin",
      "referrer-policy": "no-referrer",
      "content-length": "4"
    });
    expect(mocks.openAttachment).toHaveBeenCalledWith(photoId);
  });

  it("answers the same way whenever the photo cannot be shown to this person", async () => {
    mocks.openAttachment.mockRejectedValue(new Error("not_found"));
    const response = await GET(new Request(`https://cubby.test/api/attachments/${photoId}`), { params: { id: photoId } });
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("private, no-store");

    mocks.openAttachment.mockRejectedValue(new Error("unauthenticated"));
    expect((await GET(new Request(`https://cubby.test/api/attachments/${photoId}`), { params: { id: photoId } })).status).toBe(401);
  });

  it("does not look up an id that could not be one", async () => {
    const response = await GET(new Request("https://cubby.test/api/attachments/x"), { params: { id: "../../etc/passwd" } });
    expect(response.status).toBe(404);
    expect(mocks.openAttachment).not.toHaveBeenCalled();
  });
});
