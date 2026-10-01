// @vitest-environment jsdom
/**
 * The responses section on a logged entry's own screen.
 *
 * Comments on an entry already worked and already appeared in Moments, but only there: someone
 * looking at the entry could not see what the family had said about it. These tests drive the real
 * page with the real FeedResponses component so the thread is proven to reach the screen, keyed by
 * the activity rather than by a post.
 */
import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireUserPage: vi.fn(),
  getHouseholdHome: vi.fn(),
  getActivityView: vi.fn(),
  listFeedInteractions: vi.fn()
}));

vi.mock("@/server/auth/session", () => ({ requireUserPage: mocks.requireUserPage }));
vi.mock("@/server/services/households", () => ({ getHouseholdHome: mocks.getHouseholdHome }));
vi.mock("@/server/services/activities", () => ({ getActivityView: mocks.getActivityView }));
vi.mock("@/server/services/feed-interactions", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/server/services/feed-interactions");
  return { ...actual, listFeedInteractions: mocks.listFeedInteractions };
});
// The real FeedResponses is a client component that refreshes the route after a reply; in jsdom
// there is no mounted app router, so give it one. Mocking it away instead would stop these tests
// proving the thread actually renders.
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/components/app-shell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => createElement("main", null, children)
}));
vi.mock("@/components/activity-artwork", () => ({ ActivityArtwork: () => createElement("span") }));
vi.mock("@/components/actions/confirmed-activity-delete", () => ({
  ConfirmedActivityDelete: () => createElement("button", { type: "button" }, "Delete")
}));
vi.mock("@/components/actions/activity-actions", () => ({
  PauseTimerButton: () => createElement("button", { type: "button" }, "Pause"),
  ResumeTimerButton: () => createElement("button", { type: "button" }, "Resume"),
  StopTimerButton: () => createElement("button", { type: "button" }, "Stop timer")
}));
vi.mock("@/components/timer-elapsed", () => ({
  TimerDot: () => createElement("span"),
  TimerElapsed: () => createElement("span")
}));

const occurredAt = new Date("2026-10-01T12:00:00.000Z");

beforeEach(() => {
  // Every render must start from an empty document, or a later test matches an earlier render.
  cleanup();
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.requireUserPage.mockResolvedValue({ name: "Sam" });
  mocks.getHouseholdHome.mockResolvedValue({ householdId: "household-1" });
  mocks.getActivityView.mockResolvedValue({
    activity: {
      id: "act-1",
      babyId: "baby-1",
      baby: { name: "Avery", inactiveAt: null },
      type: "feeding",
      occurredAt,
      startedAt: occurredAt,
      endedAt: null,
      durationSeconds: null,
      timezone: "Etc/UTC",
      notes: null,
      timerState: "none",
      pausedAt: null,
      pausedSeconds: 0,
      actorMember: { displayName: "Dad", user: { name: "Daniel" } }
    },
    canUpdate: true,
    canDelete: true
  });
  mocks.listFeedInteractions.mockResolvedValue({ comments: {}, reactions: {}, canRespond: true });
});

async function renderPage() {
  const Page = (await import("./page")).default;
  render(await Page({ params: { id: "act-1" }, searchParams: {} }));
}

describe("responses on a logged entry's screen", () => {
  it("asks for this entry's thread and no posts", async () => {
    await renderPage();

    // One entry, so one activity: the entry screen must not pull the whole feed's interactions.
    expect(mocks.listFeedInteractions).toHaveBeenCalledWith({ postIds: [], activityIds: ["act-1"] });
  });

  it("shows the responses section", async () => {
    await renderPage();

    expect(screen.getByRole("heading", { name: /responses/i })).toBeTruthy();
  });

  it("offers a way to comment when the viewer may respond", async () => {
    await renderPage();

    // The real FeedResponses renders here, so this proves the thread reached the screen rather than
    // only that the page called the service.
    expect(screen.getAllByRole("button", { name: /comment/i }).length).toBeGreaterThan(0);
  });

  it("shows a comment the family already left on this entry", async () => {
    mocks.listFeedInteractions.mockResolvedValue({
      comments: {
        "activity:act-1": [
          {
            id: "c-1",
            body: "She finally finished a whole bottle",
            authorName: "Alex",
            createdAt: occurredAt,
            updatedAt: occurredAt,
            edited: false,
            canEdit: false,
            canRemove: false
          }
        ]
      },
      reactions: {},
      canRespond: true
    });

    await renderPage();

    expect(screen.getByText(/finally finished a whole bottle/i)).toBeTruthy();
  });

  it("does not borrow a post's thread that shares the entry's id", async () => {
    // The key is kind-qualified, so a post with the same id must not leak into the entry.
    mocks.listFeedInteractions.mockResolvedValue({
      comments: { "post:act-1": [{ id: "c-9", body: "belongs to a post", authorName: "Alex", createdAt: occurredAt, updatedAt: occurredAt, edited: false, canEdit: false, canRemove: false }] },
      reactions: {},
      canRespond: true
    });

    await renderPage();

    expect(screen.queryByText(/belongs to a post/i)).toBeNull();
  });
});
