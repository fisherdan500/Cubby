import { describe, expect, it } from "vitest";
import { calendarEventTextColor, calendarFullBleedClassName } from "@/lib/calendar-layout";

describe("calendar responsive layout", () => {
  it("mirrors the AppShell mobile px-3 gutter without leaking into document overflow", () => {
    expect(calendarFullBleedClassName.split(" ")).toContain("-mx-3");
    expect(calendarFullBleedClassName.split(" ")).not.toContain("-mx-4");
    expect(calendarFullBleedClassName.split(" ")).toContain("md:-mx-6");
  });
});

describe("calendar event contrast", () => {
  it("uses black for the current default primary palette when no custom color is present", () => {
    expect(calendarEventTextColor(undefined)).toBe("#000000");
    expect(calendarEventTextColor("hsl(var(--primary))")).toBe("#000000");
  });

  it.each([
    ["#14b8a6", "#000000"],
    ["#ffffff", "#000000"],
    ["#000000", "#ffffff"]
  ])("chooses readable text for %s", (background, expected) => {
    expect(calendarEventTextColor(background)).toBe(expected);
  });

  it.each(["#7c7c7c", "#777777"])("guarantees WCAG AA contrast for %s", (background) => {
    expect(contrastRatio(background, calendarEventTextColor(background))).toBeGreaterThanOrEqual(4.5);
  });
});

function contrastRatio(background: string, foreground: string) {
  const luminance = (color: string) => {
    const channels = color
      .slice(1)
      .match(/.{2}/g)!
      .map((channel) => parseInt(channel, 16) / 255)
      .map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  };
  const values = [luminance(background), luminance(foreground)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}
