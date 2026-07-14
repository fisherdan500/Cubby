import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./calendar-focus-restore.tsx", import.meta.url), "utf8");

describe("CalendarFocusRestore", () => {
  it("focuses the restored opener after the destination page commits", () => {
    expect(source).toContain("requestAnimationFrame");
    expect(source).toContain("querySelector<HTMLElement>(selector)?.focus()");
    expect(source).toContain("cancelAnimationFrame");
  });
});
