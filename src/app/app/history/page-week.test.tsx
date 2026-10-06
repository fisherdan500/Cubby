// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireUserPage: vi.fn(),
  getHeaderBabySelector: vi.fn(),
  listActivities: vi.fn(),
  getActivityUnitPreferences: vi.fn(),
  getActivityRowViewer: vi.fn(),
  notFound: vi.fn(),
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() },
  searchParams: new URLSearchParams(),
  env: { APP_TIMEZONE: "America/New_York" }
}));

vi.mock("@/server/auth/session", () => ({ requireUserPage: mocks.requireUserPage }));
vi.mock("@/server/services/baby-selector", () => ({ getHeaderBabySelector: mocks.getHeaderBabySelector }));
vi.mock("@/server/services/activities", () => ({
  listActivities: mocks.listActivities,
  getActivityRowViewer: mocks.getActivityRowViewer
}));
vi.mock("@/server/services/unit-preferences", () => ({ getActivityUnitPreferences: mocks.getActivityUnitPreferences }));
vi.mock("@/lib/env", () => ({ env: mocks.env }));
vi.mock("next/navigation", () => ({
  notFound: mocks.notFound,
  useRouter: () => mocks.router,
  usePathname: () => "/app/history",
  useSearchParams: () => mocks.searchParams
}));

import HistoryPage from "./page";

type SearchParams = { babyId?: string; type?: string; search?: string; cursor?: string; week?: unknown };

const filteredParams = { babyId: "baby-1", type: "sleep", search: "night feed", week: "2026-03-02", cursor: "activity-25" };
const filteredHref = "/app/history?babyId=baby-1&type=sleep&search=night+feed&week=2026-03-02";
const occurredAt = new Date("2026-03-04T12:00:00.000Z");
const disclaimer = "These are records in or overlapping the week, not necessarily the exact records or days used in the chart value.";

