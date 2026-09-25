import { describe, expect, it } from "vitest";
import type { PlannedScheduleItem } from "@/domain/planned-schedule";
import { applyProposalChoices, proposeScheduleFromRoutine, type ProposalRoutine } from "@/lib/schedule-proposal";

const slot = (minutes: number, spreadMinutes: number, days: number) => ({
  minutes, time: "", spreadMinutes, durationSeconds: null, duration: null, days
});

function routine(overrides: Partial<ProposalRoutine> = {}): ProposalRoutine {
  return {
    startKey: "2026-09-18",
    endKey: "2026-10-01",
    windowDays: 14,
    daysWithData: 14,
    enoughData: true,
    naps: { usualCount: 2, daysWithUsualCount: 11, daysCounted: 14, minCount: 1, maxCount: 3, slots: [] },
    feeds: { usualCount: 5, daysWithUsualCount: 9, daysCounted: 14, minCount: 4, maxCount: 6, slots: [], intervalMinutes: null, interval: null, nightFeeds: null },
    timeline: [
      { id: "wake", kind: "wake", activityType: "sleep", label: "Wake up", slot: slot(7 * 60, 5, 14) },
      { id: "nap-0", kind: "nap", activityType: "sleep", label: "Nap 1", slot: slot(9 * 60 + 30, 30, 11) },
      { id: "medicine-0", kind: "medicine", activityType: "medicine", label: "Medicine", slot: slot(8 * 60, 0, 6) },
      { id: "bedtime", kind: "bedtime", activityType: "sleep", label: "Bedtime", slot: slot(19 * 60 + 12, 15, 13) }
    ],
    ...overrides
  };
}

const planned = (kind: PlannedScheduleItem["kind"], timing: PlannedScheduleItem["timing"]): PlannedScheduleItem => ({ kind, label: null, timing, note: null });

describe("suggesting a plan from the observed routine", () => {
  it("suggests each steady time, as an exact time when it barely moves and a window when it does", () => {
    const proposal = proposeScheduleFromRoutine(routine(), []);

    expect(proposal.items.map((item) => [item.kind, item.proposed])).toEqual([
      ["wake", { mode: "exact", at: "07:00" }],
      ["nap", { mode: "window", from: "09:00", to: "10:00" }],
      ["bedtime", { mode: "window", from: "19:00", to: "19:30" }]
    ]);
    expect(proposal.items.every((item) => item.change.type === "add")).toBe(true);
  });

  it("shows the evidence behind each suggestion: days, window, spread, what was left out, and a plain confidence", () => {
    const [wake, nap] = proposeScheduleFromRoutine(routine(), []).items;

    expect(wake.evidence).toEqual({ days: 14, windowDays: 14, spreadMinutes: 5, leftOutDays: 0, startKey: "2026-09-18", endKey: "2026-10-01" });
    expect(wake.confidence).toBe("steady");
    expect(wake.confidenceText).toMatch(/most days/i);
    // Three days with a different number of naps were not used for nap times.
    expect(nap.evidence).toMatchObject({ days: 11, spreadMinutes: 30, leftOutDays: 3 });
    expect(nap.confidence).toBe("fairly_steady");
  });

  it("offers nothing where the logs cannot support it, and says why instead of inventing a time", () => {
    const proposal = proposeScheduleFromRoutine(routine({
      timeline: [
        { id: "wake", kind: "wake", activityType: "sleep", label: "Wake up", slot: slot(7 * 60, 120, 5) },
        { id: "medicine-0", kind: "medicine", activityType: "medicine", label: "Medicine", slot: slot(8 * 60, 0, 6) }
      ]
    }), []);

    expect(proposal.items).toEqual([]);
    expect(proposal.omitted).toEqual([
      { label: "Wake up", reason: expect.stringMatching(/varies too much/i) },
      { label: "Medicine", reason: expect.stringMatching(/not planned here/i) },
      { label: "Naps", reason: expect.stringMatching(/vary too much/i) },
      { label: "Feeds", reason: expect.stringMatching(/vary too much/i) }
    ]);
    expect(proposeScheduleFromRoutine(routine({ enoughData: false, timeline: [] }), []).limitation).toMatch(/not enough/i);
  });

  it("compares with the plan: a nearby item of the same kind is a change shown beside its current time, a match is left alone", () => {
    const current = [
      planned("wake", { mode: "exact", at: "07:00" }),
      planned("nap", { mode: "exact", at: "10:15" }),
      planned("feeding", { mode: "exact", at: "12:00" })
    ];
    const proposal = proposeScheduleFromRoutine(routine(), current);

    expect(proposal.items.map((item) => [item.kind, item.change])).toEqual([
      ["nap", { type: "change", currentIndex: 1, current: { mode: "exact", at: "10:15" } }],
      ["bedtime", { type: "add" }]
    ]);
    expect(proposal.alreadyPlanned).toEqual(["Wake up"]);
  });

  it("builds the new plan only from accepted choices, leaving every other item exactly as it was", () => {
    const current = [planned("nap", { mode: "exact", at: "10:15" }), planned("feeding", { mode: "exact", at: "12:00" })];
    const proposal = proposeScheduleFromRoutine(routine(), current);
    const [wake, nap, bedtime] = proposal.items;

    const result = applyProposalChoices(current, proposal.items, {
      [wake.id]: { choice: "reject" },
      [nap.id]: { choice: "accept" },
      [bedtime.id]: { choice: "edit", timing: { mode: "exact", at: "19:15" } }
    });

    expect(result.items).toEqual([
      planned("nap", { mode: "window", from: "09:00", to: "10:00" }),
      planned("feeding", { mode: "exact", at: "12:00" }),
      planned("bedtime", { mode: "exact", at: "19:15" })
    ]);
    expect(result.counts).toEqual({ added: 1, changed: 1, rejected: 1, undecided: 0 });
  });

  it("changes nothing for choices left undecided", () => {
    const current = [planned("nap", { mode: "exact", at: "10:15" })];
    const proposal = proposeScheduleFromRoutine(routine(), current);
    const result = applyProposalChoices(current, proposal.items, {});
    expect(result.items).toEqual(current);
    expect(result.counts).toEqual({ added: 0, changed: 0, rejected: 0, undecided: 3 });
  });

  it("keeps a window that would cross midnight as a single time instead", () => {
    const late = routine({ timeline: [{ id: "bedtime", kind: "bedtime", activityType: "sleep", label: "Bedtime", slot: slot(23 * 60 + 50, 30, 12) }] });
    expect(proposeScheduleFromRoutine(late, []).items[0].proposed).toEqual({ mode: "exact", at: "23:50" });
  });
});
