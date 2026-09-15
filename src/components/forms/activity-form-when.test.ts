// @vitest-environment jsdom
import React, { createElement } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultUnitPreferences, type UnitPreferences } from "@/domain/unit-preferences";
import type { ActivityTypeName } from "@/domain/activity";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }) }));
import { ActivityForm } from "@/components/forms/activity-form";

globalThis.React = React;

function renderForm(
  type: ActivityTypeName,
  initial?: Record<string, string>,
  options: { babies?: Array<{ id: string; name: string }>; unitPreferences?: UnitPreferences } = {}
) {
  render(createElement(ActivityForm, {
    babies: options.babies ?? [{ id: "baby-1", name: "Avery" }], type, selectedBabyId: "baby-1", initial, activityId: initial ? "activity-1" : undefined,
    appTimeZone: "UTC", unitPreferences: options.unitPreferences ?? defaultUnitPreferences, medicineNames: [], supplementNames: []
  }));
  const form = screen.getByRole("button", { name: initial ? "Save changes" : /^Log / }).closest("form") as HTMLFormElement;
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
  it("defaults to now on one line and submits the same wall-time format as before", () => {
    const values = renderForm("diaper");
    expect(screen.getByRole("button", { name: /3:47 PM\s*Today · Now/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Now" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Log diaper" })).toBeTruthy();
    expect(values().occurredAt).toBe("2026-09-15T15:47");
    expect(values().startedAt).toBeUndefined();
  });

  it("applies one-tap shortcuts on the form and nudges inside the sheet", async () => {
    const user = userEvent.setup();
    const values = renderForm("diaper");
    await user.click(screen.getByRole("button", { name: "15 min ago" }));
    expect(values().occurredAt).toBe("2026-09-15T15:32");
    expect(screen.queryByRole("button", { name: "1 minute earlier" })).toBeNull();
    await user.click(screen.getByRole("button", { name: /3:32 PM/ }));
    const dialog = screen.getByRole("dialog", { name: "Time" });
    await user.click(within(dialog).getByRole("button", { name: "1 minute earlier" }));
    await user.click(within(dialog).getByRole("button", { name: "5 minutes later" }));
    expect(values().occurredAt).toBe("2026-09-15T15:32");
    await user.click(within(dialog).getByRole("button", { name: "Done" }));
    expect(values().occurredAt).toBe("2026-09-15T15:36");
    expect(screen.getByRole("button", { name: "Now" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("sets an exact time in the sheet only when Done is pressed", async () => {
    const user = userEvent.setup();
    const values = renderForm("diaper");
    const pick = async () => {
      await user.click(screen.getByRole("button", { name: /3:47 PM/ }));
      const dialog = screen.getByRole("dialog", { name: "Time" });
      await user.click(within(dialog).getByRole("button", { name: "Yesterday" }));
      await user.click(within(within(dialog).getByRole("listbox", { name: "Hour" })).getByRole("option", { name: "2" }));
      await user.click(within(within(dialog).getByRole("listbox", { name: "Minute" })).getByRole("option", { name: "05" }));
      await user.click(within(within(dialog).getByRole("listbox", { name: "AM or PM" })).getByRole("option", { name: "AM" }));
      return dialog;
    };
    await user.click(within(await pick()).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(values().occurredAt).toBe("2026-09-15T15:47");

    await user.click(within(await pick()).getByRole("button", { name: "Done" }));
    expect(values().occurredAt).toBe("2026-09-14T02:05");
    expect(screen.getByRole("button", { name: /2:05 AM\s*Yesterday/ })).toBeTruthy();
  });

  it("closes the sheet on Escape without changing the value", async () => {
    const user = userEvent.setup();
    const values = renderForm("diaper");
    await user.click(screen.getByRole("button", { name: /3:47 PM/ }));
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

  it("opens an edit with its saved start, length, kind and amount", () => {
    const values = renderForm("feeding", {
      babyId: "baby-1", updatedAt: "2026-09-15T00:00:00.000Z", occurredAt: "2026-09-14T08:10", startedAt: "2026-09-14T08:10", endedAt: "2026-09-14T08:30",
      mode: "bottle", amount: "4.5", unit: "mL"
    });
    expect(screen.getByRole("button", { name: /8:10 AM\s*Yesterday/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "20 min" }).getAttribute("aria-pressed")).toBe("true");
    expect(values()).toMatchObject({ occurredAt: "2026-09-14T08:10", startedAt: "2026-09-14T08:10", endedAt: "2026-09-14T08:30", mode: "bottle", amount: "4.5", unit: "mL" });
  });
});

describe("calm activity fields", () => {
  it("steps a feeding amount by half an ounce with the unit shown inside the field", async () => {
    const user = userEvent.setup();
    const values = renderForm("feeding");
    const amount = screen.getByRole("textbox", { name: "Amount" }) as HTMLInputElement;
    const decrease = screen.getByRole("button", { name: "Decrease amount by 0.5" }) as HTMLButtonElement;
    expect(decrease.disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: "Increase amount by 0.5" }));
    await user.click(screen.getByRole("button", { name: "Increase amount by 0.5" }));
    expect(amount.value).toBe("1");
    await user.clear(amount);
    await user.type(amount, "4.3x");
    expect(amount.value).toBe("4.3");
    await user.click(screen.getByRole("button", { name: "Increase amount by 0.5" }));
    expect(values()).toMatchObject({ mode: "bottle", amount: "5", unit: "oz" });
    expect(screen.getAllByText("oz").length).toBeGreaterThan(0);
  });

  it("steps by 5 when the entry is in mL, whether from Settings or a one-off unit change", async () => {
    const user = userEvent.setup();
    const values = renderForm("feeding", undefined, { unitPreferences: { ...defaultUnitPreferences, volume: "mL" } });
    await user.click(screen.getByRole("button", { name: "Increase amount by 5" }));
    expect(values()).toMatchObject({ amount: "5", unit: "mL" });
    const unit = screen.getByRole("radiogroup", { name: /Unit for this entry/ });
    await user.click(within(unit).getByRole("radio", { name: "oz" }));
    await user.click(screen.getByRole("button", { name: "Increase amount by 0.5" }));
    expect(values()).toMatchObject({ amount: "5.5", unit: "oz" });
  });

  it("shows only the fields that fit the kind of feeding", async () => {
    const user = userEvent.setup();
    const values = renderForm("feeding");
    const kind = screen.getByRole("radiogroup", { name: "Kind" });
    expect(within(kind).getByRole("radio", { name: "Bottle" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByRole("radiogroup", { name: /Side/ })).toBeNull();

    await user.click(within(kind).getByRole("radio", { name: "Breast" }));
    expect(screen.queryByRole("textbox", { name: "Amount" })).toBeNull();
    const side = screen.getByRole("radiogroup", { name: /Side/ });
    await user.click(within(side).getByRole("radio", { name: "Left" }));
    expect(values()).toMatchObject({ mode: "breast", side: "left" });
    expect(values().amount).toBeUndefined();
    await user.click(within(side).getByRole("radio", { name: "Left" }));
    expect(values().side).toBe("");

    await user.click(within(kind).getByRole("radio", { name: "Solids" }));
    expect(screen.getByRole("textbox", { name: "Food" })).toBeTruthy();
  });

  it("uses big choices and toggle chips for diapers, submitting the same values", async () => {
    const user = userEvent.setup();
    const values = renderForm("diaper");
    expect(values()).toMatchObject({ kind: "wet" });
    await user.click(within(screen.getByRole("radiogroup", { name: "Kind" })).getByRole("radio", { name: "Dirty" }));
    await user.click(screen.getByRole("checkbox", { name: "Rash or concern" }));
    expect(values()).toMatchObject({ kind: "dirty", rashConcern: "on" });
    expect(values().blowout).toBeUndefined();
  });

  it("moves between choices with arrow keys", async () => {
    const user = userEvent.setup();
    const values = renderForm("diaper");
    within(screen.getByRole("radiogroup", { name: "Kind" })).getByRole("radio", { name: "Wet" }).focus();
    await user.keyboard("{ArrowRight}");
    expect(values().kind).toBe("dirty");
    expect(document.activeElement?.textContent).toBe("Dirty");
  });

  it("offers a baby choice only when the household has more than one baby", async () => {
    const user = userEvent.setup();
    const values = renderForm("note", undefined, { babies: [{ id: "baby-1", name: "Avery" }, { id: "baby-2", name: "Blake" }] });
    await user.click(within(screen.getByRole("radiogroup", { name: "Baby" })).getByRole("radio", { name: "Blake" }));
    expect(values().babyId).toBe("baby-2");
  });

  it("folds notes and optional details away, opening them when an edit already has values", () => {
    renderForm("sleep", { babyId: "baby-1", updatedAt: "2026-09-15T00:00:00.000Z", occurredAt: "2026-09-15T10:00", notes: "Fussy", location: "Crib" });
    const [notes, details] = Array.from(document.querySelectorAll("details"));
    expect(notes.textContent).toContain("Add a note");
    expect(notes.open).toBe(true);
    expect(details.textContent).toContain("More details");
    expect(details.open).toBe(true);
  });
});
