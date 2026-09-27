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
  it("contains keyboard focus, isolates the background, and restores the actual opener", () => {
    vi.useFakeTimers();
    try {
      const background = document.createElement("button");
      background.textContent = "Outside";
      document.body.append(background);
      const { container } = render(createElement(FeedPhotoGallery, { photos }));
      const opener = screen.getByRole("button", { name: "Open photo 2 of 2" });
      // Pointer opens need not focus their trigger (notably Safari).
      background.focus();
      fireEvent.click(opener);
      const viewer = screen.getByRole("dialog");
      expect(document.activeElement).toBe(viewer);
      expect(container.hasAttribute("inert")).toBe(true);
      expect(background.hasAttribute("inert")).toBe(true);
      expect(viewer.closest("[inert]")).toBeNull();
      fireEvent.keyDown(viewer, { key: "Tab", shiftKey: true });
      expect(document.activeElement).toBe(within(viewer).getByRole("button", { name: "Previous photo" }));
      fireEvent.keyDown(document.activeElement!, { key: "Tab" });
      expect(document.activeElement).toBe(within(viewer).getByRole("button", { name: "Save photo" }));
      act(() => vi.advanceTimersByTime(2100));
      expect(viewer.getAttribute("data-controls")).toBe("shown");
      // Pointer toggles must not hide a keyboard-focused interactive control either.
      fireEvent.click(viewer, { clientX: window.innerWidth / 2 });
      expect(viewer.getAttribute("data-controls")).toBe("shown");
      fireEvent.keyDown(viewer, { key: "Escape" });
      expect(document.activeElement).toBe(opener);
      expect(container.hasAttribute("inert")).toBe(false);
      expect(background.hasAttribute("inert")).toBe(false);
      background.remove();
    } finally { vi.useRealTimers(); }
  });


  it("shows the photos in the post, each a button that opens it in place rather than a link away", () => {
    render(createElement(FeedPhotoGallery, { photos }));
    const images = within(screen.getByRole("list", { name: "Photos" })).getAllByRole("img");

    // Grids load small copies; the photo's own shape still sets how much room each takes.
    expect(images.map((image) => [image.getAttribute("src"), image.getAttribute("width"), image.getAttribute("alt")])).toEqual([
      ["/api/attachments/photo-a?size=thumbnail", "2560", "Photo 1 of 2"],
      ["/api/attachments/photo-b?size=thumbnail", "1440", "Photo 2 of 2"]
    ]);
    expect(screen.queryAllByRole("link")).toEqual([]);
    expect(screen.getByRole("button", { name: "Open photo 2 of 2" })).toBeTruthy();
  });

  it("opens a photo full screen, and closes back to the feed with the Close button", () => {
    render(createElement(FeedPhotoGallery, { photos }));
    fireEvent.click(screen.getByRole("button", { name: "Open photo 2 of 2" }));

    const viewer = screen.getByRole("dialog", { name: "Photo 2 of 2" });
    // Full screen shows the photo itself, not the small copy.
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

  it("allows native pinch zoom and discards a single-finger swipe once a second finger joins", () => {
    render(createElement(FeedPhotoGallery, { photos }));
    fireEvent.click(screen.getByRole("button", { name: "Open photo 1 of 2" }));
    const viewer = screen.getByRole("dialog");
    fireEvent.touchStart(viewer, { touches: [{ clientX: 300, clientY: 200 }] });
    fireEvent.touchMove(viewer, { touches: [{ clientX: 240, clientY: 200 }] });
    fireEvent.touchStart(viewer, { touches: [{ clientX: 240, clientY: 200 }, { clientX: 400, clientY: 200 }] });
    fireEvent.touchEnd(viewer, { touches: [{ clientX: 400, clientY: 200 }], changedTouches: [{ clientX: 100, clientY: 200 }] });
    fireEvent.touchEnd(viewer, { touches: [], changedTouches: [{ clientX: 400, clientY: 400 }] });
    fireEvent.click(viewer, { clientX: window.innerWidth - 10 });
    expect(viewer.getAttribute("aria-label")).toBe("Photo 1 of 2");
    expect(within(viewer).getByRole("img").style.transform).toBe("");
    expect(viewer.classList.contains("touch-none")).toBe(false);
    expect(viewer.classList.contains("touch-pinch-zoom")).toBe(true);
    // Geometry contract only: jsdom cannot measure native layout or image aspect rendering.
    expect(viewer.className).toContain("fixed inset-0");
    expect(within(viewer).getByRole("img").className).toBe("relative max-h-full max-w-full object-contain");
  });

  it.each(["Close", "Back"])("restores the selected opener on %s without resetting focus on every photo", (method) => {
    render(createElement(FeedPhotoGallery, { photos }));
    const opener = screen.getByRole("button", { name: "Open photo 2 of 2" });
    fireEvent.click(opener);
    const save = screen.getByRole("button", { name: "Save photo" });
    act(() => save.focus());
    fireEvent.keyDown(save, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(save);
    if (method === "Close") fireEvent.click(screen.getByRole("button", { name: "Close photo" }));
    else fireEvent(window, new PopStateEvent("popstate"));
    expect(document.activeElement).toBe(opener);
  });

  it("reveals auto-hidden controls on Tab and keeps focus inside after a navigation button disappears", () => {
    vi.useFakeTimers();
    try {
      render(createElement(FeedPhotoGallery, { photos }));
      fireEvent.click(screen.getByRole("button", { name: "Open photo 1 of 2" }));
      const viewer = screen.getByRole("dialog");
      act(() => vi.advanceTimersByTime(2100));
      expect(viewer.getAttribute("data-controls")).toBe("hidden");
      expect([...viewer.querySelectorAll("button")].every((button) => button.tabIndex === -1)).toBe(true);
      fireEvent.keyDown(viewer, { key: "Tab" });
      expect(viewer.getAttribute("data-controls")).toBe("shown");
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Save photo" }));
      const next = screen.getByRole("button", { name: "Next photo" });
      act(() => next.focus());
      fireEvent.click(next);
      expect(document.activeElement).toBe(viewer);
      fireEvent.keyDown(viewer, { key: "Tab", shiftKey: true });
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Previous photo" }));
    } finally { vi.useRealTimers(); }
  });

  it("restores background isolation and overflow on unmount, preserving prior inert values", async () => {
    const existing = document.createElement("section");
    existing.setAttribute("inert", "already-isolated");
    document.body.append(existing);
    const before = document.body.style.overflow;
    document.body.style.overflow = "clip";
    const { unmount } = render(createElement(FeedPhotoGallery, { photos }));
    try {
      fireEvent.click(screen.getByRole("button", { name: "Open photo 1 of 2" }));
      const late = document.createElement("button");
      document.body.append(late);
      await act(async () => { await Promise.resolve(); });
      expect(late.hasAttribute("inert")).toBe(true);
      act(() => late.focus());
      expect(document.activeElement).toBe(screen.getByRole("dialog"));
      unmount();
      expect(late.hasAttribute("inert")).toBe(false);
      expect(existing.getAttribute("inert")).toBe("already-isolated");
      expect(document.body.style.overflow).toBe("clip");
      late.remove();
    } finally { existing.remove(); document.body.style.overflow = before; }
  });

  it.each(["move", "cancel", "zoom"])("never navigates or closes after %s interrupts a gesture", (mode) => {
    render(createElement(FeedPhotoGallery, { photos }));
    fireEvent.click(screen.getByRole("button", { name: "Open photo 1 of 2" }));
    const viewer = screen.getByRole("dialog");
    fireEvent.touchStart(viewer, { touches: [{ clientX: 300, clientY: 200 }] });
    if (mode === "zoom") vi.stubGlobal("visualViewport", { scale: 2 });
    if (mode === "cancel") fireEvent.touchCancel(viewer, { touches: [] });
    else fireEvent.touchMove(viewer, { touches: [{ clientX: 300, clientY: 400 }, { clientX: 400, clientY: 200 }] });
    fireEvent.touchEnd(viewer, { touches: [], changedTouches: [{ clientX: 300, clientY: 400 }] });
    fireEvent.click(viewer, { clientX: window.innerWidth - 1 });
    expect(screen.getByRole("dialog").getAttribute("aria-label")).toBe("Photo 1 of 2");
    expect(within(viewer).getByRole("img").style.transform).toBe("");
  });

  it("releases modal isolation when the displayed photo disappears during a refresh", () => {
    const { container, rerender } = render(createElement(FeedPhotoGallery, { photos }));
    const overflow = document.body.style.overflow;
    fireEvent.click(screen.getByRole("button", { name: "Open photo 2 of 2" }));
    expect(container.hasAttribute("inert")).toBe(true);
    rerender(createElement(FeedPhotoGallery, { photos: [] }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(container.hasAttribute("inert")).toBe(false);
    expect(document.body.style.overflow).toBe(overflow);
    expect(window.history.back).toHaveBeenCalledTimes(1);
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

  it("lays a gallery out as an even grid of squares, however many photos there are", () => {
    render(createElement(FeedPhotoGallery, { photos, layout: "grid" }));
    const grid = screen.getByRole("list", { name: "Photos" });
    expect(grid.className).toContain("grid-cols-3");
    expect(within(grid).getAllByRole("img").every((image) => image.className.includes("aspect-square"))).toBe(true);
  });

  it("offers no stepping for a single photo", () => {
    render(createElement(FeedPhotoGallery, { photos: [photos[0]] }));
    fireEvent.click(screen.getByRole("button", { name: "Open photo 1 of 1" }));
    expect(screen.queryByRole("button", { name: "Next photo" })).toBeNull();
  });
});
