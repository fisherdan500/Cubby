// @vitest-environment jsdom
import React, { createElement } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ pathname: "/app", search: "", refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useSearchParams: () => new URLSearchParams(navigation.search),
  useRouter: () => ({ refresh: navigation.refresh })
}));
vi.mock("@/components/actions/activity-actions", () => ({
  StopTimerButton: ({ id, accessibleLabel }: { id: string; accessibleLabel?: string }) =>
    createElement("button", { type: "button", "data-stops": id, "aria-label": accessibleLabel }, "Stop timer")
}));

import { ActiveTimerBar } from "@/components/active-timer-bar";
import { AppFreshnessProvider, PageFreshness } from "@/components/app-freshness";
import * as freshness from "@/components/app-freshness";
import type { ActiveTimerSummary } from "@/server/services/active-timers";

globalThis.React = React;

const startedAt = "2026-09-21T10:00:00.000Z";
const nowMs = Date.parse("2026-09-21T10:12:04.000Z");
const requestToken = "00000000-0000-4000-8000-000000000000";

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
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, data: { requestToken, confirmedAt: "2026-09-21T10:12:04.000Z", timers } }) });
  vi.stubGlobal("fetch", fetchMock);
  render(createElement(ActiveTimerBar, { selectedBabyId, activityType }));
  // The bar asks the server for its own timers, so let that settle before asserting.
  await act(async () => {
    await Promise.resolve();
  });
  return fetchMock;
}

beforeEach(() => {
  vi.spyOn(crypto, "getRandomValues").mockImplementation((array) => array);
  vi.spyOn(Math, "random").mockReturnValue(0.999999);
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date(nowMs));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  cleanup();
  navigation.pathname = "/app";
  navigation.search = "";
  document.documentElement.style.removeProperty("--active-timer-bar");
});

