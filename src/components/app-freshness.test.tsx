// @vitest-environment jsdom
import { StrictMode, useEffect, useState } from "react";
import { readFileSync } from "node:fs";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const refresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/components/household-selection-control", () => ({ HouseholdSelectionControl: () => null }));
vi.mock("@/components/session-activity-reporter", () => ({ SessionActivityReporter: () => null }));
vi.mock("@/server/auth/session", () => ({ requireUserPage: vi.fn() }));
vi.mock("@/server/services/invitation-setup-corridor", () => ({ requireInvitationSetupCorridor: vi.fn() }));
vi.mock("@/server/services/household-selection", () => ({ getHouseholdSelectionState: async () => ({ status: "selected", options: [] }) }));
import Layout from "@/app/app/layout";
import { AppFreshnessProvider, PageFreshness, TimerFreshnessGuard, useRegisterTimerRetry, useReportTimerFreshness } from "@/components/app-freshness";
const instant = "2026-10-07T12:00:00.000Z";
function page(token = "server-1", confirmedAt = instant) {
  return <AppFreshnessProvider><PageFreshness token={token} confirmedAt={confirmedAt} timeZone="America/New_York" /><input aria-label="Draft" defaultValue="unsaved" /></AppFreshnessProvider>;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });
  vi.setSystemTime(new Date(instant));
  vi.spyOn(Math, "random").mockReturnValue(0.999999);
  refresh.mockClear();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
});

type ReportedTimerFreshness = Parameters<NonNullable<ReturnType<typeof useReportTimerFreshness>>>[0];
function TimerFreshnessReporter({ state }: { state: ReportedTimerFreshness }) {
  const report = useReportTimerFreshness();
  useEffect(() => { report?.(state); }, [report, state]);
  return null;
}

it.each((["running", "paused"] as const).flatMap((expectedTimerState) =>
  ["null snapshot", "empty snapshot", "missing ID", "mismatched state", "matching state"].map((scenario) => ({ expectedTimerState, scenario }))
))("binds the $expectedTimerState detail target for $scenario", ({ expectedTimerState, scenario }) => {
  const matching = { id: "timer-1", timerState: expectedTimerState };
  const tree = (targets: NonNullable<ReportedTimerFreshness>["targets"]) => <AppFreshnessProvider>
    <TimerFreshnessReporter state={{ babyId: "baby-1", pending: false, stale: false, confirmedAt: instant, targets }} />
    <TimerFreshnessGuard babyId="baby-1" activityId="timer-1" expectedTimerState={expectedTimerState}><button>Act on timer</button></TimerFreshnessGuard>
  </AppFreshnessProvider>;
  render(tree(scenario === "null snapshot" ? null : scenario === "empty snapshot" ? []
    : scenario === "missing ID" ? [{ ...matching, id: "other-timer" }]
    : scenario === "mismatched state" ? [{ ...matching, timerState: expectedTimerState === "running" ? "paused" : "running" }]
    : [matching]));
  expect(screen.getByRole("button", { name: "Act on timer" }).matches(":disabled"), scenario).toBe(scenario !== "matching state");
});

