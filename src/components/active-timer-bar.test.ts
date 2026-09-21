// @vitest-environment jsdom
import React, { createElement } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ pathname: "/app" }));
vi.mock("next/navigation", () => ({ usePathname: () => navigation.pathname, useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/components/actions/activity-actions", () => ({
  StopTimerButton: ({ id }: { id: string }) =>
    createElement("button", { type: "button", "data-stops": id }, "Stop timer")
}));

import { ActiveTimerBar } from "@/components/active-timer-bar";
import type { ActiveTimerSummary } from "@/server/services/active-timers";

globalThis.React = React;

const startedAt = "2026-09-21T10:00:00.000Z";
const nowMs = Date.parse("2026-09-21T10:12:04.000Z");

function timer(overrides: Partial<ActiveTimerSummary> = {}): ActiveTimerSummary {
  return {
    id: "timer-1",
    type: "sleep",
    babyId: "baby-1",
    babyName: "Avery",
    timerState: "running",
    startedAt,
    pausedAt: null,
    pausedSeconds: 0,
    ...overrides
  };
}

async function renderBar(timers: ActiveTimerSummary[]) {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ timers }) });
  vi.stubGlobal("fetch", fetchMock);
  render(createElement(ActiveTimerBar));
  // The bar asks the server for its own timers, so let that settle before asserting.
  await act(async () => {
    await Promise.resolve();
  });
  return fetchMock;
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date(nowMs));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  cleanup();
  navigation.pathname = "/app";
  document.documentElement.style.removeProperty("--active-timer-bar");
});

describe("ActiveTimerBar", () => {
  it("shows nothing at all when no timer is running", async () => {
    await renderBar([]);
    expect(screen.queryByRole("region", { name: "Running timers" })).toBeNull();
    expect(document.documentElement.style.getPropertyValue("--active-timer-bar")).toBe("0rem");
  });

  it("offers one-tap stop for a running timer, with how long it has been going", async () => {
    await renderBar([timer()]);

    expect(screen.getByRole("region", { name: "Running timers" })).toBeTruthy();
    expect(screen.getByText("12:04")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop timer" }).getAttribute("data-stops")).toBe("timer-1");
    // Pause belongs to the activity's own screen; the bar is for the thing you need in a hurry.
    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
  });

  it("links to the activity itself, carrying a way back to where you were", async () => {
    navigation.pathname = "/app/history";
    await renderBar([timer()]);

    expect(screen.getByRole("link", { name: /Sleep/ }).getAttribute("href"))
      .toBe("/app/activities/timer-1?returnTo=%2Fapp%2Fhistory");
  });

  it("keeps ticking a running timer once a second", async () => {
    await renderBar([timer()]);

    act(() => {
      // advanceTimersByTime moves the clock on as well as firing the interval, so this lands a
      // whole minute and one second past the render instant.
      vi.setSystemTime(new Date(nowMs + 60_000));
      vi.advanceTimersByTime(1_000);
    });

    expect(screen.getByText("13:05")).toBeTruthy();
  });

  it("holds a paused timer still at the moment it was paused", async () => {
    await renderBar([timer({ timerState: "paused", pausedAt: "2026-09-21T10:05:00.000Z" })]);

    act(() => {
      vi.setSystemTime(new Date(nowMs + 600_000));
      vi.advanceTimersByTime(5_000);
    });

    expect(screen.getByText("5:00")).toBeTruthy();
  });

  it("reaches every timer, including a second one of the same type", async () => {
    const twinFeed = timer({ id: "timer-2", type: "feeding", startedAt: "2026-09-21T10:06:00.000Z" });
    const sameTypeAgain = timer({ id: "timer-3", type: "feeding", startedAt: "2026-09-21T10:08:00.000Z" });
    await renderBar([timer(), twinFeed, sameTypeAgain]);

    // Collapsed, the bar carries the first timer and says how many more there are.
    expect(screen.getAllByRole("button", { name: "Stop timer" })).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: /2 more running timers/ }));

    const stops = screen.getAllByRole("button", { name: "Stop timer" });
    expect(stops.map((button) => button.getAttribute("data-stops"))).toEqual(["timer-1", "timer-2", "timer-3"]);
    await userEvent.click(screen.getByRole("button", { name: "Show fewer" }));
    expect(screen.getAllByRole("button", { name: "Stop timer" })).toHaveLength(1);
  });

  it("stands aside on Nursery, which already gives every timer full night controls", async () => {
    navigation.pathname = "/app/nursery";
    await renderBar([timer()]);

    expect(screen.queryByRole("region", { name: "Running timers" })).toBeNull();
  });

  it("speaks the duration in words rather than announcing every passing second", async () => {
    await renderBar([timer()]);

    // The digits are hidden from assistive technology; a live region here would talk over the app.
    expect(screen.getByText("12:04").getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByText(/Running for 12 minutes/)).toBeTruthy();
    expect(document.querySelectorAll("[aria-live]")).toHaveLength(0);
  });
});
