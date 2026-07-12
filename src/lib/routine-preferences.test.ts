import { describe, expect, it } from "vitest";
import {
  filterRoutineRows,
  parseRoutineActivitySelection,
  serializeRoutineActivitySelection
} from "@/lib/routine-preferences";

describe("routine activity preferences", () => {
  it("uses recommended defaults when no preference exists", () => {
    expect(parseRoutineActivitySelection(null)).toEqual(["sleep", "feeding", "diaper"]);
  });

  it("preserves an intentionally empty selection", () => {
    expect(parseRoutineActivitySelection("[]")).toEqual([]);
  });

  it("drops unsupported and duplicate values while retaining supported order", () => {
    expect(parseRoutineActivitySelection('["play","mood","note","play","sleep"]')).toEqual(["play", "sleep"]);
  });

  it("falls back to defaults for malformed JSON or a non-array value", () => {
    expect(parseRoutineActivitySelection("not-json")).toEqual(["sleep", "feeding", "diaper"]);
    expect(parseRoutineActivitySelection('{"sleep":true}')).toEqual(["sleep", "feeding", "diaper"]);
  });

  it("serializes selections as a JSON array", () => {
    expect(serializeRoutineActivitySelection(["sleep", "supplement"])).toBe('["sleep","supplement"]');
  });

  it("filters rows without changing their chronological order", () => {
    const rows = [
      { type: "feeding" as const, averageMinutes: 480 },
      { type: "diaper" as const, averageMinutes: 500 },
      { type: "sleep" as const, averageMinutes: 540 }
    ];

    expect(filterRoutineRows(rows, ["sleep", "feeding"])).toEqual([rows[0], rows[2]]);
  });
});
