// @vitest-environment jsdom
import React, { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("@/lib/browser-operation-tab-scope", () => ({ tabScopedBrowserOperationStorageKey: async (_partition: string, key: string) => `${key}:tab:test` }));

import { FeedResponses } from "@/components/feed/feed-responses";

globalThis.React = React;
const response = (status: number, body: unknown) => ({ status, ok: status >= 200 && status < 300, json: async () => body }) as Response;
const operationId = "bmo_0123456789abcdefghjkmnpqrs";
const partition = () => response(200, { ok: true, data: { version: 1, scope: "household", partition: "household-a" } });

function operationFetch() {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(partition())
    .mockResolvedValueOnce(response(200, { ok: true, data: { status: "open", operationId } }))
    .mockResolvedValueOnce(response(200, { ok: true, data: { status: "completed", operationId } }));
  globalThis.fetch = fetchMock;
  return fetchMock;
}

const sent = (fetchMock: ReturnType<typeof vi.fn>) =>
  fetchMock.mock.calls.slice(1).map(([url, init]) => [url, init?.method, JSON.parse(String(init?.body))]);

const comment = (overrides: object = {}) => ({
  id: "comment-1", body: "So sweet", authorName: "Alex", createdAt: new Date("2026-09-27T10:00:00Z"),
  edited: false, canEdit: false, canRemove: false, ...overrides
});

function renderResponses(overrides: object = {}) {
  return render(createElement(FeedResponses, {
    parentKind: "post",
    parentId: "post-1",
    reactions: [{ key: "love", emoji: "❤️", label: "love", names: ["You", "Alex"], mine: true }],
    comments: [],
    canRespond: true,
    timeZone: "UTC",
    ...overrides
  }));
}

// Every browser has scrollIntoView; jsdom does not.
const scrolled = vi.fn();
beforeEach(() => {
  sessionStorage.clear();
  mocks.refresh.mockReset();
  scrolled.mockReset();
  HTMLElement.prototype.scrollIntoView = scrolled;
});
afterEach(() => {
  cleanup();
  delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
});

describe("FeedResponses reactions", () => {
  it("shows who reacted by name, never a number, and offers all four reactions", () => {
    renderResponses();
    const chosen = screen.getByRole("list", { name: "Reactions" });
    expect(chosen.textContent).toContain("You and Alex");
    expect(chosen.textContent).not.toMatch(/\d/);

    const buttons = within(screen.getByRole("group", { name: "React" })).getAllByRole("button");
    // Four, so the Comment button fits on the same row on a phone.
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual(["love", "funny", "aww", "celebrate"]);
    expect(buttons.map((button) => button.getAttribute("aria-pressed"))).toEqual(["true", "false", "false", "false"]);
  });

  it("turns a reaction on through an operation bound to the post", async () => {
    const fetchMock = operationFetch();
    renderResponses();
    fireEvent.click(screen.getByRole("button", { name: "celebrate" }));

    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
    expect(sent(fetchMock)).toEqual([
      ["/api/feed/reactions?issue=1", "PUT", { parentKind: "post", parentId: "post-1" }],
      ["/api/feed/reactions", "PUT", { operationId, parentKind: "post", parentId: "post-1", reaction: "celebrate", on: true }]
    ]);
  });

  it("turns off a reaction this member already chose", async () => {
    const fetchMock = operationFetch();
    renderResponses({ parentKind: "activity", parentId: "activity-1" });
    fireEvent.click(screen.getByRole("button", { name: "love" }));

    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
    expect(sent(fetchMock)[1][2]).toMatchObject({ parentKind: "activity", parentId: "activity-1", reaction: "love", on: false });
  });
});

describe("FeedResponses comments", () => {
  it("lists comments oldest first with who wrote them, marking edited ones", () => {
    renderResponses({ comments: [comment(), comment({ id: "comment-2", body: "Big day", authorName: "Sam", edited: true })] });
    const items = within(screen.getByRole("list", { name: "Comments" })).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining("Alex"),
      expect.stringMatching(/Sam.*Big day.*edited/)
    ]);
    expect(screen.queryByRole("button", { name: "Edit comment" })).toBeNull();
  });

  it("adds a comment through an operation bound to what it is on", async () => {
    const fetchMock = operationFetch();
    renderResponses({ parentKind: "activity", parentId: "activity-1" });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    fireEvent.change(screen.getByLabelText("Your comment"), { target: { value: "Well done, little one" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
    expect(sent(fetchMock)).toEqual([
      ["/api/feed/comments?issue=1", "POST", { parentKind: "activity", parentId: "activity-1" }],
      ["/api/feed/comments", "POST", { operationId, parentKind: "activity", parentId: "activity-1", body: "Well done, little one" }]
    ]);
    expect(screen.queryByLabelText("Your comment")).toBeNull();
  });

  it("opens the keyboard at once: the comment box is focused within the tap itself and brought into view", () => {
    renderResponses({ comments: [comment()] });

    // A plain tap, outside the test helper that finishes React's work afterwards: an iPhone raises
    // the keyboard only when focus lands during the tap, not a moment later.
    screen.getByRole("button", { name: "Comment" }).dispatchEvent(new MouseEvent("click", { bubbles: true }));

    const box = screen.getByLabelText("Your comment");
    expect(document.activeElement).toBe(box);
    expect(scrolled).toHaveBeenCalledWith({ block: "center" });
    // An invitation, not a rule about what to say.
    expect(box.getAttribute("placeholder")).toBe("Add your two cents…");
  });

  it("asks for words before sending a comment", () => {
    globalThis.fetch = vi.fn();
    renderResponses();
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(screen.getByRole("alert").textContent).toMatch(/Write something/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("lets the author edit their comment in place", async () => {
    const fetchMock = operationFetch();
    renderResponses({ comments: [comment({ canEdit: true, canRemove: true })] });
    fireEvent.click(screen.getByRole("button", { name: "Edit comment" }));
    const field = screen.getByLabelText("Edit your comment") as HTMLTextAreaElement;
    expect(field.value).toBe("So sweet");
    fireEvent.change(field, { target: { value: "So very sweet" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
    expect(sent(fetchMock)).toEqual([
      ["/api/feed/comments/comment-1?issue=1", "PATCH", {}],
      ["/api/feed/comments/comment-1", "PATCH", { operationId, body: "So very sweet" }]
    ]);
  });

  it("asks before removing a comment", async () => {
    const fetchMock = operationFetch();
    renderResponses({ comments: [comment({ canRemove: true })] });
    fireEvent.click(screen.getByRole("button", { name: "Remove comment" }));
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));

    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
    expect(sent(fetchMock).map(([url, method]) => [url, method])).toEqual([
      ["/api/feed/comments/comment-1?issue=1", "DELETE"],
      ["/api/feed/comments/comment-1", "DELETE"]
    ]);
  });

  it("offers nothing to change when this member may not respond", () => {
    renderResponses({ canRespond: false, comments: [comment()] });
    expect(screen.queryByRole("group", { name: "React" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Comment" })).toBeNull();
    expect(screen.getByRole("list", { name: "Comments" })).toBeTruthy();
  });
});
