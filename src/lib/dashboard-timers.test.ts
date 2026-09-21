import { describe, expect, it } from "vitest";
import type { ActivityTypeName } from "@/domain/activity";
import { timersWithoutTile } from "@/lib/dashboard-timers";

const tileTypes = new Set<ActivityTypeName>(["sleep", "feeding", "diaper"]);

describe("dashboard timers without a tile", () => {
  it("leaves a single timer to its own tile", () => {
    expect(timersWithoutTile([{ id: "a", type: "sleep" }], tileTypes)).toEqual([]);
  });

  it("gives a row to a type the grid has no tile for", () => {
    expect(timersWithoutTile([{ id: "a", type: "pumping" }], tileTypes)).toEqual([{ id: "a", type: "pumping" }]);
  });

  it("gives a row to a second timer of a type that already has a tile", () => {
    // Twins feeding at once, or a nap started before the last was stopped: the tile can only stand
    // for one of them, and the other used to be invisible and unreachable from this screen.
    const timers = [{ id: "first", type: "feeding" }, { id: "second", type: "feeding" }];

    expect(timersWithoutTile(timers, tileTypes)).toEqual([{ id: "second", type: "feeding" }]);
  });

  it("shows every timer exactly once across tiles and rows", () => {
    const timers = [
      { id: "sleep-1", type: "sleep" },
      { id: "feed-1", type: "feeding" },
      { id: "feed-2", type: "feeding" },
      { id: "feed-3", type: "feeding" },
      { id: "pump-1", type: "pumping" },
      { id: "play-1", type: "play" }
    ];

    const rows = timersWithoutTile(timers, tileTypes);
    const onTiles = timers.filter((timer) => !rows.some((row) => row.id === timer.id));

    expect(onTiles.map(({ id }) => id)).toEqual(["sleep-1", "feed-1"]);
    expect(rows.map(({ id }) => id)).toEqual(["feed-2", "feed-3", "pump-1", "play-1"]);
    expect(new Set([...onTiles, ...rows].map(({ id }) => id)).size).toBe(timers.length);
  });

  it("has nothing to show when nothing is running", () => {
    expect(timersWithoutTile([], tileTypes)).toEqual([]);
  });
});
