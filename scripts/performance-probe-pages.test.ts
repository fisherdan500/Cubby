import { describe, expect, it } from "vitest";
import {
  datasetActivityCount,
  populatedDashboardPath,
  populatedDateKey,
  requirePopulatedPage
} from "./performance-probe-pages.mjs";

function row(id: string) {
  return `<a href="/app/activities/${id}?returnTo=%2Fapp%3FbabyId%3Dpf_bby_first01">Feeding</a>`;
}

describe("performance probe pages", () => {
  it("pins the dashboard to the dataset's last day rather than the wall clock", () => {
    const dateKey = populatedDateKey({ endDate: "2026-09-19T00:00:00.000Z" });

    expect(dateKey).toBe("2026-09-19");
    expect(populatedDashboardPath("pf_bby_first01", dateKey)).toBe("/app?babyId=pf_bby_first01&date=2026-09-19");
  });

  it.each([
    ["missing", {}],
    ["not a string", { endDate: 20260919 }],
    ["not an instant", { endDate: "yesterday" }],
    ["not midnight UTC, so not a whole dataset day", { endDate: "2026-09-19T05:00:00.000Z" }]
  ])("refuses a handoff whose end date is %s", (_label, handoff) => {
    expect(() => populatedDateKey(handoff)).toThrow("performance_probe_handoff_end_date_invalid");
  });

  it("counts each dataset activity once, however often the page links to it", () => {
    const html = `<main>${row("perf_000000001")}${row("perf_000000001")}${row("perf_00000000a")}${row("act_other")}</main>`;

    expect(datasetActivityCount(html)).toBe(2);
  });

  it("fails a page that rendered no dataset activity, which is what an unpinned date measured", () => {
    const empty = `<main><p>No activity for this date.</p></main>`;

    expect(() => requirePopulatedPage("/app?babyId=pf_bby_first01", empty, 10))
      .toThrow("performance_probe_page_unpopulated:/app?babyId=pf_bby_first01:0");
  });

  it("fails a page with too few dataset rows to stand for a populated day", () => {
    const sparse = `<main>${row("perf_000000001")}${row("perf_000000002")}</main>`;

    expect(() => requirePopulatedPage("/app/history", sparse, 10)).toThrow("performance_probe_page_unpopulated:/app/history:2");
  });

  it("accepts a page that renders a populated day", () => {
    const populated = `<main>${Array.from({ length: 12 }, (_, index) => row(`perf_${String(index).padStart(9, "0")}`)).join("")}</main>`;

    expect(() => requirePopulatedPage("/app/history", populated, 10)).not.toThrow();
  });
});
