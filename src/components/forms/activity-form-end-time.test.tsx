// @vitest-environment jsdom
/**
 * Correcting how long an activity lasted by saying when it ended.
 *
 * An existing sleep shows its length in minutes. To fix the time the baby actually woke, a
 * caregiver had to subtract bedtime from wake time in their head -- across midnight, for a night
 * sleep. These tests drive the real form and read what it would submit.
 */
import React, { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defaultUnitPreferences } from "@/domain/unit-preferences";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }) }));
import { ActivityForm } from "@/components/forms/activity-form";

globalThis.React = React;

function renderSleep(initial?: Record<string, string>) {
  render(
    createElement(ActivityForm, {
      babies: [{ id: "baby-1", name: "Avery" }],
      type: "sleep" as const,
      selectedBabyId: "baby-1",
      initial,
      activityId: initial ? "activity-1" : undefined,
      appTimeZone: "UTC",
      unitPreferences: defaultUnitPreferences,
      medicineNames: [],
      supplementNames: []
    })
  );
  const form = screen.getByRole("button", { name: initial ? "Save changes" : /^Log / }).closest("form") as HTMLFormElement;
  return () => Object.fromEntries(new FormData(form)) as Record<string, string>;
}

// An existing sleep that went down at 8:44pm and was recorded as ending at 8:30am.
const overnight = {
  occurredAt: "2026-09-27T20:44",
  startedAt: "2026-09-27T20:44",
  endedAt: "2026-09-28T08:30"
};

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-28T15:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("setting how long an activity lasted by its end time", () => {
  it("offers to set the end time directly", () => {
    renderSleep(overnight);
    expect(screen.getByRole("button", { name: "Ends at" })).toBeTruthy();
  });

  it("opens on the activity's current end, so nothing has to be worked out", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderSleep(overnight);

    await user.click(screen.getByRole("button", { name: "Ends at" }));

    const input = screen.getByLabelText("Ended") as HTMLInputElement;
    expect(input.value).toBe("2026-09-28T08:30");
  });

  it("submits the new end when the caregiver corrects the wake-up time", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const read = renderSleep(overnight);

    await user.click(screen.getByRole("button", { name: "Ends at" }));
    const input = screen.getByLabelText("Ended");
    await user.clear(input);
    await user.type(input, "2026-09-28T07:20");

    // She actually woke at 7:20, not 8:30. The caregiver says that; nobody computes 636 minutes.
    expect(read().endedAt).toBe("2026-09-28T07:20");
  });

  it("keeps the end date, so an overnight sleep stays one entry", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const read = renderSleep(overnight);

    await user.click(screen.getByRole("button", { name: "Ends at" }));
    const input = screen.getByLabelText("Ended");
    await user.clear(input);
    await user.type(input, "2026-09-28T09:05");

    const submitted = read();
    expect(submitted.startedAt).toBe("2026-09-27T20:44");
    expect(submitted.endedAt).toBe("2026-09-28T09:05");
  });

  it("says so when the end would fall before the start", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderSleep(overnight);

    await user.click(screen.getByRole("button", { name: "Ends at" }));
    const input = screen.getByLabelText("Ended");
    await user.clear(input);
    await user.type(input, "2026-09-27T19:00");

    // Refused rather than silently clamped: it means the date is wrong.
    expect(screen.getByRole("alert").textContent).toContain("before it started");
  });

  it("still lets a length be chosen from the presets", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const read = renderSleep(overnight);

    await user.click(screen.getByRole("button", { name: "45 min" }));

    expect(read().endedAt).toBe("2026-09-27T21:29");
  });

  it("names the day when an activity ends on a different one", () => {
    renderSleep(overnight);
    // "Ends 8:30 AM" on a sleep that began the previous evening would read as the same morning.
    expect(screen.getByText(/Ends Sep 28, 8:30 AM/)).toBeTruthy();
  });
});