it.each<{ name: string; state: ReportedTimerFreshness; reason: string; excluded: RegExp }>([
  { name: "null", state: null, reason: "not yet been confirmed", excluded: /refreshing|being confirmed|out of date/ },
  { name: "initial pending", state: { babyId: "baby-1", pending: true, stale: false, confirmedAt: null, targets: null }, reason: "being confirmed", excluded: /refreshing|out of date/ },
  { name: "post-confirmation pending", state: { babyId: "baby-1", pending: true, stale: false, confirmedAt: instant, targets: [{ id: "timer-1", timerState: "running" }] }, reason: "refreshing", excluded: /not yet been confirmed|out of date/ },
  { name: "scope mismatch", state: { babyId: "baby-2", pending: false, stale: false, confirmedAt: instant, targets: [{ id: "timer-1", timerState: "running" }] }, reason: "not yet been confirmed", excluded: /refreshing|being confirmed|out of date/ },
  { name: "other scope pending", state: { babyId: "baby-2", pending: true, stale: false, confirmedAt: instant, targets: [{ id: "timer-1", timerState: "running" }] }, reason: "not yet been confirmed", excluded: /refreshing|being confirmed|out of date/ },
  { name: "unconfirmed", state: { babyId: "baby-1", pending: false, stale: false, confirmedAt: null, targets: null }, reason: "not yet been confirmed", excluded: /refreshing|being confirmed|out of date/ },
  { name: "stale", state: { babyId: "baby-1", pending: false, stale: true, confirmedAt: instant, targets: [{ id: "timer-1", timerState: "running" }] }, reason: "may be out of date", excluded: /refreshing|being confirmed/ },
  { name: "stale retry pending", state: { babyId: "baby-1", pending: true, stale: true, confirmedAt: instant, targets: [{ id: "timer-1", timerState: "running" }] }, reason: "may be out of date and is refreshing", excluded: /not yet been confirmed|being confirmed/ }
])("provides a truthful unique guard explanation for $name without PageFreshness", ({ state, reason, excluded }) => {
  const tree = (state: ReportedTimerFreshness) => <AppFreshnessProvider>
    <TimerFreshnessReporter state={state} />
    <TimerFreshnessGuard babyId="baby-1" activityId="timer-1" expectedTimerState="running"><button>Pause</button></TimerFreshnessGuard>
    <TimerFreshnessGuard babyId="baby-1" activityId="timer-1" expectedTimerState="running"><button>Stop</button></TimerFreshnessGuard>
  </AppFreshnessProvider>;
  const view = render(tree(state));
  expect(document.getElementById("app-freshness-status")).toBeNull();
  const guards = screen.getAllByRole("group", { name: "Timer actions" });
  const descriptionIds = guards.map((guard) => {
    expect((guard as HTMLFieldSetElement).disabled).toBe(true);
    const id = guard.getAttribute("aria-describedby");
    expect(id).toBeTruthy();
    const description = document.getElementById(id!);
    expect(description, "aria-describedby must resolve without a page status").not.toBeNull();
    expect(guard.contains(description)).toBe(true);
    expect(description!.classList.contains("sr-only")).toBe(true);
    expect(description!.textContent).toContain(reason);
    expect(description!.textContent).toContain("Timer actions are unavailable");
    expect(description!.textContent).not.toMatch(excluded);
    return id;
  });
  expect(new Set(descriptionIds).size).toBe(guards.length);
  view.rerender(tree({ babyId: "baby-1", pending: false, stale: false, confirmedAt: instant, targets: [{ id: "timer-1", timerState: "running" }] }));
  for (const guard of guards) {
    expect((guard as HTMLFieldSetElement).disabled).toBe(false);
    expect(guard.hasAttribute("aria-describedby")).toBe(false);
  }
  for (const id of descriptionIds) expect(document.getElementById(id!)).toBeNull();
  expect(screen.queryByText(/Timer actions are unavailable/)).toBeNull();
});

it("keeps the guard explanation distinct from a page-only stale banner", () => {
  render(<AppFreshnessProvider>
    <PageFreshness token="page-1" confirmedAt={instant} timeZone="America/New_York" />
    <TimerFreshnessReporter state={{ babyId: "baby-1", pending: true, stale: false, confirmedAt: instant, targets: [{ id: "timer-1", timerState: "running" }] }} />
    <TimerFreshnessGuard babyId="baby-1" activityId="timer-1" expectedTimerState="running"><button>Pause</button></TimerFreshnessGuard>
  </AppFreshnessProvider>);
  act(() => vi.advanceTimersByTime(25_000));
  const status = screen.getByRole("status");
  expect(status.textContent).toContain("Data may be out of date");
  expect(status.querySelector("time")?.dateTime).toBe(instant);
  const guard = screen.getByRole("group", { name: "Timer actions" });
  const description = document.getElementById(guard.getAttribute("aria-describedby")!);
  expect(description).not.toBeNull();
  expect(description).not.toBe(status);
  expect(description!.textContent).toContain("Timer data is refreshing");
  expect(description!.textContent).not.toContain("out of date");
});

it("uses confirmations to gate five-second focus refresh and close only a new generation", () => {
  const view = render(page());
  act(() => { vi.advanceTimersByTime(4_999); window.dispatchEvent(new Event("focus")); });
  expect(refresh).not.toHaveBeenCalled();
  act(() => { vi.advanceTimersByTime(2); window.dispatchEvent(new Event("focus")); });
  expect(refresh).toHaveBeenCalledTimes(1);
  view.rerender(page());
  act(() => { vi.advanceTimersByTime(9_000); window.dispatchEvent(new Event("focus")); });
  expect(refresh).toHaveBeenCalledTimes(1);
  view.rerender(page("server-2", "2026-10-07T12:00:35.001Z"));
  act(() => { vi.advanceTimersByTime(5_001); window.dispatchEvent(new Event("focus")); });
  expect(refresh).toHaveBeenCalledTimes(2);
});

