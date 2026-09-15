// @vitest-environment jsdom
import React, { createElement } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultUnitPreferences } from "@/domain/unit-preferences";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }) }));
import { ActivityForm } from "@/components/forms/activity-form";

globalThis.React = React;

function renderForm(type: "feeding" | "diaper", initial?: Record<string, string>) {
  render(createElement(ActivityForm, {
    babies: [{ id: "baby-1", name: "Avery" }], type, selectedBabyId: "baby-1", initial, activityId: initial ? "activity-1" : undefined,
    appTimeZone: "UTC", unitPreferences: defaultUnitPreferences, medicineNames: [], supplementNames: []
  }));
  const form = screen.getByRole("button", { name: initial ? "Save changes" : "Log activity" }).closest("form") as HTMLFormElement;
  return () => Object.fromEntries(new FormData(form)) as Record<string, string>;
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-15T15:47:30.000Z"));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("activity form time entry", () => {
  it("defaults to now and submits the same wall-time format as before", () => {
    const values = renderForm("diaper");
    expect(screen.getByRole("button", { name: /Today, 3:47 PM/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Now" }).getAttribute("aria-pressed")).toBe("true");
    expect(values().occurredAt).toBe("2026-09-15T15:47");
    expect(values().startedAt).toBeUndefined();
  });

  it("applies one-tap shortcuts and nudges", async () => {
    const user = userEvent.setup();
    const values = renderForm("diaper");
    await user.click(screen.getByRole("button", { name: "15 min ago" }));
    expect(values().occurredAt).toBe("2026-09-15T15:32");
    await user.click(screen.getByRole("button", { name: "1 minute earlier" }));
    await user.click(screen.getByRole("button", { name: "5 minutes later" }));
    expect(values().occurredAt).toBe("2026-09-15T15:36");
    expect(screen.getByRole("button", { name: "Now" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("sets an exact time in the sheet only when Done is pressed", async () => {
    const user = userEvent.setup();
    const values = renderForm("diaper");
    await user.click(screen.getByRole("button", { name: /Today, 3:47 PM/ }));
    let dialog = screen.getByRole("dialog", { name: "Time" });
    await user.click(within(dialog).getByRole("button", { name: "Yesterday" }));
    await user.click(within(within(dialog).getByRole("listbox", { name: "Hour" })).getByRole("option", { name: "2" }));
    await user.click(within(within(dialog).getByRole("listbox", { name: "Minute" })).getByRole("option", { name: "05" }));
    await user.click(within(within(dialog).getByRole("listbox", { name: "AM or PM" })).getByRole("option", { name: "AM" }));
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(values().occurredAt).toBe("2026-09-15T15:47");

    await user.click(screen.getByRole("button", { name: /Today, 3:47 PM/ }));
    dialog = screen.getByRole("dialog", { name: "Time" });
    await user.click(within(dialog).getByRole("button", { name: "Yesterday" }));
    await user.click(within(within(dialog).getByRole("listbox", { name: "Hour" })).getByRole("option", { name: "2" }));
    await user.click(within(within(dialog).getByRole("listbox", { name: "Minute" })).getByRole("option", { name: "05" }));
    await user.click(within(within(dialog).getByRole("listbox", { name: "AM or PM" })).getByRole("option", { name: "AM" }));
    await user.click(within(dialog).getByRole("button", { name: "Done" }));
    expect(values().occurredAt).toBe("2026-09-14T02:05");
    expect(screen.getByRole("button", { name: /Yesterday, 2:05 AM/ })).toBeTruthy();
  });

  it("closes the sheet on Escape without changing the value", async () => {
    const user = userEvent.setup();
    const values = renderForm("diaper");
    await user.click(screen.getByRole("button", { name: /Today, 3:47 PM/ }));
    await user.click(within(screen.getByRole("listbox", { name: "Minute" })).getByRole("option", { name: "00" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(values().occurredAt).toBe("2026-09-15T15:47");
  });

  it("derives start and end from a length for timed activities", async () => {
    const user = userEvent.setup();
    const values = renderForm("feeding");
    expect(screen.getByText("Started")).toBeTruthy();
    expect(values().endedAt).toBe("");
    await user.click(screen.getByRole("button", { name: "30 min ago" }));
    await user.click(screen.getByRole("button", { name: "15 min" }));
    expect(values()).toMatchObject({ occurredAt: "2026-09-15T15:17", startedAt: "2026-09-15T15:17", endedAt: "2026-09-15T15:32" });
    expect(screen.getByText("Ends 3:32 PM · 15 min")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Other" }));
    await user.type(screen.getByRole("spinbutton", { name: "Minutes" }), "22");
    expect(values().endedAt).toBe("2026-09-15T15:39");
    await user.click(screen.getByRole("checkbox", { name: /start a timer/ }));
    expect(values()).toMatchObject({ activeTimer: "on", endedAt: "" });
    expect(screen.queryByRole("group", { name: "How long" })).toBeNull();
  });

  it("opens an edit with its saved start and length instead of now", () => {
    const values = renderForm("feeding", {
      babyId: "baby-1", updatedAt: "2026-09-15T00:00:00.000Z", occurredAt: "2026-09-14T08:10", startedAt: "2026-09-14T08:10", endedAt: "2026-09-14T08:30"
    });
    expect(screen.getByRole("button", { name: /Yesterday, 8:10 AM/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "20 min" }).getAttribute("aria-pressed")).toBe("true");
    expect(values()).toMatchObject({ occurredAt: "2026-09-14T08:10", startedAt: "2026-09-14T08:10", endedAt: "2026-09-14T08:30" });
  });
});
