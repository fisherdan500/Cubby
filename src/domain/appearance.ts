import { z } from "zod";

export const accentThemes = ["sage", "rose", "powder", "butter", "terracotta"] as const;
export type AccentTheme = (typeof accentThemes)[number];

export const accentThemeSchema = z.enum(accentThemes);

export const appearanceModes = ["system", "light", "dark"] as const;
export type AppearanceMode = (typeof appearanceModes)[number];
export const appearanceModeSchema = z.enum(appearanceModes);

/**
 * Where an account starts before anyone chooses. Cubby is used at night far more than a general
 * purpose app is, so it opens dark and offers Light and System to whoever wants them.
 *
 * Accounts that already hold a stored mode keep it, including the "system" every account was given by
 * the old column default: there is no way to tell that apart from someone who chose to follow their
 * device, so it is left alone rather than overridden.
 */
export const DEFAULT_APPEARANCE_MODE: AppearanceMode = "dark";

export const accentThemeDetails: Record<AccentTheme, { label: string; description: string; swatch: string }> = {
  sage: { label: "Sage", description: "Calm botanical green", swatch: "#6f8978" },
  rose: { label: "Dusty rose", description: "Soft and warm", swatch: "#a86f75" },
  powder: { label: "Powder blue", description: "Quiet and airy", swatch: "#66869a" },
  butter: { label: "Butter", description: "Sunny and gentle", swatch: "#9a7a38" },
  terracotta: { label: "Terracotta", description: "Earthy and cozy", swatch: "#a25f49" }
};

export function parseAccentTheme(value: unknown): AccentTheme {
  return accentThemeSchema.catch("sage").parse(value);
}

export function parseAppearanceMode(value: unknown): AppearanceMode {
  return appearanceModeSchema.catch(DEFAULT_APPEARANCE_MODE).parse(value);
}
