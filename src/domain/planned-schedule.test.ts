import { describe, expect, it } from "vitest";
import {
  PLANNED_SCHEDULE_MAX_ITEMS,
  formatScheduleTiming,
  parsePlannedScheduleItems,
  scheduleItemLabel
} from "@/domain/planned-schedule";

const exact = (kind: string, at: string, extra: Record<string, unknown> = {}) => ({ kind, label: null, timing: { mode: "exact", at }, note: null, ...extra });

describe("planned schedule items", () => {
  it("keeps the plan in time order, however it was entered", () => {
    const items = parsePlannedScheduleItems([
      exact("bedtime", "19:15"),
      exact("wake", "06:30"),
      { kind: "nap", label: null, timing: { mode: "window", from: "09:30", to: "10:00" }, note: "In the crib, white noise on" }
    ]);

    expect(items.map((item) => item.kind)).toEqual(["wake", "nap", "bedtime"]);
  });

  it("reads each item the way a caregiver would: what, and when", () => {
    const [wake, nap, walk] = parsePlannedScheduleItems([
      exact("wake", "06:30"),
      { kind: "nap", label: null, timing: { mode: "window", from: "13:00", to: "13:30" }, note: null },
      exact("custom", "16:00", { label: "Walk to the park" })
    ]);

    expect([scheduleItemLabel(wake), formatScheduleTiming(wake.timing)]).toEqual(["Wake up", "6:30 AM"]);
    expect([scheduleItemLabel(nap), formatScheduleTiming(nap.timing)]).toEqual(["Nap", "1:00 PM to 1:30 PM"]);
    expect(scheduleItemLabel(walk)).toBe("Walk to the park");
  });

  it("requires a custom item to say what it is, and nothing else to carry a label", () => {
    expect(() => parsePlannedScheduleItems([exact("custom", "16:00")])).toThrow();
    expect(() => parsePlannedScheduleItems([exact("feeding", "16:00", { label: "Bottle" })])).toThrow();
  });

  it("rejects a window that ends before it starts, and a time that is not a time", () => {
    expect(() => parsePlannedScheduleItems([{ kind: "nap", label: null, timing: { mode: "window", from: "10:00", to: "09:30" }, note: null }])).toThrow();
    expect(() => parsePlannedScheduleItems([exact("wake", "25:00")])).toThrow();
    expect(() => parsePlannedScheduleItems([exact("wake", "6:30")])).toThrow();
  });

  it("leaves medicine and supplements out until their safety fields exist", () => {
    // DEC-PROD-149: a planned medicine item needs approved safety fields, which this first version
    // does not have, so it cannot be planned yet rather than being planned unsafely.
    expect(() => parsePlannedScheduleItems([exact("medicine", "08:00")])).toThrow();
    expect(() => parsePlannedScheduleItems([exact("supplement", "08:00")])).toThrow();
  });

  it("bounds the plan and its text", () => {
    expect(() => parsePlannedScheduleItems(Array.from({ length: PLANNED_SCHEDULE_MAX_ITEMS + 1 }, () => exact("feeding", "08:00")))).toThrow();
    expect(() => parsePlannedScheduleItems([exact("custom", "08:00", { label: "x".repeat(61) })])).toThrow();
    expect(() => parsePlannedScheduleItems([exact("feeding", "08:00", { note: "x".repeat(301) })])).toThrow();
    expect(() => parsePlannedScheduleItems([exact("custom", "08:00", { label: "Walk\u0007" })])).toThrow();
  });

  it("tidies text so blank notes and labels do not linger", () => {
    const [item] = parsePlannedScheduleItems([exact("custom", "08:00", { label: "  Walk  ", note: "   " })]);
    expect(item).toMatchObject({ label: "Walk", note: null });
  });
});
