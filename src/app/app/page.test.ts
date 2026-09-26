// @vitest-environment jsdom
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireUserPage: vi.fn(),
  getDashboardPageData: vi.fn()
}));

globalThis.React = React;

vi.mock("@/server/auth/session", () => ({ requireUserPage: mocks.requireUserPage }));
vi.mock("@/server/services/dashboard", () => ({ getDashboardPageData: mocks.getDashboardPageData }));
vi.mock("@/components/app-shell", () => ({
  AppShell: ({ children, showAllTimers }: { children: React.ReactNode; showAllTimers?: boolean }) =>
    createElement("main", { "data-show-all-timers": String(Boolean(showAllTimers)) }, children)
}));
vi.mock("@/components/activity-artwork", () => ({ ActivityArtwork: () => createElement("span") }));
vi.mock("@/components/dashboard/dashboard-warnings", () => ({ DashboardWarnings: () => null }));
vi.mock("@/components/dashboard/day-picker-heading", () => ({ DayPickerHeading: () => null }));
vi.mock("@/components/activity-list-row", () => ({ ActivityListRow: () => null }));

import DashboardPage from "@/app/app/page";

function dashboard(summary: Record<string, unknown>, activeTimers: Array<Record<string, unknown>> = []) {
  return {
    dashboard: {
      home: { role: "owner", householdId: "household-1", household: { settings: { unitPreferences: null } } },
      baby: { id: "baby-1", name: "Avery", birthDate: null, inactiveAt: null },
      selectedDate: {
        key: "2026-09-22",
        label: "Tue, Sep 22, 2026",
        shortLabel: "Tue, Sep 22",
        todayKey: "2026-09-22",
        isToday: true,
        isYesterday: false,
        previous: "2026-09-21",
        next: "2026-09-23",
        start: new Date("2026-09-22T00:00:00.000Z"),
        end: new Date("2026-09-23T00:00:00.000Z"),
        timezone: "Etc/UTC"
      },
      activities: [],
      activeTimers,
      warnings: [],
      summaries: {},
      dailySummary: {
        sleep: { count: 2, seconds: 25_200 },
        awake: { seconds: 7_200, known: true },
        feeding: { count: 3, amount: 12, unit: "oz" },
        diaper: { count: 4, wet: 2, dirty: 1, mixed: 1, dry: 0 },
        bath: { count: 0 },
        pumping: { count: 0, amount: 0, unit: "oz" },
        milestone: { count: 0 },
        medicine: { count: 0 },
        supplement: { count: 0 },
        vaccine: { count: 0 },
        play: { count: 0, seconds: 0 },
        ...summary
      }
    },
    babySelector: null
  };
}

async function renderDashboard(
  summary: Record<string, unknown> = {},
  searchParams: { babyId?: string; date?: string; summaryType?: string } = {},
  activeTimers: Array<Record<string, unknown>> = []
) {
  mocks.getDashboardPageData.mockResolvedValue(dashboard(summary, activeTimers));
  document.body.innerHTML = renderToStaticMarkup(await DashboardPage({ searchParams }));
  return document.body;
}

/** Each summary chip's small label, in the order they are laid out. */
function chipLabels(body: HTMLElement) {
  return [...body.querySelectorAll("p.max-w-40")].map((node) => node.textContent);
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireUserPage.mockResolvedValue({ id: "user-1", name: "Parent", email: "parent@example.test" });
});

describe("daily summary chips", () => {
  it("leads with awake time, then sleep, then the activity counts", async () => {
    const body = await renderDashboard();

    // Awake and sleep account for the whole day between them, so they read as a pair up front.
    // The feeding chip labels itself with the volume when there is one.
    expect(chipLabels(body).slice(0, 3)).toEqual(["Awake Time", "Total Sleep", "12.0 oz"]);
  });

  it("names the awake chip in full rather than as a bare state", async () => {
    const body = await renderDashboard();

    expect(body.textContent).toContain("Awake Time");
    expect(chipLabels(body)).not.toContain("Awake");
  });

  it("shows the awake and sleep figures as durations", async () => {
    const body = await renderDashboard();

    expect(body.textContent).toContain("2h");
    expect(body.textContent).toContain("7h");
  });

  it("leaves the awake chip out entirely for a day that has not begun", async () => {
    const body = await renderDashboard({ awake: { seconds: 0, known: false } });

    expect(chipLabels(body)).not.toContain("Awake Time");
    expect(chipLabels(body)[0]).toBe("Total Sleep");
  });

  it("marks legacy pause-affected sleep and awake totals unavailable instead of guessing", async () => {
    const body = await renderDashboard({
      sleep: { count: 1, seconds: null, unavailableReason: "legacy_pause_allocation" },
      awake: { seconds: null, known: false, unavailableReason: "legacy_pause_allocation" }
    });

    expect(chipLabels(body).slice(0, 2)).toEqual(["Awake Time", "Total Sleep"]);
    expect([...body.querySelectorAll("p")].filter((node) => node.textContent === "Unavailable")).toHaveLength(2);
    expect(body.textContent).toContain("Older pause timing is not precise enough for this day");
  });

  it("keeps the awake chip out of the log filters", async () => {
    const body = await renderDashboard();
    const links = [...body.querySelectorAll("a")].map((node) => node.getAttribute("href") ?? "");

    // Every filter chip is a link; awake is not one, because no activity accounts for it.
    expect(links.some((href) => href.includes("summaryType=sleep"))).toBe(true);
    expect(links.some((href) => href.includes("summaryType=awake"))).toBe(false);
  });
});

describe("the running-timer bar on the Log screen", () => {
  it("is asked for here, with every running timer and one-tap Stop", async () => {
    const body = await renderDashboard();
    expect(body.querySelector("main")?.getAttribute("data-show-all-timers")).toBe("true");
  });
});

describe("dashboard timer navigation", () => {
  it("preserves the selected baby, date, and summary filter in the timer return route", async () => {
    const body = await renderDashboard(
      {},
      { babyId: "baby-1", date: "2026-09-22", summaryType: "sleep" },
      [{
        id: "timer-1",
        type: "sleep",
        timerState: "running",
        startedAt: new Date("2026-09-22T10:00:00.000Z"),
        pausedAt: null,
        pausedSeconds: 0
      }]
    );

    expect(body.querySelector('a[href^="/app/activities/timer-1"]')?.getAttribute("href")).toBe(
      "/app/activities/timer-1?returnTo=%2Fapp%3FbabyId%3Dbaby-1%26date%3D2026-09-22%26summaryType%3Dsleep"
    );
  });
});
