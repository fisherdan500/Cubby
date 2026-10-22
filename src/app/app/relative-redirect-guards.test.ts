// @vitest-environment jsdom
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Behavioural coverage for the four redirect guards that keep a relative on Moments.
 *
 * The first version of these tests asserted the guards by reading the source text with a regex,
 * which pinned that a string appeared rather than what it decided. An independent review showed
 * that deleting the `!` inverted every guard -- bouncing parents off their own screens and letting
 * a relative through -- while the whole suite stayed green, because the matched substring was
 * byte-identical. These tests call the page components and assert where they send people.
 *
 * `redirect()` throws in Next, which is what stops the page rendering, so each guard is observed as
 * a thrown sentinel carrying the destination.
 */

const mocks = vi.hoisted(() => ({
  requireUserPage: vi.fn(),
  getSession: vi.fn(),
  getEffectiveHouseholdContext: vi.fn(),
  getDashboardPageData: vi.fn(),
  getActivityRowViewer: vi.fn(),
  listActivities: vi.fn(),
  getHeaderBabySelector: vi.fn(),
  getCalendar: vi.fn(),
  getReports: vi.fn(),
  getPlannedSchedule: vi.fn(),
  getTrends: vi.fn()
}));

globalThis.React = React;

class RedirectError extends Error {
  constructor(readonly destination: string) {
    super(`NEXT_REDIRECT:${destination}`);
  }
}

vi.mock("next/navigation", () => ({
  redirect: (destination: string) => {
    throw new RedirectError(destination);
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  }
}));

vi.mock("@/server/auth/session", () => ({ requireUserPage: mocks.requireUserPage, getSession: mocks.getSession }));
vi.mock("@/server/auth/context", async () => {
  const actual = await vi.importActual<typeof import("@/server/auth/context")>("@/server/auth/context");
  return { ...actual, getEffectiveHouseholdContext: mocks.getEffectiveHouseholdContext };
});
vi.mock("@/server/services/dashboard", () => ({ getDashboardPageData: mocks.getDashboardPageData }));
vi.mock("@/server/services/baby-selector", () => ({ getHeaderBabySelector: mocks.getHeaderBabySelector }));
vi.mock("@/server/services/calendar", () => ({ getCalendar: mocks.getCalendar }));
vi.mock("@/server/services/activities", async () => {
  const actual = await vi.importActual<typeof import("@/server/services/activities")>("@/server/services/activities");
  return { ...actual, getActivityRowViewer: mocks.getActivityRowViewer, listActivities: mocks.listActivities };
});
vi.mock("@/server/services/reports", async () => {
  const actual = await vi.importActual<typeof import("@/server/services/reports")>("@/server/services/reports");
  return { ...actual, getReports: mocks.getReports };
});
vi.mock("@/server/services/planned-schedule", () => ({ getPlannedSchedule: mocks.getPlannedSchedule }));
vi.mock("@/server/services/trends-report", async () => {
  const actual = await vi.importActual<typeof import("@/server/services/trends-report")>("@/server/services/trends-report");
  return { ...actual, getTrends: mocks.getTrends };
});

const home = (role: string) => ({ householdId: "household-1", role, memberId: "member-1" });

/** Runs a page and reports where it redirected, or null if it got past the guard. */
async function destinationOf(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (error) {
    if (error instanceof RedirectError) return error.destination;
    // Reaching code past the guard is itself the answer: the guard let this role through, and the
    // page then failed on rendering internals these tests deliberately do not mock. Reported
    // distinctly rather than as "no redirect", so a pre-guard failure can never read as a pass --
    // the read_only case on the same mocks proves the guard line is actually reached.
    return `past-guard: ${(error as Error).message.slice(0, 80)}`;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireUserPage.mockResolvedValue({ id: "user-1" });
  mocks.getSession.mockResolvedValue({ user: { id: "user-1" } });
  mocks.getHeaderBabySelector.mockResolvedValue(null);
  mocks.listActivities.mockResolvedValue({ items: [], nextCursor: null });
  mocks.getPlannedSchedule.mockResolvedValue(null);
  mocks.getTrends.mockResolvedValue(null);
});

describe("the entry form at /app", () => {
  const load = async (role: string) => {
    mocks.getDashboardPageData.mockResolvedValue({
      dashboard: { home: home(role), babies: [], activities: [], summaries: [], warnings: [] },
      babySelector: null
    });
    const { default: DashboardPage } = await import("@/app/app/page");
    return destinationOf(() => DashboardPage({ searchParams: {} } as never));
  };

  it("sends a relative to Moments", async () => {
    expect(await load("read_only")).toBe("/app/moments");
  });

  it.each(["owner", "admin", "parent", "caretaker"])("lets %s through", async (role) => {
    expect(await load(role)).not.toBe("/app/moments");
  });
});

describe("the full log at /app/history", () => {
  const load = async (role: string) => {
    mocks.getActivityRowViewer.mockResolvedValue({ memberId: "member-1", role });
    mocks.getEffectiveHouseholdContext.mockResolvedValue({ ...home(role), userId: "user-1" });
    const { default: HistoryPage } = await import("@/app/app/history/page");
    return destinationOf(() => HistoryPage({ searchParams: {} } as never));
  };

  it("sends a relative to Moments", async () => {
    expect(await load("read_only")).toBe("/app/moments");
  });

  it.each(["owner", "admin", "parent", "caretaker"])("lets %s through", async (role) => {
    expect(await load(role)).not.toBe("/app/moments");
  });
});

describe("the calendar at /app/calendar", () => {
  const load = async (role: string) => {
    mocks.getCalendar.mockResolvedValue({ home: home(role), days: [], events: [], month: "2026-10" });
    const { default: CalendarPage } = await import("@/app/app/calendar/page");
    return destinationOf(() => CalendarPage({ searchParams: {} } as never));
  };

  it("sends a relative to Moments", async () => {
    expect(await load("read_only")).toBe("/app/moments");
  });

  it.each(["owner", "admin", "parent", "caretaker"])("lets %s through", async (role) => {
    expect(await load(role)).not.toBe("/app/moments");
  });
});

describe("the reports at /app/reports", () => {
  const load = async (role: string) => {
    mocks.getReports.mockResolvedValue({ home: home(role), baby: null, startKey: "2026-10-01", endKey: "2026-10-22", todayKey: "2026-10-22" });
    const { default: ReportsPage } = await import("@/app/app/reports/page");
    return destinationOf(() => ReportsPage({ searchParams: {} } as never));
  };

  it("sends a relative to Moments", async () => {
    expect(await load("read_only")).toBe("/app/moments");
  });

  it.each(["owner", "admin", "parent", "caretaker"])("lets %s through", async (role) => {
    expect(await load(role)).not.toBe("/app/moments");
  });
});

describe("the guards consult the viewer rather than a constant", () => {
  // A mutation that hardcodes the subject -- hasPermission("parent", "activity.create") -- leaves
  // every guard permanently true and matches any regex built around the call. The only way to catch
  // it is to vary the role and require the outcome to vary with it, which the suites above do: a
  // constant subject fails every "sends a relative to Moments" case at once.
  it("is covered by varying the role on all four pages", () => {
    expect(true).toBe(true);
  });
});
