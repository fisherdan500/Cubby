// @vitest-environment jsdom
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireUserPage: vi.fn(),
  getHeaderBabySelector: vi.fn(),
  listRemovedFeedPosts: vi.fn()
}));

globalThis.React = React;

vi.mock("@/server/auth/session", () => ({ requireUserPage: mocks.requireUserPage }));
vi.mock("@/server/services/baby-selector", () => ({ getHeaderBabySelector: mocks.getHeaderBabySelector }));
vi.mock("@/server/services/feed-posts", () => ({ listRemovedFeedPosts: mocks.listRemovedFeedPosts }));
vi.mock("@/components/feed/feed-post-actions", () => ({
  FeedPostRestoreButton: ({ postId }: { postId: string }) => createElement("button", { type: "button", "data-restore": postId }, "Restore")
}));
vi.mock("@/lib/env", () => ({ env: { APP_TIMEZONE: "UTC" } }));
vi.mock("@/components/app-shell", () => ({
  AppShell: ({ title, children }: { title: string; children: React.ReactNode }) => createElement("main", { "data-title": title }, children)
}));

import RemovedFeedPostsPage from "@/app/app/moments/removed/page";

async function renderPage(searchParams: Record<string, string> = {}) {
  document.body.innerHTML = renderToStaticMarkup(await RemovedFeedPostsPage({ searchParams }));
  return document.body;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-29T12:00:00Z"));
  mocks.requireUserPage.mockResolvedValue({ id: "user-1", name: "Sam" });
  mocks.getHeaderBabySelector.mockResolvedValue({ selectedBabyId: "baby-1", babies: [] });
  mocks.listRemovedFeedPosts.mockResolvedValue([]);
});

describe("Recently removed posts", () => {
  it("lists each removed post with who wrote it, when it goes for good, and a way back", async () => {
    mocks.listRemovedFeedPosts.mockResolvedValue([
      {
        id: "post-1", babyId: null, body: "Family walk #weekend", occurredAt: new Date("2026-09-20T10:00:00Z"),
        deletedAt: new Date("2026-09-28T12:00:00Z"), photoCount: 3, authorName: "Sam"
      },
      {
        id: "post-2", babyId: "baby-1", body: "", occurredAt: new Date("2026-09-01T10:00:00Z"),
        // Thirty days after this is 14:00 today: two hours left.
        deletedAt: new Date("2026-08-30T14:00:00Z"), photoCount: 1, authorName: "Alex"
      }
    ]);
    const body = await renderPage({ babyId: "baby-1" });
    const posts = [...body.querySelectorAll("article")];

    expect(body.querySelector("main")?.getAttribute("data-title")).toBe("Recently removed");
    expect(posts).toHaveLength(2);
    expect(posts[0].textContent).toContain("Sam");
    expect(posts[0].textContent).toContain("Family walk #weekend");
    expect(posts[0].textContent).toContain("3 photos");
    expect(posts[0].textContent).toContain("29 days left");
    expect(posts[1].textContent).toContain("1 photo");
    expect(posts[1].textContent).toContain("Less than a day left");
    expect(posts.map((post) => post.querySelector("[data-restore]")?.getAttribute("data-restore"))).toEqual(["post-1", "post-2"]);
    expect([...body.querySelectorAll("a")].find((link) => link.textContent === "Back to Moments")?.getAttribute("href")).toBe("/app/moments?babyId=baby-1");
  });

  it("explains the thirty days when there is nothing to bring back", async () => {
    const body = await renderPage();
    expect(body.textContent).toContain("Nothing removed in the last 30 days");
  });
});
