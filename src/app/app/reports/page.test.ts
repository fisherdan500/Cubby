// @vitest-environment jsdom
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireUserPage: vi.fn(),
  getHeaderBabySelector: vi.fn(),
  getReports: vi.fn()
}));

globalThis.React = React;

vi.mock("@/server/auth/session", () => ({ requireUserPage: mocks.requireUserPage }));
vi.mock("@/server/services/baby-selector", () => ({ getHeaderBabySelector: mocks.getHeaderBabySelector }));
vi.mock("@/server/services/reports", async () => {
  const actual = await vi.importActual<typeof import("@/server/services/reports")>("@/server/services/reports");
  return { ...actual, getReports: mocks.getReports };
});
vi.mock("@/components/app-shell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => createElement("main", null, children)
}));
vi.mock("@/components/activity-artwork", () => ({ ActivityArtwork: () => createElement("span") }));
vi.mock("@/components/reports/routine-tab", () => ({ RoutineTab: () => createElement("div", null, "routine") }));

import { buildReportStats, buildRoutineTimeline } from "@/server/services/reports";
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
    routine: buildRoutineTimeline([], endKey, "1w", "Etc/UTC"),
    stats: buildReportStats([], null, "Etc/UTC")
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
    expect(current[0].textContent).toContain("Growth");
    // Icons beside each label are decorative, so they are not announced twice.
    expect(views?.querySelectorAll("svg:not([aria-hidden='true'])")).toHaveLength(0);
  });

  it("reads the heatmap as a table of weekdays, hours and counts", async () => {
    const body = await renderReports("heatmaps");
    const table = body.querySelector("table");

    expect(table?.querySelector("caption")?.textContent).toBe("Activity counts by weekday and hour of day");
    expect(table?.querySelectorAll('thead th[scope="col"]')).toHaveLength(25);
    expect(table?.querySelectorAll('tbody th[scope="row"]')).toHaveLength(7);
    expect(table?.querySelectorAll("tbody td")).toHaveLength(7 * 24);
    // The count was previously only in a hover title, which never reaches a screen reader or keyboard.
    expect(table?.querySelector("tbody td .sr-only")?.textContent).toBe("0");
  });

  it("treats the growth chart as decorative because its points are listed as text", async () => {
    const body = await renderReports("growth");

    for (const svg of body.querySelectorAll("svg")) expect(svg.getAttribute("aria-hidden")).toBe("true");
  });
});
