import { TimerState } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { activityBrowserUpdateSchema } from "@/lib/validation/activity";

vi.mock("@/lib/db/prisma", () => ({ prisma: {} }));
vi.mock("@/server/auth/context", () => ({ getEffectiveHouseholdContext: vi.fn(), requirePermission: vi.fn() }));
vi.mock("@/server/services/audit", () => ({ writeAudit: vi.fn() }));

import { activityLogUpdateData, specificCreate } from "@/server/services/activities";

const saved = {
  timerState: TimerState.none,
  startedAt: new Date("2026-09-19T14:30:00.000Z"),
  endedAt: new Date("2026-09-19T15:00:00.000Z"),
  durationSeconds: 1800
};

/** A sleep edit as the form submits it once the user has emptied the note and the length. */
function clearedSleepEdit() {
  return activityBrowserUpdateSchema.parse({
    id: "activity-1",
    expectedUpdatedAt: "2026-09-19T15:00:00.000Z",
    type: "sleep",
    babyId: "baby-1",
    occurredAt: "2026-09-19T10:30",
    startedAt: "2026-09-19T10:30",
    endedAt: "",
    notes: "",
    sleepType: "nap"
  });
}

describe("activityLogUpdateData", () => {
  it("writes a cleared note and a cleared length as null so the edit actually removes them", () => {
    const data = activityLogUpdateData("baby-1", specificCreate(clearedSleepEdit()), saved);

    // Prisma leaves a column untouched for `undefined`; before this, both survived the edit.
    expect(data.notes).toBeNull();
    expect(data.endedAt).toBeNull();
    expect(data.durationSeconds).toBeNull();
    expect(data.startedAt).toEqual(new Date("2026-09-19T14:30:00.000Z"));
  });

  it("keeps a running or paused timer's own timing, which only the timer controls change", () => {
    for (const timerState of [TimerState.running, TimerState.paused]) {
      const running = { ...saved, timerState, endedAt: null, durationSeconds: null };
      const data = activityLogUpdateData("baby-1", specificCreate(clearedSleepEdit()), running);

      expect(data.startedAt).toBe(running.startedAt);
      expect(data.endedAt).toBeNull();
      expect(data.durationSeconds).toBeNull();
      expect(data.timerState).toBe(timerState);
      expect(data.notes).toBeNull();
    }
  });

  it("writes a kept note and length through unchanged", () => {
    const edit = activityBrowserUpdateSchema.parse({
      ...clearedSleepEdit(),
      endedAt: "2026-09-19T11:15",
      notes: "Woke once"
    });
    const data = activityLogUpdateData("baby-1", specificCreate(edit), saved);

    expect(data.notes).toBe("Woke once");
    expect(data.endedAt).toEqual(new Date("2026-09-19T15:15:00.000Z"));
    expect(data.durationSeconds).toBe(2700);
  });
});
