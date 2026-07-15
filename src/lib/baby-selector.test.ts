import { describe, expect, it } from "vitest";
import {
  activityEditBabies,
  babySelectionHref,
  buildHeaderBabySelectorData,
  formatBabyAge,
  resolveSelectedBaby
} from "@/lib/baby-selector";

const babies = [
  { id: "baby-1", name: "Finley" },
  { id: "baby-2", name: "Riley" }
];

describe("baby selector helpers", () => {
  it("formats young baby ages in weeks", () => {
    expect(formatBabyAge(new Date("2026-03-13T00:00:00.000Z"), new Date("2026-06-19T12:00:00.000Z"))).toBe(
      "14 weeks"
    );
  });

  it("formats older baby ages in months", () => {
    expect(formatBabyAge(new Date("2025-06-13T00:00:00.000Z"), new Date("2026-06-19T12:00:00.000Z"))).toBe(
      "12 months"
    );
  });

  it("falls back when birth date is missing", () => {
    expect(formatBabyAge(null)).toBe("Age not set");
  });

  it("prefers query-selected baby over cached baby", () => {
    expect(resolveSelectedBaby(babies, "baby-2", "baby-1")?.id).toBe("baby-2");
  });

  it("uses cached baby when no valid query selection exists", () => {
    expect(resolveSelectedBaby(babies, undefined, "baby-2")?.id).toBe("baby-2");
  });

  it("falls back to the first baby when cached baby is invalid", () => {
    expect(resolveSelectedBaby(babies, undefined, "missing")?.id).toBe("baby-1");
  });

  it("builds selector data from the resolved dashboard inputs", () => {
    expect(
      buildHeaderBabySelectorData(
        [
          { id: "baby-1", name: "Finley", birthDate: new Date("2026-03-13T00:00:00.000Z") },
          { id: "baby-2", name: "Riley", birthDate: null }
        ],
        "baby-2",
        "sleep",
        new Date("2026-06-19T12:00:00.000Z")
      )
    ).toEqual({
      babies: [
        { id: "baby-1", name: "Finley", ageLabel: "14 weeks", inactive: false },
        { id: "baby-2", name: "Riley", ageLabel: "Age not set", inactive: false }
      ],
      selectedBabyId: "baby-2",
      activeTimerType: "sleep"
    });
  });

  it("marks inactive babies in historical selector data", () => {
    const data = buildHeaderBabySelectorData(
      [{ id: "baby-1", name: "Finley", birthDate: null, inactiveAt: new Date("2026-07-14T12:00:00.000Z") }],
      "baby-1"
    );

    expect(data?.babies).toEqual([
      { id: "baby-1", name: "Finley", ageLabel: "Age not set", inactive: true }
    ]);
  });

  it("offers active babies plus only the activity's current inactive baby for edits", () => {
    expect(
      activityEditBabies(
        [
          { id: "baby-active", name: "Active", inactiveAt: null },
          { id: "baby-current", name: "Current", inactiveAt: new Date("2026-07-14T12:00:00.000Z") },
          { id: "baby-other", name: "Other", inactiveAt: new Date("2026-07-13T12:00:00.000Z") }
        ],
        "baby-current"
      )
    ).toEqual([
      { id: "baby-active", name: "Active" },
      { id: "baby-current", name: "Current (Inactive)" }
    ]);
  });

  it("resets pagination when changing babies and preserves independent filters", () => {
    expect(
      babySelectionHref("/app/history", "babyId=baby-1&type=note&search=night+feed&cursor=activity-25", "baby-2")
    ).toBe("/app/history?babyId=baby-2&type=note&search=night+feed");
  });
});
