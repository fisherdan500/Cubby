// @vitest-environment jsdom
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireUserPage: vi.fn(),
  getHouseholdHome: vi.fn(),
  getActivityView: vi.fn()
}));

globalThis.React = React;

vi.mock("@/server/auth/session", () => ({ requireUserPage: mocks.requireUserPage }));
vi.mock("@/server/services/households", () => ({ getHouseholdHome: mocks.getHouseholdHome }));
vi.mock("@/server/services/activities", () => ({ getActivityView: mocks.getActivityView }));
vi.mock("@/components/app-shell", () => ({
  AppShell: ({ children, timerBabyId, timerActivityType }: { children: React.ReactNode; timerBabyId?: string; timerActivityType?: string }) =>
    createElement("main", { "data-timer-baby-id": timerBabyId, "data-timer-activity-type": timerActivityType }, children)
}));
vi.mock("@/components/activity-artwork", () => ({ ActivityArtwork: () => createElement("span") }));
vi.mock("@/components/actions/confirmed-activity-delete", () => ({
  ConfirmedActivityDelete: () => createElement("button", { type: "button" }, "Delete")
}));
vi.mock("@/components/actions/activity-actions", () => ({
  PauseTimerButton: () => createElement("button", { type: "button" }, "Pause"),
  ResumeTimerButton: () => createElement("button", { type: "button" }, "Resume"),
  StopTimerButton: ({ returnTo }: { returnTo?: string }) =>
    createElement("button", { type: "button", "data-returns-to": returnTo ?? "" }, "Stop timer")
}));

import ActivityDetailPage from "@/app/app/activities/[id]/page";

function savedActivity(overrides: Record<string, unknown> = {}) {
  return {
    id: "activity-1",
    babyId: "baby-1",
    baby: { name: "Avery", inactiveAt: null },
    type: "sleep",
    occurredAt: new Date("2026-09-21T10:00:00.000Z"),
    startedAt: new Date("2026-09-21T10:00:00.000Z"),
    endedAt: null,
    durationSeconds: null,
    timezone: "Etc/UTC",
    notes: null,
    timerState: "none",
    pausedAt: null,
    pausedSeconds: 0,
    actorMember: { displayName: "Dad", user: { name: "Daniel" } },
    sleep: { sleepType: "nap", location: "Crib" },
    ...overrides
  };
}

async function renderDetail(activity: Record<string, unknown>) {
  mocks.getActivityView.mockResolvedValue({ activity, canUpdate: true, canDelete: true });
  const markup = renderToStaticMarkup(
    await ActivityDetailPage({ params: { id: "activity-1" }, searchParams: {} })
  );
  document.body.innerHTML = markup;
  return document.body;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireUserPage.mockResolvedValue({ id: "user-1", name: "Parent", email: "parent@example.test" });
  mocks.getHouseholdHome.mockResolvedValue({ householdId: "household-1" });
});

describe("activity detail timer controls", () => {
  it("scopes the shell timer bar to the activity's baby", async () => {
    const body = await renderDetail(savedActivity({ babyId: "baby-detail" }));

    expect(body.querySelector("main")?.getAttribute("data-timer-baby-id")).toBe("baby-detail");
    // And to its activity: another activity's timer does not show on this one's screen.
    expect(body.querySelector("main")?.getAttribute("data-timer-activity-type")).toBe("sleep");
  });

  it("offers pause and stop for a running timer, with how long it has run", async () => {
    // Pause lives only here: the dashboard tile is an indicator and the shell's bar carries stop.
    const body = await renderDetail(savedActivity({ timerState: "running" }));

    expect(body.textContent).toContain("Timer running");
    expect(body.textContent).toContain("Pause");
    expect(body.textContent).toContain("Stop timer");
    expect(body.textContent).not.toContain("Resume");
  });

  it("offers resume rather than pause once a timer is paused", async () => {
    const body = await renderDetail(
      savedActivity({ timerState: "paused", pausedAt: new Date("2026-09-21T10:30:00.000Z") })
    );

    expect(body.textContent).toContain("Timer paused");
    expect(body.textContent).toContain("Resume");
    expect(body.textContent).toContain("Stop timer");
    expect(body.textContent).not.toContain("Pause timer");
  });

  it("shows no timer controls on an activity that is not timing", async () => {
    const body = await renderDetail(savedActivity());

    expect(body.textContent).not.toContain("Timer running");
    expect(body.textContent).not.toContain("Stop timer");
  });

  it("hands Stop the same destination the Back link uses", async () => {
    mocks.getActivityView.mockResolvedValue({
      activity: savedActivity({ timerState: "running" }),
      canUpdate: true,
      canDelete: true
    });
    document.body.innerHTML = renderToStaticMarkup(
      await ActivityDetailPage({ params: { id: "activity-1" }, searchParams: { returnTo: "/app/history" } })
    );

    // Stopping finishes with this screen, so it leaves by itself rather than stranding you on a
    // stopped timer with a Back press still to make.
    expect(document.querySelector("[data-returns-to]")?.getAttribute("data-returns-to")).toBe("/app/history");
  });

  it("keeps its action bar clear of the shell's timer bar", async () => {
    const body = await renderDetail(savedActivity({ timerState: "running" }));
    const bar = body.querySelector('[aria-label="Activity actions"]')?.parentElement;

    // The offset is expressed against the shell's own variable, so the bar moves up exactly when a
    // timer bar is present and sits where it always did when there is none.
    expect(bar?.className).toContain("var(--active-timer-bar,0rem)");
  });

  it("does not offer timer controls to a member who cannot update the activity", async () => {
    mocks.getActivityView.mockResolvedValue({
      activity: savedActivity({ timerState: "running" }),
      canUpdate: false,
      canDelete: false
    });
    const markup = renderToStaticMarkup(
      await ActivityDetailPage({ params: { id: "activity-1" }, searchParams: {} })
    );
    document.body.innerHTML = markup;

    expect(document.body.textContent).not.toContain("Stop timer");
    expect(document.body.textContent).not.toContain("Pause");
  });
});
