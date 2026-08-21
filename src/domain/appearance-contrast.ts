import { accentThemes } from "@/domain/appearance";

export const appearanceContrastContract = {
  accents: accentThemes,
  effectiveModes: ["light", "dark", "system-light", "system-dark"] as const,
  matrixCases: accentThemes.length * 4,
  normalTextRatio: 4.5,
  largeTextAndControlRatio: 3,
  states: ["focus", "error", "stale", "expired", "forced-colors", "first-paint"] as const,
  viewports: ["320x568", "375x667", "390x844", "430x932", "desktop"] as const,
  nonColorStatus: true
} as const;