it("is silent when current, times out at ten seconds, retains server current-as-of and retries", () => {
  const view = render(page());
  expect(screen.queryByRole("status")).toBeNull();
  act(() => vi.advanceTimersByTime(24_999));
  expect(screen.queryByRole("status")).toBeNull();
  act(() => vi.advanceTimersByTime(1));
  expect(screen.getByRole("status").textContent).toContain("Data may be out of date");
  expect(screen.getByRole("status").textContent).toContain("Data current as of");
  expect(screen.getByRole("status").querySelector("time")?.dateTime).toBe(instant);
  fireEvent.click(screen.getByRole("button", { name: "Retry refresh" }));
  expect(refresh).toHaveBeenCalledTimes(2);
  expect(screen.getByRole("status").querySelector("time")?.dateTime).toBe(instant);
  view.rerender(page("server-2", "2026-10-07T12:00:25.000Z"));
  expect(screen.queryByRole("status")).toBeNull();
});

it("offline is stale and online or cached confirmation cannot clear it", () => {
  const view = render(page());
  Object.defineProperty(navigator, "onLine", { value: false });
  act(() => window.dispatchEvent(new Event("offline")));
  expect(screen.getByRole("status")).toBeTruthy();
  Object.defineProperty(navigator, "onLine", { value: true });
  act(() => window.dispatchEvent(new Event("online")));
  view.rerender(page());
  expect(screen.getByRole("status")).toBeTruthy();
  view.rerender(page("server-2", "2026-10-07T12:00:01.000Z"));
  expect(screen.queryByRole("status")).toBeNull();
  Object.defineProperty(navigator, "onLine", { value: false });
  act(() => window.dispatchEvent(new Event("offline")));
  view.rerender(page("server-1", instant));
  expect(screen.getByRole("status").querySelector("time")?.dateTime).toBe("2026-10-07T12:00:01.000Z");
});

it("accepts a genuinely new token within the same server millisecond but rejects replay", () => {
  const view = render(page());
  act(() => vi.advanceTimersByTime(25_000));
  expect(screen.getByRole("status")).toBeTruthy();
  view.rerender(page("server-2", instant));
  expect(screen.queryByRole("status")).toBeNull();
  act(() => vi.advanceTimersByTime(30_000));
  view.rerender(page("server-1", instant));
  expect(screen.getByRole("status")).toBeTruthy();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

it("mounts one controller in the authenticated layout and polls at 15 seconds even in Strict Mode", async () => {
  render(<StrictMode>{await Layout({ children: <input defaultValue="draft" /> })}</StrictMode>);
  act(() => vi.advanceTimersByTime(14_999));
  expect(refresh).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(1));
  expect(refresh).toHaveBeenCalledTimes(1);
});

it.each([[0, 14_500], [0.5, 14_750], [0.999999, 15_000]])("bounds per-client polling jitter for random %s to %s ms", (random, delay) => {
  vi.mocked(Math.random).mockReturnValue(random);
  const view = render(<StrictMode>{page()}</StrictMode>);
  act(() => vi.advanceTimersByTime(delay - 1));
  expect(refresh).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(1));
  expect(refresh).toHaveBeenCalledTimes(1);
  vi.mocked(Math.random).mockReturnValue(random === 0 ? 0.999999 : 0);
  view.rerender(<StrictMode>{page("server-2")}</StrictMode>);
  act(() => vi.advanceTimersByTime(delay - 1));
  expect(refresh).toHaveBeenCalledTimes(1);
  act(() => vi.advanceTimersByTime(1));
  expect(refresh).toHaveBeenCalledTimes(2);
});

it("requests immediately on eligible focus, coalesces triggers, and emits one generic event", () => {
  const requested = vi.fn();
  window.addEventListener("cubby:freshness-requested", requested);
  const view = render(<AppFreshnessProvider><input /></AppFreshnessProvider>);
  act(() => {
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("online"));
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(9_000);
  });
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(requested).toHaveBeenCalledTimes(1);
  expect(requested.mock.calls[0][0].detail).toEqual({ generation: 1 });
  view.unmount();
  window.removeEventListener("cubby:freshness-requested", requested);
});

it.each(["focus", "online", "visibilitychange"])("refreshes on %s when eligible", (event) => {
  render(<AppFreshnessProvider><input /></AppFreshnessProvider>);
  act(() => (event === "visibilitychange" ? document : window).dispatchEvent(new Event(event)));
  expect(refresh).toHaveBeenCalledTimes(1);
});

