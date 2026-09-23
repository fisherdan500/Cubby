// @vitest-environment jsdom
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireUserPage: vi.fn(),
  getHeaderBabySelector: vi.fn(),
  getDashboard: vi.fn()
}));

vi.mock("next/link", () => ({ default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) =>
  createElement("a", { href, ...props }, children) }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/components/app-shell", () => ({ AppShell: ({ children }: { children: React.ReactNode }) => createElement("main", null, children) }));
vi.mock("@/components/activity-artwork", () => ({ ActivityArtwork: () => createElement("span") }));
vi.mock("@/components/ui/card", () => ({ Card: ({ children, ...props }: { children: React.ReactNode }) => createElement("section", props, children) }));
vi.mock("@/components/actions/activity-actions", () => ({
  PauseTimerButton: ({ accessibleLabel }: { accessibleLabel?: string }) => createElement("button", { "aria-label": accessibleLabel }, "Pause"),
  ResumeTimerButton: ({ accessibleLabel }: { accessibleLabel?: string }) => createElement("button", { "aria-label": accessibleLabel }, "Resume"),
  StopTimerButton: ({ accessibleLabel }: { accessibleLabel?: string }) => createElement("button", { "aria-label": accessibleLabel }, "Stop timer")
}));
vi.mock("@/server/auth/session", () => ({ requireUserPage: mocks.requireUserPage }));
vi.mock("@/server/services/baby-selector", () => ({ getHeaderBabySelector: mocks.getHeaderBabySelector }));
vi.mock("@/server/services/dashboard", () => ({ getDashboard: mocks.getDashboard }));

import NurseryPage from "@/app/app/nursery/page";

globalThis.React = React;

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireUserPage.mockResolvedValue({ id: "user-1", name: "Parent" });
  mocks.getHeaderBabySelector.mockResolvedValue({ selectedBabyId: "baby-1", babies: [] });
  mocks.getDashboard.mockResolvedValue({
    home: { householdId: "household-1" },
    baby: { id: "baby-1", name: "Avery" },
    selectedDate: { timezone: "Etc/UTC" },
    activeTimers: [
      { id: "timer-1", babyId: "baby-1", type: "feeding", timerState: "running", startedAt: new Date("2026-09-22T10:00:00.000Z") },
      { id: "timer-2", babyId: "baby-1", type: "feeding", timerState: "running", startedAt: new Date("2026-09-22T10:05:00.000Z") }
    ]
  });
});

describe("Nursery timer actions", () => {
  it("distinguishes every action when the same baby has concurrent timers of one type", async () => {
    document.body.innerHTML = renderToStaticMarkup(await NurseryPage({ searchParams: { babyId: "baby-1" } }));

    expect(Array.from(document.querySelectorAll("button")).map((button) => button.getAttribute("aria-label"))).toEqual([
      "Pause Avery's feeding timer 1 of 2",
      "Stop Avery's feeding timer 1 of 2",
      "Pause Avery's feeding timer 2 of 2",
      "Stop Avery's feeding timer 2 of 2"
    ]);
  });
});
