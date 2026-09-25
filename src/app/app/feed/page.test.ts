// @vitest-environment jsdom
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireUserPage: vi.fn(),
  getHeaderBabySelector: vi.fn(),
  listActivities: vi.fn(),
  getActivityUnitPreferences: vi.fn()
}));

globalThis.React = React;

vi.mock("@/server/auth/session", () => ({ requireUserPage: mocks.requireUserPage }));
vi.mock("@/server/services/baby-selector", () => ({ getHeaderBabySelector: mocks.getHeaderBabySelector }));
vi.mock("@/server/services/activities", () => ({ listActivities: mocks.listActivities }));
vi.mock("@/server/services/unit-preferences", () => ({ getActivityUnitPreferences: mocks.getActivityUnitPreferences }));
vi.mock("@/lib/env", () => ({ env: { APP_TIMEZONE: "UTC" } }));
vi.mock("@/components/app-shell", () => ({
  AppShell: ({ title, children }: { title: string; children: React.ReactNode }) => createElement("main", { "data-title": title }, children)
}));
vi.mock("@/components/activity-artwork", () => ({ ActivityArtwork: () => createElement("span") }));

import FeedPage from "@/app/app/feed/page";

function entry(id: string, occurredAt: string, type: string, detail: Record<string, unknown> = {}) {
  return {
    id,
    type,
    occurredAt: new Date(occurredAt),
    durationSeconds: null,
    notes: null,
    actorMember: { displayName: "Sam", user: { name: "Sam Parent" } },
    baby: { id: "baby-1", name: "Avery", inactiveAt: null },
    ...detail
  };
}

async function renderFeed(searchParams: Record<string, string> = {}) {
  document.body.innerHTML = renderToStaticMarkup(await FeedPage({ searchParams }));
  return document.body;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-25T18:00:00Z"));
  mocks.requireUserPage.mockResolvedValue({ id: "user-1", name: "Sam" });
  mocks.getHeaderBabySelector.mockResolvedValue({ selectedBabyId: "baby-1", babies: [] });
  mocks.getActivityUnitPreferences.mockResolvedValue({ preferences: { volume: "oz" } });
  mocks.listActivities.mockResolvedValue([
    entry("a1", "2026-09-25T15:00:00Z", "milestone", { milestone: { title: "Rolled over", category: "Motor" } }),
    entry("a2", "2026-09-25T09:00:00Z", "diaper", { diaper: { kind: "wet" } }),
    entry("a3", "2026-09-24T20:00:00Z", "note", { note: { text: "Giggled at the cat" } })
  ]);
});

describe("Feed page", () => {
  it("is a titled screen of cards for the selected baby, newest first, under their days", async () => {
    const body = await renderFeed({ babyId: "baby-1" });

    expect(body.querySelector("main")?.getAttribute("data-title")).toBe("Feed");
    expect(mocks.listActivities).toHaveBeenCalledWith(expect.objectContaining({ babyId: "baby-1", type: undefined }));
    expect([...body.querySelectorAll("h2")].map((heading) => heading.textContent)).toEqual(["Today", "Yesterday"]);
    expect([...body.querySelectorAll("article")].map((card) => card.getAttribute("aria-label"))).toEqual(["Milestone", "Diaper", "Note"]);
  });

  it("gives each card what it is, when, who logged it, and the thing worth reading", async () => {
    const body = await renderFeed({ babyId: "baby-1" });
    const [milestone, , note] = [...body.querySelectorAll("article")];

    expect(milestone.textContent).toContain("Rolled over");
    expect(milestone.textContent).toContain("3:00 PM");
    expect(milestone.textContent).toContain("Logged by Sam");
    expect(note.textContent).toContain("Giggled at the cat");
  });

  it("opens an entry and comes back to the same feed", async () => {
    const body = await renderFeed({ babyId: "baby-1", filter: "milestone" });
    const href = body.querySelector("article")?.closest("a")?.getAttribute("href") ?? "";

    expect(href).toMatch(/^\/app\/activities\/a1\?/);
    expect(new URL(href, "https://cubby.invalid").searchParams.get("returnTo")).toBe("/app/feed?babyId=baby-1&filter=milestone");
  });

  it("filters from the header, marking the filter in use", async () => {
    const body = await renderFeed({ babyId: "baby-1", filter: "milestone" });
    const filters = [...body.querySelectorAll('nav[aria-label="Feed filters"] a')];

    expect(mocks.listActivities).toHaveBeenCalledWith(expect.objectContaining({ type: "milestone" }));
    expect(filters.map((link) => link.textContent)).toEqual(["Everything", "Feeds", "Sleep", "Diapers", "Milestones", "Notes"]);
    expect(filters.find((link) => link.getAttribute("aria-current") === "true")?.textContent).toBe("Milestones");
    expect(filters[0].getAttribute("href")).toBe("/app/feed?babyId=baby-1");
  });

  it("pages back through older entries", async () => {
    mocks.listActivities.mockResolvedValue(Array.from({ length: 26 }, (_, index) =>
      entry(`a${index}`, new Date(Date.parse("2026-09-25T15:00:00Z") - index * 3_600_000).toISOString(), "diaper", { diaper: { kind: "wet" } })
    ));
    const body = await renderFeed({ babyId: "baby-1" });

    expect(body.querySelectorAll("article")).toHaveLength(25);
    const older = [...body.querySelectorAll("a")].find((link) => link.textContent === "Older entries");
    expect(older?.getAttribute("href")).toBe("/app/feed?babyId=baby-1&cursor=a24");
  });

  it("says so kindly when there is nothing yet", async () => {
    mocks.listActivities.mockResolvedValue([]);
    const body = await renderFeed({ babyId: "baby-1" });
    expect(body.textContent).toContain("Nothing here yet");
  });
});
