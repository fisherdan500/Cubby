// @vitest-environment jsdom
import React, { createElement } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => mocks }));
vi.mock("@/lib/browser-operation-tab-scope", () => ({ tabScopedBrowserOperationStorageKey: async (_p: string, key: string) => key }));
import { FeedPostComposer } from "./feed-post-actions";
import { FeedPostCard } from "./feed-post-card";
globalThis.React = React;
const response = (data: unknown) => ({ status: 200, ok: true, json: async () => ({ ok: true, data }) }) as Response;
const id = "bmo_0123456789abcdefghjkmnpqrs";
beforeEach(() => { sessionStorage.clear(); mocks.refresh.mockReset(); URL.createObjectURL = vi.fn(() => "blob:preview"); URL.revokeObjectURL = vi.fn(); });
afterEach(cleanup);
function composer() {
  const view = render(createElement(FeedPostComposer, { babyId: "b", babyName: "Baby", photosEnabled: true }));
  fireEvent.click(screen.getByRole("button", { name: "Share a moment" }));
  fireEvent.change(screen.getByLabelText("Add photos"), { target: { files: [new File(["fixture"], "photo.jpg", { type: "image/jpeg" })] } });
  return view;
}
it("revokes abandoned previews exactly once on unmount", async () => {
  globalThis.fetch = vi.fn().mockResolvedValue(response({ attachmentId: "a" }));
  const view = composer(); await screen.findByRole("img"); view.unmount();
  expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:preview");
});
it("does not allocate a preview from a late upload after unmount", async () => {
  let settle!: (value: Response) => void;
  globalThis.fetch = vi.fn().mockReturnValue(new Promise<Response>((resolve) => { settle = resolve; }));
  const view = composer(); view.unmount();
  await act(async () => settle(response({ attachmentId: "a" })));
  expect(URL.createObjectURL).not.toHaveBeenCalled();
});
it("hiding an uncertain photo draft retains its operation and photo references", async () => {
  globalThis.fetch = vi.fn().mockResolvedValueOnce(response({ attachmentId: "a" }))
    .mockResolvedValueOnce(response({ version: 1, scope: "household", partition: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }))
    .mockResolvedValueOnce(response({ status: "open", operationId: id, bindingId: "binding" })).mockRejectedValueOnce(new Error("lost"));
  composer(); await screen.findByRole("img");
  fireEvent.click(screen.getByRole("button", { name: "Post" })); await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(sessionStorage.getItem("cubby:feed-post-create:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toBe(id);
  expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Share a moment" }));
  expect(screen.getByRole("img").getAttribute("src")).toBe("blob:preview");
});
it.each(["available", "unavailable", "none"])("clears optional captions only with retained photos: %s", async (photoState) => {
  const hasPhotos = photoState !== "none";
  const fetcher = vi.fn().mockResolvedValueOnce(response({ version: 1, scope: "household", partition: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }))
    .mockResolvedValueOnce(response({ status: "open", operationId: id, bindingId: "binding" }))
    .mockResolvedValueOnce(response({ status: "completed", operationId: id, outcome: { operationId: id, kind: "feed_post", code: "updated", postId: "p" } }));
  globalThis.fetch = fetcher;
  render(createElement(FeedPostCard, { post: { id: "p", babyId: null, body: "Caption", occurredAt: new Date(), updatedAt: new Date(), authorName: "A", canRemove: false, canEdit: true, hasRetainedPhotos: hasPhotos, photos: photoState === "available" ? [{ id: "a", width: 1, height: 1 }] : [] }, timeZone: "UTC" }));
  fireEvent.click(screen.getByRole("button", { name: "Edit post" }));
  fireEvent.change(screen.getByLabelText("Edit your post"), { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  if (hasPhotos) {
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledOnce());
    expect(JSON.parse(String(fetcher.mock.calls[2][1]?.body)).body).toBe("");
  } else { expect(fetcher).not.toHaveBeenCalled(); expect(screen.getByRole("alert").textContent).toMatch(/Write something/); }
});