it.each(["cadence", "focus", "online", "visibilitychange"])("automatically retries the same timed-out generation on %s and retries its loader", (trigger) => {
  const reloadTimers = vi.fn();
  function TimerLoader() {
    const register = useRegisterTimerRetry();
    useEffect(() => register?.(reloadTimers), [register]);
    return null;
  }
  const requested = vi.fn();
  window.addEventListener("cubby:freshness-requested", requested);
  try {
    const tree = (token: string) => <AppFreshnessProvider>
      <PageFreshness token={token} confirmedAt={instant} timeZone="America/New_York" /><TimerLoader />
    </AppFreshnessProvider>;
    const view = render(tree("server-1"));
    act(() => vi.advanceTimersByTime(25_000));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status").querySelector("time")?.dateTime).toBe(instant);
    act(() => {
      if (trigger === "cadence") vi.advanceTimersByTime(5_000);
      else (trigger === "visibilitychange" ? document : window).dispatchEvent(new Event(trigger));
    });
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(reloadTimers).toHaveBeenCalledTimes(1);
    expect(requested).toHaveBeenCalledTimes(1);
    expect(requested.mock.calls[0][0].detail).toEqual({ generation: 1 });
    expect(screen.getByRole("status").querySelector("time")?.dateTime).toBe(instant);
    act(() => {
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("online"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(reloadTimers).toHaveBeenCalledTimes(1);
    view.rerender(tree("server-2"));
    expect(screen.queryByRole("status")).toBeNull();
    act(() => vi.advanceTimersByTime(15_000));
    expect(requested.mock.calls.map(([event]) => event.detail.generation)).toEqual([1, 2]);
  } finally { window.removeEventListener("cubby:freshness-requested", requested); }
});

it("makes an in-flight offline generation immediately retryable on online recovery", () => {
  const reloadTimers = vi.fn();
  function TimerLoader() {
    const register = useRegisterTimerRetry();
    useEffect(() => register?.(reloadTimers), [register]);
    return null;
  }
  const requested = vi.fn();
  window.addEventListener("cubby:freshness-requested", requested);
  try {
    render(<AppFreshnessProvider><PageFreshness token="server-1" confirmedAt={instant} timeZone="America/New_York" /><TimerLoader /></AppFreshnessProvider>);
    act(() => { vi.advanceTimersByTime(5_001); window.dispatchEvent(new Event("focus")); });
    expect(refresh).toHaveBeenCalledTimes(1);
    Object.defineProperty(navigator, "onLine", { value: false });
    act(() => window.dispatchEvent(new Event("offline")));
    Object.defineProperty(navigator, "onLine", { value: true });
    act(() => window.dispatchEvent(new Event("online")));
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(reloadTimers).toHaveBeenCalledTimes(1);
    expect(requested).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status").querySelector("time")?.dateTime).toBe(instant);
  } finally { window.removeEventListener("cubby:freshness-requested", requested); }
});

it.each([false, true])("refreshes at five-second confirmation age after a short visible-window blur (overlapping visibility: %s)", (overlappingVisibility) => {
  const requested = vi.fn();
  window.addEventListener("cubby:freshness-requested", requested);
  try {
    render(page());
    act(() => { vi.advanceTimersByTime(1_000); window.dispatchEvent(new Event("blur")); });
    act(() => { vi.advanceTimersByTime(1_000); window.dispatchEvent(new Event("focus")); });
    expect(document.visibilityState).toBe("visible");
    expect(refresh).not.toHaveBeenCalled();
    expect(requested).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1_000);
      if (overlappingVisibility) document.dispatchEvent(new Event("visibilitychange"));
      vi.advanceTimersByTime(1_999);
    });
    expect(refresh).not.toHaveBeenCalled();
    expect(requested).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(requested).toHaveBeenCalledTimes(1);
    expect(requested.mock.calls[0][0].detail).toEqual({ generation: 1 });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("focus"));
      vi.advanceTimersByTime(1_000);
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(requested).toHaveBeenCalledTimes(1);
  } finally { window.removeEventListener("cubby:freshness-requested", requested); }
});

it("requests at the remaining confirmation-age threshold after a short hidden interval", () => {
  render(page());
  act(() => vi.advanceTimersByTime(1_000));
  Object.defineProperty(document, "visibilityState", { value: "hidden" });
  act(() => { document.dispatchEvent(new Event("visibilitychange")); vi.advanceTimersByTime(1_000); });
  Object.defineProperty(document, "visibilityState", { value: "visible" });
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  act(() => vi.advanceTimersByTime(2_999));
  expect(refresh).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(1));
  expect(refresh).toHaveBeenCalledTimes(1);
  act(() => {
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(1_000);
  });
  expect(refresh).toHaveBeenCalledTimes(1);
});

