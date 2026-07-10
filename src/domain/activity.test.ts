import { describe, expect, it } from "vitest";
import { filterActivitiesBySummaryType, isDailySummaryActivityType } from "@/domain/activity";

describe("daily summary activity filters", () => {
  it("accepts only activity types shown in the daily summary", () => {
    expect(isDailySummaryActivityType("feeding")).toBe(true);
    expect(isDailySummaryActivityType("vaccine")).toBe(true);
    expect(isDailySummaryActivityType("note")).toBe(false);
    expect(isDailySummaryActivityType(undefined)).toBe(false);
  });

  it("filters the daily log by the selected summary type", () => {
    const activities = [
      { id: "feed-1", type: "feeding" },
      { id: "sleep-1", type: "sleep" },
      { id: "feed-2", type: "feeding" }
    ];

    expect(filterActivitiesBySummaryType(activities, "feeding")).toEqual([activities[0], activities[2]]);
    expect(filterActivitiesBySummaryType(activities)).toEqual(activities);
  });
});
