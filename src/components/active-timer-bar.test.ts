// @vitest-environment jsdom
import React, { createElement } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ pathname: "/app", search: "" }));
vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useSearchParams: () => new URLSearchParams(navigation.search),
  useRouter: () => ({ refresh: vi.fn() })
}));
vi.mock("@/components/actions/activity-actions", () => ({
  StopTimerButton: ({ id, accessibleLabel }: { id: string; accessibleLabel?: string }) =>
    createElement("button", { type: "button", "data-stops": id, "aria-label": accessibleLabel }, "Stop timer")
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

async function renderBar(timers: ActiveTimerSummary[], selectedBabyId?: string, activityType?: string) {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, data: { timers } }) });
  vi.stubGlobal("fetch", fetchMock);
  render(createElement(ActiveTimerBar, { selectedBabyId, activityType }));
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
  navigation.search = "";
  document.documentElement.style.removeProperty("--active-timer-bar");
});

describe("ActiveTimerBar", () => {
  it("consumes the canonical API success envelope", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, data: { timers: [timer()] } })
      })
    );

    render(createElement(ActiveTimerBar));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByRole("region", { name: "Running timers" })).toBeTruthy();
  });

  it("receives the shell's selected baby instead of falling back to another baby", () => {
    const shell = readFileSync(resolve(process.cwd(), "src/components/app-shell.tsx"), "utf8");
    expect(shell).toContain("<ActiveTimerBar selectedBabyId={timerBabyId ?? selectedBabyId} activityType={timerActivityType} />");
  });

  it("on an activity's own screen, shows only a timer of that activity, never another one's", async () => {
    await renderBar([timer({ id: "sleep-1", type: "sleep" }), timer({ id: "feed-1", type: "feeding" })], "baby-1", "feeding");

    expect(screen.getByRole("region", { name: "Running timers" }).textContent).toContain("Feed");
    expect(document.querySelector('[data-stops="feed-1"]')).toBeTruthy();
    expect(document.querySelector('[data-stops="sleep-1"]')).toBeNull();
    expect(screen.queryByRole("button", { name: /more running timers/ })).toBeNull();
  });

  it("stays out of the way entirely on another activity's screen, so its buttons are never covered", async () => {
    await renderBar([timer({ id: "sleep-1", type: "sleep" })], "baby-1", "diaper");

    expect(screen.queryByRole("region", { name: "Running timers" })).toBeNull();
    expect(document.documentElement.style.getPropertyValue("--active-timer-bar")).toBe("0rem");
  });

  it("shows nothing at all when no timer is running", async () => {
    await renderBar([]);
    expect(screen.queryByRole("region", { name: "Running timers" })).toBeNull();
    expect(document.documentElement.style.getPropertyValue("--active-timer-bar")).toBe("0rem");
  });

  it("offers one-tap stop for a running timer, with how long it has been going", async () => {
    await renderBar([timer()]);

    expect(screen.getByRole("region", { name: "Running timers" })).toBeTruthy();
    expect(screen.getByText("12:04")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop Avery's sleep timer" }).getAttribute("data-stops")).toBe("timer-1");
    // Pause belongs to the activity's own screen; the bar is for the thing you need in a hurry.
    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
  });

  it("loads only the selected baby's timers and labels the baby beside the stop action", async () => {
    const fetchMock = await renderBar([
      timer({ id: "timer-b", type: "feeding", babyId: "baby-b", babyName: "Blake" })
    ], "baby-b");

    expect(fetchMock).toHaveBeenCalledWith("/api/timers/active?babyId=baby-b", { cache: "no-store" });
    expect(screen.getByText("Blake · Feeding")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop Blake's feeding timer" }).getAttribute("data-stops")).toBe("timer-b");
  });

  it("refetches immediately after an authoritative stop, pause, or resume completes", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, data: { timers: [timer()] } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, data: { timers: [] } }) });
    vi.stubGlobal("fetch", fetchMock);
    render(createElement(ActiveTimerBar, { selectedBabyId: "baby-1" }));
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByRole("region", { name: "Running timers" })).toBeTruthy();

    await act(async () => {
      window.dispatchEvent(new CustomEvent("cubby:active-timers-changed", {
        detail: { timerId: "timer-1", operation: "stop" }
      }));
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("region", { name: "Running timers" })).toBeNull();
  });

  it("does not let an older timer request overwrite the authoritative refresh", async () => {
    let resolveInitial: ((value: {
      ok: true;
      json: () => Promise<{ ok: true; data: { timers: ActiveTimerSummary[] } }>;
    }) => void) | undefined;
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { resolveInitial = resolve; }))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, data: { timers: [] } }) });
    vi.stubGlobal("fetch", fetchMock);
    render(createElement(ActiveTimerBar, { selectedBabyId: "baby-1" }));

    await act(async () => {
      window.dispatchEvent(new CustomEvent("cubby:active-timers-changed", {
        detail: { timerId: "timer-1", operation: "stop" }
      }));
      await Promise.resolve();
    });
    expect(screen.queryByRole("region", { name: "Running timers" })).toBeNull();

    await act(async () => {
      resolveInitial?.({ ok: true, json: async () => ({ ok: true, data: { timers: [timer()] } }) });
      await Promise.resolve();
    });

    expect(screen.queryByRole("region", { name: "Running timers" })).toBeNull();
  });

  it("links to the activity itself, carrying a way back to where you were", async () => {
    navigation.pathname = "/app";
    navigation.search = "babyId=baby-b&date=2026-09-20&summaryType=sleep";
    await renderBar([timer()]);

    expect(screen.getByRole("link", { name: /Sleep/ }).getAttribute("href"))
      .toBe("/app/activities/timer-1?returnTo=%2Fapp%3FbabyId%3Dbaby-b%26date%3D2026-09-20%26summaryType%3Dsleep");
  });

  it("keeps the validated outer return route when switching timers from an activity page", async () => {
    navigation.pathname = "/app/activities/timer-a";
    navigation.search = "returnTo=%2Fapp%2Fhistory%3FbabyId%3Dbaby-b%26type%3Dfeeding";
    await renderBar([timer({ id: "timer-b" })]);

    expect(screen.getByRole("link", { name: /Sleep/ }).getAttribute("href"))
      .toBe("/app/activities/timer-b?returnTo=%2Fapp%2Fhistory%3FbabyId%3Dbaby-b%26type%3Dfeeding");
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
    expect(screen.getAllByRole("button", { name: /^Stop .* timer$/ })).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: /2 more running timers/ }));
    const disclosure = screen.getByRole("button", { name: "Show fewer" });
    expect(document.activeElement).toBe(disclosure);

    const stops = screen.getAllByRole("button", { name: /^Stop .* timer/ });
    expect(stops.map((button) => button.getAttribute("data-stops"))).toEqual(["timer-1", "timer-2", "timer-3"]);
    expect(stops.map((button) => button.getAttribute("aria-label"))).toEqual([
      "Stop Avery's sleep timer",
      "Stop Avery's feeding timer 1 of 2",
      "Stop Avery's feeding timer 2 of 2"
    ]);
    await userEvent.click(disclosure);
    const collapsedDisclosure = screen.getByRole("button", { name: /2 more running timers/ });
    expect(document.activeElement).toBe(collapsedDisclosure);
    expect(screen.getAllByRole("button", { name: /^Stop .* timer$/ })).toHaveLength(1);
  });

  it("distinguishes same-name babies with the same timer type", async () => {
    await renderBar([
      timer({ id: "timer-a", type: "feeding", babyId: "baby-a", babyName: "Avery (baby 1 of 2)" }),
      timer({ id: "timer-b", type: "feeding", babyId: "baby-b", babyName: "Avery (baby 2 of 2)" })
    ]);

    await userEvent.click(screen.getByRole("button", { name: /1 more running timer/ }));

    expect(screen.getAllByText(/Avery \(baby [12] of 2\) · Feeding/)).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: /^Stop Avery/ }).map((button) => button.getAttribute("aria-label")))
      .toEqual([
        "Stop Avery (baby 1 of 2)'s feeding timer",
        "Stop Avery (baby 2 of 2)'s feeding timer"
      ]);
  });

  it("keeps a many-timer expansion scrollable inside a narrow phone viewport", async () => {
    const manyTimers = Array.from({ length: 12 }, (_, index) => timer({ id: `timer-${index + 1}` }));
    await renderBar(manyTimers);

    await userEvent.click(screen.getByRole("button", { name: /11 more running timers/ }));

    const list = screen.getByRole("list");
    expect(list.className).toContain("max-h-[calc(100dvh-10rem)]");
    expect(list.className).toContain("overflow-y-auto");
    expect(list.className).toContain("overscroll-contain");
    expect(screen.getAllByRole("button", { name: /^Stop .* timer/ })).toHaveLength(12);
  });

  it("shows on every app screen now that no screen carries its own timer controls", async () => {
    for (const pathname of ["/app", "/app/history", "/app/reports", "/app/settings"]) {
      navigation.pathname = pathname;
      await renderBar([timer()]);
      expect({ pathname, shown: screen.queryByRole("region", { name: "Running timers" }) !== null }).toEqual({ pathname, shown: true });
      cleanup();
    }
  });

  it("speaks the duration in words rather than announcing every passing second", async () => {
    await renderBar([timer()]);

    // The digits are hidden from assistive technology; a live region here would talk over the app.
    expect(screen.getByText("12:04").getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByText(/Running for 12 minutes/)).toBeTruthy();
    expect(document.querySelectorAll("[aria-live]")).toHaveLength(0);
  });
});
