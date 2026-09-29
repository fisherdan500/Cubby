// @vitest-environment jsdom
import React, { createElement } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FeedPhotoGallery } from "@/components/feed/feed-photo-gallery";

globalThis.React = React;

// Opening a photo downloads the full-size image, and stepping to the next one starts that download from
// scratch. Two things make that feel slow that are true whatever the caching policy turns out to be:
//
//   1. Nothing is fetched ahead, so every step waits for a fresh round trip.
//   2. Until the full image arrives the viewer is blank black, so there is no feedback that a step
//      happened at all -- the same "did my tap register?" problem as the navigation tabs.
//
// The grid already loaded an 800px thumbnail for every photo, which is a fraction of the full size. The
// viewer shows that immediately as a placeholder and fades the full photo in over it, and it fetches the
// photos either side of the open one so a step has usually already started.

const photos = [
  { id: "photo-a", width: 2560, height: 1920 },
  { id: "photo-b", width: 1440, height: 2560 },
  { id: "photo-c", width: 1000, height: 1000 }
];

const preloadHrefs = () =>
  Array.from(document.head.querySelectorAll('link[rel="preload"][as="image"]'))
    .concat(Array.from(document.body.querySelectorAll('link[rel="preload"][as="image"]')))
    .map((link) => link.getAttribute("href"));

beforeEach(() => {
  vi.spyOn(window.history, "pushState");
  vi.spyOn(window.history, "back").mockImplementation(() => {
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("FeedPhotoGallery neighbour prefetch and placeholder", () => {
  it("fetches the photos either side of the open one, so a step has already started", () => {
    render(createElement(FeedPhotoGallery, { photos }));
    fireEvent.click(screen.getByRole("button", { name: "Open photo 2 of 3" }));

    // Both neighbours, and not the one already on screen -- that request is already in flight.
    expect(preloadHrefs().sort()).toEqual(["/api/attachments/photo-a", "/api/attachments/photo-c"]);
  });

  it("asks for nothing beyond the ends", () => {
    render(createElement(FeedPhotoGallery, { photos }));
    fireEvent.click(screen.getByRole("button", { name: "Open photo 1 of 3" }));

    // Only forward exists from the first photo.
    expect(preloadHrefs()).toEqual(["/api/attachments/photo-b"]);
  });

  it("moves the prefetch along as the open photo changes", () => {
    render(createElement(FeedPhotoGallery, { photos }));
    fireEvent.click(screen.getByRole("button", { name: "Open photo 1 of 3" }));
    fireEvent.click(screen.getByRole("button", { name: "Next photo" }));

    expect(preloadHrefs().sort()).toEqual(["/api/attachments/photo-a", "/api/attachments/photo-c"]);
  });

  it("prefetches nothing for a single photo, and nothing once closed", () => {
    render(createElement(FeedPhotoGallery, { photos: [photos[0]] }));
    fireEvent.click(screen.getByRole("button", { name: "Open photo 1 of 1" }));
    expect(preloadHrefs()).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Close photo" }));
    expect(preloadHrefs()).toEqual([]);
  });

  it("shows the thumbnail at once behind the full photo, so a step is never a blank screen", () => {
    render(createElement(FeedPhotoGallery, { photos }));
    fireEvent.click(screen.getByRole("button", { name: "Open photo 2 of 3" }));
    const viewer = screen.getByRole("dialog");

    // The placeholder is decoration: it must not become a second image for a screen reader to announce,
    // which is also what keeps getByRole("img") unambiguous for every other test in this suite.
    const placeholder = viewer.querySelector('img[aria-hidden="true"]');
    expect(placeholder?.getAttribute("src")).toBe("/api/attachments/photo-b?size=thumbnail");
    expect(within(viewer).getByRole("img").getAttribute("src")).toBe("/api/attachments/photo-b");
  });

  it("hides the full photo until it has arrived, then reveals it", () => {
    render(createElement(FeedPhotoGallery, { photos }));
    fireEvent.click(screen.getByRole("button", { name: "Open photo 1 of 3" }));
    const full = within(screen.getByRole("dialog")).getByRole("img") as HTMLImageElement;

    // Transparent while the thumbnail stands in for it, so the two do not visibly overlap.
    expect(full.style.opacity).toBe("0");
    fireEvent.load(full);
    expect(full.style.opacity).toBe("1");
  });

  it("goes back to the placeholder when the photo changes, rather than holding the previous one", () => {
    render(createElement(FeedPhotoGallery, { photos }));
    fireEvent.click(screen.getByRole("button", { name: "Open photo 1 of 3" }));
    const viewer = screen.getByRole("dialog");
    fireEvent.load(within(viewer).getByRole("img"));
    expect((within(viewer).getByRole("img") as HTMLImageElement).style.opacity).toBe("1");

    fireEvent.click(within(viewer).getByRole("button", { name: "Next photo" }));

    // Showing the previous photo's pixels under the new one's thumbnail would be worse than a wait.
    const full = within(viewer).getByRole("img") as HTMLImageElement;
    expect(full.getAttribute("src")).toBe("/api/attachments/photo-b");
    expect(full.style.opacity).toBe("0");
  });

  it("reveals a photo the browser already had, which fires no load event", () => {
    render(createElement(FeedPhotoGallery, { photos }));
    // A cached image can finish before React attaches its handler, so completeness is checked on mount
    // rather than waited for. Without this a reused photo would stay invisible behind its thumbnail.
    const complete = vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(true);
    try {
      fireEvent.click(screen.getByRole("button", { name: "Open photo 1 of 3" }));
      const full = within(screen.getByRole("dialog")).getByRole("img") as HTMLImageElement;
      expect(full.style.opacity).toBe("1");
    } finally {
      complete.mockRestore();
    }
  });
  it("re-checks a photo it has already shown once, instead of assuming it is still there", () => {
    // Stepping back to a photo whose id was previously marked loaded must not trust that stale mark: the
    // browser may have dropped it, and a photo assumed present but absent renders as nothing over its
    // thumbnail. The mark is cleared on every change and re-established only from the real element.
    render(createElement(FeedPhotoGallery, { photos }));
    fireEvent.click(screen.getByRole("button", { name: "Open photo 1 of 3" }));
    const viewer = screen.getByRole("dialog");
    fireEvent.load(within(viewer).getByRole("img"));

    fireEvent.click(within(viewer).getByRole("button", { name: "Next photo" }));
    // Back to photo-a, which was loaded a moment ago. jsdom reports complete=false, standing in for a
    // browser that no longer holds it, so it must be transparent again rather than assumed ready.
    fireEvent.click(within(viewer).getByRole("button", { name: "Previous photo" }));

    const full = within(viewer).getByRole("img") as HTMLImageElement;
    expect(full.getAttribute("src")).toBe("/api/attachments/photo-a");
    expect(full.style.opacity).toBe("0");
  });
});
