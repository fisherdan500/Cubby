import { describe, expect, it } from "vitest";
import { activityTypes, type ActivityTypeName } from "@/domain/activity";
import { buildActivityDetailSections } from "@/lib/activity-detail";
import type { ActivityWithDetails } from "@/lib/activity-format";

const typeCases: Array<{
  type: ActivityTypeName;
  detail: Record<string, unknown>;
  expected: [string, string];
}> = [
  { type: "feeding", detail: { feeding: { mode: "bottle" } }, expected: ["Kind", "Bottle"] },
  { type: "diaper", detail: { diaper: { kind: "wet" } }, expected: ["Kind", "Wet"] },
  { type: "sleep", detail: { sleep: { sleepType: "nap" } }, expected: ["Sleep type", "Nap"] },
  { type: "pumping", detail: { pumping: { inventoryAction: "stored" } }, expected: ["Inventory action", "Stored"] },
  { type: "medicine", detail: { medicine: { name: "Ibuprofen" } }, expected: ["Medicine", "Ibuprofen"] },
  { type: "measurement", detail: { measurement: { measurementType: "growth" } }, expected: ["Measurement type", "Growth"] },
  { type: "milestone", detail: { milestone: { title: "First steps" } }, expected: ["Milestone", "First steps"] },
  { type: "note", detail: { note: { text: "Tried avocado" } }, expected: ["Entry", "Tried avocado"] },
  { type: "bath", detail: { bath: { bathType: "sponge" } }, expected: ["Bath type", "Sponge"] },
  { type: "play", detail: { play: { activityName: "Tummy time" } }, expected: ["Activity", "Tummy time"] },
  { type: "mood", detail: { mood: { mood: "content" } }, expected: ["Mood", "Content"] },
  { type: "supplement", detail: { supplement: { name: "Vitamin D" } }, expected: ["Supplement", "Vitamin D"] },
  { type: "vaccine", detail: { vaccine: { name: "DTaP" } }, expected: ["Vaccine", "DTaP"] },
  { type: "milk_inventory", detail: { milkInventory: { action: "stored" } }, expected: ["Action", "Stored"] }
];

describe("buildActivityDetailSections", () => {
  it("has a presentation fixture for every current activity type", () => {
    expect(typeCases.map(({ type }) => type)).toEqual([...activityTypes]);
  });

  it.each(typeCases)("formats populated $type details", ({ type, detail, expected }) => {
    expect(rowsFor(activity(type, detail))).toContainEqual({ label: expected[0], value: expected[1] });
  });

  it("keeps numeric zero while omitting blank and false-only optional fields", () => {
    const rows = rowsFor(
      activity("feeding", {
        feeding: {
          mode: "bottle",
          amount: 0,
          unit: "oz",
          side: null,
          bottleType: " ",
          food: "",
          leftSeconds: 3600,
          rightSeconds: 0
        }
      })
    );

    expect(rows).toContainEqual({ label: "Amount", value: "0 oz" });
    expect(rows).toContainEqual({ label: "Left side", value: "1h" });
    expect(rows).toContainEqual({ label: "Right side", value: "0 min" });
    expect(rows.map(({ label }) => label)).not.toContain("Bottle type");
  });

  it("formats timer state and timing facts without duplicating notes", () => {
    const detail = buildActivityDetailSections(
      activity("sleep", {
        timerState: "paused",
        startedAt: new Date("2026-07-13T18:00:00.000Z"),
        endedAt: new Date("2026-07-13T19:12:00.000Z"),
        durationSeconds: 4320,
        notes: "Settled quickly",
        sleep: { sleepType: "nap" }
      })
    );
    const rows = detail.sections.flatMap(({ rows }) => rows);

    expect(rows).toContainEqual({ label: "Timer", value: "Paused" });
    expect(rows).toContainEqual({ label: "Duration", value: "1h 12m" });
    expect(detail.notes).toBe("Settled quickly");
    expect(rows.map(({ value }) => value)).not.toContain("Settled quickly");
  });

  it("keeps a populated zero timer duration", () => {
    const rows = rowsFor(activity("sleep", { durationSeconds: 0 }));

    expect(rows).toContainEqual({ label: "Duration", value: "0 min" });
  });

  it("keeps vaccine due dates date-only across application timezones", () => {
    const rows = buildActivityDetailSections(
      activity("vaccine", {
        vaccine: { name: "DTaP", dueDate: new Date("2026-07-14T00:00:00.000Z") }
      }),
      "America/Los_Angeles"
    ).sections.flatMap(({ rows }) => rows);

    expect(rows).toContainEqual({ label: "Due date", value: "Jul 14, 2026" });
  });
});

function rowsFor(value: ActivityWithDetails) {
  return buildActivityDetailSections(value).sections.flatMap(({ rows }) => rows);
}

function activity(type: ActivityTypeName, detail: Record<string, unknown> = {}) {
  return {
    type,
    timerState: "none",
    durationSeconds: null,
    startedAt: null,
    endedAt: null,
    notes: null,
    ...detail
  } as unknown as ActivityWithDetails;
}
