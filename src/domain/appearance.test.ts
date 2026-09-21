import { describe, expect, it } from "vitest";
import {
  accentThemes,
  appearanceModes,
  DEFAULT_APPEARANCE_MODE,
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
  });

  it("starts an account in dark, and keeps every mode anyone has actually stored", () => {
    expect(DEFAULT_APPEARANCE_MODE).toBe("dark");
    expect(parseAppearanceMode(undefined)).toBe("dark");
    expect(parseAppearanceMode("sage")).toBe("dark");

    // A stored choice is never reinterpreted, including the "system" the old column default gave
    // every account: that cannot be told apart from someone who wants to follow their device.
    expect(parseAppearanceMode("system")).toBe("system");
    expect(parseAppearanceMode("light")).toBe("light");
  });
});
