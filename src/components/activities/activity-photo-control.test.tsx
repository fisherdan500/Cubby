// @vitest-environment jsdom
/**
 * Adding a photo to a logged entry.
 *
 * The photo is uploaded privately first and only then attached, by creating the entry's photo post.
 * That order matters: an upload that fails must never produce a post, or the family sees an empty
 * moment and an error about the wrong step.
 *
 * The post carries the entry's id, so Moments shows the entry and its photo as one moment, and the
 * photo stays an ordinary feed photo on a real post -- which is what keeps private delivery and
 * backups working.
 */
import { createElement } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ runFeedOperation: vi.fn(), refresh: vi.fn() }));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh, push: vi.fn() }) }));
vi.mock("@/components/feed/feed-post-actions", () => ({ runFeedOperation: mocks.runFeedOperation }));

import { ActivityPhotoControl } from "./activity-photo-control";

const file = () => new File([new Uint8Array([1, 2, 3])], "wren.jpg", { type: "image/jpeg" });

function mockUpload(result: { ok: boolean; attachmentId?: string }) {
  globalThis.fetch = vi.fn(async () => ({
    ok: result.ok,
    json: async () => (result.ok
      ? { ok: true, data: { attachmentId: result.attachmentId } }
      : { ok: false, error: { message: "That photo is too large." } })
  })) as unknown as typeof fetch;
}

beforeEach(() => {
  cleanup();
  mocks.runFeedOperation.mockReset();
  mocks.refresh.mockReset();
  mocks.runFeedOperation.mockResolvedValue({ ok: true });
});

describe("adding a photo to an entry", () => {
  it("uploads the picture before creating anything", async () => {
    mockUpload({ ok: true, attachmentId: "att-1" });
    render(createElement(ActivityPhotoControl, { activityId: "act-1", babyId: "baby-1" }));

    await userEvent.upload(screen.getByLabelText(/add a photo/i), file());

    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe("/api/attachments/feed-photos");
    expect((init as RequestInit).method).toBe("POST");
  });

  it("attaches the uploaded photo to this entry", async () => {
    mockUpload({ ok: true, attachmentId: "att-1" });
    render(createElement(ActivityPhotoControl, { activityId: "act-1", babyId: "baby-1" }));

    await userEvent.upload(screen.getByLabelText(/add a photo/i), file());

    await waitFor(() => expect(mocks.runFeedOperation).toHaveBeenCalled());
    const payload = mocks.runFeedOperation.mock.calls[0]![3] as Record<string, unknown>;
    // The entry id is what makes Moments show one combined moment.
    expect(payload.activityId).toBe("act-1");
    expect(payload.attachmentIds).toEqual(["att-1"]);
    expect(payload.babyId).toBe("baby-1");
  });

  it("never creates a post when the upload fails", async () => {
    mockUpload({ ok: false });
    render(createElement(ActivityPhotoControl, { activityId: "act-1", babyId: "baby-1" }));

    await userEvent.upload(screen.getByLabelText(/add a photo/i), file());

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    // An empty moment would be worse than no moment.
    expect(mocks.runFeedOperation).not.toHaveBeenCalled();
  });

  it("says what went wrong when attaching fails", async () => {
    mockUpload({ ok: true, attachmentId: "att-1" });
    mocks.runFeedOperation.mockResolvedValue({ ok: false, message: "Could not add the photo." });
    render(createElement(ActivityPhotoControl, { activityId: "act-1", babyId: "baby-1" }));

    await userEvent.upload(screen.getByLabelText(/add a photo/i), file());

    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/could not add the photo/i));
  });

  it("shows the new photo once it is attached", async () => {
    mockUpload({ ok: true, attachmentId: "att-1" });
    render(createElement(ActivityPhotoControl, { activityId: "act-1", babyId: "baby-1" }));

    await userEvent.upload(screen.getByLabelText(/add a photo/i), file());

    // The page reloads so the entry shows its photo, rather than the control faking it.
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalled());
  });

  it("uploads once when the same file is chosen twice in quick succession", async () => {
    let release: (value: unknown) => void = () => {};
    const calls: string[] = [];
    globalThis.fetch = vi.fn((url: string) => {
      calls.push(String(url));
      return new Promise((resolve) => { release = resolve; });
    }) as unknown as typeof fetch;
    render(createElement(ActivityPhotoControl, { activityId: "act-1", babyId: "baby-1" }));

    const input = screen.getByLabelText(/add a photo/i) as HTMLInputElement;
    // Two choices racing the first upload: a double tap, or a slow connection the family retries on.
    await userEvent.upload(input, file());
    await userEvent.upload(input, file());

    // One picture chosen must become one upload and one post, never two of either.
    expect(calls).toHaveLength(1);

    release({ ok: true, json: async () => ({ ok: true, data: { attachmentId: "att-1" } }) });
    await waitFor(() => expect(mocks.runFeedOperation).toHaveBeenCalledTimes(1));
  });
});