describe("ActiveTimerBar", () => {
  function guardedTree(selectedBabyId: string, expectedBabyId = selectedBabyId, expectedTimerState: "running" | "paused" = "running") {
    return createElement(AppFreshnessProvider, null,
      createElement(PageFreshness, { token: "page-1", confirmedAt: "2026-09-21T10:12:04.000Z", timeZone: "America/New_York" }),
      createElement(ActiveTimerBar, { selectedBabyId }),
      createElement(freshness.TimerFreshnessGuard, { babyId: expectedBabyId, activityId: "timer-1", expectedTimerState },
        ...["Pause", "Resume", "Stop"].map((name) => createElement("button", { key: name }, name))),
      createElement("button", null, "Edit activity"));
  }

  function expectGuardedActions(disabled: boolean) {
    for (const name of ["Pause", "Resume", "Stop"]) {
      expect(screen.getByRole("button", { name }).matches(":disabled"), name).toBe(disabled);
    }
    expect(screen.getByRole("button", { name: "Edit activity" }).matches(":disabled")).toBe(false);
  }

  function deferredTimerFetch(timers: ActiveTimerSummary[] = []) {
    const requests: { babyId: string | null; signal: AbortSignal; respond: (responseTimers?: ActiveTimerSummary[]) => void; reject: () => void }[] = [];
    let sequence = 0;
    vi.mocked(crypto.getRandomValues).mockImplementation((array) => {
      if (array instanceof Uint8Array) array[15] = ++sequence;
      return array;
    });
    vi.stubGlobal("fetch", vi.fn((url: string, options: RequestInit) => new Promise((resolve, reject) => {
      const params = new URL(url, "http://localhost").searchParams;
      requests.push({ babyId: params.get("babyId"), signal: options.signal as AbortSignal,
        reject: () => reject(new Error("network")), respond: (responseTimers = timers) => resolve({ ok: true, json: async () => ({
        ok: true, data: { requestToken: params.get("requestToken"), confirmedAt: "2026-09-21T10:12:04.000Z", timers: responseTimers }
      }) }) });
    })));
    return requests;
  }

  function expectAllTimerActions(disabled: boolean) {
    expectGuardedActions(disabled);
    const stops = screen.getAllByRole("button", { name: /^Stop .* timer/ });
    expect(stops).toHaveLength(2);
    for (const stop of stops) expect(stop.matches(":disabled")).toBe(disabled);
    expect(screen.getAllByText("Avery · Sleep")).toHaveLength(2);
    expect(screen.getAllByText(/Running for 12 minutes/)).toHaveLength(2);
  }

  it.each(["running", "paused"] as const)("binds the detail target to the authoritative ID and %s state", async (expectedTimerState) => {
    const requests = deferredTimerFetch();
    render(guardedTree("baby-1", "baby-1", expectedTimerState));
    expectGuardedActions(true);
    await act(async () => { requests[0].respond([]); });
    expectGuardedActions(true);
    for (const targets of [
      [timer({ id: "other-timer", timerState: expectedTimerState })],
      [timer({ timerState: expectedTimerState === "running" ? "paused" : "running" })],
      [timer({ timerState: expectedTimerState })]
    ]) {
      act(() => window.dispatchEvent(new CustomEvent("cubby:active-timers-changed")));
      expectGuardedActions(true);
      await act(async () => { requests.at(-1)!.respond(targets); });
      expectGuardedActions(targets[0].id !== "timer-1" || targets[0].timerState !== expectedTimerState);
    }
    // A previously matched detail must close again when the target disappears.
    act(() => window.dispatchEvent(new CustomEvent("cubby:active-timers-changed")));
    expectGuardedActions(true);
    await act(async () => { requests.at(-1)!.respond([]); });
    expectGuardedActions(true);
  });

  it("does not let a superseded matching target override the current mismatched state", async () => {
    const requests = deferredTimerFetch([timer()]);
    render(guardedTree("baby-1"));
    await act(async () => { requests[0].respond(); });
    expectGuardedActions(false);
    act(() => window.dispatchEvent(new CustomEvent("cubby:active-timers-changed")));
    act(() => window.dispatchEvent(new CustomEvent("cubby:active-timers-changed")));
    await act(async () => { requests[2].respond([timer({ timerState: "paused" })]); });
    expectGuardedActions(true);
    await act(async () => { requests[1].respond(); });
    expectGuardedActions(true);
    expect(screen.getByRole("region", { name: "Running timers" }).textContent).toContain("Paused at");
  });

  it("resolves owned Stop group descriptions through current, pending, stale, stale retry and current", async () => {
    const requests = deferredTimerFetch([timer(), timer({ id: "timer-2" })]);
    render(createElement(AppFreshnessProvider, null, createElement(ActiveTimerBar, { selectedBabyId: "baby-1" })));
    await act(async () => { requests[0].respond(); });
    fireEvent.click(screen.getByRole("button", { name: /1 more running timer/ }));
    const section = screen.getByRole("region", { name: "Running timers" });
    const groups = [...section.querySelectorAll("fieldset")];
    expect(groups).toHaveLength(2);
    const ownedIds = new Set<string>();
    const check = (reason?: string, excluded?: RegExp) => {
      expect(document.getElementById("app-freshness-status")).toBeNull();
      for (const owner of [section, ...groups]) {
        const id = owner.getAttribute("aria-describedby");
        if (!reason) {
          expect(id).toBeNull();
          continue;
        }
        expect(id, "every unavailable Stop group must own a resolving description").toBeTruthy();
        ownedIds.add(id!);
        const description = document.getElementById(id!);
        expect(description).not.toBeNull();
        expect(section.contains(description)).toBe(true);
        expect([...document.querySelectorAll("[id]")].filter((node) => node.id === id)).toHaveLength(1);
        expect(description!.classList.contains("sr-only")).toBe(true);
        expect(description!.textContent).toContain(reason);
        expect(description!.textContent).toContain("Timer actions are unavailable");
        if (excluded) expect(description!.textContent).not.toMatch(excluded);
      }
      for (const group of groups) expect(group.disabled).toBe(Boolean(reason));
      expect(section.textContent).toContain("Avery · Sleep");
    };
    check();
    act(() => window.dispatchEvent(new CustomEvent("cubby:active-timers-changed")));
    check("Timer data is refreshing", /out of date|not yet|being confirmed/);
    await act(async () => { requests[1].reject(); });
    check("Timer data may be out of date", /refreshing|being confirmed/);
    act(() => window.dispatchEvent(new CustomEvent("cubby:active-timers-changed")));
    check("Timer data may be out of date and is refreshing", /not yet|being confirmed/);
    await act(async () => { requests[2].respond(); });
    check();
    for (const id of ownedIds) expect(document.getElementById(id)).toBeNull();
    expect(section.textContent).not.toContain("Timer actions are unavailable");
  });

  it.each(["cadence", "focus", "retry", "navigation", "local-mutation"])("guards every post-confirmation %s load until its own success", async (trigger) => {
    vi.spyOn(performance, "now").mockImplementation(() => Date.now() - nowMs);
    const requests = deferredTimerFetch([timer(), timer({ id: "timer-2" })]);
    const view = render(guardedTree("baby-1"));
    await act(async () => { requests[0].respond(); });
    fireEvent.click(screen.getByRole("button", { name: /1 more running timer/ }));
    if (trigger === "retry") {
      act(() => { vi.advanceTimersByTime(5_000); window.dispatchEvent(new Event("focus")); });
      await act(async () => { requests.at(-1)!.respond(); });
      act(() => vi.advanceTimersByTime(10_000));
    }
    expectAllTimerActions(false);
    const previousCount = requests.length;
    act(() => {
      if (trigger === "cadence") vi.advanceTimersByTime(15_000);
      else if (trigger === "focus") {
        vi.advanceTimersByTime(5_000);
        window.dispatchEvent(new Event("focus"));
      } else if (trigger === "retry") fireEvent.click(screen.getByRole("button", { name: "Retry refresh" }));
      else if (trigger === "navigation") {
        navigation.pathname = "/app/activities/timer-1";
        view.rerender(guardedTree("baby-1"));
      } else window.dispatchEvent(new CustomEvent("cubby:active-timers-changed"));
    });
    expect(requests).toHaveLength(previousCount + 1);
    expect(requests.at(-1)!.babyId).toBe("baby-1");
    expectAllTimerActions(true);
    await act(async () => { requests.at(-1)!.respond(); });
    expectAllTimerActions(false);
  });

  it.each(["failure", "timeout"])("keeps a post-confirmation load guarded through %s and a superseded retry", async (outcome) => {
    const requests = deferredTimerFetch([timer(), timer({ id: "timer-2" })]);
    const view = render(guardedTree("baby-1"));
    await act(async () => { requests[0].respond(); });
    fireEvent.click(screen.getByRole("button", { name: /1 more running timer/ }));
    expectAllTimerActions(false);
    act(() => window.dispatchEvent(new CustomEvent("cubby:active-timers-changed")));
    expectAllTimerActions(true);
    await act(async () => {
      if (outcome === "failure") requests[1].reject();
      else vi.advanceTimersByTime(10_000);
    });
    expectAllTimerActions(true);
    expect(screen.getByRole("status").textContent).toContain("Timer data may be out of date");
    expect(screen.getByRole("status").querySelector("time")?.dateTime).toBe("2026-09-21T10:12:04.000Z");
    navigation.pathname = "/app/activities/timer-1";
    view.rerender(guardedTree("baby-1"));
    expectAllTimerActions(true);
    expect(screen.getByRole("status").textContent).toContain("Timer data may be out of date");
    act(() => window.dispatchEvent(new CustomEvent("cubby:active-timers-changed")));
    expect(requests[2].signal.aborted).toBe(true);
    await act(async () => { requests[1].respond(); requests[2].respond(); });
    expectAllTimerActions(true);
    await act(async () => { requests[3].respond(); });
    expectAllTimerActions(false);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("disables guarded actions before the initial authoritative timer snapshot", async () => {
    const requests = deferredTimerFetch([timer()]);
    render(guardedTree("baby-1"));
    expect(requests).toHaveLength(1);
    expectGuardedActions(true);
    await act(async () => { requests[0].respond(); });
    expectGuardedActions(false);
  });

  it("requires the matching new scope confirmation after selectedBabyId changes", async () => {
    const requests = deferredTimerFetch([timer()]);
    const view = render(guardedTree("baby-1"));
    await act(async () => { requests[0].respond(); });
    expectGuardedActions(false);
    // The new detail can render before the shell updates its selected scope.
    view.rerender(guardedTree("baby-1", "baby-2"));
    expectGuardedActions(true);
    await act(async () => { window.dispatchEvent(new CustomEvent("cubby:active-timers-changed")); });
    view.rerender(guardedTree("baby-2"));
    expect(requests.map(({ babyId }) => babyId)).toEqual(["baby-1", "baby-1", "baby-2"]);
    expectGuardedActions(true);
    await act(async () => { requests[1].respond(); });
    expectGuardedActions(true);
    await act(async () => { requests[2].respond([timer({ babyId: "baby-2" })]); });
    expectGuardedActions(false);
  });

  it("keeps detail timer controls guarded until the timer domain confirms recovery", async () => {
    expect(freshness).toHaveProperty("TimerFreshnessGuard");
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, data: {
      requestToken, timers: [timer()], confirmedAt: "2026-09-21T10:12:04.000Z"
    } }) }).mockRejectedValue(new Error("network"));
    vi.stubGlobal("fetch", fetchMock);
    const tree = (token: string) => createElement(AppFreshnessProvider, null,
      createElement(PageFreshness, { token, confirmedAt: "2026-09-21T10:12:04.000Z", timeZone: "America/New_York" }),
      createElement(ActiveTimerBar, { selectedBabyId: "baby-1" }),
      createElement(freshness.TimerFreshnessGuard, { babyId: "baby-1", activityId: "timer-1", expectedTimerState: "running" },
        ...["Pause", "Resume", "Stop"].map((name) => createElement("button", { key: name }, name))));
    const view = render(tree("page-1"));
    await act(async () => {});
    const controls = ["Pause", "Resume", "Stop"].map((name) => screen.getByRole("button", { name }));
    const disabled = (value: boolean) => controls.forEach((control) => expect(control.matches(":disabled")).toBe(value));
    disabled(false);
    await act(async () => { window.dispatchEvent(new CustomEvent("cubby:active-timers-changed")); });
    disabled(true);
    expect(screen.getByRole("region", { name: "Running timers" }).textContent).toContain("Avery");
    view.rerender(tree("page-2"));
    disabled(true);
    await act(async () => { vi.advanceTimersByTime(5_001); window.dispatchEvent(new Event("focus")); });
    disabled(true);
    Object.defineProperty(navigator, "onLine", { value: false });
    await act(async () => { window.dispatchEvent(new Event("offline")); });
    Object.defineProperty(navigator, "onLine", { value: true });
    await act(async () => { window.dispatchEvent(new Event("online")); });
    disabled(true);
    view.rerender(tree("page-3"));
    disabled(true);
    let confirmTimer!: (value: unknown) => void;
    fetchMock.mockImplementationOnce(() => new Promise((resolve) => { confirmTimer = resolve; }));
    await act(async () => { window.dispatchEvent(new CustomEvent("cubby:active-timers-changed")); });
    disabled(true);
    await act(async () => { confirmTimer({ ok: true, json: async () => ({ ok: true, data: {
      requestToken, timers: [timer()], confirmedAt: "2026-09-21T10:12:10.000Z"
    } }) }); });
    disabled(false);
    controls.forEach((control) => expect(control.isConnected).toBe(true));
  });
  it.each(["same-millisecond", "older", "mismatched-token"])("validates a distinct current request token and a %s confirmation", async (responseKind) => {
    let sequence = 0;
    vi.mocked(crypto.getRandomValues).mockImplementation((array) => {
      if (array instanceof Uint8Array) array[15] = ++sequence;
      return array;
    });
    const tokens: string[] = [];
    const confirmedAt = "2026-09-21T10:12:04.000Z";
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      const token = new URL(url, "http://localhost").searchParams.get("requestToken")!;
      tokens.push(token);
      if (tokens.length === 2) throw new Error("network");
      const initial = tokens.length === 1;
      return { ok: true, json: async () => ({ ok: true, data: {
        requestToken: !initial && responseKind === "mismatched-token" ? tokens[0] : token,
        confirmedAt: initial || responseKind === "same-millisecond" ? confirmedAt
          : responseKind === "older" ? "2026-09-21T10:12:03.999Z" : "2026-09-21T10:12:05.000Z",
        timers: [initial ? timer() : timer({ timerState: "paused", pausedAt: "2026-09-21T10:05:00.000Z" })]
      } }) };
    });
    vi.stubGlobal("fetch", fetchMock);
    render(createElement(ActiveTimerBar));
    await act(async () => {});
    expect(screen.getByText("12:04")).toBeTruthy();
    await act(async () => { window.dispatchEvent(new CustomEvent("cubby:active-timers-changed")); });
    expect(screen.getByRole("button", { name: /^Stop/ }).matches(":disabled")).toBe(true);
    await act(async () => { window.dispatchEvent(new CustomEvent("cubby:freshness-requested")); });
    expect(tokens).toHaveLength(3);
    expect(new Set(tokens).size).toBe(3);
    expect(screen.getByRole("button", { name: /^Stop/ }).matches(":disabled")).toBe(responseKind !== "same-millisecond");
    expect(screen.getByText(responseKind === "same-millisecond" ? "5:00" : "12:04")).toBeTruthy();
  });
  it("shared retry reloads a stale timer even while the page generation is unresolved without another generic event", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, data: { requestToken, timers: [timer()], confirmedAt: "2026-09-21T10:12:04.000Z" } }) })
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, data: { requestToken, timers: [], confirmedAt: "2026-09-21T10:12:30.000Z" } }) });
    vi.stubGlobal("fetch", fetchMock);
    const requested = vi.fn();
    window.addEventListener("cubby:freshness-requested", requested);
    try {
      render(createElement(AppFreshnessProvider, null, [
        createElement(PageFreshness, { key: "page", token: "page-1", confirmedAt: "2026-09-21T10:12:04.000Z", timeZone: "America/New_York" }),
        createElement(ActiveTimerBar, { key: "timer" })]));
      await act(async () => {});
      await act(async () => { vi.advanceTimersByTime(25_000); });
      await userEvent.click(screen.getByRole("button", { name: "Retry refresh" }));
      await act(async () => {});
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(requested).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole("region", { name: "Running timers" })).toBeNull();
      expect(screen.getByRole("status").textContent).toContain("Data may be out of date");
    } finally { window.removeEventListener("cubby:freshness-requested", requested); }
  });
  it("requires its own request token even when a cached response has a newer server instant", async () => {
    const fetchMock = await renderBar([timer()]);
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, data: {
      requestToken: "00000000-0000-4000-8000-000000000001", confirmedAt: "2026-09-21T10:12:06.000Z", timers: []
    } }) });
    await act(async () => { window.dispatchEvent(new CustomEvent("cubby:freshness-requested")); });
    expect(screen.getByRole("region", { name: "Running timers" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Stop/ }).matches(":disabled")).toBe(true);
    expect(new URL(fetchMock.mock.calls[0][0] as string, "http://localhost").searchParams.get("requestToken")).toBe(requestToken);
  });
  it("retains the timer confirmation on same-baby navigation failure and never shows another baby's snapshot", async () => {
    const confirmedAt = "2026-09-21T10:12:04.000Z";
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, data: { requestToken, timers: [timer()], confirmedAt } }) }).mockRejectedValue(new Error("network"));
    vi.stubGlobal("fetch", fetchMock);
    const tree = (baby: string) => createElement(AppFreshnessProvider, null, [
      createElement(PageFreshness, { key: "page", token: "page-1", confirmedAt, timeZone: "America/New_York" }), createElement(ActiveTimerBar, { key: "timer", selectedBabyId: baby })]);
    const view = render(tree("baby-1"));
    await act(async () => {});
    navigation.pathname = "/app/activities/timer-1";
    view.rerender(tree("baby-1"));
    await act(async () => {});
    expect(screen.getByRole("status").querySelector("time")?.dateTime).toBe(confirmedAt);
    expect(screen.getByRole("region", { name: "Running timers" })).toBeTruthy();
    view.rerender(tree("baby-2"));
    await act(async () => {});
    expect(screen.queryByRole("region", { name: "Running timers" })).toBeNull();
  });
  it("rejects an older timer instant after failure and only an authoritative snapshot reenables actions", async () => {
    const fetchMock = await renderBar([timer()]);
    fetchMock.mockRejectedValueOnce(new Error("network"));
    await act(async () => { window.dispatchEvent(new CustomEvent("cubby:active-timers-changed")); });
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, data: { requestToken, timers: [timer()], confirmedAt: "2026-09-21T10:12:03.999Z" } }) });
    await act(async () => { window.dispatchEvent(new CustomEvent("cubby:freshness-requested")); });
    expect(screen.getByRole("button", { name: /^Stop/ }).matches(":disabled")).toBe(true);
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, data: { requestToken, timers: [timer()], confirmedAt: "2026-09-21T10:12:05.000Z" } }) });
    await act(async () => { window.dispatchEvent(new CustomEvent("cubby:freshness-requested")); });
    expect(screen.getByRole("button", { name: /^Stop/ }).matches(":disabled")).toBe(false);
  });
  it("reports timer stale/current-as-of independently and shared retry accepts an authoritative empty snapshot", async () => {
    const confirmedAt = "2026-09-21T10:12:04.000Z";
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, data: { requestToken, timers: [timer()], confirmedAt } }) });
    vi.stubGlobal("fetch", fetchMock);
    const tree = (token: string) => createElement(AppFreshnessProvider, null, [
      createElement(PageFreshness, { key: "page", token, confirmedAt: "2026-09-21T10:12:05.000Z", timeZone: "America/New_York" }), createElement(ActiveTimerBar, { key: "timers" })]);
    const view = render(tree("page-1"));
    await act(async () => {});
    fetchMock.mockRejectedValueOnce(new Error("unavailable"));
    await act(async () => { window.dispatchEvent(new CustomEvent("cubby:active-timers-changed")); });
    view.rerender(tree("page-2"));
    expect(screen.getByRole("status").textContent).toContain("Timer data may be out of date");
    expect(screen.getByRole("status").querySelector("time")?.dateTime).toBe(confirmedAt);
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, data: { requestToken, timers: [], confirmedAt: "2026-09-21T10:12:06.000Z" } }) });
    await userEvent.click(screen.getByRole("button", { name: "Retry refresh" }));
    await act(async () => {});
    expect(screen.queryByRole("region", { name: "Running timers" })).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("marks a hung timer snapshot stale at ten seconds and aborts work on cleanup", async () => {
    const fetchMock = await renderBar([timer()]);
    fetchMock.mockImplementationOnce(() => new Promise(() => {}));
    await act(async () => { window.dispatchEvent(new CustomEvent("cubby:freshness-requested")); });
    act(() => vi.advanceTimersByTime(10_000));
    expect(screen.getByRole("button", { name: /^Stop/ }).matches(":disabled")).toBe(true);
    cleanup();
    expect(vi.getTimerCount()).toBe(0);
    const options = fetchMock.mock.calls.at(-1)?.[1] as RequestInit;
    expect(options.signal?.aborted).toBe(true);
  });

  it("offline disables known timer actions and online alone cannot reenable them", async () => {
    await renderBar([timer()]);
    Object.defineProperty(navigator, "onLine", { value: false });
    act(() => window.dispatchEvent(new Event("offline")));
    expect(screen.getByRole("button", { name: /^Stop/ }).matches(":disabled")).toBe(true);
    Object.defineProperty(navigator, "onLine", { value: true });
    act(() => window.dispatchEvent(new Event("online")));
    expect(screen.getByRole("button", { name: /^Stop/ }).matches(":disabled")).toBe(true);
  });
  it("reloads on generic freshness requests and cleans up that listener", async () => {
    const fetchMock = await renderBar([timer()]);
    await act(async () => { window.dispatchEvent(new CustomEvent("cubby:freshness-requested", { detail: { generation: 1 } })); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenLastCalledWith(`/api/timers/active?requestToken=${requestToken}`, expect.objectContaining({ cache: "no-store" }));
    cleanup();
    await act(async () => { window.dispatchEvent(new CustomEvent("cubby:freshness-requested", { detail: { generation: 2 } })); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(["network", "http", "malformed", "missing-instant", "bad-timer"])("retains known timers and disables every stale Stop on %s failure", async (failure) => {
    const fetchMock = await renderBar([timer(), timer({ id: "timer-2" })]);
    await userEvent.click(screen.getByRole("button", { name: /1 more running timer/ }));
    if (failure === "network") fetchMock.mockRejectedValueOnce(new Error("offline"));
    else fetchMock.mockResolvedValueOnce({ ok: failure !== "http", json: async () => failure === "malformed" ? {} : ({
      ok: true, data: { requestToken, timers: failure === "bad-timer" ? [{}] : [], ...(failure === "missing-instant" ? {} : { confirmedAt: "2026-09-21T10:12:05.000Z" }) }
    }) });
    await act(async () => { window.dispatchEvent(new CustomEvent("cubby:active-timers-changed")); });
    expect(screen.getByRole("region", { name: "Running timers" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /^Stop .* timer/ }).every((button) => button.matches(":disabled"))).toBe(true);
    expect(screen.getByText(/Timer data may be out of date/)).toBeTruthy();
  });
  it("consumes the canonical API success envelope", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, data: { requestToken, confirmedAt: "2026-09-21T10:12:04.000Z", timers: [timer()] } })
      })
    );

    render(createElement(ActiveTimerBar));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByRole("region", { name: "Running timers" })).toBeTruthy();
  });

  it("is placed by the shell only on the Log screen and on an activity's own screen", () => {
    const shell = readFileSync(resolve(process.cwd(), "src/components/app-shell.tsx"), "utf8");
    // Moments, Calendar, Reports, Settings and every other screen get no bar at all.
    expect(shell).toContain("{showAllTimers || timerActivityType ? (");
    expect(shell).toContain("<ActiveTimerBar selectedBabyId={timerBabyId ?? selectedBabyId} activityType={timerActivityType} />");
    expect(shell.match(/<ActiveTimerBar\b/g)).toHaveLength(1);
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

    expect(fetchMock).toHaveBeenCalledWith(`/api/timers/active?requestToken=${requestToken}&babyId=baby-b`, expect.objectContaining({ cache: "no-store" }));
    expect(screen.getByText("Blake · Feeding")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop Blake's feeding timer" }).getAttribute("data-stops")).toBe("timer-b");
  });

  it("refetches immediately after an authoritative stop, pause, or resume completes", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, data: { requestToken, confirmedAt: "2026-09-21T10:12:04.000Z", timers: [timer()] } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, data: { requestToken, confirmedAt: "2026-09-21T10:12:05.000Z", timers: [] } }) });
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
      json: () => Promise<{ ok: true; data: { requestToken: string; confirmedAt: string; timers: ActiveTimerSummary[] } }>;
    }) => void) | undefined;
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { resolveInitial = resolve; }))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, data: { requestToken, confirmedAt: "2026-09-21T10:12:05.000Z", timers: [] } }) });
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
      resolveInitial?.({ ok: true, json: async () => ({ ok: true, data: { requestToken, confirmedAt: "2026-09-21T10:12:04.000Z", timers: [timer()] } }) });
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

  it("shows on each of its activity's screens: logging, viewing and editing it", async () => {
    for (const pathname of ["/app/log/sleep", "/app/activities/timer-1", "/app/activities/timer-1/edit"]) {
      navigation.pathname = pathname;
      await renderBar([timer()], "baby-1", "sleep");
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
