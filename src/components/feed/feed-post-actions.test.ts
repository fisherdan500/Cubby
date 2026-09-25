// @vitest-environment jsdom
import React, { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("@/lib/browser-operation-tab-scope", () => ({ tabScopedBrowserOperationStorageKey: async (_partition: string, key: string) => `${key}:tab:test` }));

import { FeedPostBody, FeedPostComposer, FeedPostRemoveButton, FeedPostRestoreButton } from "@/components/feed/feed-post-actions";

globalThis.React = React;
const response = (status: number, body: unknown) => ({ status, ok: status >= 200 && status < 300, json: async () => body }) as Response;
const operationId = "bmo_0123456789abcdefghjkmnpqrs";
const partition = () => response(200, { ok: true, data: { version: 1, scope: "household", partition: "household-a" } });

beforeEach(() => {
  sessionStorage.clear();
  mocks.refresh.mockReset();
  // jsdom has no object URLs; the composer only needs a stable string to preview with.
  URL.createObjectURL = vi.fn((file: Blob) => `blob:${(file as File).name}`);
  URL.revokeObjectURL = vi.fn();
});
afterEach(cleanup);

const photo = (name: string, type = "image/jpeg") => new File([new Uint8Array([1, 2, 3])], name, { type });
const uploaded = (attachmentId: string) => response(201, { ok: true, data: { attachmentId, width: 800, height: 600 } });

describe("FeedPostComposer photos", () => {
  it("offers photos only once they are switched on", () => {
    render(createElement(FeedPostComposer, { babyId: "baby-1", babyName: "Avery" }));
    fireEvent.click(screen.getByRole("button", { name: "Share a moment" }));
    expect(screen.queryByLabelText("Add photos")).toBeNull();
  });

  it("uploads chosen photos straight away, then shares them - with or without words", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(uploaded("att-1"))
      .mockResolvedValueOnce(uploaded("att-2"))
      .mockResolvedValueOnce(partition())
      .mockResolvedValueOnce(response(200, { ok: true, data: { status: "open", operationId } }))
      .mockResolvedValueOnce(response(200, { ok: true, data: { status: "completed", operationId } }));
    globalThis.fetch = fetchMock;
    render(createElement(FeedPostComposer, { babyId: "baby-1", babyName: "Avery", photosEnabled: true }));
    fireEvent.click(screen.getByRole("button", { name: "Share a moment" }));

    const picker = screen.getByLabelText("Add photos") as HTMLInputElement;
    expect(picker.accept).toBe("image/jpeg,image/png,image/webp");
    fireEvent.change(picker, { target: { files: [photo("a.jpg"), photo("b.png", "image/png")] } });

    await waitFor(() => expect(screen.getAllByRole("img")).toHaveLength(2));
    expect(fetchMock.mock.calls.slice(0, 2).map(([url, init]) => [url, init?.method, (init?.headers as Record<string, string>)["content-type"]])).toEqual([
      ["/api/attachments/feed-photos", "POST", "image/jpeg"],
      ["/api/attachments/feed-photos", "POST", "image/png"]
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Post" }));
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String(fetchMock.mock.calls[4][1]?.body))).toEqual({ operationId, body: "", babyId: "baby-1", attachmentIds: ["att-1", "att-2"] });
  });

  it("lets a chosen photo be taken out again before posting", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(uploaded("att-1")).mockResolvedValueOnce(uploaded("att-2"));
    render(createElement(FeedPostComposer, { babyId: "baby-1", babyName: "Avery", photosEnabled: true }));
    fireEvent.click(screen.getByRole("button", { name: "Share a moment" }));
    fireEvent.change(screen.getByLabelText("Add photos"), { target: { files: [photo("a.jpg"), photo("b.jpg")] } });
    await waitFor(() => expect(screen.getAllByRole("img")).toHaveLength(2));

    fireEvent.click(screen.getByRole("button", { name: "Remove photo 1" }));
    expect(screen.getAllByRole("img")).toHaveLength(1);
  });

  it("says why a photo could not be added, and keeps the rest", async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(uploaded("att-1"))
      .mockResolvedValueOnce(response(415, { ok: false, error: { code: "attachment_unsupported_format", message: "Choose a JPEG, PNG or WebP photo." } }));
    render(createElement(FeedPostComposer, { babyId: "baby-1", babyName: "Avery", photosEnabled: true }));
    fireEvent.click(screen.getByRole("button", { name: "Share a moment" }));
    fireEvent.change(screen.getByLabelText("Add photos"), { target: { files: [photo("a.jpg"), photo("b.jpg")] } });

    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/JPEG, PNG or WebP/));
    expect(screen.getAllByRole("img")).toHaveLength(1);
  });

  it("stops at ten photos", async () => {
    globalThis.fetch = vi.fn(async () => uploaded(`att-${Math.random()}`));
    render(createElement(FeedPostComposer, { babyId: "baby-1", babyName: "Avery", photosEnabled: true }));
    fireEvent.click(screen.getByRole("button", { name: "Share a moment" }));
    fireEvent.change(screen.getByLabelText("Add photos"), { target: { files: Array.from({ length: 12 }, (_, index) => photo(`${index}.jpg`)) } });

    await waitFor(() => expect(screen.getAllByRole("img")).toHaveLength(10));
    expect(globalThis.fetch).toHaveBeenCalledTimes(10);
    expect(screen.getByRole("alert").textContent).toMatch(/up to 10 photos/);
    expect(screen.queryByLabelText("Add photos")).toBeNull();
  });
});

