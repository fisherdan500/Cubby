// @vitest-environment jsdom
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireUserPage: vi.fn(),
  getHeaderBabySelector: vi.fn(),
  getReports: vi.fn(),
  getPlannedSchedule: vi.fn()
}));

globalThis.React = React;

vi.mock("@/server/auth/session", () => ({ requireUserPage: mocks.requireUserPage }));
vi.mock("@/server/services/baby-selector", () => ({ getHeaderBabySelector: mocks.getHeaderBabySelector }));
vi.mock("@/server/services/planned-schedule", () => ({ getPlannedSchedule: mocks.getPlannedSchedule }));
vi.mock("@/server/services/reports", async () => {
  const actual = await vi.importActual<typeof import("@/server/services/reports")>("@/server/services/reports");
  return { ...actual, getReports: mocks.getReports };
});
vi.mock("@/components/app-shell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => createElement("main", null, children)
}));
vi.mock("@/components/activity-artwork", () => ({ ActivityArtwork: () => createElement("span") }));
vi.mock("@/components/reports/routine-tab", () => ({ RoutineTab: () => createElement("div", null, "routine") }));

import { buildReportStats, buildRoutine } from "@/server/services/reports";
import ReportsPage from "@/app/app/reports/page";

const endKey = "2026-09-19";

async function renderReports(tab?: string) {
  const markup = renderToStaticMarkup(await ReportsPage({ searchParams: { babyId: "baby-1", ...(tab ? { tab } : {}) } }));
  document.body.innerHTML = markup;
  return document.body;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireUserPage.mockResolvedValue({ id: "user-1", name: "Parent", email: "parent@example.test" });
  mocks.getHeaderBabySelector.mockResolvedValue(null);
  mocks.getReports.mockResolvedValue({
    home: { householdId: "household-1" },
    baby: { id: "baby-1", name: "Avery", birthDate: null },
    startKey: "2026-09-13",
    endKey,
    todayKey: endKey,
    routine: buildRoutine([], endKey, "1w", "Etc/UTC"),
    stats: buildReportStats([], null, "Etc/UTC"),
    previous: null
  });
});

describe("ReportsPage accessibility", () => {
  it("names both ends of the date range", async () => {
    const body = await renderReports();
    const start = body.querySelector<HTMLInputElement>("#report-start");
    const end = body.querySelector<HTMLInputElement>("#report-end");

    expect(start?.getAttribute("name")).toBe("start");
    expect(end?.getAttribute("name")).toBe("end");
    expect(body.querySelector('label[for="report-start"]')?.textContent).toBe("Report start date");
    expect(body.querySelector('label[for="report-end"]')?.textContent).toBe("Report end date");
  });

  it("marks the open report, and only that one, as the current page", async () => {
    const body = await renderReports("growth");
    const views = body.querySelector('nav[aria-label="Report views"]');
    const current = views?.querySelectorAll('a[aria-current="page"]') ?? [];

    expect(views).toBeTruthy();
    expect(current).toHaveLength(1);
    expect(current[0].textContent).toBe("Growth");
    // Icons beside each label are decorative, so they are not announced twice.
    expect(views?.querySelectorAll("svg:not([aria-hidden='true'])")).toHaveLength(0);
  });

  it("offers Routine, Stats, Growth and Milestones, and opens Routine for an old Activity or Heatmaps link", async () => {
    for (const oldTab of ["activity", "heatmaps"]) {
      const body = await renderReports(oldTab);
      const views = [...body.querySelectorAll('nav[aria-label="Report views"] a')].map((link) => link.textContent);
      expect(views).toEqual(["Routine", "Stats", "Growth", "Milestones"]);
      expect(body.querySelector('nav[aria-label="Report views"] a[aria-current="page"]')?.textContent).toBe("Routine");
      expect(body.textContent).toContain("routine");
    }
  });

  it("offers quick periods ending today, marking the one in use", async () => {
    const body = await renderReports("stats");
    const periods = [...body.querySelectorAll('nav[aria-label="Report period"] a')];

    expect(periods.map((link) => link.textContent)).toEqual(["7 days", "14 days", "30 days"]);
    expect(periods[0].getAttribute("aria-current")).toBe("true");
    expect(periods[1].getAttribute("href")).toContain("start=2026-09-06&end=2026-09-19");
    expect(periods[1].getAttribute("href")).toContain("tab=stats");
  });

  it("reads the previous period only for Stats, and shows each figure per day with its change", async () => {
    await renderReports("routine");
    expect(mocks.getReports).toHaveBeenLastCalledWith("user-1", expect.objectContaining({ compare: false }));

    const diapers = (count: number, day: string) => Array.from({ length: count }, (_, index) => ({
      type: "diaper", occurredAt: new Date(`${day}T${String(8 + index).padStart(2, "0")}:00:00.000Z`), durationSeconds: null, diaper: { kind: "wet" }
    }));
    mocks.getReports.mockResolvedValue({
      ...(await mocks.getReports.mock.results.at(-1)?.value),
      stats: buildReportStats(diapers(6, "2026-09-18") as never, null, "Etc/UTC"),
      previous: { startKey: "2026-09-06", endKey: "2026-09-12", stats: buildReportStats(diapers(5, "2026-09-10") as never, null, "Etc/UTC") }
    });
    const body = await renderReports("stats");

    expect(mocks.getReports).toHaveBeenLastCalledWith("user-1", expect.objectContaining({ compare: true }));
    expect(body.textContent).toContain("Per day, over the 1 day with entries");
    expect(body.textContent).toContain("compared with Sep 6 to Sep 12");
    const row = [...body.querySelectorAll("li")].find((item) => item.textContent?.startsWith("Diapers per day"));
    expect(row?.textContent).toBe("Diapers per day6+1");
  });

  it("treats the growth chart as decorative because its points are listed as text", async () => {
    const body = await renderReports("growth");

    for (const svg of body.querySelectorAll("svg")) expect(svg.getAttribute("aria-hidden")).toBe("true");
  });
});
