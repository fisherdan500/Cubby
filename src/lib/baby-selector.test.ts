import { describe, expect, it } from "vitest";
import { formatBabyAge, resolveSelectedBaby } from "@/lib/baby-selector";

const babies = [
  { id: "baby-1", name: "Finley" },
  { id: "baby-2", name: "Riley" }
];

describe("baby selector helpers", () => {
  it("formats young baby ages in weeks", () => {
    expect(formatBabyAge(new Date("2026-03-13T00:00:00.000Z"), new Date("2026-06-19T12:00:00.000Z"))).toBe(
      "14 weeks"
    );
  });

  it("formats older baby ages in months", () => {
    expect(formatBabyAge(new Date("2025-06-13T00:00:00.000Z"), new Date("2026-06-19T12:00:00.000Z"))).toBe(
      "12 months"
    );
  });

  it("falls back when birth date is missing", () => {
    expect(formatBabyAge(null)).toBe("Age not set");
  });

  it("prefers query-selected baby over cached baby", () => {
    expect(resolveSelectedBaby(babies, "baby-2", "baby-1")?.id).toBe("baby-2");
  });

  it("uses cached baby when no valid query selection exists", () => {
    expect(resolveSelectedBaby(babies, undefined, "baby-2")?.id).toBe("baby-2");
  });

  it("falls back to the first baby when cached baby is invalid", () => {
    expect(resolveSelectedBaby(babies, undefined, "missing")?.id).toBe("baby-1");
  });
});
