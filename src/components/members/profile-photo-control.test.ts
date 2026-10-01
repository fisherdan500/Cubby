/**
 * Uploading your own profile picture.
 *
 * Two steps in a fixed order: the picture is uploaded privately, then claimed onto your membership.
 * A picture that fails to upload must never be claimed, or the member sees an error about the wrong
 * step and a meaningless id reaches the server.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { uploadAndClaimOwnPhoto } from "./profile-photo-control";

const jpeg = () => new File([new Uint8Array([1, 2, 3])], "me.jpg", { type: "image/jpeg" });

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(...responses: Array<{ status: number; body: unknown }>) {
  const calls: Array<{ url: string; method: string }> = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? "GET" });
    const next = responses.shift() ?? { status: 500, body: null };
    return {
      ok: next.status < 400,
      status: next.status,
      json: async () => next.body
    } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

describe("setting your own profile picture", () => {
  it("uploads, then claims it onto your own membership", async () => {
    const calls = stubFetch(
      { status: 201, body: { ok: true, data: { attachmentId: "att-9" } } },
      { status: 200, body: { ok: true, data: { attachmentId: "att-9" } } }
    );

    const result = await uploadAndClaimOwnPhoto(jpeg());

    expect(result).toEqual({ ok: true, attachmentId: "att-9" });
    // No member id in the claim: a member sets their own picture and nobody else's.
    expect(calls).toEqual([
      { url: "/api/attachments/user-photos", method: "POST" },
      { url: "/api/members/me/photo", method: "PUT" }
    ]);
  });

  it("does not claim anything when the upload fails", async () => {
    const calls = stubFetch({ status: 413, body: { ok: false, error: { message: "That picture is too large." } } });

    const result = await uploadAndClaimOwnPhoto(jpeg());

    expect(result).toEqual({ ok: false, message: "That picture is too large." });
    expect(calls).toHaveLength(1);
  });

  it("reports the claim's own failure rather than the upload's", async () => {
    stubFetch(
      { status: 201, body: { ok: true, data: { attachmentId: "att-9" } } },
      { status: 403, body: { ok: false, error: { message: "Your access has changed. Sign in again." } } }
    );

    const result = await uploadAndClaimOwnPhoto(jpeg());

    expect(result).toEqual({ ok: false, message: "Your access has changed. Sign in again." });
  });

  it("says something a person can act on when the network is down", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("offline");
    }));

    const result = await uploadAndClaimOwnPhoto(jpeg());

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain("connection");
  });

  it("does not claim a response that arrived without an id", async () => {
    const calls = stubFetch({ status: 201, body: { ok: true, data: {} } });

    const result = await uploadAndClaimOwnPhoto(jpeg());

    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(1);
  });
});
