import { describe, expect, it } from "vitest";
import { activityCreateSchema } from "@/lib/validation/activity";
import { MAX_BACKUP_TEXT_LENGTH } from "@/server/services/backup-format";

describe("activity validation", () => {
  // A note the restore parser would reject must not be storable in the first place. The column is
  // unbounded and the exporter copies whatever it finds, so accepting a longer note would produce
  // data that exports cleanly and then cannot be restored - stranding the household's own backup on
  // the instance that accepted it. The bound is shared with the backup format so the two cannot
  // drift apart.
  it("refuses a note longer than a backup can carry back in", () => {
    expect(() =>
      activityCreateSchema.parse({
        clientMutationId: "018f2b6c-8f5f-7e0b-8c3f-9f42c0a64004",
        babyId: "baby_1",
        type: "feeding",
        mode: "bottle",
        occurredAt: "2026-01-01T05:00",
        notes: "x".repeat(MAX_BACKUP_TEXT_LENGTH + 1)
      })
    ).toThrow();
  });

  it("accepts a note exactly as long as a backup can carry back in", () => {
    const notes = "x".repeat(MAX_BACKUP_TEXT_LENGTH);
    const parsed = activityCreateSchema.parse({
      clientMutationId: "018f2b6c-8f5f-7e0b-8c3f-9f42c0a64004",
      babyId: "baby_1",
      type: "feeding",
      mode: "bottle",
      occurredAt: "2026-01-01T05:00",
      notes
    });

    expect(parsed.notes).toBe(notes);
  });

  it("requires a UUID mutation ID for normal activity creation", () => {
    expect(() =>
      activityCreateSchema.parse({
        babyId: "baby_1",
        type: "feeding",
        occurredAt: "2026-01-01T05:00",
        mode: "bottle"
      })
    ).toThrow();
  });

  it("accepts a feeding payload", () => {
    const parsed = activityCreateSchema.parse({
      clientMutationId: "018f2b6c-8f5f-7e0b-8c3f-9f42c0a64004",
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
        clientMutationId: "018f2b6c-8f5f-7e0b-8c3f-9f42c0a64004",
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
        clientMutationId: "018f2b6c-8f5f-7e0b-8c3f-9f42c0a64004",
        babyId: "baby_1",
        type: "bath",
        occurredAt: "2026-01-01T05:00",
        timezone: "America/New_York",
        bathType: "sink"
      }).type
    ).toBe("bath");

    expect(
      activityCreateSchema.parse({
        clientMutationId: "018f2b6c-8f5f-7e0b-8c3f-9f42c0a64004",
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
      clientMutationId: "018f2b6c-8f5f-7e0b-8c3f-9f42c0a64004",
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
