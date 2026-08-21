import { describe, expect, it } from "vitest";
import { accentThemes } from "@/domain/appearance";
import { appearanceContrastContract } from "@/domain/appearance-contrast";

describe("appearance contrast acceptance contract", () => {
  it("covers every Family accent across explicit and system-effective light/dark modes", () => {
    expect(appearanceContrastContract.accents).toEqual(accentThemes);
    expect(appearanceContrastContract.effectiveModes).toEqual(["light", "dark", "system-light", "system-dark"]);
    expect(appearanceContrastContract.matrixCases).toBe(20);
  });

  it("retains WCAG, forced-color, focus, error, first-paint, and narrow-viewport gates", () => {
    expect(appearanceContrastContract.normalTextRatio).toBe(4.5);
    expect(appearanceContrastContract.largeTextAndControlRatio).toBe(3);
    expect(appearanceContrastContract.states).toEqual(expect.arrayContaining(["focus", "error", "stale", "expired", "forced-colors", "first-paint"]));
    expect(appearanceContrastContract.viewports).toEqual(expect.arrayContaining(["320x568", "375x667", "390x844", "430x932", "desktop"]));
    expect(appearanceContrastContract.nonColorStatus).toBe(true);
  });
});
