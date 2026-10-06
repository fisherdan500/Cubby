import { describe, expect, it } from "vitest";
import {
  HISTORY_PAGE_SIZE,
  historyHref,
  historyPageQuery,
  paginateHistoryItems
} from "@/lib/history-pagination";

describe("paginateHistoryItems", () => {
  it("renders one page and uses the last rendered item as the next cursor", () => {
    const items = Array.from({ length: HISTORY_PAGE_SIZE + 1 }, (_, index) => ({ id: `activity-${index + 1}` }));

    const result = paginateHistoryItems(items);

    expect(result.items).toHaveLength(HISTORY_PAGE_SIZE);
    expect(result.nextCursor).toBe(`activity-${HISTORY_PAGE_SIZE}`);
  });

  it("does not return a cursor when no older item exists", () => {
    const items = Array.from({ length: HISTORY_PAGE_SIZE }, (_, index) => ({ id: `activity-${index + 1}` }));

    const result = paginateHistoryItems(items);

    expect(result.items).toEqual(items);
    expect(result.nextCursor).toBeUndefined();
  });
});

describe("historyHref", () => {
  it("preserves week with the selected baby, filters and cursor in a stable order", () => {
    expect(historyHref({
      cursor: "activity-25", week: "2026-03-02", search: "night feed", type: "sleep", babyId: "baby-1"
    })).toBe("/app/history?babyId=baby-1&type=sleep&search=night+feed&week=2026-03-02&cursor=activity-25");
  });

  it("omits an empty week and keeps bare history unchanged", () => {
    expect(historyHref({ week: "" })).toBe("/app/history");
    expect(historyHref({})).toBe("/app/history");
  });

  it("preserves active filters and the pagination cursor", () => {
    expect(
      historyHref({
        babyId: "baby-1",
        type: "note",
        search: "night feed",
        cursor: "activity-25"
      })
    ).toBe("/app/history?babyId=baby-1&type=note&search=night+feed&cursor=activity-25");
  });

  it("omits empty filters and cursors", () => {
    expect(historyHref({ babyId: "baby-1", type: "", search: "", cursor: undefined })).toBe("/app/history?babyId=baby-1");
  });
});

describe("historyPageQuery", () => {
  it("requests one lookahead row with deterministic ordering", () => {
    expect(historyPageQuery()).toEqual({
      take: HISTORY_PAGE_SIZE + 1,
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }]
    });
  });

  it("starts after the supplied cursor", () => {
    expect(historyPageQuery("activity-25")).toEqual({
      take: HISTORY_PAGE_SIZE + 1,
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      cursor: { id: "activity-25" },
      skip: 1
    });
  });
});
