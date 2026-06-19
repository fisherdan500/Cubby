import { describe, expect, it } from "vitest";
import { activityCreateSchema } from "@/lib/validation/activity";

describe("activity validation", () => {
  it("accepts a feeding payload", () => {
    const parsed = activityCreateSchema.parse({
      babyId: "baby_1",
      type: "feeding",
      occurredAt: "2026-01-01T05:00",
      timezone: "America/New_York",
      mode: "bottle",
      amount: "3",
      unit: "oz"
    });
    expect(parsed.type).toBe("feeding");
  });

  it("requires medicine name", () => {
    expect(() =>
      activityCreateSchema.parse({
        babyId: "baby_1",
        type: "medicine",
        occurredAt: "2026-01-01T05:00",
        timezone: "America/New_York",
        name: ""
      })
    ).toThrow();
  });

  it("accepts new care activity types", () => {
    expect(
      activityCreateSchema.parse({
        babyId: "baby_1",
        type: "bath",
        occurredAt: "2026-01-01T05:00",
        timezone: "America/New_York",
        bathType: "sink"
      }).type
    ).toBe("bath");

    expect(
      activityCreateSchema.parse({
        babyId: "baby_1",
        type: "milk_inventory",
        occurredAt: "2026-01-01T05:00",
        timezone: "America/New_York",
        action: "stored",
        amount: "3",
        unit: "oz"
      }).type
    ).toBe("milk_inventory");
  });

  it("accepts feeding timers", () => {
    const parsed = activityCreateSchema.parse({
      babyId: "baby_1",
      type: "feeding",
      occurredAt: "2026-01-01T05:00",
      startedAt: "2026-01-01T05:00",
      timezone: "America/New_York",
      mode: "breast",
      side: "left",
      activeTimer: true
    });
    expect(parsed.activeTimer).toBe(true);
  });
});
