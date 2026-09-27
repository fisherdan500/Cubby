// @vitest-environment jsdom
import React, { createElement } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => mocks }));
vi.mock("@/lib/browser-operation-tab-scope", () => ({ tabScopedBrowserOperationStorageKey: async (_p: string, key: string) => key }));
import { FeedPostComposer, runFeedOperation } from "./feed-post-actions";
import { FeedResponses } from "./feed-responses";
globalThis.React = React;
const id = "bmo_0123456789abcdefghjkmnpqrs";
const response = (data: unknown, status = 200) => ({ status, ok: true, json: async () => ({ ok: true, data }) }) as Response;
const partition = () => response({ version: 1, scope: "household", partition: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
const result = (status: string, kind = "post") => response({ status, operationId: id, ...(status === "open" ? { bindingId: "binding" } : status === "prepared" ? { code: "operation_prepared" } : { outcome: kind === "post" ? { operationId: id, kind: "feed_post", code: "created", postId: "p" } : { operationId: id, kind: "feed_comment", code: "created", commentId: "c" } }) }, status === "prepared" ? 202 : 200);
beforeEach(() => { sessionStorage.clear(); mocks.refresh.mockReset(); HTMLElement.prototype.scrollIntoView = vi.fn(); });
afterEach(cleanup);
it.each(["post", "comment"])("keeps the %s composer on a malformed terminal object", async (kind) => {
  globalThis.fetch = vi.fn().mockResolvedValueOnce(partition()).mockResolvedValueOnce(result("open"))
    .mockResolvedValueOnce(response({ status: "completed", operationId: id, outcome: {} }));
  if (kind === "post") render(createElement(FeedPostComposer, { babyId: "b", babyName: "Baby" }));
  else render(createElement(FeedResponses, { parentKind: "post", parentId: "p", comments: [], reactions: [], canRespond: true, timeZone: "UTC" }));
  fireEvent.click(screen.getByRole("button", { name: kind === "post" ? "Share a moment" : "Comment" }));
  const label = kind === "post" ? "What happened?" : "Your comment";
  fireEvent.change(screen.getByLabelText(label), { target: { value: "Keep my draft" } });
  fireEvent.click(screen.getByRole("button", { name: kind === "post" ? "Post" : "Send" }));
  await screen.findByRole("alert");
  expect((screen.getByLabelText(label) as HTMLTextAreaElement).value).toBe("Keep my draft");
  expect(mocks.refresh).not.toHaveBeenCalled(); expect(Object.values(sessionStorage)).toEqual([id]);
});
it.each(["post", "comment"])("preserves a changed %s draft after reconciling the earlier completion", async (kind) => {
  const fetcher = vi.fn().mockResolvedValueOnce(partition()).mockResolvedValueOnce(result("open")).mockRejectedValueOnce(new Error("lost"));
  globalThis.fetch = fetcher;
  if (kind === "post") render(createElement(FeedPostComposer, { babyId: "b", babyName: "Baby" }));
  else render(createElement(FeedResponses, { parentKind: "post", parentId: "p", comments: [], reactions: [], canRespond: true, timeZone: "UTC" }));
  fireEvent.click(screen.getByRole("button", { name: kind === "post" ? "Share a moment" : "Comment" }));
  const field = screen.getByLabelText(kind === "post" ? "What happened?" : "Your comment") as HTMLTextAreaElement;
  const submit = () => fireEvent.click(screen.getByRole("button", { name: kind === "post" ? "Post" : "Send" }));
  fireEvent.change(field, { target: { value: "A" } }); submit();
  await screen.findByRole("alert");
  fireEvent.change(field, { target: { value: "B" } });
  fetcher.mockResolvedValueOnce(partition()).mockResolvedValueOnce(result("completed", kind)); submit();
  await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/previous.*saved/i));
  expect(field.value).toBe("B"); expect(mocks.refresh).not.toHaveBeenCalled();
  fetcher.mockResolvedValueOnce(partition()).mockResolvedValueOnce(result("open")).mockResolvedValueOnce(result("completed", kind)); submit();
  await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
  expect(JSON.parse(String(fetcher.mock.calls[7][1]?.body)).body).toBe("B");
});
it.each(["post", "comment"])("does not clear a %s draft edited during the in-flight request", async (kind) => {
  let settle!: (value: Response) => void;
  globalThis.fetch = vi.fn().mockResolvedValueOnce(partition()).mockResolvedValueOnce(result("open")).mockReturnValueOnce(new Promise<Response>((resolve) => { settle = resolve; }));
  if (kind === "post") render(createElement(FeedPostComposer, { babyId: "b", babyName: "Baby" }));
  else render(createElement(FeedResponses, { parentKind: "post", parentId: "p", comments: [], reactions: [], canRespond: true, timeZone: "UTC" }));
  fireEvent.click(screen.getByRole("button", { name: kind === "post" ? "Share a moment" : "Comment" }));
  const label = kind === "post" ? "What happened?" : "Your comment";
  fireEvent.change(screen.getByLabelText(label), { target: { value: "A" } });
  fireEvent.click(screen.getByRole("button", { name: kind === "post" ? "Post" : "Send" }));
  await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(3));
  fireEvent.change(screen.getByLabelText(label), { target: { value: "B" } });
  await act(async () => settle(result("completed", kind)));
  expect((screen.getByLabelText(label) as HTMLTextAreaElement).value).toBe("B");
});
it.each(["prepared", "completed"])("never acknowledges unknown retained intent as the current draft (%s)", async (status) => {
  sessionStorage.setItem("unknown:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", id);
  globalThis.fetch = vi.fn().mockResolvedValueOnce(partition()).mockResolvedValueOnce(result(status));
  expect((await runFeedOperation("unknown", "/api/feed/posts", "POST", { body: "B" })).ok).toBe(false);
  expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  expect(sessionStorage.getItem("unknown:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toBe(status === "prepared" ? id : null);
});
it("never sends a changed intent under a prepared ID or persists plaintext drafts", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(partition()).mockResolvedValueOnce(result("open")).mockRejectedValueOnce(new Error("lost"));
  globalThis.fetch = fetcher;
  await runFeedOperation("prepared", "/api/feed/posts", "POST", { body: "private A", attachmentIds: ["att-A"] });
  expect(JSON.stringify(sessionStorage)).not.toContain("private A");
  fetcher.mockResolvedValueOnce(partition()).mockResolvedValueOnce(result("prepared"));
  expect((await runFeedOperation("prepared", "/api/feed/posts", "POST", { body: "private B", attachmentIds: ["att-B"] })).ok).toBe(false);
  expect(fetcher).toHaveBeenCalledTimes(5);
  expect(sessionStorage.getItem("prepared:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toBe(id);
});
