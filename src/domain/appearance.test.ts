import { describe, expect, it } from "vitest";
import {
  accentThemes,
  appearanceModes,
  parseAccentTheme,
  parseAppearanceMode
} from "@/domain/appearance";

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

  it("keeps personal system, light, and dark modes separate from household accents", () => {
    expect(appearanceModes).toEqual(["system", "light", "dark"]);
    for (const mode of appearanceModes) expect(parseAppearanceMode(mode)).toBe(mode);
    expect(parseAppearanceMode(undefined)).toBe("system");
    expect(parseAppearanceMode("sage")).toBe("system");
  });
});