it.each([-60_000, 60_000])("uses monotonic confirmation age despite a wall-clock shift of %s ms", (shift) => {
  render(page());
  act(() => {
    vi.advanceTimersByTime(1_000);
    vi.setSystemTime(new Date(Date.now() + shift));
    window.dispatchEvent(new Event("focus"));
  });
  expect(refresh).not.toHaveBeenCalled();
  act(() => { vi.advanceTimersByTime(4_001); window.dispatchEvent(new Event("focus")); });
  expect(refresh).toHaveBeenCalledTimes(1);
  act(() => vi.advanceTimersByTime(10_000));
  expect(screen.getByRole("status").querySelector("time")?.dateTime).toBe(instant);
});

it.each(["focus", "visibilitychange"].flatMap((trigger) =>
  ["confirmation", "hidden", "offline", "unmount"].map((reason) => [trigger, reason])
))("cancels the %s one-shot on %s", (trigger, reason) => {
  const view = render(page());
  act(() => { vi.advanceTimersByTime(2_000); (trigger === "focus" ? window : document).dispatchEvent(new Event(trigger)); });
  if (reason === "confirmation") view.rerender(page("server-2", "2026-10-07T12:00:02.000Z"));
  if (reason === "hidden") {
    Object.defineProperty(document, "visibilityState", { value: "hidden" });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
  }
  if (reason === "offline") {
    Object.defineProperty(navigator, "onLine", { value: false });
    act(() => window.dispatchEvent(new Event("offline")));
  }
  if (reason === "unmount") view.unmount();
  act(() => vi.advanceTimersByTime(3_000));
  expect(refresh).not.toHaveBeenCalled();
  if (reason !== "confirmation") expect(vi.getTimerCount()).toBe(0);
});

it("does no periodic or focus work while hidden or offline and removes all work on cleanup", () => {
  const view = render(<AppFreshnessProvider><input /></AppFreshnessProvider>);
  Object.defineProperty(document, "visibilityState", { value: "hidden" });
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
    vi.advanceTimersByTime(60_000);
  });
  expect(refresh).not.toHaveBeenCalled();
  Object.defineProperty(document, "visibilityState", { value: "visible" });
  Object.defineProperty(navigator, "onLine", { value: false });
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("offline"));
    vi.advanceTimersByTime(60_000);
  });
  expect(refresh).not.toHaveBeenCalled();
  view.unmount();
  Object.defineProperty(navigator, "onLine", { value: true });
  act(() => {
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("online"));
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(60_000);
  });
  expect(refresh).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("preserves mounted draft, file, dialog, focus and scroll across a new server confirmation", () => {
  function Draft() {
    const [open, setOpen] = useState(false);
    return <><input aria-label="Notes" defaultValue="" /><input aria-label="Photo" type="file" />
      <button onClick={() => setOpen(true)}>Open dialog</button>{open ? <div role="dialog">Unsaved dialog</div> : null}</>;
  }
  const tree = (token: string, confirmedAt: string) => <AppFreshnessProvider>
    <PageFreshness token={token} confirmedAt={confirmedAt} timeZone="America/New_York" /><Draft />
  </AppFreshnessProvider>;
  const view = render(tree("one", instant));
  const notes = screen.getByRole("textbox") as HTMLInputElement;
  const file = screen.getByLabelText("Photo") as HTMLInputElement;
  const files = [new File(["fixture"], "fixture.txt")];
  fireEvent.change(notes, { target: { value: "keep this" } });
  fireEvent.change(file, { target: { files } });
  fireEvent.click(screen.getByRole("button", { name: "Open dialog" }));
  notes.focus();
  document.documentElement.scrollTop = 123;
  act(() => vi.advanceTimersByTime(15_000));
  view.rerender(tree("two", "2026-10-07T12:00:16.000Z"));
  expect(screen.getByRole("textbox")).toBe(notes);
  expect(notes.value).toBe("keep this");
  expect(file.files).toBe(files);
  expect(document.activeElement).toBe(notes);
  expect(screen.getByRole("dialog")).toBeTruthy();
  expect(document.documentElement.scrollTop).toBe(123);
  const source = ["src/components/app-freshness.tsx", "src/app/app/layout.tsx", "src/components/app-shell.tsx"].map((path) => readFileSync(path, "utf8")).join("\n");
  expect(source).not.toMatch(/location\.reload|\.reset\(|scrollTo\(|<AppFreshnessProvider\s+key=/);
});
