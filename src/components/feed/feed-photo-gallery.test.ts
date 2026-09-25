// @vitest-environment jsdom
import React, { createElement } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FeedPhotoGallery } from "@/components/feed/feed-photo-gallery";

globalThis.React = React;

const photos = [
  { id: "photo-a", width: 2560, height: 1920 },
  { id: "photo-b", width: 1440, height: 2560 }
];

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

  it("closes with Escape or a tap outside the photo, and steps between photos", () => {
    render(createElement(FeedPhotoGallery, { photos }));
    fireEvent.click(screen.getByRole("button", { name: "Open photo 1 of 2" }));

    fireEvent.click(screen.getByRole("button", { name: "Next photo" }));
    expect(screen.getByRole("dialog", { name: "Photo 2 of 2" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Previous photo" }));
    expect(screen.getByRole("dialog", { name: "Photo 1 of 2" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(screen.getByRole("dialog", { name: "Photo 2 of 2" })).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Open photo 1 of 2" }));
    fireEvent.click(screen.getByTestId("photo-viewer-backdrop"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("offers no stepping for a single photo", () => {
    render(createElement(FeedPhotoGallery, { photos: [photos[0]] }));
    fireEvent.click(screen.getByRole("button", { name: "Open photo 1 of 1" }));
    expect(screen.queryByRole("button", { name: "Next photo" })).toBeNull();
  });
});
