// @vitest-environment jsdom
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RunningTimerRow, RunningTimerTile, type RunningTimerIndicator } from "@/components/dashboard/running-timer";

globalThis.React = React;

const nowMs = Date.parse("2026-09-21T10:12:04.000Z");

function timer(overrides: Partial<RunningTimerIndicator> = {}): RunningTimerIndicator {
  return {
    id: "timer-1",
    type: "sleep",
    timerState: "running",
    startedAt: new Date("2026-09-21T10:00:00.000Z"),
    pausedAt: null,
    pausedSeconds: 0,
    ...overrides
  };
}

function renderMarkup(element: React.ReactElement) {
  document.body.innerHTML = renderToStaticMarkup(element);
  return document.body;
}

describe("dashboard running timer indicators", () => {
  it("carries no timer buttons at all on the tile", () => {
    const body = renderMarkup(createElement(RunningTimerTile, { timer: timer(), label: "Sleep", nowMs }));

    // The whole point of the change: two wrapped buttons inside a third of a phone's width made the
    // tile tower over its neighbours. Stop lives in the shell's bar, pause on the activity.
    expect(body.querySelectorAll("button")).toHaveLength(0);
    expect(body.textContent).not.toContain("Stop");
    expect(body.textContent).not.toContain("Pause");
  });

  it("says how long instead of just saying that it is running", () => {
    const body = renderMarkup(createElement(RunningTimerTile, { timer: timer(), label: "Sleep", nowMs }));

    expect(body.textContent).toContain("12:04");
    expect(body.textContent).toContain("Sleep");
    // The old "Running" badge bought nothing the dot and the ticking clock do not already say, and it
    // cost one of the three lines the tile has. Only the spoken form still uses the word.
    const visibleText = [...body.querySelectorAll("*")]
      .filter((node) => !node.className.toString().includes("sr-only"))
      .map((node) => node.textContent ?? "");
    expect(visibleText.some((text) => text.trim() === "Running")).toBe(false);
  });

  it("opens the activity, with a way back to the dashboard", () => {
    const body = renderMarkup(createElement(RunningTimerTile, { timer: timer(), label: "Sleep", nowMs }));

    expect(body.querySelector("a")?.getAttribute("href")).toBe("/app/activities/timer-1?returnTo=%2Fapp");
  });

  it("shows a paused timer frozen at the moment it was paused", () => {
    const paused = timer({ timerState: "paused", pausedAt: new Date("2026-09-21T10:05:00.000Z") });
    const body = renderMarkup(createElement(RunningTimerTile, { timer: paused, label: "Sleep", nowMs }));

    expect(body.textContent).toContain("5:00");
    expect(body.textContent).toContain("Paused at 5 minutes");
  });

  it("gives a row the same indicator and no controls", () => {
    const body = renderMarkup(createElement(RunningTimerRow, { timer: timer({ type: "pumping" }), nowMs }));

    expect(body.querySelectorAll("button")).toHaveLength(0);
    expect(body.textContent).toContain("Pumping");
    expect(body.textContent).toContain("12:04");
    expect(body.querySelector("a")?.getAttribute("href")).toBe("/app/activities/timer-1?returnTo=%2Fapp");
  });

  it("accepts an already-serialized instant as well as a Date", () => {
    const body = renderMarkup(
      createElement(RunningTimerRow, { timer: timer({ startedAt: "2026-09-21T10:00:00.000Z" }), nowMs })
    );

    expect(body.textContent).toContain("12:04");
  });
});