function activity(id: string) {
  return {
    id, babyId: "baby-1", baby: { name: "Avery", inactiveAt: null },
    type: "sleep", occurredAt, startedAt: occurredAt, endedAt: null, durationSeconds: null,
    timezone: "Etc/UTC", notes: "Private record content", timerState: "none", pausedAt: null, pausedSeconds: 0,
    actorMemberId: "member-1", actorMember: { displayName: "Dad", user: { name: "Daniel" } }
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  mocks.env.APP_TIMEZONE = "America/New_York";
  mocks.searchParams = new URLSearchParams("babyId=baby-1");
  mocks.notFound.mockImplementation(() => { throw new Error("NEXT_NOT_FOUND"); });
  mocks.requireUserPage.mockResolvedValue({ id: "user-1", name: "Sam" });
  mocks.getHeaderBabySelector.mockResolvedValue({
    selectedBabyId: "baby-1",
    babies: [{ id: "baby-1", name: "Avery", ageLabel: "2 months", inactive: false }]
  });
  mocks.listActivities.mockResolvedValue([]);
  mocks.getActivityUnitPreferences.mockResolvedValue({ preferences: { volume: "ml" } });
  mocks.getActivityRowViewer.mockResolvedValue({ memberId: "member-1", role: "read_only" });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function renderPage(searchParams: SearchParams = {}) {
  return render(await HistoryPage({ searchParams }));
}

describe("Full Log week filter", () => {
  it("keeps the existing no-week query and empty state", async () => {
    await renderPage();
    expect(mocks.listActivities).toHaveBeenCalledOnce();
    expect(mocks.listActivities).toHaveBeenCalledWith({
      babyId: "baby-1", type: undefined, search: undefined,
      page: { take: 26, orderBy: [{ occurredAt: "desc" }, { id: "desc" }] }
    });
    expect(screen.getByText("No activity logged yet.")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Clear" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Selected week" })).toBeNull();
    expect(document.querySelector('input[name="week"]')).toBeNull();
  });

  it.each([
    "", "bad-week", "2026-02-30", "2026-03-03", "2026-3-02", " 2026-03-02",
    ["2026-03-02"], ["2026-03-02", "2026-03-02"]
  ].map((week) => ({ week })))("rejects invalid week $week before any history query", async ({ week }) => {
    await expect(HistoryPage({ searchParams: { week } })).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mocks.notFound).toHaveBeenCalledOnce();
    expect(mocks.listActivities).not.toHaveBeenCalled();
  });

  it("queries the canonical week and cursor with current filters and the authorized selected baby", async () => {
    await renderPage({ babyId: "unselected-baby", type: "sleep", search: "night feed", week: "2026-03-02", cursor: "activity-25" });
    expect(mocks.requireUserPage).toHaveBeenCalledOnce();
    expect(mocks.getHeaderBabySelector).toHaveBeenCalledWith("user-1", "unselected-baby", { includeInactive: true });
    expect(mocks.listActivities).toHaveBeenCalledOnce();
    expect(mocks.listActivities).toHaveBeenCalledWith({
      babyId: "baby-1", type: "sleep", search: "night feed", week: "2026-03-02",
      page: { take: 26, orderBy: [{ occurredAt: "desc" }, { id: "desc" }], cursor: { id: "activity-25" }, skip: 1 }
    });
  });

  it("does not query history when household baby resolution denies access", async () => {
    mocks.getHeaderBabySelector.mockRejectedValueOnce(new Error("Forbidden"));
    await expect(HistoryPage({ searchParams: { babyId: "foreign-baby", week: "2026-03-02" } })).rejects.toThrow("Forbidden");
    expect(mocks.listActivities).not.toHaveBeenCalled();
  });

  it("submits the hidden week with search and type changes, retaining baby and dropping cursor", async () => {
    const submit = vi.spyOn(HTMLFormElement.prototype, "requestSubmit").mockImplementation(() => {});
    const { container } = await renderPage(filteredParams);
    const hidden = container.querySelector<HTMLInputElement>('input[type="hidden"][name="week"]');
    expect(hidden?.value).toBe("2026-03-02");
    fireEvent.change(screen.getByLabelText("Activity type"), { target: { value: "feeding" } });
    await waitFor(() => expect(submit).toHaveBeenCalledOnce());
    fireEvent.change(screen.getByLabelText("Search activity history"), { target: { value: "bottle" } });
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
    expect(Object.fromEntries(new FormData(hidden!.form!))).toEqual({
      babyId: "baby-1", week: "2026-03-02", type: "feeding", search: "bottle"
    });
  });

  it("keeps week and filters on Older while advancing to the last visible row", async () => {
    mocks.listActivities.mockResolvedValue(Array.from({ length: 26 }, (_, index) => activity(`activity-${index + 26}`)));
    await renderPage(filteredParams);
    expect(screen.getByRole("link", { name: "Older entries" }).getAttribute("href"))
      .toBe(`${filteredHref}&cursor=activity-50`);
    expect(document.querySelector('a[href^="/app/activities/activity-51?"]')).toBeNull();
  });

  it("keeps week and filters on Back to newest while removing cursor", async () => {
    await renderPage(filteredParams);
    expect(screen.getByRole("link", { name: "Back to newest" }).getAttribute("href")).toBe(filteredHref);
    expect(screen.queryByRole("link", { name: "Older entries" })).toBeNull();
  });

  it("encodes the full week-filtered return path in the real row's detail link", async () => {
    mocks.listActivities.mockResolvedValue([activity("activity-26")]);
    await renderPage(filteredParams);
    const href = document.querySelector('a[href^="/app/activities/activity-26?"]')?.getAttribute("href");
    expect(href).toBe("/app/activities/activity-26?returnTo=%2Fapp%2Fhistory%3FbabyId%3Dbaby-1%26type%3Dsleep%26search%3Dnight%2Bfeed%26week%3D2026-03-02%26cursor%3Dactivity-25");
    expect(new URL(href!, "https://cubby.invalid").searchParams.get("returnTo")).toBe(`${filteredHref}&cursor=activity-25`);
  });

  it.each([
    { week: "2026-03-02" },
    { ...filteredParams, babyId: "unselected-baby" }
  ])("offers Clear for active week filters %j, retaining only the selected baby", async (params) => {
    await renderPage(params);
    expect(screen.getByRole("link", { name: "Clear" }).getAttribute("href")).toBe("/app/history?babyId=baby-1");
  });

  it.each([
    { type: "sleep", explanation: "Records whose recorded interval overlaps the week." },
    { type: "feeding", explanation: "Records logged in the week." },
    { type: undefined, explanation: "Activity records logged in or overlapping the week." }
  ])("explains $type week matching and chart limitations without record content", async ({ type, explanation }) => {
    mocks.listActivities.mockResolvedValue([activity("activity-26")]);
    await renderPage({ week: "2026-03-02", type });
    const summary = screen.queryByRole("region", { name: "Selected week" });
    expect(summary).not.toBeNull();
    expect(within(summary!).getByText(explanation)).toBeTruthy();
    expect(within(summary!).getByText("Mar 2, 2026 – Mar 8, 2026")).toBeTruthy();
    expect(within(summary!).getByText(disclaimer)).toBeTruthy();
    expect(summary!.textContent).not.toContain("Private record content");
    expect(summary!.textContent).not.toContain("Dad");
  });

  it.each([
    { zone: "America/New_York", week: "2026-10-26", range: "Oct 26, 2026 – Nov 1, 2026" },
    { zone: "Pacific/Auckland", week: "2026-09-21", range: "Sep 21, 2026 – Sep 27, 2026" },
    { zone: "America/New_York", week: "2025-12-29", range: "Dec 29, 2025 – Jan 4, 2026" }
  ])("shows local Monday through Sunday across boundaries: $zone $week", async ({ zone, week, range }) => {
    mocks.env.APP_TIMEZONE = zone;
    await renderPage({ week });
    expect(screen.queryByText(range)).not.toBeNull();
    expect(screen.queryByText(disclaimer)).not.toBeNull();
  });

  it.each([{ week: "2026-03-02" }, filteredParams])("describes an empty week-filtered page truthfully: %j", async (params) => {
    await renderPage(params);
    expect(screen.queryByText("No records match the selected week and filters.")).not.toBeNull();
    expect(screen.queryByText("No activity logged yet.")).toBeNull();
    expect(screen.queryByText("Nothing matches that search.")).toBeNull();
    expect(screen.getByText(disclaimer)).toBeTruthy();
  });

  it("preserves week and filters through the real baby switcher while dropping cursor", async () => {
    mocks.searchParams = new URLSearchParams(filteredParams);
    mocks.getHeaderBabySelector.mockResolvedValue({
      selectedBabyId: "baby-1",
      babies: [
        { id: "baby-1", name: "Avery", ageLabel: "2 months", inactive: false },
        { id: "baby-2", name: "Robin", ageLabel: "1 year", inactive: true }
      ]
    });
    await renderPage(filteredParams);
    fireEvent.change(screen.getAllByLabelText("Select baby")[0], { target: { value: "baby-2" } });
    expect(mocks.router.push).toHaveBeenCalledWith("/app/history?babyId=baby-2&type=sleep&search=night+feed&week=2026-03-02");
  });

  it("does not query or resolve a baby before authentication succeeds", async () => {
    mocks.requireUserPage.mockRejectedValueOnce(new Error("Sign in required"));
    await expect(HistoryPage({ searchParams: filteredParams })).rejects.toThrow("Sign in required");
    expect(mocks.getHeaderBabySelector).not.toHaveBeenCalled();
    expect(mocks.listActivities).not.toHaveBeenCalled();
  });
});
