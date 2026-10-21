// @vitest-environment jsdom
import { cleanup, render, screen, act } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const pathname = vi.hoisted(() => ({ current: "/app" }));
vi.mock("next/navigation", () => ({ usePathname: () => pathname.current }));

import { UnseenMomentsBadge } from "@/components/unseen-moments-badge";

function reply(unseen: number) {
  return { ok: true, json: async () => ({ data: { unseen } }) } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

function badge() {
  return <UnseenMomentsBadge placement="tab" />;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
}

function setOnline(online: boolean) {
  Object.defineProperty(navigator, "onLine", { configurable: true, value: online });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });
  vi.spyOn(Math, "random").mockReturnValue(0);
  pathname.current = "/app";
  setVisibility("visible");
  setOnline(true);
  fetchMock = vi.fn(async () => reply(3));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("asks for the count on mount and shows it", async () => {
  render(badge());
  await flush();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(screen.getByLabelText("3 new moments").textContent).toBe("3");
});

it("keeps polling while the page sits visible and idle", async () => {
  render(badge());
  await flush();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await act(async () => { vi.advanceTimersByTime(60_000); });
  await flush();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  await act(async () => { vi.advanceTimersByTime(60_000); });
  await flush();
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

it("moves the count when a moment arrives under an untouched page", async () => {
  fetchMock
    .mockImplementationOnce(async () => reply(1))
    .mockImplementationOnce(async () => reply(4));
  render(badge());
  await flush();
  expect(screen.getByLabelText("1 new moment").textContent).toBe("1");
  await act(async () => { vi.advanceTimersByTime(60_000); });
  await flush();
  expect(screen.getByLabelText("4 new moments").textContent).toBe("4");
});

it("spends no requests in a background tab", async () => {
  render(badge());
  await flush();
  const settled = fetchMock.mock.calls.length;
  setVisibility("hidden");
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
  await act(async () => { vi.advanceTimersByTime(300_000); });
  await flush();
  expect(fetchMock).toHaveBeenCalledTimes(settled);
});

it("refetches the moment the tab returns to the foreground", async () => {
  render(badge());
  await flush();
  setVisibility("hidden");
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
  await act(async () => { vi.advanceTimersByTime(300_000); });
  await flush();
  const hidden = fetchMock.mock.calls.length;
  setVisibility("visible");
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
  await flush();
  expect(fetchMock).toHaveBeenCalledTimes(hidden + 1);
});

it("holds off while offline and asks again when the connection returns", async () => {
  render(badge());
  await flush();
  const online = fetchMock.mock.calls.length;
  setOnline(false);
  await act(async () => { window.dispatchEvent(new Event("offline")); });
  await act(async () => { vi.advanceTimersByTime(300_000); });
  await flush();
  expect(fetchMock).toHaveBeenCalledTimes(online);
  setOnline(true);
  await act(async () => { window.dispatchEvent(new Event("online")); });
  await flush();
  expect(fetchMock).toHaveBeenCalledTimes(online + 1);
});

it("refetches on navigation even moments after the last poll", async () => {
  const view = render(badge());
  await flush();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  pathname.current = "/app/moments";
  await act(async () => { view.rerender(badge()); });
  await flush();
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("coalesces a burst of focus events into one request", async () => {
  render(badge());
  await flush();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("focus"));
  });
  await flush();
  // Still riding the mount answer: three focus events inside the gap spend no request yet.
  expect(fetchMock).toHaveBeenCalledTimes(1);
  // ...and they collapse into exactly ONE deferred ask, not three.
  await act(async () => { vi.advanceTimersByTime(5_000); });
  await flush();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  // A later return, well past the gap, is a fresh ask rather than a coalesced one.
  await act(async () => { vi.advanceTimersByTime(5_000); });
  await act(async () => { window.dispatchEvent(new Event("focus")); });
  await flush();
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

it("spreads the poll across clients with jitter inside its stated bounds", async () => {
  vi.spyOn(Math, "random").mockReturnValue(0.999999);
  render(badge());
  await flush();
  await act(async () => { vi.advanceTimersByTime(64_999); });
  await flush();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await act(async () => { vi.advanceTimersByTime(1); });
  await flush();
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("stops asking once it unmounts", async () => {
  const view = render(badge());
  await flush();
  const mounted = fetchMock.mock.calls.length;
  view.unmount();
  await act(async () => { vi.advanceTimersByTime(300_000); });
  await flush();
  expect(fetchMock).toHaveBeenCalledTimes(mounted);
});

it("abandons a request still in flight when it unmounts", async () => {
  let signal: AbortSignal | undefined;
  fetchMock.mockImplementationOnce((_url: string, init: RequestInit) => {
    signal = init.signal as AbortSignal;
    return new Promise<Response>(() => undefined);
  });
  const view = render(badge());
  await flush();
  expect(signal?.aborted).toBe(false);
  view.unmount();
  expect(signal?.aborted).toBe(true);
});

it("spends nothing on a navigation that happens while the tab is hidden", async () => {
  const view = render(badge());
  await flush();
  const visible = fetchMock.mock.calls.length;
  setVisibility("hidden");
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
  pathname.current = "/app/moments";
  await act(async () => { view.rerender(badge()); });
  await flush();
  expect(fetchMock).toHaveBeenCalledTimes(visible);
});

it("stays silent and keeps the last count when a poll fails", async () => {
  fetchMock
    .mockImplementationOnce(async () => reply(2))
    .mockImplementationOnce(async () => { throw new Error("network"); });
  render(badge());
  await flush();
  expect(screen.getByLabelText("2 new moments").textContent).toBe("2");
  await act(async () => { vi.advanceTimersByTime(60_000); });
  await flush();
  expect(screen.getByLabelText("2 new moments").textContent).toBe("2");
});

it("ignores a superseded response that lands after a newer one", async () => {
  let resolveFirst: (response: Response) => void = () => undefined;
  fetchMock
    .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveFirst = resolve; }))
    .mockImplementationOnce(async () => reply(1));
  const view = render(badge());
  await flush();
  pathname.current = "/app/moments";
  await act(async () => { view.rerender(badge()); });
  await flush();
  expect(screen.getByLabelText("1 new moment").textContent).toBe("1");
  await act(async () => { resolveFirst(reply(9)); });
  await flush();
  expect(screen.getByLabelText("1 new moment").textContent).toBe("1");
});

it("shows nothing at all when the feed is read", async () => {
  fetchMock.mockImplementation(async () => reply(0));
  render(badge());
  await flush();
  expect(screen.queryByLabelText(/new moment/)).toBeNull();
});
