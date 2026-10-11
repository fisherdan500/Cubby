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

/** A stopped-timer edit as the form submits it: both ends of the window, as wall time. */
function stoppedTimerEdit(startedAt: string, endedAt: string) {
  return activityBrowserUpdateSchema.parse({
    id: "activity-1",
    expectedUpdatedAt: "2026-09-19T15:00:00.000Z",
    type: "sleep",
    babyId: "baby-1",
    occurredAt: startedAt,
    startedAt,
    endedAt,
    notes: "",
    sleepType: "nap"
  });
}

const stoppedWithPause = {
  timerState: TimerState.stopped,
  startedAt: new Date("2026-09-19T13:00:00.000Z"),
  endedAt: new Date("2026-09-19T14:00:00.000Z"),
  durationSeconds: 2700,
  pausedSeconds: 900
};

describe("activityLogUpdateData", () => {
  it("writes a cleared note and a cleared length as null so the edit actually removes them", () => {
    const data = activityLogUpdateData("baby-1", specificCreate(clearedSleepEdit()), saved);

    // Prisma leaves a column untouched for `undefined`; before this, both survived the edit.
    expect(data.notes).toBeNull();
    expect(data.endedAt).toBeNull();
    expect(data.durationSeconds).toBeNull();
    expect(data.startedAt).toEqual(new Date("2026-09-19T14:30:00.000Z"));
  });

  // A stopped timer's window is a record of something that already finished, so a caregiver who
  // mistyped it must be able to correct it. Only a RUNNING or PAUSED timer belongs exclusively to
  // the timer controls. Before this, every stopped-timer edit was silently discarded.
  it("applies a corrected window to a stopped timer", () => {
    const data = activityLogUpdateData(
      "baby-1",
      specificCreate(stoppedTimerEdit("2026-09-19T09:00", "2026-09-19T11:00")),
      stoppedWithPause
    );

    expect(data.startedAt).toEqual(new Date("2026-09-19T13:00:00.000Z"));
    expect(data.endedAt).toEqual(new Date("2026-09-19T15:00:00.000Z"));
    expect(data.timerState).toBe(TimerState.stopped);
  });

  // The duration is the ACTIVE time, so the paused time stays subtracted from the new window.
  // Recomputing it as the raw span would silently add the pause back into the active duration.
  it("recomputes a corrected stopped-timer duration without adding its paused time back", () => {
    const data = activityLogUpdateData(
      "baby-1",
      specificCreate(stoppedTimerEdit("2026-09-19T09:00", "2026-09-19T11:00")),
      stoppedWithPause
    );

    // 2h window minus the 15m already paused.
    expect(data.durationSeconds).toBe(6300);
  });

  it("keeps a stopped timer's own timing when the edit carries no window", () => {
    // Editing only descriptive fields must not disturb the arithmetic the stop produced.
    const edit = activityBrowserUpdateSchema.parse({
      id: "activity-1",
      expectedUpdatedAt: "2026-09-19T15:00:00.000Z",
      type: "sleep",
      babyId: "baby-1",
      occurredAt: "2026-09-19T09:00",
      notes: "Woke once",
      sleepType: "nap"
    });
    const data = activityLogUpdateData("baby-1", specificCreate(edit), stoppedWithPause);

    expect(data.startedAt).toBe(stoppedWithPause.startedAt);
    expect(data.endedAt).toBe(stoppedWithPause.endedAt);
    expect(data.durationSeconds).toBe(2700);
  });

  // The form submits the window on EVERY edit, so presence alone cannot mean "corrected". An edit
  // that resubmits the stored window unchanged must leave the precise pause tracking in place,
  // otherwise a note-only change would quietly coarsen the entry's pause history.
  it("leaves the precise pause tracking alone when the resubmitted window is unchanged", () => {
    const unchanged = activityBrowserUpdateSchema.parse({
      id: "activity-1",
      expectedUpdatedAt: "2026-09-19T15:00:00.000Z",
      type: "sleep",
      babyId: "baby-1",
      occurredAt: "2026-09-19T09:00",
      // The same instants the fixture already stores, as the form would resubmit them.
      startedAt: "2026-09-19T09:00",
      endedAt: "2026-09-19T10:00",
      notes: "Woke once",
      sleepType: "nap"
    });
    const data = activityLogUpdateData("baby-1", specificCreate(unchanged), stoppedWithPause);

    expect(data.durationSeconds).toBe(2700);
    expect(data.pauseTrackingStartedAt).toBeUndefined();
    expect(data.pauseTrackingBaselineSeconds).toBeUndefined();
  });

  // A genuinely corrected window must clear the precise pause tracking: starting a timer sets
  // pauseTrackingStartedAt to the old start, and the integrity trigger requires it to sit inside
  // the entry's window. Clearing is only legal because assertStoppedWindowCorrectionAllowed has
  // already rejected the edit when any interval row exists - the rows themselves cannot be removed,
  // since the table is append-only for the runtime role.
  it("clears the precise pause tracking when the window really is corrected", () => {
    const data = activityLogUpdateData(
      "baby-1",
      specificCreate(stoppedTimerEdit("2026-09-19T09:00", "2026-09-19T11:00")),
      stoppedWithPause
    );

    expect(data.pauseTrackingStartedAt).toBeNull();
    expect(data.pauseTrackingBaselineSeconds).toBeNull();
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

  // A running timer has no end to correct, so an end arriving for one is ignored rather than
  // written: accepting it would end a timer through the ordinary edit path.
  it("ignores a window sent for a running timer", () => {
    const running = { ...stoppedWithPause, timerState: TimerState.running, endedAt: null, durationSeconds: null };
    const data = activityLogUpdateData(
      "baby-1",
      specificCreate(stoppedTimerEdit("2026-09-19T09:00", "2026-09-19T11:00")),
      running
    );

    expect(data.startedAt).toBe(running.startedAt);
    expect(data.endedAt).toBeNull();
    expect(data.durationSeconds).toBeNull();
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
