// @vitest-environment jsdom
import React, { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/lib/browser-operation-tab-scope", () => ({ tabScopedBrowserOperationStorageKey: async (_p: string, key: string) => key }));
import { FeedPostCard } from "./feed-post-card";
import { FeedResponses } from "./feed-responses";
globalThis.React = React;
const opening = new Date("2026-09-25T10:00:00Z");
const newer = new Date("2026-09-25T11:00:00Z");
beforeEach(() => sessionStorage.clear());
afterEach(cleanup);
it.each(["post", "comment"])("freezes the %s revision at opening across a real prop refresh", async (kind) => {
  const response = (body: unknown) => ({ status: 200, ok: true, json: async () => body }) as Response;
  const fetcher = vi.fn().mockResolvedValueOnce(response({ ok: true, data: { version: 1, scope: "household", partition: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } }))
    .mockResolvedValueOnce(response({ ok: false, error: { message: "Changed meanwhile" } }));
  globalThis.fetch = fetcher;
  const view = (updatedAt: Date, body: string) => kind === "post"
    ? createElement(FeedPostCard, { post: { id: "p", babyId: null, body, occurredAt: opening, updatedAt, authorName: "A", canEdit: true, canRemove: false }, timeZone: "UTC" })
    : createElement(FeedResponses, { parentKind: "post", parentId: "p", comments: [{ id: "c", body, createdAt: opening, updatedAt, edited: false, authorName: "A", canEdit: true, canRemove: false }], reactions: [], canRespond: true, timeZone: "UTC" });
  const rendered = render(view(opening, "Original"));
  fireEvent.click(screen.getByRole("button", { name: kind === "post" ? "Edit post" : "Edit comment" }));
  const label = kind === "post" ? "Edit your post" : "Edit your comment";
  fireEvent.change(screen.getByLabelText(label), { target: { value: "My draft" } });
  rendered.rerender(view(newer, "Other tab saved"));
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toEqual({ expectedUpdatedAt: opening.toISOString() });
  expect((screen.getByLabelText(label) as HTMLTextAreaElement).value).toBe("My draft");
});
