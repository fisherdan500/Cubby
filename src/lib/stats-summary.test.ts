import { describe, expect, it } from "vitest";
import { buildStatsSummary } from "@/lib/stats-summary";
import type { ReportStats } from "@/server/services/reports";

function stats(overrides: {
  days?: number; sleepSeconds?: number; naps?: number; feeds?: number; bottleCount?: number; bottleTotal?: number | null;
  breast?: number; solids?: number; diapers?: number; wet?: number; dirty?: number; pumped?: number | null;
} = {}): ReportStats {
  return {
    daysWithEntries: overrides.days ?? 7,
    sleep: { total: "", totalSeconds: overrides.sleepSeconds ?? 0, average: "", naps: overrides.naps ?? 0, night: "" },
    feeding: {
      // `in`, not `??`: null is a real value here, meaning a volume that could not be converted.
      count: overrides.feeds ?? 0, bottleCount: overrides.bottleCount ?? 0, bottleTotal: "bottleTotal" in overrides ? overrides.bottleTotal ?? null : 0,
      bottleAverage: 0, unit: "oz", breastCount: overrides.breast ?? 0, solidsCount: overrides.solids ?? 0
    },
    diaper: { count: overrides.diapers ?? 0, wet: overrides.wet ?? 0, dirty: overrides.dirty ?? 0 },
    pumping: { total: "pumped" in overrides ? overrides.pumped ?? null : 0, unit: "oz" },
    growth: { weight: [], length: [], head: [] },
    milestones: []
  };
}

const rows = (summary: ReturnType<typeof buildStatsSummary>, title: string) =>
  summary.sections.find((section) => section.title === title)?.rows.map(({ label, value, change }) => [label, value, change]);

describe("buildStatsSummary", () => {
  it("turns a period's totals into per-day figures, averaged over the days that have entries", () => {
    const summary = buildStatsSummary(stats({ days: 6, sleepSeconds: 6 * 13 * 3600, naps: 18, feeds: 36, diapers: 30, wet: 24, dirty: 9 }), null);

    expect(summary.daysWithEntries).toBe(6);
    expect(rows(summary, "Sleep")).toEqual([["Sleep per day", "13h", null], ["Naps per day", "3", null]]);
    expect(rows(summary, "Feeding")).toEqual([["Feeds per day", "6", null]]);
    expect(rows(summary, "Diapers")).toEqual([["Diapers per day", "5", null], ["Wet per day", "4", null], ["Dirty per day", "1.5", null]]);
  });

  it("says how each figure moved against the previous period, without calling it better or worse", () => {
    const summary = buildStatsSummary(
      stats({ days: 7, sleepSeconds: 7 * (13 * 3600 + 20 * 60), naps: 21, feeds: 35 }),
      stats({ days: 7, sleepSeconds: 7 * (12 * 3600 + 40 * 60), naps: 28, feeds: 35 })
    );

    expect(rows(summary, "Sleep")).toEqual([["Sleep per day", "13h 20m", "+40m"], ["Naps per day", "3", "−1"]]);
    expect(rows(summary, "Feeding")).toEqual([["Feeds per day", "5", "Same"]]);
  });

  it("shows bottle, breast, solids and pumping only when they were logged", () => {
    const summary = buildStatsSummary(stats({ feeds: 14, bottleCount: 14, bottleTotal: 168, pumped: 70 }), stats({ feeds: 14, bottleCount: 14, bottleTotal: 154 }));

    expect(rows(summary, "Feeding")).toEqual([["Feeds per day", "2", "Same"], ["Bottle per day", "24 oz", "+2 oz"]]);
    expect(rows(summary, "Pumping")).toEqual([["Pumped per day", "10 oz", null]]);
  });

  it("does not guess a volume it could not convert", () => {
    const summary = buildStatsSummary(stats({ feeds: 7, bottleCount: 7, bottleTotal: null }), null);
    expect(rows(summary, "Feeding")).toEqual([["Feeds per day", "1", null], ["Bottle per day", "Unavailable", null]]);
  });

  it("leaves out areas nothing was logged for, and offers no comparison with an empty period", () => {
    const summary = buildStatsSummary(stats({ days: 3, diapers: 12, wet: 9, dirty: 3 }), stats({ days: 0 }));

    expect(summary.sections.map((section) => section.title)).toEqual(["Diapers"]);
    expect(rows(summary, "Diapers")?.every(([, , change]) => change === null)).toBe(true);
    expect(buildStatsSummary(stats({ days: 0 }), null).sections).toEqual([]);
  });
});
