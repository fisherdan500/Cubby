import { describe, expect, it } from "vitest";
import { accentThemes, parseAccentTheme } from "@/domain/appearance";

describe("appearance", () => {
  it("accepts every curated household accent", () => {
    for (const accent of accentThemes) {
      expect(parseAccentTheme(accent)).toBe(accent);
    }
  });

  it("falls back to sage for missing or unsupported backup values", () => {
    expect(parseAccentTheme(undefined)).toBe("sage");
    expect(parseAccentTheme("neon")).toBe("sage");
  });
});
