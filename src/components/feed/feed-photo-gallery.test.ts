// @vitest-environment jsdom
import React, { createElement } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FeedPhotoGallery } from "@/components/feed/feed-photo-gallery";

globalThis.React = React;

const photos = [
  { id: "photo-a", width: 2560, height: 1920 },
  { id: "photo-b", width: 1440, height: 2560 }
];

// The photo as the private photo address serves it.
const jpeg = () => new Response("jpeg-bytes", { status: 200, headers: { "Content-Type": "image/jpeg" } });

beforeEach(() => {
  vi.spyOn(window.history, "pushState");
  vi.spyOn(window.history, "back").mockImplementation(() => {
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (URL as { createObjectURL?: unknown }).createObjectURL;
  delete (URL as { revokeObjectURL?: unknown }).revokeObjectURL;
  delete (navigator as { share?: unknown }).share;
  delete (navigator as { canShare?: unknown }).canShare;
});

describe("FeedPhotoGallery", () => {
  it("shows the photos in the post, each a button that opens it in place rather than a link away", () => {
    render(createElement(FeedPhotoGallery, { photos }));
    const images = within(screen.getByRole("list", { name: "Photos" })).getAllByRole("img");

    expect(images.map((image) => [image.getAttribute("src"), image.getAttribute("width"), image.getAttribute("alt")])).toEqual([
      ["/api/attachments/photo-a", "2560", "Photo 1 of 2"],
      ["/api/attachments/photo-b", "1440", "Photo 2 of 2"]
    ]);
    expect(screen.queryAllByRole("link")).toEqual([]);
    expect(screen.getByRole("button", { name: "Open photo 2 of 2" })).toBeTruthy();
  });

  it("opens a photo full screen, and closes back to the feed with the Close button", () => {
    render(createElement(FeedPhotoGallery, { photos }));
    fireEvent.click(screen.getByRole("button", { name: "Open photo 2 of 2" }));

    const viewer = screen.getByRole("dialog", { name: "Photo 2 of 2" });
    expect(within(viewer).getByRole("img").getAttribute("src")).toBe("/api/attachments/photo-b");
    expect(window.history.pushState).toHaveBeenCalledTimes(1);

    fireEvent.click(within(viewer).getByRole("button", { name: "Close photo" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    // Closing undoes the history step opening added, so Back afterwards leaves the feed as usual.
    expect(window.history.back).toHaveBeenCalledTimes(1);
  });

  it("closes with the phone's back gesture, without leaving the feed", () => {
    render(createElement(FeedPhotoGallery, { photos }));
    fireEvent.click(screen.getByRole("button", { name: "Open photo 1 of 2" }));

    fireEvent(window, new PopStateEvent("popstate"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(window.history.back).not.toHaveBeenCalled();
  });

  it("closes with Escape, and steps with the buttons and arrow keys without running past either end", () => {
    render(createElement(FeedPhotoGallery, { photos }));
    fireEvent.click(screen.getByRole("button", { name: "Open photo 1 of 2" }));

    // Nothing before the first photo, so no way back from it.
    expect(screen.queryByRole("button", { name: "Previous photo" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Next photo" }));
    expect(screen.getByRole("dialog", { name: "Photo 2 of 2" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Next photo" })).toBeNull();
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(screen.getByRole("dialog", { name: "Photo 2 of 2" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Previous photo" }));
    expect(screen.getByRole("dialog", { name: "Photo 1 of 2" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(screen.getByRole("dialog", { name: "Photo 2 of 2" })).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  describe("gestures", () => {
    const three = [...photos, { id: "photo-c", width: 1000, height: 1000 }];
    const viewer = () => screen.getByRole("dialog");

    function swipe(from: [number, number], to: [number, number]) {
      fireEvent.touchStart(viewer(), { touches: [{ clientX: from[0], clientY: from[1] }] });
      fireEvent.touchMove(viewer(), { touches: [{ clientX: to[0], clientY: to[1] }] });
      fireEvent.touchEnd(viewer(), { changedTouches: [{ clientX: to[0], clientY: to[1] }] });
    }

    it("swipes left and right between photos, stopping at the first and last", () => {
      render(createElement(FeedPhotoGallery, { photos: three }));
      fireEvent.click(screen.getByRole("button", { name: "Open photo 1 of 3" }));

      swipe([300, 400], [360, 405]);
      expect(viewer().getAttribute("aria-label")).toBe("Photo 1 of 3");
      swipe([300, 400], [200, 410]);
      expect(viewer().getAttribute("aria-label")).toBe("Photo 2 of 3");
      swipe([300, 400], [200, 390]);
      expect(viewer().getAttribute("aria-label")).toBe("Photo 3 of 3");
      swipe([300, 400], [200, 400]);
      expect(viewer().getAttribute("aria-label")).toBe("Photo 3 of 3");
      swipe([200, 400], [300, 400]);
      expect(viewer().getAttribute("aria-label")).toBe("Photo 2 of 3");
    });

    it("closes with a swipe down, as the Photos app does, and not with a short or upward one", () => {
      render(createElement(FeedPhotoGallery, { photos: three }));
      fireEvent.click(screen.getByRole("button", { name: "Open photo 2 of 3" }));

      swipe([300, 400], [305, 430]);
      swipe([300, 400], [300, 250]);
      expect(screen.getByRole("dialog")).toBeTruthy();

      swipe([300, 300], [310, 450]);
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(window.history.back).toHaveBeenCalledTimes(1);
    });

    it("steps with a tap near either edge, and shows or hides the buttons with a tap in the middle", () => {
      render(createElement(FeedPhotoGallery, { photos: three }));
      fireEvent.click(screen.getByRole("button", { name: "Open photo 2 of 3" }));
      const width = window.innerWidth;

      fireEvent.click(viewer(), { clientX: width - 10, clientY: 300 });
      expect(viewer().getAttribute("aria-label")).toBe("Photo 3 of 3");
      fireEvent.click(viewer(), { clientX: 10, clientY: 300 });
      expect(viewer().getAttribute("aria-label")).toBe("Photo 2 of 3");

      expect(viewer().getAttribute("data-controls")).toBe("shown");
      fireEvent.click(viewer(), { clientX: width / 2, clientY: 300 });
      expect(viewer().getAttribute("data-controls")).toBe("hidden");
      fireEvent.click(viewer(), { clientX: width / 2, clientY: 300 });
      expect(viewer().getAttribute("data-controls")).toBe("shown");
      // A tap in the middle never closes the photo.
      expect(screen.getByRole("dialog")).toBeTruthy();
    });

    it("fades the buttons out after two seconds so the photo is clear, and a button tap does not step", () => {
      vi.useFakeTimers();
      try {
        render(createElement(FeedPhotoGallery, { photos: three }));
        fireEvent.click(screen.getByRole("button", { name: "Open photo 1 of 3" }));
        expect(viewer().getAttribute("data-controls")).toBe("shown");

        act(() => vi.advanceTimersByTime(2100));
        expect(viewer().getAttribute("data-controls")).toBe("hidden");

        // Close sits over the right edge; tapping it closes rather than stepping.
        fireEvent.click(screen.getByRole("button", { name: "Close photo" }), { clientX: window.innerWidth - 10 });
        expect(screen.queryByRole("dialog")).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("saves the open photo to the device from the private photo address", async () => {
    const fetchPhoto = vi.fn(async () => jpeg());
    vi.stubGlobal("fetch", fetchPhoto);
    const objectUrl = vi.fn(() => "blob:cubby/photo-b");
    const revoke = vi.fn();
    // jsdom has no object URLs; afterEach removes these.
    Object.assign(URL, { createObjectURL: objectUrl, revokeObjectURL: revoke });
    const clicked: Array<{ href: string; download: string }> = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ href: this.getAttribute("href") ?? "", download: this.download });
    });

    render(createElement(FeedPhotoGallery, { photos }));
    fireEvent.click(screen.getByRole("button", { name: "Open photo 2 of 2" }));
    fireEvent.click(screen.getByRole("button", { name: "Save photo" }));

    await waitFor(() => expect(clicked).toEqual([{ href: "blob:cubby/photo-b", download: "cubby-photo-b.jpg" }]));
    expect(fetchPhoto).toHaveBeenCalledWith("/api/attachments/photo-b", { credentials: "same-origin" });
    // The temporary address is let go once the download has started.
    await waitFor(() => expect(revoke).toHaveBeenCalledWith("blob:cubby/photo-b"), { timeout: 2000 });
    // Saving leaves the viewer open.
    expect(screen.getByRole("dialog", { name: "Photo 2 of 2" })).toBeTruthy();
  });

  it("says so when the photo could not be saved", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));
    render(createElement(FeedPhotoGallery, { photos }));
    fireEvent.click(screen.getByRole("button", { name: "Open photo 1 of 2" }));
    fireEvent.click(screen.getByRole("button", { name: "Save photo" }));

    expect((await screen.findByRole("alert")).textContent).toBe("Couldn't get the photo. Try again.");
  });

  it("offers Share beside Save on a computer that can share files", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jpeg()));
    const share = vi.fn(async (_data: { files: File[] }) => undefined);
    Object.assign(navigator, { share, canShare: () => true });

    render(createElement(FeedPhotoGallery, { photos }));
    fireEvent.click(screen.getByRole("button", { name: "Open photo 1 of 2" }));
    expect(screen.getByRole("button", { name: "Save photo" })).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Share photo" }));

    await waitFor(() => expect(share).toHaveBeenCalledTimes(1));
    const [file] = share.mock.calls[0][0].files;
    expect([file.name, file.type]).toEqual(["cubby-photo-a.jpg", "image/jpeg"]);
  });

  describe("on a phone", () => {
    // A touch screen that can share files: an iPhone, where a download only reaches the Files app and
    // the share sheet's Save Image is the way into Photos.
    function asPhone(share: (data: { files: File[] }) => Promise<void>) {
      vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === "(pointer: coarse)", media: query }));
      Object.assign(navigator, { share, canShare: () => true });
    }

    it("saves through the share sheet, with the photo fetched when opened so the sheet opens at once", async () => {
      const fetchPhoto = vi.fn(async () => jpeg());
      vi.stubGlobal("fetch", fetchPhoto);
      const share = vi.fn(async (_data: { files: File[] }) => undefined);
      asPhone(share);
      const download = vi.spyOn(HTMLAnchorElement.prototype, "click");

      render(createElement(FeedPhotoGallery, { photos }));
      fireEvent.click(screen.getByRole("button", { name: "Open photo 2 of 2" }));
      await waitFor(() => expect(fetchPhoto).toHaveBeenCalledWith("/api/attachments/photo-b", { credentials: "same-origin" }));
      // Ready before the tap: an iPhone only opens the sheet straight from a tap, not after a wait.
      await waitFor(() => expect(screen.getByRole("button", { name: "Save photo" }).getAttribute("data-ready")).toBe("true"));

      fireEvent.click(screen.getByRole("button", { name: "Save photo" }));

      expect(share).toHaveBeenCalledTimes(1);
      expect(share.mock.calls[0][0].files[0].name).toBe("cubby-photo-b.jpg");
      expect(fetchPhoto).toHaveBeenCalledTimes(1);
      expect(download).not.toHaveBeenCalled();
      // One button: Share would open the very same sheet.
      expect(screen.queryByRole("button", { name: "Share photo" })).toBeNull();
    });

    it("asks for one more tap when the phone refused the sheet because the photo was still arriving", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => jpeg()));
      const share = vi.fn(async () => {
        throw new DOMException("Not allowed", "NotAllowedError");
      });
      asPhone(share);

      render(createElement(FeedPhotoGallery, { photos }));
      fireEvent.click(screen.getByRole("button", { name: "Open photo 1 of 2" }));
      fireEvent.click(screen.getByRole("button", { name: "Save photo" }));

      expect((await screen.findByRole("status")).textContent).toBe("The photo is ready. Tap Save again, then Save Image.");
    });

    it("says nothing when the share sheet is closed without saving", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => jpeg()));
      const share = vi.fn(async () => {
        throw new DOMException("Share canceled", "AbortError");
      });
      asPhone(share);

      render(createElement(FeedPhotoGallery, { photos }));
      fireEvent.click(screen.getByRole("button", { name: "Open photo 1 of 2" }));
      await waitFor(() => expect(screen.getByRole("button", { name: "Save photo" }).getAttribute("data-ready")).toBe("true"));
      fireEvent.click(screen.getByRole("button", { name: "Save photo" }));

      await waitFor(() => expect(share).toHaveBeenCalledTimes(1));
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.queryByRole("status")).toBeNull();
    });
  });

  it("offers Share only where the device can share files", () => {
    render(createElement(FeedPhotoGallery, { photos }));
    fireEvent.click(screen.getByRole("button", { name: "Open photo 1 of 2" }));
    expect(screen.queryByRole("button", { name: "Share photo" })).toBeNull();
    expect(screen.getByRole("button", { name: "Save photo" })).toBeTruthy();
  });

  it("offers no stepping for a single photo", () => {
    render(createElement(FeedPhotoGallery, { photos: [photos[0]] }));
    fireEvent.click(screen.getByRole("button", { name: "Open photo 1 of 1" }));
    expect(screen.queryByRole("button", { name: "Next photo" })).toBeNull();
  });
});