describe("FeedPostRestoreButton", () => {
  it("brings a removed post back through an operation bound to it", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(partition())
      .mockResolvedValueOnce(response(200, { ok: true, data: { status: "open", operationId } }))
      .mockResolvedValueOnce(response(200, { ok: true, data: { status: "completed", operationId } }));
    globalThis.fetch = fetchMock;
    render(createElement(FeedPostRestoreButton, { postId: "post-1" }));
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));

    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls.slice(1).map(([url, init]) => [url, init?.method])).toEqual([
      ["/api/feed/posts/post-1/restore?issue=1", "POST"],
      ["/api/feed/posts/post-1/restore", "POST"]
    ]);
  });
});

describe("FeedPostComposer", () => {
  it("starts as a quiet prompt and opens to write", () => {
    render(createElement(FeedPostComposer, { babyId: "baby-1", babyName: "Avery" }));
    expect(screen.queryByLabelText("What happened?")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Share a moment" }));
    expect(screen.getByLabelText("What happened?")).toBeTruthy();
    expect((screen.getByLabelText("About Avery") as HTMLInputElement).checked).toBe(true);
  });

  it("posts through a server-issued operation, about the baby or the whole family", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(partition())
      .mockResolvedValueOnce(response(200, { ok: true, data: { status: "open", operationId } }))
      .mockResolvedValueOnce(response(200, { ok: true, data: { status: "completed", operationId } }));
    globalThis.fetch = fetchMock;
    render(createElement(FeedPostComposer, { babyId: "baby-1", babyName: "Avery" }));

    fireEvent.click(screen.getByRole("button", { name: "Share a moment" }));
    fireEvent.change(screen.getByLabelText("What happened?"), { target: { value: "Family walk #weekend" } });
    fireEvent.click(screen.getByLabelText("The whole family"));
    fireEvent.click(screen.getByRole("button", { name: "Post" }));

    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/browser-operations/partition", "/api/feed/posts?issue=1", "/api/feed/posts"]);
    expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body))).toEqual({ operationId, body: "Family walk #weekend", babyId: null });
    // Done: the composer closes, and nothing is left retained for a retry.
    expect(screen.queryByLabelText("What happened?")).toBeNull();
    expect(sessionStorage.getItem("cubby:feed-post-create:household-a:tab:test")).toBeNull();
  });

  it("asks for words before sending anything", () => {
    globalThis.fetch = vi.fn();
    render(createElement(FeedPostComposer, { babyId: "baby-1", babyName: "Avery" }));
    fireEvent.click(screen.getByRole("button", { name: "Share a moment" }));
    fireEvent.click(screen.getByRole("button", { name: "Post" }));

    expect(screen.getByRole("alert").textContent).toMatch(/Write something/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe("FeedPostRemoveButton", () => {
  it("asks before removing, then removes through an operation bound to the post", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(partition())
      .mockResolvedValueOnce(response(200, { ok: true, data: { status: "open", operationId } }))
      .mockResolvedValueOnce(response(200, { ok: true, data: { status: "completed", operationId } }));
    globalThis.fetch = fetchMock;
    render(createElement(FeedPostRemoveButton, { postId: "post-1" }));

    fireEvent.click(screen.getByRole("button", { name: "Remove post" }));
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));

    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      ["/api/browser-operations/partition", undefined],
      ["/api/feed/posts/post-1?issue=1", "DELETE"],
      ["/api/feed/posts/post-1", "DELETE"]
    ]);
  });

  it("can be backed out of", () => {
    globalThis.fetch = vi.fn();
    render(createElement(FeedPostRemoveButton, { postId: "post-1" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove post" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep" }));
    expect(screen.getByRole("button", { name: "Remove post" })).toBeTruthy();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe("FeedPostBody", () => {
  const linked = createElement("span", null, "First bath ", createElement("a", { href: "#" }, "#firsts"));

  it("shows the caption as written, and whether it was edited", () => {
    render(createElement(FeedPostBody, { postId: "post-1", body: "First bath #firsts", edited: true, canEdit: false }, linked));
    expect(screen.getByText("#firsts")).toBeTruthy();
    expect(screen.getByText("edited")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit post" })).toBeNull();
  });

  it("lets the author edit the caption through an operation bound to the post", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(partition())
      .mockResolvedValueOnce(response(200, { ok: true, data: { status: "open", operationId } }))
      .mockResolvedValueOnce(response(200, { ok: true, data: { status: "completed", operationId } }));
    globalThis.fetch = fetchMock;
    render(createElement(FeedPostBody, { postId: "post-1", body: "First bath #firsts", edited: false, canEdit: true }, linked));

    fireEvent.click(screen.getByRole("button", { name: "Edit post" }));
    const field = screen.getByLabelText("Edit your post") as HTMLTextAreaElement;
    expect(field.value).toBe("First bath #firsts");
    fireEvent.change(field, { target: { value: "First bath #firsts #splash" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls.slice(1).map(([url, init]) => [url, init?.method])).toEqual([
      ["/api/feed/posts/post-1?issue=1", "PATCH"],
      ["/api/feed/posts/post-1", "PATCH"]
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body))).toEqual({ operationId, body: "First bath #firsts #splash" });
    expect(screen.queryByLabelText("Edit your post")).toBeNull();
  });

  it("can be backed out of without saving", () => {
    globalThis.fetch = vi.fn();
    render(createElement(FeedPostBody, { postId: "post-1", body: "First bath", edited: false, canEdit: true }, linked));
    fireEvent.click(screen.getByRole("button", { name: "Edit post" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByText("#firsts")).toBeTruthy();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
