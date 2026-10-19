// @vitest-environment jsdom
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireUserPage: vi.fn(),
  getHeaderBabySelector: vi.fn(),
  getFeedPostView: vi.fn(),
  listFeedInteractions: vi.fn(),
  getHouseholdHome: vi.fn()
}));

globalThis.React = React;

vi.mock("@/server/auth/session", () => ({ requireUserPage: mocks.requireUserPage }));
vi.mock("@/server/services/baby-selector", () => ({ getHeaderBabySelector: mocks.getHeaderBabySelector }));
vi.mock("@/server/services/feed-posts", () => ({ getFeedPostView: mocks.getFeedPostView }));
vi.mock("@/server/services/households", () => ({ getHouseholdHome: mocks.getHouseholdHome }));
vi.mock("@/server/services/feed-interactions", () => ({
  listFeedInteractions: mocks.listFeedInteractions,
  feedInteractionKey: (kind: string, id: string) => `${kind}:${id}`
}));
vi.mock("@/components/feed/feed-post-actions", () => ({
  FeedPostRemoveButton: ({ postId }: { postId: string }) => createElement("button", { type: "button", "data-remove": postId }, "Remove post"),
  FeedPostBody: ({ canEdit, edited, children }: { canEdit: boolean; edited: boolean; children: React.ReactNode }) =>
    createElement("p", { "data-can-edit": String(canEdit), "data-edited": String(edited) }, children)
}));
vi.mock("@/components/feed/feed-responses", () => ({
  FeedResponses: ({ parentKind, parentId, comments, reactions, canRespond }: {
    parentKind: string; parentId: string; comments: unknown[]; reactions: unknown[]; canRespond: boolean;
  }) => createElement("div", {
    "data-responses": `${parentKind}:${parentId}`,
    "data-comments": String(comments.length),
    "data-reactions": String(reactions.length),
    "data-can-respond": String(canRespond)
  })
}));
vi.mock("@/lib/env", () => ({ env: { APP_TIMEZONE: "UTC" } }));
vi.mock("@/components/app-shell", () => ({
  AppShell: ({ title, children }: { title: string; children: React.ReactNode }) => createElement("main", { "data-title": title }, children)
}));

import MomentDetailPage from "@/app/app/moments/[id]/page";

function postView(overrides: object = {}) {
  return {
    id: "post-1",
    babyId: "baby-1",
    body: "First giggle",
    occurredAt: new Date("2026-09-25T15:00:00Z"),
    updatedAt: new Date("2026-09-25T15:00:00Z"),
    authorName: "Dana",
    authorPhotoAttachmentId: null,
    canRemove: false,
    canEdit: false,
    edited: false,
    hasRetainedPhotos: false,
    photos: [],
    ...overrides
  };
}

async function renderMoment(id = "post-1") {
  document.body.innerHTML = renderToStaticMarkup(await MomentDetailPage({ params: { id } }));
  return document.body;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireUserPage.mockResolvedValue({ id: "user-1", name: "Sam" });
  mocks.getHouseholdHome.mockResolvedValue({ householdId: "household-1" });
  mocks.getHeaderBabySelector.mockResolvedValue({ selectedBabyId: "baby-1", babies: [{ id: "baby-1", name: "Avery", ageLabel: "", inactive: false }] });
  mocks.listFeedInteractions.mockResolvedValue({ comments: { "post:post-1": [{ id: "c1" }] }, reactions: { "post:post-1": [] }, canRespond: true });
  mocks.getFeedPostView.mockResolvedValue(postView());
});

describe("Moment focus page", () => {
  it("gives one moment the screen: author, caption, responses, and a way back", async () => {
    const body = await renderMoment();

    // The moment itself, with the baby it is about resolved to a name.
    expect(body.textContent).toContain("Dana");
    expect(body.textContent).toContain("First giggle");
    expect(body.textContent).toContain("About Avery");
    // The same response thread the feed shows, keyed to this post, with its comment carried in.
    const responses = body.querySelector('[data-responses="post:post-1"]');
    expect(responses?.getAttribute("data-comments")).toBe("1");
    // Back to the feed is always one tap away.
    expect(body.querySelector('a[href="/app/moments"]')?.textContent).toContain("All moments");
  });

  it("explains a gone moment calmly and points home, because a notification can outlive its moment", async () => {
    mocks.getFeedPostView.mockResolvedValue(null);

    const body = await renderMoment("post-gone");

    expect(body.textContent).toContain("This moment is gone");
    expect(body.querySelector('a[href="/app/moments"]')).not.toBeNull();
    // Gone is not broken: nothing beyond the lookup runs, and nothing renders as an error.
    expect(mocks.listFeedInteractions).not.toHaveBeenCalled();
  });

  it("asks the service for exactly the id in the address", async () => {
    await renderMoment("post-1");
    expect(mocks.getFeedPostView).toHaveBeenCalledWith("post-1");
  });
});
