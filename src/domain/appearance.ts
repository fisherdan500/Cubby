import { z } from "zod";

export const accentThemes = ["sage", "rose", "powder", "butter", "terracotta"] as const;
export type AccentTheme = (typeof accentThemes)[number];

export const accentThemeSchema = z.enum(accentThemes);

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
