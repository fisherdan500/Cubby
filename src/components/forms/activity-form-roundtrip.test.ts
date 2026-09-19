// @vitest-environment jsdom
import React, { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { activityTypes, type ActivityTypeName } from "@/domain/activity";
import { defaultUnitPreferences } from "@/domain/unit-preferences";
import { buildActivityDetailSections } from "@/lib/activity-detail";
import { activityEditInitial, type EditableActivity } from "@/lib/activity-edit-initial";
import type { ActivityWithDetails } from "@/lib/activity-format";
import { env } from "@/lib/env";
import { activityBrowserCreateSchema } from "@/lib/validation/activity";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/lib/db/prisma", () => ({ prisma: {} }));
vi.mock("@/server/auth/context", () => ({ getEffectiveHouseholdContext: vi.fn(), requirePermission: vi.fn() }));
vi.mock("@/server/services/audit", () => ({ writeAudit: vi.fn() }));

import { ActivityForm } from "@/components/forms/activity-form";
import { specificCreate } from "@/server/services/activities";

globalThis.React = React;
afterEach(cleanup);

// Everything the add form can submit for each type, filled in, as FormData sends it (strings; a ticked
// toggle chip is "on"). Timed types carry a start and an end one length-preset later.
const when = "2026-09-19T10:30";
const timed = { occurredAt: when, startedAt: when, endedAt: "2026-09-19T11:00" };
const full: Record<ActivityTypeName, Record<string, string>> = {
  feeding: { ...timed, mode: "bottle", amount: "4.5", unit: "oz", side: "left", bottleType: "Glass", food: "Oat cereal", leftSeconds: "300", rightSeconds: "240" },
  diaper: { occurredAt: when, kind: "mixed", rashConcern: "on", blowout: "on", creamApplied: "on", color: "Yellow", consistency: "Seedy", condition: "Mild redness" },
  sleep: { ...timed, sleepType: "nap", quality: "restless", location: "Crib" },
  pumping: { ...timed, amount: "6", unit: "oz", leftAmount: "3", rightAmount: "3", inventoryAction: "stored" },
  medicine: { occurredAt: when, name: "Ibuprofen", dose: "2.5", unit: "mL" },
  measurement: { occurredAt: when, weight: "14.2", weightUnit: "lb", length: "24", lengthUnit: "in", headCircumference: "16", headUnit: "in", temperature: "98.6", temperatureUnit: "F", measurementType: "Checkup" },
  milestone: { occurredAt: when, title: "First steps", category: "Motor" },
  note: { occurredAt: when, text: "Tried avocado", category: "Feeding" },
  bath: { occurredAt: when, bathType: "Sponge", products: "Gentle wash", waterTemp: "Warm" },
  play: { ...timed, intensity: "active", activityName: "Tummy time", location: "Living room" },
  mood: { occurredAt: when, mood: "Content", intensity: "3", context: "After nap" },
  supplement: { occurredAt: when, name: "Vitamin D", dose: "1", unit: "drop" },
  vaccine: { occurredAt: when, name: "DTaP", dose: "1 of 5", lot: "A123", provider: "Dr. Lee", dueDate: "2026-10-01", documentUrl: "https://example.test/card" },
  milk_inventory: { occurredAt: when, action: "stored", amount: "5", unit: "oz", storage: "Freezer", label: "Sept batch" }
};
const toggles = new Set(["rashConcern", "blowout", "creamApplied"]);
const notes = "Written on the way out";

/** What the database would hand back: the draft's own columns plus its one detail relation, unwrapped. */
function savedRecord(type: ActivityTypeName, payload: Record<string, string>) {
  const parsed = activityBrowserCreateSchema.parse({ type, babyId: "baby-1", notes, ...payload });
  const draft = specificCreate(parsed) as Record<string, unknown>;
  const record: Record<string, unknown> = { id: "activity-1", updatedAt: new Date("2026-09-19T15:00:00.000Z"), babyId: "baby-1" };
  for (const [key, value] of Object.entries(draft)) {
    record[key] = value && typeof value === "object" && "create" in value ? (value as { create: unknown }).create : value;
  }
  return record;
}

function editFormValues(type: ActivityTypeName, record: Record<string, unknown>) {
  render(createElement(ActivityForm, {
    babies: [{ id: "baby-1", name: "Avery" }],
    type,
    activityId: "activity-1",
    initial: activityEditInitial(record as unknown as EditableActivity, env.APP_TIMEZONE),
    appTimeZone: env.APP_TIMEZONE,
    unitPreferences: defaultUnitPreferences,
    medicineNames: [],
    supplementNames: []
  }));
  const form = screen.getByRole("button", { name: "Save changes" }).closest("form") as HTMLFormElement;
  return Object.fromEntries(new FormData(form)) as Record<string, string>;
}

describe("activity add/edit round trip", () => {
  it("covers every activity type", () => {
    expect(Object.keys(full).sort()).toEqual([...activityTypes].sort());
  });

  it.each([...activityTypes])("reopens a saved %s with every field as it was entered", (type) => {
    const payload = full[type];
    const submitted = editFormValues(type, savedRecord(type, payload));

    for (const [field, value] of Object.entries(payload)) {
      expect({ field, value: submitted[field] }).toEqual({ field, value });
    }
    expect(submitted.notes).toBe(notes);
  });

  it.each([...activityTypes])("shows every saved %s detail on the activity page", (type) => {
    const payload = full[type];
    const detail = buildActivityDetailSections(savedRecord(type, payload) as unknown as ActivityWithDetails, env.APP_TIMEZONE);
    const shown = detail.sections.flatMap(({ rows }) => rows);
    const text = shown.map(({ label, value }) => `${label}: ${value}`).join("\n").toLowerCase();

    for (const [field, value] of Object.entries(payload)) {
      // Timing, units and toggles are presented differently (a duration, a suffix, a "Yes" row).
      if (["occurredAt", "startedAt", "endedAt", "leftSeconds", "rightSeconds", "dueDate"].includes(field) || /unit$/i.test(field) || toggles.has(field)) continue;
      expect({ field, shown: text.includes(value.toLowerCase()) }).toEqual({ field, shown: true });
    }
    expect(detail.notes).toBe(notes);
  });
});
