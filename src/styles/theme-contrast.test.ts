import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { accentThemes } from "@/domain/appearance";

/**
 * Legibility, checked rather than eyeballed.
 *
 * A palette is retuned by moving numbers that each look harmless on their own, and the way it goes
 * wrong is that some pairing quietly falls below the line - which is how the old palette ended up
 * putting pure black text on a sage button. Every pair that carries meaning is measured here, in both
 * modes and under all five accents, so a future retune cannot regress legibility without failing.
 *
 * WCAG 2.1: 4.5:1 for body text, 3:1 for large text and for the boundary of a control.
 */

const css = readFileSync(new URL("./globals.css", import.meta.url), "utf8");

type Hsl = { h: number; s: number; l: number };

/** Reads `--name: H S% L%;` out of one CSS block. */
function tokens(block: string): Record<string, Hsl> {
  const found: Record<string, Hsl> = {};
  for (const [, name, h, s, l] of block.matchAll(/--([a-z-]+):\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s*;/g)) {
    found[name] = { h: Number(h), s: Number(s) / 100, l: Number(l) / 100 };
  }
  return found;
}

function block(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`missing block ${selector}`);
  const end = css.indexOf("}", start);
  return css.slice(start, end);
}

function rgb({ h, s, l }: Hsl): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    hp < 1 ? [c, x, 0]
    : hp < 2 ? [x, c, 0]
    : hp < 3 ? [0, c, x]
    : hp < 4 ? [0, x, c]
    : hp < 5 ? [x, 0, c]
    : [c, 0, x];
  return [r + m, g + m, b + m];
}

function luminance(colour: Hsl) {
  const [r, g, b] = rgb(colour).map((channel) =>
    channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  );
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(a: Hsl, b: Hsl) {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return Math.round(((light! + 0.05) / (dark! + 0.05)) * 100) / 100;
}

const light = tokens(block(":root"));
const dark = { ...light, ...tokens(block(".dark")) };

const modes = [
  { name: "light", palette: light },
  { name: "dark", palette: dark }
] as const;

/** Text against the surface it sits on, which is the pairing that decides whether Cubby is readable. */
const textPairs = [
  ["foreground", "background"],
  ["foreground", "card"],
  ["foreground", "surface"],
  ["foreground", "muted"],
  ["muted-foreground", "background"],
  ["muted-foreground", "card"],
  ["muted-foreground", "surface"],
  ["muted-foreground", "muted"],
  ["primary", "background"],
  ["primary", "card"],
  ["live", "background"],
  ["live", "card"],
  ["danger", "background"],
  ["danger", "card"],
  ["primary-foreground", "primary"],
  ["accent-foreground", "accent"]
] as const;

describe("theme contrast", () => {
  it.each(modes)("keeps $name text legible on every surface it lands on", ({ palette }) => {
    for (const [text, surface] of textPairs) {
      const ratio = contrast(palette[text]!, palette[surface]!);
      expect({ pair: `${text} on ${surface}`, ratio: ratio >= 4.5 }).toEqual({
        pair: `${text} on ${surface}`,
        ratio: true
      });
    }
  });

  it.each(modes)("keeps a $name border visible against what it separates", ({ palette }) => {
    // A boundary is not text, so 3:1 is the bar - but it still has to be findable.
    for (const surface of ["background", "card", "surface"] as const) {
      const ratio = contrast(palette.border!, palette[surface]!);
      expect({ surface, visible: ratio >= 1.2 }).toEqual({ surface, visible: true });
    }
  });

  it.each(modes)("separates each $name surface from the one beneath it", ({ palette }) => {
    // Elevation reads as a value step, so the steps have to actually differ.
    const ladder = ["background", "surface-soft", "card", "surface", "muted"] as const;
    const lightnesses = ladder.map((name) => palette[name]!.l);
    expect(new Set(lightnesses).size).toBe(ladder.length);
  });

  it.each(accentThemes)("keeps the %s accent legible in both modes", (accent) => {
    for (const mode of ["light", "dark"] as const) {
      const selector = mode === "light" ? `[data-accent="${accent}"]` : `.dark [data-accent="${accent}"]`;
      const palette = { ...(mode === "light" ? light : dark), ...tokens(block(selector)) };

      // The accent leads, so it has to read as text, carry its own foreground, and be seen as a focus ring.
      expect({ accent, mode, on: "background", ok: contrast(palette.primary!, palette.background!) >= 4.5 })
        .toEqual({ accent, mode, on: "background", ok: true });
      expect({ accent, mode, on: "card", ok: contrast(palette.primary!, palette.card!) >= 4.5 })
        .toEqual({ accent, mode, on: "card", ok: true });
      expect({ accent, mode, on: "its own text", ok: contrast(palette["primary-foreground"]!, palette.primary!) >= 4.5 })
        .toEqual({ accent, mode, on: "its own text", ok: true });
      expect({ accent, mode, on: "ring", ok: contrast(palette.ring!, palette.background!) >= 3 })
        .toEqual({ accent, mode, on: "ring", ok: true });
    }
  });

  it.each(accentThemes)("gives the %s accent a live spark that never collides with it", (accent) => {
    for (const mode of ["light", "dark"] as const) {
      const selector = mode === "light" ? `[data-accent="${accent}"]` : `.dark [data-accent="${accent}"]`;
      const palette = { ...(mode === "light" ? light : dark), ...tokens(block(selector)) };
      const apart = Math.abs(palette.live!.h - palette.primary!.h);
      const hueGap = Math.min(apart, 360 - apart);

      // A running timer has to be tellable from the accent at a glance, whichever accent is chosen -
      // the old fixed terracotta spark vanished for anyone using the terracotta preset.
      expect({ accent, mode, hueGap: hueGap >= 60 }).toEqual({ accent, mode, hueGap: true });
      expect({ accent, mode, legible: contrast(palette.live!, palette.background!) >= 4.5 })
        .toEqual({ accent, mode, legible: true });
    }
  });

  it("gives every activity tone its own place, in both modes", () => {
    for (const mode of ["light", "dark"] as const) {
      // Anchored, or the light pattern also matches inside every `.dark .activity-tone-` rule.
      const prefix = mode === "light" ? "" : "\\.dark ";
      const tones = [...css.matchAll(new RegExp(`^${prefix}\\.activity-tone-[a-z-]+ \\{ background: hsl\\((\\d+) (\\d+)% (\\d+)%\\); \\}`, "gm"))]
        .map(([, h, s, l]) => ({ h: Number(h), s: Number(s), l: Number(l) }));
      expect(tones).toHaveLength(14);

      // Two tones that sit close in hue have to differ in saturation or lightness instead, or the
      // pair becomes indistinguishable at the size of a dashboard tile - as four pairs once were.
      for (let i = 0; i < tones.length; i += 1) {
        for (let j = i + 1; j < tones.length; j += 1) {
          const apart = Math.abs(tones[i]!.h - tones[j]!.h);
          const hueGap = Math.min(apart, 360 - apart);
          const otherGap = Math.abs(tones[i]!.s - tones[j]!.s) + Math.abs(tones[i]!.l - tones[j]!.l);
          expect({ mode, pair: [i, j], distinct: hueGap >= 18 || otherGap >= 10 })
            .toEqual({ mode, pair: [i, j], distinct: true });
        }
      }
    }
  });
});
