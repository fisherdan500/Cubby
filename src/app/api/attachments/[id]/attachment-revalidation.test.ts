// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The endpoint used to send `no-store`, so a photo was re-downloaded on every view and every full-size view
// re-read and re-hashed the file. `no-cache` is a different instruction: the browser may keep a copy but
// must ask before reusing it. Every view therefore still reaches this route and is authorized afresh,
// which is what DEC-PROD-144 (DISC-Q-0241) requires; what is avoided is re-sending bytes that have not
// changed.
//
// The validator is the attachment's own content hash, so it changes if the bytes ever do.

const mocks = vi.hoisted(() => ({ openAttachment: vi.fn(), stageFeedPhoto: vi.fn() }));
vi.mock("@/server/services/attachments", () => ({
  openAttachment: mocks.openAttachment,
  stageFeedPhoto: mocks.stageFeedPhoto
}));

const photoId = "a".repeat(25);
const DIGEST = "b".repeat(64);
const url = (query = "") => `https://cubby.test/api/attachments/${photoId}${query}`;

beforeEach(() => {
  mocks.openAttachment.mockResolvedValue({
    bytes: Buffer.from("jpeg"),
    mimeType: "image/jpeg",
    digest: DIGEST,
    notModified: false
  });
});
afterEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

describe("GET /api/attachments/[id] revalidation", () => {
  it("lets a browser keep a copy but never reuse it without asking", async () => {
    const { GET } = await import("./route");
    const response = await GET(new Request(url()), { params: { id: photoId } });

    // no-cache, NOT no-store: the copy may be kept, and the request still arrives here every time.
    expect(response.headers.get("cache-control")).toBe("private, no-cache");
    expect(response.headers.get("etag")).toBe(`"${DIGEST}"`);
    // The rest of the private-delivery headers are unchanged.
    expect(Object.fromEntries(response.headers)).toMatchObject({
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cross-origin-resource-policy": "same-origin",
      "referrer-policy": "no-referrer"
    });
  });

  it("passes the browser's version to the service so it can skip reading the file", async () => {
    const { GET } = await import("./route");
    await GET(new Request(url(), { headers: { "if-none-match": `"${DIGEST}"` } }), { params: { id: photoId } });

    expect(mocks.openAttachment).toHaveBeenCalledWith(photoId, { knownDigests: [DIGEST] });
  });

  it("answers 304 with no body when the version still matches", async () => {
    mocks.openAttachment.mockResolvedValue({ bytes: null, mimeType: "image/jpeg", digest: DIGEST, notModified: true });
    const { GET } = await import("./route");
    const response = await GET(new Request(url(), { headers: { "if-none-match": `"${DIGEST}"` } }), { params: { id: photoId } });

    expect(response.status).toBe(304);
    expect(await response.arrayBuffer()).toEqual(new ArrayBuffer(0));
    // A 304 must still carry the validator and the caching rule, or the browser cannot keep revalidating.
    expect(response.headers.get("etag")).toBe(`"${DIGEST}"`);
    expect(response.headers.get("cache-control")).toBe("private, no-cache");
    // And it must NOT claim a body length it is not sending.
    expect(response.headers.get("content-length")).toBeNull();
  });

  it("tolerates the quoting and weak-validator forms a browser may send", async () => {
    const { GET } = await import("./route");
    for (const header of [`"${DIGEST}"`, DIGEST, `W/"${DIGEST}"`, `"other", "${DIGEST}"`]) {
      mocks.openAttachment.mockClear();
      await GET(new Request(url(), { headers: { "if-none-match": header } }), { params: { id: photoId } });
      const [, passed] = mocks.openAttachment.mock.calls[0] as [string, { knownDigests: string[] }];
      // Any one of the versions a browser offers may be the one it holds, so all of them travel.
      expect(passed.knownDigests, header).toContain(DIGEST);
    }
  });

  it("asks for the thumbnail's own version, not the photo's", async () => {
    const { GET } = await import("./route");
    await GET(new Request(url("?size=thumbnail"), { headers: { "if-none-match": `"${DIGEST}-thumbnail"` } }), {
      params: { id: photoId }
    });

    expect(mocks.openAttachment).toHaveBeenCalledWith(photoId, { size: "thumbnail", knownDigests: [`${DIGEST}-thumbnail`] });
  });

  it("sends `*` to the service as no version at all", async () => {
    const { GET } = await import("./route");
    // `If-None-Match: *` means "if any version exists". For a private photo whose identity is the digest,
    // honouring that would return 304 for bytes the caller may never have seen.
    await GET(new Request(url(), { headers: { "if-none-match": "*" } }), { params: { id: photoId } });

    expect(mocks.openAttachment).toHaveBeenCalledWith(photoId, { knownDigests: [] });
  });

  it("keeps a refusal uncacheable, so it can never be reused as an answer", async () => {
    mocks.openAttachment.mockRejectedValue(new Error("not_found"));
    const { GET } = await import("./route");
    const response = await GET(new Request(url()), { params: { id: photoId } });

    expect(response.status).toBe(404);
    // An error carries no validator and must not be kept: `no-store` remains right for these.
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("etag")).toBeNull();
  });

  it("does not look up an id that could not be one, even with a version", async () => {
    const { GET } = await import("./route");
    const response = await GET(new Request(url(), { headers: { "if-none-match": `"${DIGEST}"` } }), {
      params: { id: "../../etc/passwd" }
    });

    expect(response.status).toBe(404);
    expect(mocks.openAttachment).not.toHaveBeenCalled();
  });
});
